/**
 * Founder-signed settlements another account executed first (audit run-4 v-2; re-check M3, M4, L5). Treasury.ownerSpend
 * and MilestoneEscrow.releaseMilestone do not check who submits them, so anyone who sees the relayer's pending tx can
 * land a copy first. The copy opens the settlement and the relayer's row ends REVERTED (or POLICY_DENIED, when the
 * relay's simulation already saw it): no row would ever pay or fail that settlement.
 *
 * For every OWNER_SPEND / RELEASE_MILESTONE whose rows all ended without executing (founderAdoptions, pure), one
 * finalized head per pass:
 * 1. isIntentUsed at `finalized`; when used, the block it first reads used (settle-adopt.ts firstBlockWhere: historical
 *    state, so the log is read from ONE block and capped eth_getLogs ranges are never hit);
 * 2. that block's OwnerSpent / MilestoneReleased, checked against the founder-signed row; a tx a live row of ours sent
 *    (an autoRelease inside its own funding) is ours already;
 * 3. Treasury.settlementState at the same finalized block must still be NONE (M4): a settlement someone already
 *    confirmed or failed is not adopted;
 * 4. the executing tx's signed bytes rebuilt and checked, then one worker-owned FINALIZED row
 *    (`adopt-owner:<spendId>` / `adopt-release:<settlementId>`) with an EXECUTED_BY_THIRD_PARTY ALERT. The usual binding
 *    (settle-verify*.ts) and rail flow then pay it exactly once.
 * Every other outcome is one ALERT per kind on the founder row's trace (L5): a mismatch, our own tx, a closed settlement
 * or a DROPPED row that still holds the intent (unique index: never adopted) is then never looked up again; history
 * reads the RPC cannot serve are alerted once and retried quietly. Groups whose signatures expired more than
 * ADOPTION_GRACE_S before the finalized head are never looked up again either (M3): nothing can execute them any more.
 */
import { iMilestoneEscrowAbi, iPlanRegistryAbi, iTreasuryAbi, shortErrorReason } from '@hogee/chain';
import { getAbiItem, type Hex } from 'viem';
import { poolOf, rows, type Pg } from '../store/pg';
import { appendTrace, hasTrace } from '../store/trace';
import { ADOPT_OWNER_ID_PREFIX, ADOPT_RELEASE_ID_PREFIX } from './agent-actions-ids';
import type { JobDeps } from './deps';
import { traceIdOf } from './pacing';
import { firstBlockWhere, rebuiltTx, treasuryReadOr, type AdoptOutcome } from './settle-adopt';
import { bytes32OfShortId, finalizedHead, same, type FinalizedHead } from './settle-chain';

const OWNER_SPENT = getAbiItem({ abi: iTreasuryAbi, name: 'OwnerSpent' });
const MILESTONE_RELEASED = getAbiItem({ abi: iMilestoneEscrowAbi, name: 'MilestoneReleased' });

export type FounderKind = 'OWNER_SPEND' | 'RELEASE_MILESTONE';

/** The API's SIGNATURE_TTL_S (packages/api signing/typed.ts): how long past a signature's expiry it is still looked up. */
export const ADOPTION_GRACE_S = 900n;

/** One ALERT reason code per kind of outcome (L5). */
export const ADOPT_ALERT = Object.freeze({
  ADOPTED: 'EXECUTED_BY_THIRD_PARTY',
  HELD: 'ADOPTION_HELD',
  MISMATCH: 'ADOPTION_MISMATCH',
  OWN_TX: 'ADOPTION_OWN_TX',
  CLOSED: 'ADOPTION_SETTLEMENT_CLOSED',
  HISTORY: 'ADOPTION_HISTORY_UNAVAILABLE',
} as const);

/** Alerts after which a group is never looked up again (a held group only by its own). */
const FINAL_ALERTS: readonly string[] = [ADOPT_ALERT.MISMATCH, ADOPT_ALERT.OWN_TX, ADOPT_ALERT.CLOSED];

