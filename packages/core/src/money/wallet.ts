/**
 * What the founder's wallet shows (the chat rail and the CFO page's tiles), the same in live and mock, from the
 * chain's raw numbers (GET /api/balances, kept raw for the reconciler's drift check).
 *
 * On chain a released escrow milestone stays in `escrowedMinor` and never enters a pocket's `spentMinor`:
 * MilestoneEscrow pays it through Treasury.escrowRelease, which only counts the payee's paid amount. So:
 *   - left = plan total − Σ pocket.spent − escrowMinor: BU committed to escrow are no longer the plan's to spend;
 *   - the part of escrow already paid out to suppliers comes from ONE shared source, the CFO report's
 *     pnl.supplierCostMinor (core buildCfoReport over each side's records, live and mock alike);
 *   - spent = Σ pocket.spent + that paid-out part; held in escrow = escrowMinor − that paid-out part;
 *   - free = Σ pocket.available, capped (when given) by releasedMinor / fundedMinor minus total outflow (Σ spent +
 *     escrowMinor): spend and escrow funding revert CapExceeded past either, so this is what the agent can move now,
 *     the same rule as the CFO report's cashAvailable.
 * While the paid-out part is unknown (not loaded, or above what escrow ever held: the sources disagree), spent and
 * held are null: nothing is shown rather than a wrong number.
 */
import type { Minor } from "../schemas/primitives";
import { minBig, parseMinor, sumBig, toMinor } from "./index";

export interface WalletInputs {
  /** The committed plan's manifest.totalMinor; null when no plan is known (total and left are then null too). */
  readonly planTotalMinor: string | null;
  /** The pockets as GET /api/balances reports them (chain-raw). */
  readonly pockets: readonly { readonly spent: string; readonly available: string }[];
  /** GET /api/balances escrowMinor: everything funded into escrow, released milestones included. */
  readonly escrowMinor: string;
  /** What escrow has paid out to suppliers (the CFO report's pnl.supplierCostMinor); null while unknown. */
  readonly supplierPaidMinor: string | null;
  /** GET /api/balances releasedMinor / fundedMinor: ceilings on total outflow (absent = not capped). */
  readonly releasedMinor?: string;
  readonly fundedMinor?: string;
}

export interface WalletFigures {
  readonly totalMinor: Minor | null;
  /** The plan total less everything paid or committed to escrow (never below zero). */
  readonly leftMinor: Minor | null;
  /** Σ pocket.available, capped by the released stage and the funding: what the agent may still pay now. */
  readonly freeMinor: Minor;
  /** escrowMinor as the chain counts it: paid out or still held. */
  readonly escrowCommittedMinor: Minor;
  readonly supplierPaidMinor: Minor | null;
  /** Committed to escrow and not paid out yet: what waits for the founder's release. */
  readonly escrowHeldMinor: Minor | null;
  /** Σ pocket.spent plus what escrow paid out to suppliers. */
  readonly spentMinor: Minor | null;
}

export function walletFigures(i: WalletInputs): WalletFigures {
  const total = i.planTotalMinor === null ? null : parseMinor(i.planTotalMinor, "planTotalMinor");
  const spent = sumBig(i.pockets.map((p) => parseMinor(p.spent, "pocket.spent")));
  const free = sumBig(i.pockets.map((p) => parseMinor(p.available, "pocket.available")));
  const committed = parseMinor(i.escrowMinor, "escrowMinor");
  const reported = i.supplierPaidMinor === null ? null : parseMinor(i.supplierPaidMinor, "supplierPaidMinor");
  const paid = reported !== null && reported <= committed ? reported : null;
  const used = spent + committed;
  const ceilings = [
    ...(i.releasedMinor === undefined ? [] : [parseMinor(i.releasedMinor, "releasedMinor")]),
    ...(i.fundedMinor === undefined ? [] : [parseMinor(i.fundedMinor, "fundedMinor")]),
  ].map((c) => (c > used ? c - used : 0n));
  return {
    totalMinor: total === null ? null : toMinor(total),
    leftMinor: total === null ? null : toMinor(total > used ? total - used : 0n),
    freeMinor: toMinor(minBig(free, ...ceilings)),
    escrowCommittedMinor: toMinor(committed),
    supplierPaidMinor: paid === null ? null : toMinor(paid),
    escrowHeldMinor: paid === null ? null : toMinor(committed - paid),
    spentMinor: paid === null ? null : toMinor(spent + paid),
  };
}
