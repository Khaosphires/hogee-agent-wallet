/**
 * The AI CFO report (VISION-DECISIONS §8 core-cfo, §5 GET /api/cfo): the facility's own records into core
 * buildCfoReport. Cash basis; nothing invented. Everything comes from ONE chain snapshot block B and the facility's DB
 * mirror of what landed at or below B:
 *
 *   - lines: Treasury pockets at B (current caps after any tightening, pacingMinor, windowSeconds); releasedMinor /
 *     fundedMinor from Treasury.balances at B (they cap the cash the agent can still move);
 *   - payments: this facility's mined rows (block ≤ B), dated by their block's timestamp (chain time, so an Anvil time
 *     warp moves them with the chain). A FUND_MILESTONE on an autoRelease milestone the escrow has paid counts as
 *     supplier cost (core `autoReleased`); any other funding is escrowed, not cost;
 *   - sales: recorded sales only (sales.tx_hash set by the worker's sync after SalesOracle.isSaleRecorded, and the
 *     landed recordSale action's block ≤ B), dated by that block;
 *   - reserve: Treasury.revenueLedger() at B (skimmed, withdrawn), the LIVE rate (currentPlan().reserveBps, which the
 *     agent's RAISE_RESERVE_BPS moves) and the committed plan's rate (manifest.reserveBps);
 *   - stage: the first unreleased stage (chain at B) of the committed plan, when its gate is a salesMinor gate with a
 *     deadline (an orders gate counts sales, not BU, so the BU projection does not apply);
 *   - agentActions: the cfo-guard's own landed Treasury.tighten actions (worker jobs/cfo-guard.ts writes their
 *     request_json), dated by their block;
 *   - now: B's timestamp (the policy clock).
 *
 * Fail closed: a chain or DB read error answers UPSTREAM (502); records core refuses (CfoInputError) answer UPSTREAM
 * too, never a partial report. A stored tighten request that does not parse is dropped and logged, never shown.
 *
 * Bounded (fixr-cfo, re-check LOW 4): records are dated through ./cfo-dating.ts (the last 30 chain days exactly, older
 * records by a lower bound that leaves the report unchanged, through an LRU), and one report per (deployment,
 * facility, snapshot block hash) is computed at a time and kept 15 s (./cfo-cache.ts). The route limits the rate.
 *
 * A lagging backend (fix-cfo-load): every chain read pinned to B (the snapshot, the revenue ledger, each block date) is
 * retried once when the node answers that it has not seen the block yet (./block-lag.ts); a second failure still fails
 * closed.
 */
import {
  buildCfoReport,
  CfoInputError,
  LineKey,
  PlanManifest,
  toCfoReportJson,
  type CfoAgentAction,
  type CfoInputs,
  type CfoLineIn,
  type CfoPaymentIn,
  type CfoReport,
  type CfoSaleIn,
  type CurrencyCode,
  type Hex32,
  type Id,
  type PaymentKind,
  type PaymentState,
  type PayeeId,
  type StageId,
} from "@hogee/core";
import { TIGHTEN_ACTIONS } from "@hogee/core";
import { z } from "zod";
import { taxPayeeFor } from "../catalog/payees";
import type { ApiDeps, Scope } from "../context";
import { fail } from "../http/problem";
import { retryOnBlockLag, type BlockLagOptions } from "./block-lag";
import { ReportCache } from "./cfo-cache";
import { BlockTimeCache, dateRecords, type BlockClient } from "./cfo-dating";
import { committedPlanRow } from "./plans";
import { readRevenueLedger, type RevenueLedger } from "./revenue-ledger";
import { lagRetry, readSnapshot, shortIdFromBytes32, type Snapshot } from "./snapshot";
import { pool, rows, type Q } from "./sql";

