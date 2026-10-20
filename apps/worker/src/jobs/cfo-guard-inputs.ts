/**
 * cfo-guard's view of one facility (core CfoInputs), read at the guard's snapshot block B: the mirrored chain state
 * (ChainSnapshot at B, Treasury.revenueLedger at B) plus this facility's DB rows that landed at or below B, each dated
 * by its block's timestamp (chain time). Same records and rules as the API's GET /api/cfo (packages/api
 * services/cfo.ts), so the agent tightens on exactly the numbers the founder sees:
 *   - payments: mined rows; a FUND_MILESTONE on an autoRelease milestone the escrow paid is supplier cost;
 *   - sales: recorded sales (sales.tx_hash) dated by their landed SalesOracle.recordSale action;
 *   - agentActions: this job's own Treasury.tighten rows that may have landed (not REVERTED, not refused before signing);
 *     core skips a line tightened within its window. A slot tried today stays used anyway (its action id is per day);
 *   - lines: the pockets at B plus the committed plan's caps (core never lowers a cap below half of them).
 *
 * Bounded (audit run-9 lead 3): only the last GUARD_WINDOW_DAYS chain days are read and dated, plus the EARLIEST record
 * of each payment class (kind, state, line or not, auto-released or not) and the earliest sale before the window. Core
 * proposeTightenings reads spend over the last min(7, sampleDays) days, the first counted record's day (sampleDays) and
 * whether any revenue exists; the anchors are real rows, so core applies its own counting rules to them and finds the
 * same first day and the same "any revenue" as over the full history, and the proposals are identical. The window's
 * first block is found by a binary search over the facility's own record blocks (chain time only grows with the block
 * number), and every timestamp comes through an in-process LRU (chain/block-times.ts), so a pass costs O(log n) block
 * reads plus the blocks new since the last pass. Any read error throws (the job fails closed: nothing is sent).
 */
import { CfoInputError, LineKey, MEI_IDS, RINA_IDS, type CfoAgentAction, type CfoInputs, type CfoLineIn, type CfoPaymentIn, type CfoSaleIn, type CurrencyCode, type Hex32, type Id, type PayeeId, type PlanManifest } from '@hogee/core';
import { parseAbi, type Hex } from 'viem';
import { z } from 'zod';
import { BlockTimeCache, blockTimesFor, type BlockTimes } from '../chain/block-times';
import type { CommittedPlan } from '../chain/context';
import { shortIdFromBytes32, type ChainSnapshot } from '../chain/snapshot';
import { rows, type Pg } from '../store/pg';
import { minedPayments, paymentAnchors, recordedSales, saleAnchor, windowStart, type PaymentRow, type SaleRow } from './cfo-guard-records';
import type { JobDeps } from './deps';

/** Every chain action id this job writes starts with it (the API reads its landed ones as the CFO's agent actions). */
export const CFO_GUARD_ACTION_PREFIX = 'cfo-guard:';

const ledgerAbi = parseAbi(['function revenueLedger() view returns (uint128 reserveSkimmedMinor, uint128 reserveWithdrawnMinor, uint64 salesCount)']);

/** Chain days of records each pass reads: the CFO report's 30-day series (core SERIES_DAYS); more than MA7 needs. */
export const GUARD_WINDOW_DAYS = 30;
const SECONDS_PER_DAY = 86_400n;

/** This process's block timestamps (one chain: the cache re-scopes itself by genesis hash). */
const SHARED_BLOCK_TIMES = new BlockTimeCache();

/** The window's first second: the start of the UTC day GUARD_WINDOW_DAYS − 1 days before the snapshot's. */
export function windowFrom(timestamp: bigint): bigint {
  const day = timestamp / SECONDS_PER_DAY - BigInt(GUARD_WINDOW_DAYS - 1);
  return day > 0n ? day * SECONDS_PER_DAY : 0n;
}

/**
 * The request_json of a cfo-guard Treasury.tighten action. Built from the facility's own records by core
 * proposeTightenings, never from model text. `chainTime`: the snapshot timestamp the decision was made at.
 */
