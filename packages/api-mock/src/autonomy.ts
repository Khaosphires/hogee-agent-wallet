/**
 * GET /api/stats/autonomy counted from the store's own records, the way the live API counts its rows (packages/api
 * services/dashboard.ts), so the numbers add up with the payments and the activity record:
 *   - agentTxs: mined payments the agent decided by itself (SPEND, FUND_MILESTONE; isAgentPayment). The founder's
 *     MilestoneRelease (RELEASE_MILESTONE) and OwnerSpend (OWNER_SPEND) count once, as the founder's signature in humanSigs (W-4);
 *   - humanSigs: signatures (founder or loan officer) plus the officer's own chain actions (fund, open, key approval);
 *   - autoPct / escalatedPct: per decision trace (events with a policy verdict), escalated if any verdict was
 *     NEEDS_FOUNDER / NEEDS_OFFICER, else auto if one was AUTO; shares of auto + escalated (DENY is neither), 0.1 %;
 *   - startedAt: the first committed plan (`startedAtMs`); hours: since then, 0.01 h.
 * The sample business serves these; the other scenarios keep their seeded stats, and their agentTxs grows by the same
 * rule (transitions.ts createScriptedPayment).
 */
import type { AutonomyStats, Payment, PaymentKind, PaymentState } from "@hogee/core";
import { nowIso, type MockState } from "./store";

/** As live AGENT_PAYMENT_KINDS (packages/api services/dashboard.ts): the payment kinds the agent decides by itself. */
const AGENT_PAYMENT_KINDS: ReadonlySet<PaymentKind> = new Set(["SPEND", "FUND_MILESTONE"]);

/** An AI payment: one the agent decided by itself, never a founder-signed one the relayer only carries (W-4). */
export const isAgentPayment = (p: Pick<Payment, "kind" | "decisionId">): boolean => AGENT_PAYMENT_KINDS.has(p.kind) && p.decisionId !== null;

const MINED: ReadonlySet<PaymentState> = new Set(["INCLUDED", "FINALIZED", "SETTLEMENT_REQUESTED", "SETTLED", "SETTLEMENT_FAILED"]);
const MS_PER_HOUR = 3_600_000;

const share = (part: number, whole: number): number => (whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10);

export function autonomyOf(st: MockState, startedAtMs: number, nowMs: number): AutonomyStats {
  const agentTxs = st.payments.filter((sp) => isAgentPayment(sp.payment) && MINED.has(sp.payment.state)).length;
  const humanSigs = st.traces.filter((t) => t.kind === "SIGNATURE" || (t.actor === "officer" && t.kind === "TX")).length;
  const verdicts = new Map<string, { auto: boolean; escalated: boolean }>();
  for (const t of st.traces) {
    if (!t.verdict) continue;
    const d = verdicts.get(t.traceId) ?? { auto: false, escalated: false };
    verdicts.set(t.traceId, { auto: d.auto || t.verdict === "AUTO", escalated: d.escalated || t.verdict === "NEEDS_FOUNDER" || t.verdict === "NEEDS_OFFICER" });
  }
  const decisions = [...verdicts.values()];
  const escalated = decisions.filter((d) => d.escalated).length;
  const auto = decisions.filter((d) => d.auto && !d.escalated).length;
  return {
    agentTxs,
    humanSigs,
    autoPct: share(auto, auto + escalated),
    escalatedPct: share(escalated, auto + escalated),
    startedAt: nowIso(startedAtMs),
    hours: Math.max(0, Math.round(((nowMs - startedAtMs) / MS_PER_HOUR) * 100) / 100),
    drift: st.balances.drift,
  };
}
