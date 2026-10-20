/**
 * SPEND and FUND_MILESTONE (the two things the agent does with money alone).
 * On-chain-mirrored checks run first, in §8.4 order, so a DENY's reasonCode is exactly the error a forced send
 * reverts with. Off-chain-only checks (taint, Reader flags) run after them.
 */
import { effectiveLifetimeCap } from "../constitution/check";
import { parseMinor, tryParseMinor } from "../money/index";
import type { LineKey } from "../schemas/enums";
import { TAINT_REASON, isTrusted } from "../taint/labels";
import { isSequenceInvoiceHash } from "./sequence";
import { agentGate, allow, deny, escalate, isCooling, lineState, nowOf, payeeState, planLine, spendablePayeeState } from "./state";
import { RESERVE_LINE_KEY, type FundMilestoneProposalIn, type PolicyContext, type PolicyDecision, type PolicyLineState, type PolicyPayeeState, type SpendProposalIn } from "./types";

/** Reader flags on an invoice that send an otherwise valid spend to the loan officer. */
export const ESCALATING_INVOICE_FLAGS: ReadonlySet<string> = new Set([
  "IMPERATIVE_TEXT",
  "AMOUNT_MISMATCH",
  "PAYEE_DETAILS_CHANGED",
  "ENCODED_PAYLOAD",
  "OFF_PLATFORM_PAYMENT",
]);

const big = (s: string): bigint => parseMinor(s);

/** Treasury (TreasuryStorage.MAX_LIVE_SPENDS_PER_WINDOW): live entries a line's rolling window may hold (gas bound). */
export const MAX_LIVE_SPENDS_PER_WINDOW = 64;

/** Outflow bound shared by spend, ownerSpend and fundMilestone: spent + escrowed + amount ≤ releasedMinor and ≤ fundedMinor. */
function exceedsOutflow(ctx: PolicyContext, amount: bigint): boolean {
  const outflow = big(ctx.totalSpentMinor) + big(ctx.totalEscrowedMinor) + amount;
  return outflow > big(ctx.releasedMinor) || (ctx.fundedMinor !== undefined && outflow > big(ctx.fundedMinor));
}

/** Line pocket bound: spent + escrowed + amount ≤ allocated. */
function exceedsLineBalance(state: PolicyLineState, amount: bigint): boolean {
  return big(state.spentMinor) + big(state.escrowedMinor) + amount > big(state.allocatedMinor);
}

/**
 * The amount rows spend and ownerSpend share (Treasury._requireCaps rows 20-23, TreasuryGovernance._requireOwnerAmount):
 * line balance, the payee's lifetime cap, releasedMinor and fundedMinor.
 */
export function exceedsPaymentCaps(ctx: PolicyContext, state: PolicyLineState, payee: PolicyPayeeState | undefined, amount: bigint): boolean {
  const lifetime = payee ? effectiveLifetimeCap(payee) : null;
  const overLifetime = payee !== undefined && lifetime !== null && big(payee.paidMinor) + amount > lifetime;
  return exceedsLineBalance(state, amount) || overLifetime || exceedsOutflow(ctx, amount);
}

function capCheck(p: SpendProposalIn, lineKey: LineKey, ctx: PolicyContext, amount: bigint): PolicyDecision | null {
  const state = lineState(ctx, lineKey);
  const line = planLine(ctx, lineKey);
  if (!state || !line) return deny("LineExpired");
  const payee = spendablePayeeState(ctx, p.payeeId.value, lineKey);
  const overPacing = "pacingSlot" in p.basis && line.pacing !== undefined && amount > big(line.pacing.amountMinor);
  const windowFull = state.windowLiveSpends !== undefined && state.windowLiveSpends >= MAX_LIVE_SPENDS_PER_WINDOW;
  if (
    amount > big(state.perTxCapMinor) ||
    windowFull ||
    big(state.windowSpentMinor) + amount > big(state.windowCapMinor) ||
    overPacing ||
    exceedsPaymentCaps(ctx, state, payee, amount)
  ) {
    return deny("CapExceeded");
  }
  return null;
}

/**
 * A pacing line pays only its slots, and Treasury reads the slot from the invoice hash (§8.4 pacing rows), so:
 * an invoice spend on a pacing line is refused, and a pacing spend must carry bytes32(uint256(slot)).
 */
function pacingCheck(p: SpendProposalIn, lineKey: LineKey, ctx: PolicyContext): PolicyDecision | null {
  const line = planLine(ctx, lineKey);
  if (!("pacingSlot" in p.basis)) return line?.pacing ? deny("INVOICE_ON_PACING_LINE") : null;
  const state = lineState(ctx, lineKey);
  if (!line?.pacing || !state) return deny("PACING_NOT_ALLOWED");
  if (!isSequenceInvoiceHash(p.invoiceHash, p.basis.pacingSlot)) return deny("PACING_HASH_MISMATCH");
  if (p.basis.pacingSlot < state.nextSequence) return deny("DuplicateInvoice");
  if (p.basis.pacingSlot > state.nextSequence) return deny("PACING_SLOT_AHEAD");
  return null;
}