export const CfoGuardRequest = z.strictObject({
  source: z.literal('cfo-guard'),
  action: z.enum(['LOWER_PER_TX_CAP', 'LOWER_WINDOW_CAP', 'RAISE_RESERVE_BPS']),
  lineKey: LineKey.nullable(),
  newValue: z.string().regex(/^(0|[1-9][0-9]{0,38})$/),
  reason: z.string().min(1).max(200),
  decisionId: z.string().uuid(),
  chainTime: z.string().regex(/^[1-9][0-9]{0,11}$/),
  traceId: z.string().min(1).max(128),
});
export type CfoGuardRequest = z.infer<typeof CfoGuardRequest>;

function at(times: ReadonlyMap<bigint, bigint>, r: { readonly block: bigint }): Date {
  const t = times.get(r.block);
  if (t === undefined) throw new CfoInputError(`no timestamp for block ${r.block}`);
  return new Date(Number(t) * 1000);
}

/** The window's rows plus the anchors below it (cfo-guard-records.ts); none when the facility has no record. */
async function windowedRecords(q: Pg, facilityId: string, head: bigint, fromTime: bigint, times: BlockTimes): Promise<{ payments: PaymentRow[]; sales: SaleRow[] }> {
  const from = await windowStart(q, facilityId, head, fromTime, (b) => times.of(b));
  if (from === null) return { payments: [], sales: [] };
  const [anchors, payments, firstSale, sales] = await Promise.all([
    paymentAnchors(q, facilityId, from),
    minedPayments(q, facilityId, from, head),
    saleAnchor(q, facilityId, from),
    recordedSales(q, facilityId, from, head),
  ]);
  return { payments: [...anchors, ...payments], sales: [...firstSale, ...sales] };
}

/**
 * This job's own tighten rows that may have landed: every state but REVERTED, and not refused before signing (a
 * tightening that never reached the chain does not start a line's window). A row whose request does not parse is
 * skipped: it still uses its slot for the day by id.
 */
export async function guardActions(q: Pg, facilityId: string): Promise<{ id: string; request: CfoGuardRequest; txHash: Hex32 | null }[]> {
  const out = await rows<{ id: string; request_json: unknown; tx_hash: string | null }>(
    q,
    `select id, request_json, tx_hash from chain_actions
      where facility_id = $1 and kind = 'Treasury.tighten' and id like $2
        and state <> 'REVERTED' and (raw_signed_tx is not null or revert_reason is null)
      order by created_at desc limit 200`,
    [facilityId, `${CFO_GUARD_ACTION_PREFIX}%`],
  );
  return out.flatMap((a) => {
    const r = CfoGuardRequest.safeParse(a.request_json);
    return r.success ? [{ id: a.id, request: r.data, txHash: a.tx_hash as Hex32 | null }] : [];
  });
}

