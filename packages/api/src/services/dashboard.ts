/**
 * §26.6 dashboard numbers (task 1.12): GET /api/balances and GET /api/stats/autonomy. Chain values come from ONE
 * snapshot block (services/snapshot.ts) so they are consistent with each other; every DB read filters by the
 * session's facility (server config, T31). Nothing here writes or signs.
 *
 * drift (§9.3 "drift: 0", T19): how many facts the DB mirror and the chain disagree on at the snapshot block.
 *   - the committed plan: the DB's COMMITTED plan (version, planHash) vs PlanRegistry.currentPlan (none on both: ok);
 *   - per line on chain: Treasury pocket.spentMinor vs this facility's mined SPEND / OWNER_SPEND rows on the line
 *     (block ≤ snapshot; SETTLEMENT_FAILED rows left out, failSettlement returned their amount to the pocket), and
 *     pocket.escrowedMinor vs its mined FUND_MILESTONE rows (a milestone release does not lower escrowedMinor);
 *   - a line the DB holds mined payments on that the chain does not have, or a chain line that is no LineKey.
 * An orphan spend (the key used outside the backend), a row the DB marked mined that never landed, or a plan the
 * worker has not synced yet each count once. Lag between a mined tx and the worker's next pass shows as drift until
 * that pass; drift that persists is a real mismatch.
 *
 * autonomy (§15 E6), facility rows only:
 *   - agentTxs: mined payments the agent decided by itself (AGENT_PAYMENT_KINDS: SPEND, FUND_MILESTONE) plus mined
 *     agent-signed chain actions (Treasury.recordDenied denial anchors, Treasury.tighten). A founder-signed payment
 *     the relayer only carries (RELEASE_MILESTONE, OWNER_SPEND) is the founder's signature in humanSigs, never also an AI
 *     payment (W-4);
 *   - humanSigs: consumed founder signatures (signature_requests SUBMITTED) plus actions an officer approved and the
 *     lender key carries (open, fund, founder-key approval, loosen co-signature, stage release, veto), unless reverted;
 *   - autoPct / escalatedPct: per decision trace (events carrying a policy verdict), escalated if any verdict was
 *     NEEDS_FOUNDER / NEEDS_OFFICER, else auto if one was AUTO; shares of auto + escalated (DENY is neither), 0.1 %;
 *   - startedAt: when the agent's mandate began, the founder's signature on the first committed plan (now when no plan
 *     is committed yet); hours: since then, 0.01 h.
 */
import { LineKey, type AutonomyStats, type Balances, type PaymentKind, type Pocket } from "@hogee/core";
import type { ApiDeps, Scope } from "../context";
import { fail } from "../http/problem";
import { committedPlanRow, type PlanRow } from "./plans";
import { readSnapshot, shortIdFromBytes32, type LineView, type Snapshot } from "./snapshot";
import { one, pool, rows, type Q } from "./sql";
import { NOT_EVAL_TRACE } from "./traces";

/** Payment states with a recorded receipt (apps/worker MINED_STATES). */
const MINED_STATES = ["INCLUDED", "FINALIZED", "SETTLEMENT_REQUESTED", "SETTLED", "SETTLEMENT_FAILED"] as const;
/**
 * Payment kinds the agent decides by itself (W-4): its spends (pacing, invoices, API proposals, an escalation an officer
 * approved) and escrow funding. RELEASE_MILESTONE and OWNER_SPEND are founder-signed (the relayer key has no authority
 * of its own) and count once, as the founder's signature; WITHDRAW_RESERVE carries no agent decision.
 */
export const AGENT_PAYMENT_KINDS = ["SPEND", "FUND_MILESTONE"] as const satisfies readonly PaymentKind[];
/** Chain actions the agent key signs on its own (denial anchors). */
const AGENT_ACTION_KINDS = ["Treasury.recordDenied", "Treasury.tighten"] as const;
/** Chain actions that carry an officer's approval through the lender key. */
const OFFICER_ACTION_KINDS = [
  "Treasury.openFacility",
  "Treasury.fund",
  "PlanRegistry.registerFounderKey",
  "Treasury.queueLoosen",
  "Treasury.releaseStage",
  "Treasury.cancelLoosen",
] as const;
const MS_PER_HOUR = 3_600_000;

async function snapshotOf(deps: ApiDeps): Promise<Snapshot> {
  try {
    return await readSnapshot(deps);
  } catch (error: unknown) {
    deps.log.warn("snapshot_failed", { error });
    throw fail("UPSTREAM", "The chain node could not be read; try again shortly");
  }
}

const lineKeyOf = (lineId: string): LineKey | null => {
  const parsed = LineKey.safeParse(shortIdFromBytes32(lineId as `0x${string}`));
  return parsed.success ? parsed.data : null;
};

function pocketOf(v: LineView, lineKey: LineKey): Pocket {
  const p = v.pocket;
  return {
    lineKey,
    allocated: p.allocatedMinor.toString(),
    spent: p.spentMinor.toString(),
    available: p.availableMinor.toString(),
    perTxCap: p.perTxCapMinor.toString(),
    windowCap: p.windowCapMinor.toString(),
    windowSpent: p.windowSpentMinor.toString(),
    validUntil: p.validUntil.toString(),
    paused: p.paused,
    circuitOpen: p.circuitOpen,
  };
}

interface LineSums {
  line_id: string;
  spent: string;
  escrowed: string;
}