/** §8.4 `spend`, then taint, then Reader flags. */
export function evaluateSpend(p: SpendProposalIn, ctx: PolicyContext): PolicyDecision {
  const gate = agentGate(ctx);
  if (gate) return gate;
  const lineKey = p.lineKey.value;
  // Treasury.spend row 4a (after MissingDecision, which proposals cannot fail): the reserve is not a line (T8).
  if (lineKey === RESERVE_LINE_KEY) return deny("ReserveLocked");
  const line = planLine(ctx, lineKey);
  const state = lineState(ctx, lineKey);
  if (line?.escrowOnly) return deny("EscrowOnly");
  if (p.planVersion !== ctx.planVersion) return deny("StalePlan");
  if (!line || !state || nowOf(ctx) > big(state.validUntil)) return deny("LineExpired");
  // Treasury._requireLineOpen: circuit before pause.
  if (state.circuitOpen) return deny("CircuitOpen");
  if (state.paused) return deny("Paused");
  // Bound to the line and listed on it in the current plan version (a dropped payee is de-authorised).
  const payee = spendablePayeeState(ctx, p.payeeId.value, lineKey);
  if (!payee) return deny("PayeeNotBound");
  if (isCooling(ctx, payee)) return deny("PayeeCooling");
  if (ctx.usedIntents.has(p.intentId)) return deny("DuplicateIntent");
  if (ctx.paidInvoices.has(p.invoiceHash)) return deny("DuplicateInvoice");
  const pacing = pacingCheck(p, lineKey, ctx);
  if (pacing) return pacing;
  const amount = tryParseMinor(p.amountMinor.value);
  if (amount === null) return deny("INVALID_AMOUNT");
  // Treasury._requireCaps starts with amount != 0 (CapExceeded), after the invoice and pacing-slot checks.
  if (amount === 0n) return deny("CapExceeded");
  const caps = capCheck(p, lineKey, ctx, amount);
  if (caps) return caps;
  // Off-chain only: the chain would accept these; the policy layer is the protection.
  if (!isTrusted(p.payeeId)) return deny(TAINT_REASON.payee);
  if (!isTrusted(p.lineKey) || p.origin.trust !== "trusted") return deny(TAINT_REASON.action);
  if ("invoiceId" in p.basis && p.basis.flags.some((f) => ESCALATING_INVOICE_FLAGS.has(f))) {
    return escalate("NEEDS_OFFICER", "FLAGGED_INVOICE", "POLICY_ESCALATION");
  }
  return allow();
}

/**
 * `MilestoneEscrow.fundMilestone` in on-chain order (require-table-final1): agent gate, order, then
 * Treasury.checkEscrowLine (line valid, circuit, pause, payee bound, cooling; NO listing rule: the supplier is bound by
 * its signed approval), zero amount, the signed schedule (cumulative), then Treasury.escrowFund (line balance,
 * releasedMinor, fundedMinor; not perTx or the window). Off-chain only, after all of them: the plan version the agent
 * decided under (fundMilestone takes none), then taint, then the invoice's Reader flags (as for an invoice spend).
 */
export function evaluateFundMilestone(p: FundMilestoneProposalIn, ctx: PolicyContext): PolicyDecision {
  const gate = agentGate(ctx);
  if (gate) return gate;
  const order = ctx.escrowOrders.find((o) => o.orderId === p.orderId.value);
  const milestone = order?.milestones[p.idx];
  if (!order || !milestone) return deny("PayeeNotBound");
  const state = lineState(ctx, order.lineKey);
  if (!planLine(ctx, order.lineKey) || !state || nowOf(ctx) > big(state.validUntil)) return deny("LineExpired");
  if (state.circuitOpen) return deny("CircuitOpen");
  if (state.paused) return deny("Paused");
  const payee = payeeState(ctx, order.payeeId, order.lineKey);
  if (!payee) return deny("PayeeNotBound");
  if (isCooling(ctx, payee)) return deny("PayeeCooling");
  const amount = tryParseMinor(p.amountMinor.value);
  if (amount === null) return deny("INVALID_AMOUNT");
  if (amount === 0n) return deny("CapExceeded");
  if (big(milestone.fundedMinor) + amount > big(milestone.amountMinor)) return deny("AmountExceedsSchedule");
  if (exceedsLineBalance(state, amount) || exceedsOutflow(ctx, amount)) return deny("CapExceeded");
  if (p.planVersion !== ctx.planVersion) return deny("STALE_PLAN_VERSION");
  if (!isTrusted(p.orderId) || p.origin.trust !== "trusted") return deny(TAINT_REASON.action);
  if (p.invoiceFlags?.some((f) => ESCALATING_INVOICE_FLAGS.has(f))) return escalate("NEEDS_OFFICER", "FLAGGED_INVOICE", "POLICY_ESCALATION");
  return allow();
}