/** Payment states with a receipt that core counts (it leaves SETTLEMENT_FAILED out itself). */
const MINED_STATES = ["INCLUDED", "FINALIZED", "SETTLEMENT_REQUESTED", "SETTLED", "SETTLEMENT_FAILED"] as const;
const LANDED_ACTION_STATES = ["INCLUDED", "FINALIZED"] as const;
/** The cfo-guard job's chain action ids (worker jobs/cfo-guard.ts CFO_GUARD_ACTION_PREFIX). */
export const CFO_GUARD_ACTION_PREFIX = "cfo-guard:";
/** At most this many agent actions are read (core shows the 10 newest). */
const ACTIONS_READ = 50;

// ---- Records (what the chain and the DB mirror hold) ----------------------------------------------------------------
export interface PaymentRecord {
  readonly kind: PaymentKind;
  readonly lineKey: LineKey | null;
  readonly amountMinor: string;
  readonly state: PaymentState;
  readonly block: bigint;
  readonly txHash: Hex32 | null;
  readonly autoReleased: boolean;
}

export interface SaleRecord {
  readonly saleId: Id;
  readonly amountMinor: string;
  readonly block: bigint;
  readonly txHash: Hex32 | null;
}

export interface ActionRecord {
  readonly id: string;
  readonly request: unknown;
  readonly block: bigint;
  readonly txHash: Hex32 | null;
}

export interface CfoRecords {
  readonly currency: CurrencyCode;
  readonly facilityId: Id;
  readonly snapshot: Pick<Snapshot, "timestamp" | "plan" | "balances" | "lines" | "stages">;
  readonly ledger: RevenueLedger;
  /** The committed plan's manifest, null before the first commit. */
  readonly committed: PlanManifest | null;
  readonly taxPayeeId: PayeeId;
  readonly payments: readonly PaymentRecord[];
  readonly sales: readonly SaleRecord[];
  readonly actions: readonly ActionRecord[];
  /** Block number (decimal) → its timestamp (unix seconds). Every record's block must be in it. */
  readonly blockTimes: ReadonlyMap<string, bigint>;
}

/**
 * The request_json the cfo-guard job stores on its Treasury.tighten action (worker jobs/cfo-guard.ts, same shape).
 * Built from the facility's own records by core proposeTightenings, never from model text.
 */
export const CfoGuardRequest = z.object({
  source: z.literal("cfo-guard"),
  action: z.enum(TIGHTEN_ACTIONS),
  lineKey: LineKey.nullable(),
  newValue: z.string().regex(/^(0|[1-9][0-9]{0,38})$/),
  reason: z.string().min(1).max(200),
});

// ---- Pure mapping ----------------------------------------------------------------------------------------------------
function dateOfBlock(r: CfoRecords, block: bigint): Date {
  const t = r.blockTimes.get(block.toString());
  if (t === undefined) throw new CfoInputError(`no timestamp for block ${block}`);
  return new Date(Number(t) * 1000);
}

const lineKeyOf = (lineId: string): LineKey | null => {
  const parsed = LineKey.safeParse(shortIdFromBytes32(lineId as `0x${string}`));
  return parsed.success ? parsed.data : null;
};

/** The pockets at B, with the committed plan's caps for each line (core links a raise back to them). */
function linesOf(s: CfoRecords["snapshot"], committed: PlanManifest | null): CfoLineIn[] {
  const plan = new Map((committed?.lines ?? []).map((l) => [l.lineKey, l]));
  return s.lines.flatMap((v) => {
    const lineKey = lineKeyOf(v.lineId);
    if (lineKey === null) return [];
    const p = v.pocket;
    const c = plan.get(lineKey);
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
        ...(c ? { committedPerTxCapMinor: BigInt(c.perTxCapMinor), committedWindowCapMinor: BigInt(c.windowCapMinor) } : {}),
      },
    ];
  });
}

