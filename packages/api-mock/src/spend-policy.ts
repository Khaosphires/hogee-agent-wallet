/**
 * The hard spend checks Treasury.spend enforces on-chain, shared by the agent's spend path and an officer-approved
 * escalation: an officer can override a soft verdict (a flagged invoice), never the payee binding or the caps.
 */
import { formatBu, parseMinor, type ContractErrorName, type LineKey } from "@hogee/core";
import { currentPlan, pocketOf, type MockState } from "./store";
import { taxPayeeIdOf } from "./profile";
import { inFlightMinor } from "./transitions";

export interface SpendRefusal {
  readonly reasonCode: ContractErrorName;
  readonly summary: string;
}

/**
 * Whether `payeeId` is bound to the line: named by the signed plan, or added since by an ADD_PAYEE loosening that
 * executed (Treasury.executeLoosen binds the payee to the line; the plan record itself never changes).
 */
export function payeeBound(st: MockState, lineKey: LineKey, payeeId: string): boolean {
  const line = currentPlan(st)?.manifest.lines.find((l) => l.lineKey === lineKey);
  if (line?.payeeIds.includes(payeeId)) return true;
  return [...st.exceptions.values()].some(
    ({ exception: e }) => e.kind === "ADD_PAYEE" && e.status === "EXECUTED" && e.payload.lineKey === lineKey && e.payload.payeeId === payeeId,
  );
}

/**
 * Budget units already out of the pockets or on their way: every pocket's spent, what escrow holds, and every spend,
 * owner spend and milestone funding still in flight on any line (core policy pacing.ts counts the same).
 */
export function outflowMinor(st: MockState): bigint {
  const out = st.balances.pockets.reduce((sum, p) => sum + parseMinor(p.spent), 0n) + parseMinor(st.balances.escrowMinor);
  const inFlight = st.payments
    .filter((sp) => sp.script && !sp.applied.has("INCLUDED"))
    .filter((sp) => ["SPEND", "OWNER_SPEND", "FUND_MILESTONE"].includes(sp.payment.kind) || (sp.payment.kind === "RELEASE_MILESTONE" && sp.script?.fundsEscrow === true))
    .reduce((sum, sp) => sum + parseMinor(sp.payment.amountMinor), 0n);
  return out + inFlight;
}

/**
 * Treasury's outflow bound for spend, ownerSpend and fundMilestone (core policy spend.ts): spent + escrowed + in flight
 * + this amount ≤ the released stages and ≤ what the officer funded. Undefined when it fits. `releasedOnly` checks the
 * released stages alone: the mock's web-order funding has always run before the officer funds (its fresh-journey tests
 * order first), so there only the released bound is new.
 */
export function outflowRefusal(st: MockState, amountMinor: string, releasedOnly = false): SpendRefusal | undefined {
  const after = outflowMinor(st) + parseMinor(amountMinor);
  if (after > parseMinor(st.balances.releasedMinor)) return { reasonCode: "CapExceeded", summary: "more than the budget released so far (the next release needs the loan officer)" };
  if (!releasedOnly && after > parseMinor(st.balances.fundedMinor)) return { reasonCode: "CapExceeded", summary: "more than the loan officer has added so far" };
  return undefined;
}

/**
 * Why the agent may not fund an escrow milestone of `amountMinor` from `lineKey` now, as MilestoneEscrow.fundMilestone
 * refuses it (Treasury.checkEscrowLine, then escrowFund's outflow bound): a paused treasury or pocket, a pocket that
 * stopped itself, or more than the released stages and the officer's funding hold. Undefined when it may (run-10
 * re-check W-1: the catalog path funded with no check; the web path checks the same in advanceWebOrders).
 */
export function escrowFundingRefusal(st: MockState, lineKey: LineKey, amountMinor: string): SpendRefusal | undefined {
  const pocket = pocketOf(st, lineKey);
  if (st.balances.paused || pocket?.paused) return { reasonCode: "Paused", summary: "spending is paused" };
  if (pocket?.circuitOpen) return { reasonCode: "CircuitOpen", summary: `the ${lineKey} pocket stopped itself` };
  return outflowRefusal(st, amountMinor);
}

/** Why this payment may not leave the pocket now, or undefined when the signed plan allows it. */
export function spendRefusal(st: MockState, lineKey: LineKey, payeeId: string, amountMinor: string): SpendRefusal | undefined {
  const line = currentPlan(st)?.manifest.lines.find((l) => l.lineKey === lineKey);
  const pocket = pocketOf(st, lineKey);
  const amount = parseMinor(amountMinor);
  if (line?.escrowOnly) return { reasonCode: "EscrowOnly", summary: `the ${lineKey} pocket pays only through escrow milestones` };
  if (!line || !payeeBound(st, lineKey, payeeId)) return { reasonCode: "PayeeNotBound", summary: `${payeeId} is not a payee of the ${lineKey} pocket` };
  if (st.balances.paused || pocket?.paused) return { reasonCode: "Paused", summary: "spending is paused" };
  if (!pocket || amount > parseMinor(pocket.perTxCap)) return { reasonCode: "CapExceeded", summary: "above the per-payment cap of the signed plan" };
  // Payments proposed but not mined yet count against the caps too (in-flight projection).
  const inFlight = inFlightMinor(st, lineKey);
  if (parseMinor(pocket.windowSpent) + inFlight + amount > parseMinor(pocket.windowCap)) return { reasonCode: "CapExceeded", summary: "the 7-day window cap is already used up" };
  if (inFlight + amount > parseMinor(pocket.available)) return { reasonCode: "CapExceeded", summary: "the pocket has too little left" };
  return outflowRefusal(st, amountMinor);
}

/**
 * Reserve withdrawal checks, after Treasury's LOOSEN_WITHDRAW_RESERVE (TreasuryLoosenRules._checkLoosen) but stricter:
 * the chain accepts any static platform payee, the mock only the facility's tax payee (iras-tax for Mei's, lhdn-tax for
 * Rina's; profile.ts taxPayeeIdOf). Never more than the reserve holds (withdrawals still in flight count). Checked when
 * the request is made, when the officer approves it and again when the timelock executes it.
 */
export function reserveWithdrawalRefusal(st: MockState, taxPayeeId: string, amountMinor: string): SpendRefusal | undefined {
  const taxPayee = taxPayeeIdOf(st.facility);
  if (taxPayeeId !== taxPayee) {
    return { reasonCode: "PayeeNotBound", summary: `the reserve goes only to the tax payee ${taxPayee}, not ${taxPayeeId}` };
  }
  const inFlight = st.payments
    .filter((sp) => sp.script && sp.payment.kind === "WITHDRAW_RESERVE" && !sp.applied.has("INCLUDED"))
    .reduce((sum, sp) => sum + parseMinor(sp.payment.amountMinor), 0n);
  const left = parseMinor(st.balances.reserveMinor) - inFlight;
  const amount = parseMinor(amountMinor);
  if (amount === 0n || amount > left) return { reasonCode: "CapExceeded", summary: `the tax reserve holds ${formatBu((left > 0n ? left : 0n).toString())}` };
  return undefined;
}
