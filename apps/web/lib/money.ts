/**
 * The founder's money figures, one source per number (UX-PLAN D8, §4 "one number per idea"):
 *
 *   - **Ready to spend** = core walletFigures(GET /api/balances).freeMinor: every pocket's available BU, capped by the
 *     released budget and the funding minus what already left (spend and escrow funding revert CapExceeded past
 *     either). The chat's wallet rail, the Next step bar, the Money page tile and the chat's money card all read it
 *     through `useReadyToSpend()`, so they can never disagree. The CFO report's cashAvailable follows the same rule
 *     (core cfo/report.ts cashAvailableOf); the screens show this one.
 *   - Paid out, sales, kept for tax and profit come from the CFO report only (GET /api/cfo).
 *
 * Nothing here polls on its own: it reads the shared balances query (lib/api/queries.ts, fix-cfo-load's policy).
 */
import { walletFigures, type Balances, type Minor, type PlanStage } from "@hogee/core";
import { useBalances } from "./api/queries";
import { queryView, type QueryView } from "./api/query-policy";

/** Ready to spend from one balances answer (pure; the hook below and the tests use it). */
export function readyToSpendOf(b: Pick<Balances, "pockets" | "escrowMinor" | "releasedMinor" | "fundedMinor">): Minor {
  return walletFigures({
    planTotalMinor: null,
    pockets: b.pockets,
    escrowMinor: b.escrowMinor,
    // freeMinor never depends on the supplier's paid-out part; only spent / held do.
    supplierPaidMinor: null,
    releasedMinor: b.releasedMinor,
    fundedMinor: b.fundedMinor,
  }).freeMinor;
}

/**
 * Ready to spend, as a query view: `data` (with `refreshFailed` for a quiet note when a refresh failed and the last
 * figure is still shown), `loading`, or `error` when there was never a figure. Never a guessed zero.
 */
export function useReadyToSpend(): QueryView<Minor> {
  const view = queryView(useBalances());
  return view.kind === "data" ? { kind: "data", data: readyToSpendOf(view.data), refreshFailed: view.refreshFailed } : view;
}

/** The next budget release that waits on a sales goal: how much opens, the goal, and its deadline (unix seconds). */
export interface NextRelease {
  readonly releaseMinor: Minor;
  readonly targetMinor: string;
  readonly deadline: string;
}

/**
 * The first plan stage not released yet (by the chain's released total), when it opens on a sales goal in BU. Null when
 * every stage is released, or the next one opens on something else (an order count has no BU goal to state).
 */
export function nextRelease(stages: readonly Pick<PlanStage, "releaseMinor" | "gate">[], releasedMinor: string): NextRelease | null {
  const released = BigInt(releasedMinor);
  let cumulative = 0n;
  for (const s of stages) {
    cumulative += BigInt(s.releaseMinor);
    if (cumulative <= released) continue;
    if (!s.gate || s.gate.metric !== "salesMinor" || s.gate.deadline === "0") return null;
    return { releaseMinor: s.releaseMinor, targetMinor: s.gate.target, deadline: s.gate.deadline };
  }
  return null;
}