/** The next gated stage the BU projection applies to (see the header), or null. */
function stageFrom(committed: PlanManifest | null, stages: CfoRecords["snapshot"]["stages"]): CfoInputs["stage"] {
  if (!committed) return null;
  const released = new Map(stages.map((st) => [shortIdFromBytes32(st.stageId as `0x${string}`), st.released]));
  const next = committed.stages.find((st) => released.get(st.stageId) === false);
  const gate = next?.gate;
  if (!next || !gate || gate.metric !== "salesMinor" || gate.deadline === "0") return null;
  return { stageId: next.stageId as StageId, targetMinor: BigInt(gate.target), deadline: new Date(Number(gate.deadline) * 1000) };
}

/** Landed cfo-guard tightenings; a row whose request does not parse is returned in `dropped`, never shown. */
export function agentActionsOf(r: CfoRecords): { actions: CfoAgentAction[]; dropped: string[] } {
  const actions: CfoAgentAction[] = [];
  const dropped: string[] = [];
  for (const a of r.actions) {
    const req = CfoGuardRequest.safeParse(a.request);
    if (!req.success) {
      dropped.push(a.id);
      continue;
    }
    const { action, lineKey, newValue, reason } = req.data;
    actions.push({ at: dateOfBlock(r, a.block).toISOString(), action, lineKey, newValue, reason, txHash: a.txHash });
  }
  return { actions, dropped };
}

/** CfoInputs from the records (pure). Throws CfoInputError when a record has no block timestamp. */
export function cfoInputsOf(r: CfoRecords, agentActions: readonly CfoAgentAction[]): CfoInputs {
  const payments: CfoPaymentIn[] = r.payments.map((p) => ({
    kind: p.kind,
    lineKey: p.lineKey,
    amountMinor: BigInt(p.amountMinor),
    state: p.state,
    at: dateOfBlock(r, p.block),
    txHash: p.txHash,
    ...(p.kind === "FUND_MILESTONE" ? { autoReleased: p.autoReleased } : {}),
  }));
  const sales: CfoSaleIn[] = r.sales.map((s) => ({ saleId: s.saleId, amountMinor: BigInt(s.amountMinor), at: dateOfBlock(r, s.block), txHash: s.txHash }));
  const s = r.snapshot;
  return {
    currency: r.currency,
    now: new Date(Number(s.timestamp) * 1000),
    facilityId: r.facilityId,
    lines: linesOf(s, r.committed),
    payments,
    sales,
    reserve: { rateBps: s.plan.reserveBps, skimmedMinor: r.ledger.reserveSkimmedMinor, withdrawnMinor: r.ledger.reserveWithdrawnMinor, taxPayeeId: r.taxPayeeId },
    stage: stageFrom(r.committed, r.snapshot.stages),
    reserveBps: r.committed?.reserveBps ?? s.plan.reserveBps,
    agentActions,
    releasedMinor: s.balances.releasedMinor,
    fundedMinor: s.balances.fundedMinor,
  };
}

// ---- Reads ---------------------------------------------------------------------------------------------------------
interface PaymentDbRow {
  kind: PaymentKind;
  line_key: LineKey | null;
  amount_minor: string;
  state: PaymentState;
  block: string;
  tx_hash: string | null;
  auto_released: boolean;
}

async function readPayments(q: Q, scope: Scope, block: bigint): Promise<PaymentRecord[]> {
  const out = await rows<PaymentDbRow>(
    q,
    `select p.kind, p.line_key, p.amount_minor::text as amount_minor, p.state, p.block::text as block, p.tx_hash,
            (p.kind = 'FUND_MILESTONE' and exists (
               select 1 from escrow_milestones m
                where m.facility_id = p.facility_id and m.order_id = p.order_id and m.idx = p.milestone_idx and m.auto_release
                  and (m.released_minor > 0 or m.funded_minor >= m.amount_minor))) as auto_released
       from payments p
      where p.facility_id = $1 and p.state::text = any($2::text[]) and p.block is not null and p.block <= $3
      order by p.block, p.id`,
    [scope.facilityId, MINED_STATES, block.toString()],
  );
  return out.map((p) => ({
    kind: p.kind,
    lineKey: p.line_key,
    amountMinor: p.amount_minor,
    state: p.state,
    block: BigInt(p.block),
    txHash: (p.tx_hash as Hex32 | null) ?? null,
    autoReleased: p.auto_released,
  }));
}