/** The adopted row of a founder-signed settlement, named by kind and on-chain settlement id. */
export const adoptedFounderRowId = (kind: FounderKind, settlementId: Hex): string =>
  `${kind === 'OWNER_SPEND' ? ADOPT_OWNER_ID_PREFIX : ADOPT_RELEASE_ID_PREFIX}${settlementId.toLowerCase()}`;

export interface FounderRowFacts {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly intentId: string;
  /** The founder's signed message expiry (chain seconds); null when unknown. */
  readonly expiry: bigint | null;
  /** Adoption alert reason codes already on the row's trace. */
  readonly alerts: readonly string[];
}

export interface FounderAdoption {
  readonly kind: FounderKind;
  /** spendId (OWNER_SPEND) or the milestone settlementId (RELEASE_MILESTONE): the on-chain settlement id. */
  readonly intentId: Hex;
  /** The backend row the on-chain execution is checked against (the latest attempt, or the DROPPED one). */
  readonly sourceId: string;
  /** A DROPPED row still holds the intent (payments_facility_intent_id_unique): alert only, nothing can be adopted. */
  readonly held: boolean;
}

const RELEASED_STATES: ReadonlySet<string> = new Set(['POLICY_DENIED', 'REVERTED', 'CANCELLED']);
const isFounderKind = (kind: string): kind is FounderKind => kind === 'OWNER_SPEND' || kind === 'RELEASE_MILESTONE';

/** Every signature of the group expired more than ADOPTION_GRACE_S before `finalizedAt`: none can execute any more. */
const expiredLongAgo = (group: readonly FounderRowFacts[], finalizedAt: bigint): boolean =>
  group.every((r) => r.expiry !== null && r.expiry + ADOPTION_GRACE_S < finalizedAt);

/**
 * Pure: one on-chain lookup per (kind, intent) whose rows all ended without executing it, released (REVERTED behind a
 * copy that landed first, POLICY_DENIED by the relay, CANCELLED) or DROPPED (held). A row in any other state (in
 * flight, settling, settled, or an adopted row) covers the settlement; a final alert or long-expired signatures retire
 * the group (module doc). `rows` in creation order; `finalizedAt` is the finalized head's timestamp.
 */
export function founderAdoptions(rows: readonly FounderRowFacts[], finalizedAt: bigint): FounderAdoption[] {
  const groups = new Map<string, { kind: FounderKind; intentId: Hex; rows: FounderRowFacts[] }>();
  for (const r of rows) {
    if (!isFounderKind(r.kind)) continue;
    const intentId = r.intentId.toLowerCase() as Hex;
    const key = `${r.kind}:${intentId}`;
    const g = groups.get(key) ?? { kind: r.kind, intentId, rows: [] };
    groups.set(key, { ...g, rows: [...g.rows, r] });
  }
  const out: FounderAdoption[] = [];
  for (const g of groups.values()) {
    if (g.rows.some((r) => !RELEASED_STATES.has(r.state) && r.state !== 'DROPPED')) continue;
    if (expiredLongAgo(g.rows, finalizedAt)) continue;
    const held = g.rows.find((r) => r.state === 'DROPPED');
    const source = held ?? (g.rows[g.rows.length - 1] as FounderRowFacts);
    const retired = held ? source.alerts.includes(ADOPT_ALERT.HELD) : source.alerts.some((a) => FINAL_ALERTS.includes(a));
    if (retired) continue;
    out.push({ kind: g.kind, intentId: g.intentId, sourceId: source.id, held: held !== undefined });
  }
  return out;
}

interface FounderRow {
  id: string;
  kind: FounderKind;
  state: string;
  intent_id: string;
  line_key: string;
  line_id: string;
  payee_id: string;
  order_id: string | null;
  milestone_idx: number | null;
  amount_minor: string;
  invoice_hash: string;
  decision_id: string | null;
  rationale_hash: string | null;
  trace_id: string;
  expiry: string | null;
  alerts: string[];
}

/** The finalized execution of a founder-signed settlement, from its log. */
interface Execution {
  readonly txHash: Hex;
  readonly blockNumber: bigint;
  readonly amountMinor: bigint;
  /** OwnerSpent carries the plan version at execution; a release reads it from PlanRegistry at the block. */
  readonly planVersion: number | null;
}

