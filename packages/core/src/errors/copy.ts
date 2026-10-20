/**
 * Plain-English text for every contract error, API error code and constitution code (owned by P2; ROLE-P2 task 2.11).
 * Shown in the timeline, the evidence explorer and error toasts. Wording rules: project.md §14.4 (budget units,
 * never token/coin; "evidence coverage", never confidence).
 */
import type { ApiErrorCode, ConstitutionCode, ContractErrorName } from "../schemas/enums";

export interface ErrorCopy {
  /** Short headline, sentence case, no trailing period. */
  readonly title: string;
  /** One or two sentences: what happened and why it protects the plan. */
  readonly detail: string;
}

export const CONTRACT_ERROR_COPY: { readonly [E in ContractErrorName]: ErrorCopy } = {
  PlanInvariantViolated: { title: "Plan breaks a fixed safety rule", detail: "The blockchain's fixed safety rules rejected this plan, even though it was signed. A rule such as the minimum kept for tax, or a spending limit, wasn't met." },
  StalePlan: { title: "Plan version changed", detail: "This was made for an older version of the plan, so it was rejected. Nothing moved." },
  PayeeNotBound: { title: "Not approved to be paid", detail: "This account isn't approved to be paid from that pocket. Only the signed plan decides who gets paid, never an email or an invoice." },
  PayeeCooling: { title: "Still in the safety wait", detail: "A new supplier can't be paid until the safety wait ends. That leaves time to cancel a mistake or a forced change." },
  CapExceeded: { title: "Over the limit", detail: "The payment is more than allowed per payment, per 7 days, what's left in the pocket, or what's been released so far." },
  LineExpired: { title: "Pocket closed", detail: "This pocket's end date has passed. Keeping it open needs both the founder and the loan officer." },
  DuplicateIntent: { title: "Already paid", detail: "This exact payment was already made once. The blockchain rejects repeats." },
  DuplicateInvoice: { title: "Invoice already paid", detail: "This invoice was already paid, even though this try looked different." },
  DuplicateSale: { title: "Sale already recorded", detail: "This sale was recorded before. Each sale counts once." },
  NotOwner: { title: "Founder signature needed", detail: "Only the founder can do this. The AI can't set plans, add people to pay, or raise limits." },
  NotLender: { title: "Loan officer signature needed", detail: "Only the loan officer can do this, like adding money or releasing the next part of the budget." },
  NotAgent: { title: "Not the AI's paying key", detail: "Only the plan's approved AI key can do this." },
  NotOracle: { title: "Only the sales checker", detail: "Sales are only recorded after a checked payment notice, never by the AI." },
  AgentExpired: { title: "AI's paying key ran out", detail: "The AI's key ran out or was switched off, so it can't pay any more." },
  ReserveLocked: { title: "Tax money is locked", detail: "Tax money can only leave as a payment that both the founder and the loan officer approve, after a waiting time." },
  // UX-PLAN D21: only the founder's key, the lender or a set observer can cancel a queued loosening
  // (TreasuryGovernance.cancelLoosen), never "anyone". Shared by both personas, so it names both roles.
  TimelockActive: { title: "Still in the waiting time", detail: "This change must wait first (120 seconds in the demo). The founder or the loan officer can cancel it until then." },
  Paused: { title: "Payments are stopped", detail: "All payments, or this pocket's payments, are stopped. Restarting needs both signatures and a waiting time." },
  MilestoneLocked: { title: "This payment needs the founder", detail: "Only the founder can approve this supplier payment, with a delivery check report." },
  EvidenceMissing: { title: "Delivery check missing", detail: "Take a photo of the goods and the delivery note, or upload an inspector's report, before you pay the balance." },
  AmountExceedsSchedule: { title: "More than you signed for", detail: "This would set aside more than the supplier payment the founder signed." },
  SignatureExpired: { title: "Signature expired", detail: "This signed approval is too old. Ask for a new one." },
  InvalidSignature: { title: "Signature doesn't match", detail: "The signature doesn't fit this exact approval in this app version." },
  CircuitOpen: { title: "Pocket stopped itself", detail: "Three refused payments in a short time made this pocket stop itself, to be safe." },
  FounderKeyAlreadySet: { title: "Founder passkey already approved", detail: "Each loan has one founder passkey. The loan officer can't replace it." },
  MissingDecision: { title: "Missing decision record", detail: "Every AI payment must carry a record of why it was made." },
  SettlementClosed: { title: "Payment already closed", detail: "This bank payment already finished or failed. It can only be closed once." },
  EscrowOnly: { title: "Supplier is paid only in steps", detail: "The supplier pocket only pays in held steps, never directly." },
};