const lineKeyOf = (lineId: Hex): LineKey | null => {
  try {
    const parsed = LineKey.safeParse(shortIdFromBytes32(lineId));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/**
 * Current pockets at B as core CfoLineIn (lines whose id is no LineKey are left out), with the committed plan's caps for
 * the line (core's floor: never below half of them; a line the manifest does not name gets no cap proposal).
 */
export function linesOf(s: ChainSnapshot, manifest: PlanManifest): CfoLineIn[] {
  const plan = new Map(manifest.lines.map((l) => [l.lineKey, l]));
  return s.lines.flatMap((v) => {
    const lineKey = lineKeyOf(v.lineId);
    if (lineKey === null) return [];
    const p = v.pocket;
    const committed = plan.get(lineKey);
    return [
      {
        lineKey,
        allocatedMinor: p.allocatedMinor,
        spentMinor: p.spentMinor,
        escrowedMinor: p.escrowedMinor,
        availableMinor: p.availableMinor,
        perTxCapMinor: p.perTxCapMinor,
        windowCapMinor: p.windowCapMinor,
        windowSpentMinor: p.windowSpentMinor,
        validUntil: p.validUntil,
        pacingMinor: p.pacingMinor,
        windowSeconds: BigInt(p.windowSeconds),
        ...(committed ? { committedPerTxCapMinor: BigInt(committed.perTxCapMinor), committedWindowCapMinor: BigInt(committed.windowCapMinor) } : {}),
      },
    ];
  });
}

/**
 * The deployment's static tax payee for the facility's currency (the API's catalog picks it by country: SG iras-tax,
 * MY lhdn-tax). The guard never pays it; core CfoInputs names it. An unknown currency fails closed.
 */
export function taxPayeeOf(currency: string): PayeeId {
  if (currency === 'SGD') return MEI_IDS.taxPayeeId;
  if (currency === 'MYR') return RINA_IDS.taxPayeeId;
  throw new CfoInputError(`no tax payee for currency ${currency}`);
}

export interface GuardContextIn {
  readonly facilityId: string;
  readonly currency: CurrencyCode;
  readonly taxPayeeId: PayeeId;
  readonly snapshot: ChainSnapshot;
  readonly committed: CommittedPlan;
}

export interface GuardReadOptions {
  /** Block timestamps (default: this process's shared cache). */
  readonly cache?: BlockTimeCache;
  /** Runs before every block read; the pass deadline throws there (runtime/deadline.ts). */
  readonly check?: () => void;
}

/**
 * CfoInputs for the guard's proposals (core proposeTightenings), from the snapshot at B and the DB rows at or below B:
 * the last GUARD_WINDOW_DAYS chain days plus the anchors below them (module doc).
 */
export async function readGuardInputs(d: Pick<JobDeps, 'client' | 'deployment'>, q: Pg, c: GuardContextIn, o: GuardReadOptions = {}): Promise<CfoInputs> {
  const s = c.snapshot;
  const times = await blockTimesFor(d.client, o.cache ?? SHARED_BLOCK_TIMES, o.check);
  const [ledger, records, actions] = await Promise.all([
    d.client.readContract({ address: d.deployment.contracts.Treasury.address, abi: ledgerAbi, functionName: 'revenueLedger', blockNumber: s.blockNumber }),
    windowedRecords(q, c.facilityId, s.blockNumber, windowFrom(s.timestamp), times),
    guardActions(q, c.facilityId),
  ]);
  const { payments, sales } = records;
  const dated = await times.all([...payments.map((p) => p.block), ...sales.map((x) => x.block)]);
  const [skimmed, withdrawn] = ledger;
  const paymentsIn: CfoPaymentIn[] = payments.map((p) => ({
    kind: p.kind,
    lineKey: p.lineKey,
    amountMinor: p.amountMinor,
    state: p.state,
    at: at(dated, p),
    txHash: p.txHash,
    ...(p.kind === 'FUND_MILESTONE' ? { autoReleased: p.autoReleased } : {}),
  }));
  const salesIn: CfoSaleIn[] = sales.map((x) => ({ saleId: x.saleId, amountMinor: x.amountMinor, at: at(dated, x), txHash: x.txHash }));
  const agentActions: CfoAgentAction[] = actions.map(({ request: r, txHash }) => ({
    at: new Date(Number(r.chainTime) * 1000).toISOString(),
    action: r.action,
    lineKey: r.lineKey,
    newValue: r.newValue,
    reason: r.reason,
    txHash,
  }));
  return {
    currency: c.currency,
    now: new Date(Number(s.timestamp) * 1000),
    facilityId: c.facilityId as Id,
    lines: linesOf(s, c.committed.manifest as PlanManifest),
    payments: paymentsIn,
    sales: salesIn,
    reserve: { rateBps: s.plan.reserveBps, skimmedMinor: skimmed, withdrawnMinor: withdrawn, taxPayeeId: c.taxPayeeId },
    // The guard proposes no stage action; the stage projection is the report's (GET /api/cfo).
    stage: null,
    reserveBps: (c.committed.manifest as PlanManifest).reserveBps,
    agentActions,
    releasedMinor: s.balances.releasedMinor,
    fundedMinor: s.balances.fundedMinor,
  };
}