/** Why a group ends without adoption: its alert kind and what the alert says. */
interface Stop {
  readonly alert: (typeof ADOPT_ALERT)[keyof typeof ADOPT_ALERT];
  readonly why: string;
}

const stop = (alert: Stop['alert'], why: string): Stop => ({ alert, why });

const usedAt = (d: JobDeps, intentId: Hex, blockNumber: bigint): Promise<boolean> =>
  treasuryReadOr(() => d.client.readContract({ address: d.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: 'isIntentUsed', args: [intentId], blockNumber }), false);

async function ownerSpentLog(d: JobDeps, src: FounderRow, spendId: Hex, block: bigint): Promise<Execution | Stop> {
  const address = d.deployment.contracts.Treasury.address;
  const [log] = await d.client.getLogs({ address, event: OWNER_SPENT, args: { spendId }, fromBlock: block, toBlock: block });
  const a = log?.args;
  if (!log || !a || a.amountMinor === undefined) return stop(ADOPT_ALERT.MISMATCH, 'the spend is used on-chain but its block has no OwnerSpent');
  const matches = same(a.lineId, src.line_id) && same(a.payeeId, bytes32OfShortId(src.payee_id)) && a.amountMinor === BigInt(src.amount_minor) && same(a.invoiceHash, src.invoice_hash);
  if (!matches) return stop(ADOPT_ALERT.MISMATCH, 'the finalized OwnerSpent is not the founder-signed row');
  return { txHash: log.transactionHash, blockNumber: log.blockNumber, amountMinor: a.amountMinor, planVersion: Number(a.planVersion) };
}

async function milestoneReleasedLog(d: JobDeps, src: FounderRow, settlementId: Hex, block: bigint): Promise<Execution | Stop> {
  const escrow = d.deployment.contracts.MilestoneEscrow?.address;
  const orderId = bytes32OfShortId(src.order_id);
  const idx = src.milestone_idx === null ? null : Number(src.milestone_idx);
  if (!escrow || orderId === null || idx === null) return stop(ADOPT_ALERT.MISMATCH, 'the row names no escrow milestone');
  const logs = await d.client.getLogs({ address: escrow, event: MILESTONE_RELEASED, args: { orderId, idx }, fromBlock: block, toBlock: block });
  const log = logs.find((l) => same(l.args.settlementId, settlementId));
  const a = log?.args;
  if (!log || !a || a.amountMinor === undefined) return stop(ADOPT_ALERT.MISMATCH, 'the milestone settlement is used on-chain but its block has no MilestoneReleased');
  if (!same(a.payeeId, bytes32OfShortId(src.payee_id)) || a.amountMinor !== BigInt(src.amount_minor)) return stop(ADOPT_ALERT.MISMATCH, 'the finalized MilestoneReleased is not the founder-signed row');
  return { txHash: log.transactionHash, blockNumber: log.blockNumber, amountMinor: a.amountMinor, planVersion: null };
}

/** A live row of the facility sent that tx itself (say an autoRelease inside its funding): it settles it already. */
async function ownTx(q: Pg, facilityId: string, txHash: Hex): Promise<boolean> {
  const found = await rows<{ x: number }>(
    q,
    `select 1 as x from payments where facility_id = $1 and (tx_hash = $2 or $2 = any(superseded_tx_hashes)) and state not in ('POLICY_DENIED', 'REVERTED', 'CANCELLED') limit 1`,
    [facilityId, txHash.toLowerCase()],
  );
  return found.length > 0;
}

/** One ALERT of `alert`'s kind on the founder row's trace (L5); true when this call wrote it. */
async function alertOnce(d: JobDeps, facilityId: string, src: FounderRow, alert: Stop['alert'], summary: string, refs: { paymentId?: string; txHash?: string } = {}): Promise<boolean> {
  const pool = poolOf(d.db);
  if (await hasTrace(pool, { facilityId, traceId: src.trace_id, reasonCode: alert })) return false;
  d.log.warn('founder_adoption_alert', { facilityId, paymentId: src.id, alert });
  await appendTrace(pool, { facilityId, traceId: src.trace_id, actor: 'oracle', kind: 'ALERT', reasonCode: alert, summary, refs: { paymentId: src.id, ...refs } }).catch((error: unknown) =>
    d.log.warn('trace_append_failed', { paymentId: src.id, error }),
  );
  return true;
}