async function readSales(q: Q, scope: Scope, block: bigint): Promise<SaleRecord[]> {
  const out = await rows<{ id: string; amount_bucket: string; tx_hash: string | null; block: string }>(
    q,
    `select s.id, s.amount_bucket::text as amount_bucket, s.tx_hash, a.block::text as block
       from sales s
       cross join lateral (
         select block from chain_actions a
          where a.facility_id = s.facility_id and a.kind = 'SalesOracle.recordSale' and a.ref_id = s.id
            and a.state::text = any($2::text[]) and a.block is not null
          order by a.block limit 1) a
      where s.facility_id = $1 and s.tx_hash is not null and s.amount_bucket > 0 and a.block <= $3
      order by a.block, s.id`,
    [scope.facilityId, LANDED_ACTION_STATES, block.toString()],
  );
  return out.map((s) => ({ saleId: s.id as Id, amountMinor: s.amount_bucket, block: BigInt(s.block), txHash: (s.tx_hash as Hex32 | null) ?? null }));
}

async function readActions(q: Q, scope: Scope, block: bigint): Promise<ActionRecord[]> {
  const out = await rows<{ id: string; request_json: unknown; block: string; tx_hash: string | null }>(
    q,
    `select id, request_json, block::text as block, tx_hash from chain_actions
      where facility_id = $1 and kind = 'Treasury.tighten' and id like $2 and state::text = any($3::text[])
        and block is not null and block <= $4
      order by block desc, id limit ${ACTIONS_READ}`,
    [scope.facilityId, `${CFO_GUARD_ACTION_PREFIX}%`, LANDED_ACTION_STATES, block.toString()],
  );
  return out.map((a) => ({ id: a.id, request: a.request_json, block: BigInt(a.block), txHash: (a.tx_hash as Hex32 | null) ?? null }));
}

/** This process's block timestamps (one chain at a time: the cache re-scopes itself by genesis hash). */
const SHARED_BLOCK_TIMES = new BlockTimeCache();
/** This process's finished reports (per deployment, facility and snapshot block). */
const SHARED_REPORTS = new ReportCache<CfoReport>();

/**
 * Every record the report reads, at one snapshot block (`blockNumber`, default the head). Throws on any read error
 * (the caller answers UPSTREAM); a block-lag error is retried once per read first (see the header).
 */
export async function readCfoRecords(
  deps: ApiDeps,
  scope: Scope,
  blockNumber?: bigint,
  cache: BlockTimeCache = SHARED_BLOCK_TIMES,
  lag: BlockLagOptions = {},
): Promise<CfoRecords> {
  const s = await readSnapshot(deps, blockNumber, lag);
  const retry = lagRetry(deps, s.blockNumber, lag);
  const blocks: BlockClient = { getBlock: (args) => retryOnBlockLag(() => deps.client.getBlock(args), retry) };
  const q = pool(deps.db);
  const [ledger, plan, payments, sales, actions] = await Promise.all([
    retryOnBlockLag(() => readRevenueLedger(deps, s.blockNumber), retry),
    committedPlanRow(q, scope),
    readPayments(q, scope, s.blockNumber),
    readSales(q, scope, s.blockNumber),
    readActions(q, scope, s.blockNumber),
  ]);
  const committed = plan ? PlanManifest.parse(plan.manifest_json) : null;
  const stageTargetMinor = stageFrom(committed, s.stages)?.targetMinor ?? null;
  const { times } = await dateRecords(blocks, cache, { payments, sales, actions, timestamp: s.timestamp, stageTargetMinor });
  return {
    currency: deps.config.currency,
    facilityId: scope.facilityId as Id,
    snapshot: s,
    ledger,
    committed,
    taxPayeeId: taxPayeeFor(deps.config.countryCode).payeeId as PayeeId,
    payments,
    sales,
    actions,
    blockTimes: times,
  };
}

