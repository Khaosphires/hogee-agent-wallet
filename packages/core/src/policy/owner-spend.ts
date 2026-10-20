/**
 * `Treasury.ownerSpend` (run in TreasuryGovernance; G0 H4/H5): the founder's manual fallback, checked before the
 * founder signs, so a DENY is exactly the revert the relayed call would get (require-table-final1 rows 5-15, after the
 * signature envelope). Same reserve, escrow-only, validity, payee, duplicate, invoice/pacing-slot, balance, lifetime,
 * stage and funded rules as spend, and the listing rule applies: a payee the current plan version does not list is
 * PayeeNotBound. Skipped on purpose, as on-chain (§8.8): the agent checks, the plan version, the per-tx and window caps,
 * the live-spend bound, the treasury pause, line pauses and tripped circuits. An ownerSpend adds NO window entry (it is
 * not agent outflow), so it never counts toward the rolling window: see PacingInFlight.owner.
 */
import { parseMinor, tryParseMinor } from "../money/index";
import type { Hex32, Minor, PayeeId } from "../schemas/primitives";
import { exceedsPaymentCaps } from "./spend";
import { deny, isCooling, lineState, nowOf, planLine, spendablePayeeState } from "./state";
import { RESERVE_LINE_KEY, type PolicyContext, type PolicyDecision, type PolicyLineState, type SpendLineKey } from "./types";

/** The OwnerSpend struct the founder signs (deploymentId, expiry and nonce are the signature envelope). */
export interface OwnerSpendIn {
  readonly lineKey: SpendLineKey;
  readonly payeeId: PayeeId;
  readonly amountMinor: Minor;
  /** An invoice hash, or bytes32(slot) on a pacing line (ownerSpend pays the line's next slot). */
  readonly invoiceHash: Hex32;
  /** keccak256(abi.encode(planId, lineId, payeeId, invoiceHash, amount)): spendId == settlementId. */
  readonly intentId: Hex32;
}

const FOUNDER_SIGNS: PolicyDecision = Object.freeze({ verdict: "NEEDS_FOUNDER", reasonCode: "FOUNDER_SIGNATURE_REQUIRED", mirrorsRevert: false });

/** TreasuryState._requireInvoice: a paid invoice, or on a pacing line a used slot, a skipped slot or more than the pacing. */
function invoiceRow(ctx: PolicyContext, req: OwnerSpendIn, state: PolicyLineState, pacingMinor: Minor | undefined, amount: bigint): PolicyDecision | null {
  if (pacingMinor === undefined) return ctx.paidInvoices.has(req.invoiceHash) ? deny("DuplicateInvoice") : null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(req.invoiceHash)) return deny("PACING_HASH_MISMATCH");
  const slot = BigInt(req.invoiceHash);
  const next = BigInt(state.nextSequence);
  if (slot < next) return deny("DuplicateInvoice");
  return slot > next || amount > parseMinor(pacingMinor, "pacing") ? deny("CapExceeded") : null;
}

/** NEEDS_FOUNDER when the founder's signed OwnerSpend would execute; else DENY with the revert it would get. */
export function evaluateOwnerSpend(req: OwnerSpendIn, ctx: PolicyContext): PolicyDecision {
  const lineKey = req.lineKey;
  if (lineKey === RESERVE_LINE_KEY) return deny("ReserveLocked");
  const line = planLine(ctx, lineKey);
  const state = lineState(ctx, lineKey);
  if (line?.escrowOnly) return deny("EscrowOnly");
  if (!line || !state || nowOf(ctx) > parseMinor(state.validUntil, "validUntil")) return deny("LineExpired");
  const payee = spendablePayeeState(ctx, req.payeeId, lineKey);
  if (!payee) return deny("PayeeNotBound");
  if (isCooling(ctx, payee)) return deny("PayeeCooling");
  if (ctx.usedIntents.has(req.intentId)) return deny("DuplicateIntent");
  const amount = tryParseMinor(req.amountMinor);
  if (amount === null) return deny("INVALID_AMOUNT");
  const invoice = invoiceRow(ctx, req, state, line.pacing?.amountMinor, amount);
  if (invoice) return invoice;
  if (amount === 0n || exceedsPaymentCaps(ctx, state, payee, amount)) return deny("CapExceeded");
  return FOUNDER_SIGNS;
}