/** The adopted row's id, or why it was not recorded (a conflicting row: retried next pass). */
type Recorded = { readonly id: string } | Stop | string;

async function insertAdopted(d: JobDeps, facilityId: string, c: FounderAdoption, src: FounderRow, exec: Execution): Promise<Recorded> {
  const tx = await rebuiltTx(d, exec.txHash);
  if (typeof tx === 'string') return stop(ADOPT_ALERT.MISMATCH, tx);
  const planVersion =
    exec.planVersion ?? Number(await d.client.readContract({ address: d.deployment.contracts.PlanRegistry.address, abi: iPlanRegistryAbi, functionName: 'planVersion', blockNumber: exec.blockNumber }));
  const id = adoptedFounderRowId(c.kind, c.intentId);
  const inserted = await poolOf(d.db).query(
    `insert into payments (id, facility_id, kind, intent_id, line_key, line_id, payee_id, order_id, milestone_idx, amount_minor, invoice_hash, plan_version, state,
       signer_address, chain_id, raw_signed_tx, nonce, tx_hash, block, settlement_id, decision_id, rationale_hash, trace_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'FINALIZED', $13, $14, $15, $16, $17, $18, $4, $19, $20, $21)
     on conflict do nothing`,
    [
      id,
      facilityId,
      c.kind,
      c.intentId,
      src.line_key,
      src.line_id,
      src.payee_id,
      src.order_id,
      src.milestone_idx,
      exec.amountMinor.toString(),
      src.invoice_hash,
      planVersion,
      tx.from,
      d.deployment.chainId,
      tx.raw,
      String(tx.nonce),
      exec.txHash.toLowerCase(),
      String(exec.blockNumber),
      c.kind === 'OWNER_SPEND' ? null : src.decision_id,
      c.kind === 'OWNER_SPEND' ? null : src.rationale_hash,
      traceIdOf(id),
    ],
  );
  return inserted.rowCount === 1 ? { id } : 'a conflicting payment row blocks recording the execution';
}

/** Steps 2-4 of the module doc for an execution found in its block. */
async function adoptExecution(d: JobDeps, facilityId: string, c: FounderAdoption, src: FounderRow, head: FinalizedHead, exec: Execution): Promise<Recorded> {
  const txHash = exec.txHash.toLowerCase();
  if (await ownTx(poolOf(d.db), facilityId, exec.txHash)) return stop(ADOPT_ALERT.OWN_TX, `the executing tx ${txHash} is one of our own live rows, which settles it`);
  if (c.held) return stop(ADOPT_ALERT.HELD, `another account executed it (tx ${txHash}) while the DROPPED row still holds the intent, so it is not adopted`);
  const state = await d.client.readContract({ address: d.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: 'settlementState', args: [c.intentId], blockNumber: head.number });
  if (Number(state) !== 0) return stop(ADOPT_ALERT.CLOSED, `another account executed it (tx ${txHash}), but the settlement is already confirmed or failed on-chain; not adopted`);
  return insertAdopted(d, facilityId, c, src, exec);
}