/** The schema's in-app path (core schemas/cfo.ts AppHref): a single leading slash, an optional #fragment, no scheme. */
const APP_PATH = /^\/(?!\/)[A-Za-z0-9/_.?=&%-]*(#[A-Za-z0-9_-]+)?$/;

/**
 * An insight link as the wire schema accepts it. Core links the change requests as "/dashboard#change-requests",
 * which the schema's in-app path refuses (no "#"), and a refused link would 502 the whole report. The fragment is
 * dropped (the page still lands on /dashboard, where the change requests are); anything else unusable becomes null.
 */
export function wireHref(href: string | null): string | null {
  if (href === null || APP_PATH.test(href)) return href;
  const path = href.split("#", 1)[0] ?? "";
  return APP_PATH.test(path) ? path : null;
}

/** The report from the records (pure): core buildCfoReport, then the §3 wire shape. */
export function reportOf(records: CfoRecords, agentActions: readonly CfoAgentAction[]): CfoReport {
  const json = toCfoReportJson(buildCfoReport(cfoInputsOf(records, agentActions)));
  return {
    ...json,
    insights: json.insights.map((i) => (i.suggestion ? { ...i, suggestion: { ...i.suggestion, href: wireHref(i.suggestion.href) } } : i)),
  } as CfoReport;
}

export interface CfoReportOptions {
  /** Finished reports (default: this process's). */
  readonly reports?: ReportCache<CfoReport>;
  /** Block timestamps (default: this process's). */
  readonly blockTimes?: BlockTimeCache;
  /** The block-lag retry (default: one retry after BLOCK_LAG_RETRY_MS). */
  readonly lag?: BlockLagOptions;
}

const upstream = (deps: ApiDeps, error: unknown) => {
  deps.log.warn("cfo_records_failed", { error });
  return fail("UPSTREAM", "The CFO could not read the chain and the records; try again shortly");
};

/** The report at the head block: shared with concurrent requests and kept 15 s for that block (./cfo-cache.ts). */
export async function cfoReport(deps: ApiDeps, scope: Scope, o: CfoReportOptions = {}): Promise<CfoReport> {
  let head: { readonly number: bigint; readonly hash: string };
  try {
    const b = await deps.client.getBlock({ blockTag: "latest" });
    if (b.number === null || b.hash === null) throw new Error("the head block has no number or hash");
    head = { number: b.number, hash: b.hash };
  } catch (error: unknown) {
    throw upstream(deps, error);
  }
  const key = `${deps.deployment.contracts.Treasury.address.toLowerCase()}:${scope.facilityId}:${head.hash.toLowerCase()}`;
  return (o.reports ?? SHARED_REPORTS).get(key, deps.clock(), () => computeReport(deps, scope, head.number, o));
}

async function computeReport(deps: ApiDeps, scope: Scope, block: bigint, o: CfoReportOptions): Promise<CfoReport> {
  let records: CfoRecords;
  try {
    records = await readCfoRecords(deps, scope, block, o.blockTimes, o.lag);
  } catch (error: unknown) {
    throw upstream(deps, error);
  }
  const { actions, dropped } = agentActionsOf(records);
  if (dropped.length > 0) deps.log.warn("cfo_agent_action_dropped", { actionIds: dropped });
  if (BigInt(records.sales.length) !== records.ledger.salesCount) {
    // The worker's sync mirrors a landed sale on its next pass; until then the report lags the chain by that sale.
    deps.log.info("cfo_sales_mirror_lag", { mirrored: records.sales.length, onChain: records.ledger.salesCount.toString() });
  }
  try {
    return reportOf(records, actions);
  } catch (error: unknown) {
    if (!(error instanceof CfoInputError)) throw error;
    deps.log.warn("cfo_inputs_refused", { reason: error.message });
    throw fail("UPSTREAM", "The records the CFO reads are not consistent; nothing is shown rather than a wrong number");
  }
}