export const API_ERROR_COPY: { readonly [C in Exclude<ApiErrorCode, ContractErrorName>]: ErrorCopy } = {
  VALIDATION: { title: "Check the input", detail: "Some boxes are empty or filled in the wrong way." },
  NOT_FOUND: { title: "Not found", detail: "We couldn't find that. It may not exist, or demo features may be off." },
  FORBIDDEN: { title: "Not allowed for this role", detail: "Switch to the person who can do this (the Demo menu, top right), or check the officer access code." },
  CONFLICT: { title: "Can't do that now", detail: "Something changed. Refresh the page and try again." },
  UPSTREAM: { title: "Service unavailable", detail: "A service Hogee needs didn't answer. Try again in a moment." },
  COMPILE_FAILED: { title: "Plan can't be built", detail: "The answers break one of Hogee's fixed safety rules, so the plan wasn't built." },
};

export const CONSTITUTION_COPY: { readonly [C in ConstitutionCode]: string } = {
  LINES_EXCEED_FACILITY_CAP: "Budget lines add up to more than the facility cap",
  AGENT_EXPIRY_TOO_LATE: "Agent key lasts more than 90 days",
  AGENT_EXPIRY_TOO_EARLY: "Agent key expires before the judging window ends",
  PER_TX_CAP_OVER_25PCT: "A per-payment cap is above 25% of its line",
  WINDOW_CAP_OVER_50PCT: "A 7-day cap is above 50% of its line",
  LINE_VALIDITY_TOO_LONG: "A line is valid for more than 90 days",
  RESERVE_BELOW_FLOOR: "Tax reserve is below the facility's floor",
  STAGE1_OVER_40PCT: "First release is above 40% of the total",
  PLAN_ADDS_PAYEE: "The plan adds a payee that was never approved",
  SUPPLIER_LINE_NOT_ESCROW: "The supplier line isn't escrow-only",
  PAYEE_CAP_OVER_SCHEDULE: "A payee could receive more than its milestone schedule",
  TOTALS_MISMATCH: "Line totals don't match the plan total",
  MALFORMED_PLAN: "The plan is malformed",
  REPLAN_LOOSENS: "A replan tried to loosen the current rules",
};

/** The rule each constitution check enforces, phrased as the passing condition (for the plan's checklist). */
export const CONSTITUTION_RULE_COPY: { readonly [C in ConstitutionCode]: string } = {
  LINES_EXCEED_FACILITY_CAP: "Budget lines fit within the facility cap",
  AGENT_EXPIRY_TOO_LATE: "Agent key lasts at most 90 days",
  AGENT_EXPIRY_TOO_EARLY: "Agent key stays valid through the judging window",
  PER_TX_CAP_OVER_25PCT: "Every per-payment cap is at most 25% of its line",
  WINDOW_CAP_OVER_50PCT: "Every 7-day cap is at most 50% of its line",
  LINE_VALIDITY_TOO_LONG: "Every line is valid for at most 90 days",
  RESERVE_BELOW_FLOOR: "Tax reserve is at or above the facility's floor",
  STAGE1_OVER_40PCT: "First release is at most 40% of the total",
  PLAN_ADDS_PAYEE: "The plan adds no payee of its own",
  SUPPLIER_LINE_NOT_ESCROW: "The supplier line pays only through escrow",
  PAYEE_CAP_OVER_SCHEDULE: "No payee can receive more than its milestone schedule",
  TOTALS_MISMATCH: "Line totals match the plan total",
  MALFORMED_PLAN: "The plan is well formed",
  REPLAN_LOOSENS: "A replan only tightens the current rules",
};

/** Copy for any ApiError code (contract errors included). */
export function errorCopy(code: ApiErrorCode): ErrorCopy {
  return (CONTRACT_ERROR_COPY as Record<string, ErrorCopy>)[code] ?? (API_ERROR_COPY as Record<string, ErrorCopy>)[code] ?? API_ERROR_COPY.CONFLICT;
}

/** Copy for a revert reason string as it appears on payments and evidence rows (e.g. "PayeeNotBound"). */
export function revertCopy(reason: string): ErrorCopy | undefined {
  const name = reason.replace(/\(.*$/, "").trim();
  return (CONTRACT_ERROR_COPY as Record<string, ErrorCopy | undefined>)[name];
}