/** One candidate (module doc); null when done or nothing to report, else what to report this pass. */
async function adoptFounderOne(d: JobDeps, facilityId: string, c: FounderAdoption, src: FounderRow, head: FinalizedHead): Promise<string | null> {
  if (!(await usedAt(d, c.intentId, head.number))) return null;
  let block: bigint;
  try {
    block = await firstBlockWhere(d, head.number, (n) => usedAt(d, c.intentId, n));
  } catch (error: unknown) {
    // Historical state the RPC cannot serve (a non-archive node): one alert, then a quiet retry every pass.
    const why = `the RPC could not serve the historical state needed to find the execution (${shortErrorReason(error)})`;
    d.log.warn('founder_adoption_history_unavailable', { facilityId, paymentId: src.id, error: shortErrorReason(error) });
    return (await alertOnce(d, facilityId, src, ADOPT_ALERT.HISTORY, `${c.kind} ${src.id}: its founder-signed call was executed on-chain, but ${why}; retrying`)) ? why : null;
  }
  const exec = c.kind === 'OWNER_SPEND' ? await ownerSpentLog(d, src, c.intentId, block) : await milestoneReleasedLog(d, src, c.intentId, block);
  const result = 'txHash' in exec ? await adoptExecution(d, facilityId, c, src, head, exec) : exec;
  if (typeof result === 'string') return result;
  if ('alert' in result) return (await alertOnce(d, facilityId, src, result.alert, `${c.kind} ${src.id}: ${result.why}`)) ? result.why : null;
  const txHash = 'txHash' in exec ? exec.txHash.toLowerCase() : '';
  d.log.warn('founder_settlement_adopted', { facilityId, paymentId: result.id, sourceId: src.id, txHash });
  await alertOnce(d, facilityId, src, ADOPT_ALERT.ADOPTED, `${c.kind} ${src.id} ended ${src.state}, but another account executed its founder-signed call (tx ${txHash}): adopted as ${result.id}, settled once`, {
    paymentId: result.id,
    txHash,
  });
  return null;
}

const ALERT_CODES = Object.values(ADOPT_ALERT);
const UINT64_RE = /^(0|[1-9][0-9]{0,19})$/;

async function loadFounderRows(d: JobDeps, facilityId: string): Promise<FounderRow[]> {
  return rows<FounderRow>(
    poolOf(d.db),
    `select p.id, p.kind, p.state, p.intent_id, p.line_key, p.line_id, p.payee_id, p.order_id, p.milestone_idx, p.amount_minor::text as amount_minor,
            p.invoice_hash, p.decision_id::text as decision_id, p.rationale_hash, p.trace_id,
            (select s.typed_data_json->'message'->>'expiry' from signature_requests s where s.facility_id = p.facility_id and s.id = p.trace_id) as expiry,
            array(select t.reason_code from traces t where t.facility_id = p.facility_id and t.trace_id = p.trace_id and t.reason_code = any($2)) as alerts
       from payments p where p.facility_id = $1 and p.kind in ('OWNER_SPEND', 'RELEASE_MILESTONE') order by p.created_at, p.id`,
    [facilityId, ALERT_CODES],
  );
}

const factsOf = (r: FounderRow): FounderRowFacts => ({
  id: r.id,
  kind: r.kind,
  state: r.state,
  intentId: r.intent_id,
  expiry: r.expiry !== null && UINT64_RE.test(r.expiry) ? BigInt(r.expiry) : null,
  alerts: r.alerts,
});

/** Adopts every founder-signed settlement of the facility another account executed first. Never throws. */
export async function adoptFounderExecutions(d: JobDeps, facilityId: string): Promise<AdoptOutcome[]> {
  let all: FounderRow[];
  let candidates: FounderAdoption[];
  let head: FinalizedHead;
  try {
    all = await loadFounderRows(d, facilityId);
    if (all.length === 0) return [];
    head = await finalizedHead(d.client);
    candidates = founderAdoptions(all.map(factsOf), head.timestamp);
  } catch (error: unknown) {
    d.log.error('founder_adopt_failed', { facilityId, error });
    return [{ paymentId: 'adopt:-', step: 'error', detail: shortErrorReason(error) }];
  }
  const byId = new Map(all.map((r) => [r.id, r]));
  const out: AdoptOutcome[] = [];
  for (const c of candidates) {
    const src = byId.get(c.sourceId) as FounderRow;
    const paymentId = adoptedFounderRowId(c.kind, c.intentId);
    try {
      const why = await adoptFounderOne(d, facilityId, c, src, head);
      if (why) out.push({ paymentId, step: 'error', detail: why });
    } catch (error: unknown) {
      d.log.error('founder_adopt_failed', { facilityId, paymentId, error });
      out.push({ paymentId, step: 'error', detail: shortErrorReason(error) });
    }
  }
  return out;
}