/** This facility's mined outflow per lineId at or below `block`. */
async function minedByLine(q: Q, scope: Scope, block: bigint): Promise<ReadonlyMap<string, LineSums>> {
  const sums = await rows<LineSums>(
    q,
    `select line_id,
            coalesce(sum(amount_minor) filter (where kind in ('SPEND', 'OWNER_SPEND') and state <> 'SETTLEMENT_FAILED'), 0)::text as spent,
            coalesce(sum(amount_minor) filter (where kind = 'FUND_MILESTONE'), 0)::text as escrowed
       from payments
      where facility_id = $1 and line_id is not null and state::text = any($2::text[]) and block is not null and block <= $3
      group by line_id`,
    [scope.facilityId, MINED_STATES, block.toString()],
  );
  return new Map(sums.map((s) => [s.line_id.toLowerCase(), s]));
}

function planDrift(plan: PlanRow | undefined, s: Snapshot): number {
  const chainHasPlan = s.planVersion > 0;
  if (!plan) return chainHasPlan ? 1 : 0;
  const same = chainHasPlan && Number(plan.version) === s.planVersion && plan.plan_hash.toLowerCase() === s.plan.planHash.toLowerCase();
  return same ? 0 : 1;
}

/** Mismatches between this facility's DB mirror and the chain at the snapshot block (see the header). */
export async function mirrorDrift(deps: ApiDeps, scope: Scope, s: Snapshot): Promise<number> {
  const q = pool(deps.db);
  const [plan, sums] = await Promise.all([committedPlanRow(q, scope), minedByLine(q, scope, s.blockNumber)]);
  let drift = planDrift(plan, s);
  const onChain = new Set<string>();
  for (const line of s.lines) {
    const id = line.lineId.toLowerCase();
    onChain.add(id);
    if (lineKeyOf(id) === null) drift += 1;
    const db = sums.get(id);
    if (BigInt(db?.spent ?? "0") !== line.pocket.spentMinor) drift += 1;
    if (BigInt(db?.escrowed ?? "0") !== line.pocket.escrowedMinor) drift += 1;
  }
  for (const [id, sum] of sums) {
    if (!onChain.has(id) && (sum.spent !== "0" || sum.escrowed !== "0")) drift += 1;
  }
  return drift;
}

export async function balances(deps: ApiDeps, scope: Scope): Promise<Balances> {
  const s = await snapshotOf(deps);
  const pockets = s.lines.flatMap((v) => {
    const key = lineKeyOf(v.lineId);
    return key === null ? [] : [pocketOf(v, key)];
  });
  return {
    fundedMinor: s.balances.fundedMinor.toString(),
    releasedMinor: s.balances.releasedMinor.toString(),
    revenueMinor: s.balances.revenueMinor.toString(),
    reserveMinor: s.balances.reserveMinor.toString(),
    escrowMinor: s.balances.escrowedMinor.toString(),
    pockets,
    agent: { address: s.plan.agent.toLowerCase(), expiresAt: s.agentExpiry.toString(), revoked: s.plan.agentRevoked },
    paused: s.paused,
    drift: await mirrorDrift(deps, scope, s),
  };
}

interface AutonomyRow {
  agent_txs: string;
  human_sigs: string;
  auto: string;
  escalated: string;
  started_at: Date | null;
}

export async function autonomyCounts(q: Q, scope: Scope): Promise<AutonomyRow> {
  const row = await one<AutonomyRow>(
    q,
    `with decisions as (
       select bool_or(policy_verdict in ('NEEDS_FOUNDER', 'NEEDS_OFFICER')) as escalated, bool_or(policy_verdict = 'AUTO') as auto
         from traces where facility_id = $1 and policy_verdict is not null and ${NOT_EVAL_TRACE} group by trace_id)
     select
       (select count(*) from payments where facility_id = $1 and kind::text = any($5::text[]) and decision_id is not null and state::text = any($2::text[]))
         + (select count(*) from chain_actions where facility_id = $1 and kind = any($3::text[]) and state in ('INCLUDED', 'FINALIZED')) as agent_txs,
       (select count(*) from signature_requests where facility_id = $1 and status = 'SUBMITTED')
         + (select count(*) from chain_actions where facility_id = $1 and kind = any($4::text[]) and state <> 'REVERTED') as human_sigs,
       (select count(*) from decisions where auto and not escalated) as auto,
       (select count(*) from decisions where escalated) as escalated,
       (select min(coalesce(signed_at, created_at)) from plans where facility_id = $1 and status in ('COMMITTED', 'SUPERSEDED')) as started_at`,
    [scope.facilityId, MINED_STATES, AGENT_ACTION_KINDS, OFFICER_ACTION_KINDS, AGENT_PAYMENT_KINDS],
  );
  if (!row) throw fail("UPSTREAM", "The autonomy counters could not be read");
  return row;
}

const share = (part: number, whole: number): number => (whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10);

export async function autonomyStats(deps: ApiDeps, scope: Scope): Promise<AutonomyStats> {
  const s = await snapshotOf(deps);
  const [c, drift] = await Promise.all([autonomyCounts(pool(deps.db), scope), mirrorDrift(deps, scope, s)]);
  const now = deps.clock();
  const started = c.started_at ? new Date(c.started_at).getTime() : now;
  const auto = Number(c.auto);
  const escalated = Number(c.escalated);
  return {
    agentTxs: Number(c.agent_txs),
    humanSigs: Number(c.human_sigs),
    autoPct: share(auto, auto + escalated),
    escalatedPct: share(escalated, auto + escalated),
    startedAt: new Date(started).toISOString(),
    hours: Math.max(0, Math.round(((now - started) / MS_PER_HOUR) * 100) / 100),
    drift,
  };
}
