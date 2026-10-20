/** Payment, SpendProposal (project.md §12.3, §26.5, §26.6). */
import { z } from "zod";
import { LineKey, NON_AGENT_PAYMENT_KINDS, PaymentKind, PaymentState, PayoutStatus, PolicyVerdict, type PaymentKind as PaymentKindT } from "./enums";
import { BlockNumber, DecisionId, Hex32, Id, IsoDateTime, Minor, NonNegInt, PayeeId, PlanVersion, ReasonCode } from "./primitives";

const isNonAgentKind = (kind: PaymentKindT): boolean => (NON_AGENT_PAYMENT_KINDS as readonly string[]).includes(kind);

/** Payment fields without the cross-field rule (use `Payment`; this is for composing response shapes). */
export const PaymentFields = z.strictObject({
  paymentId: Id,
  kind: PaymentKind,
  // G0-REVIEW (H4): required for every kind (OWNER_SPEND: its spendId; WITHDRAW_RESERVE: the loosenId).
  intentId: Hex32,
  // G0-REVIEW: null exactly for WITHDRAW_RESERVE (the reserve is not a line).
  lineKey: LineKey.nullable(),
  payeeId: PayeeId,
  amountMinor: Minor,
  invoiceHash: Hex32.describe(
    "No-invoice lines: the on-chain per-line sequence number as bytes32. WITHDRAW_RESERVE: ZERO_HEX32 (no invoice).",
  ),
  planVersion: PlanVersion,
  state: PaymentState,
  txHash: Hex32.optional(),
  block: BlockNumber.optional(),
  revertReason: z.string().min(1).max(200).optional(),
  payout: z.strictObject({
    payoutId: Id.optional(),
    attempt: NonNegInt,
    status: PayoutStatus,
    failureCode: ReasonCode.optional().describe("e.g. INVALID_DESTINATION, SLS_RECIPIENT"),
  }),
  // G0-REVIEW (H4): null exactly when kind is OWNER_SPEND or WITHDRAW_RESERVE (no agent decision; on-chain 0).
  decisionId: DecisionId.nullable(),
  rationaleHash: Hex32.nullable(),
  traceId: Id,
  updatedAt: IsoDateTime,
});

/** Cross-field rule shared by Payment and every shape that embeds a payment. */
export function checkPaymentKindFields(p: z.infer<typeof PaymentFields>, ctx: z.RefinementCtx): void {
  const nonAgent = isNonAgentKind(p.kind);
  for (const key of ["decisionId", "rationaleHash"] as const) {
    if (nonAgent !== (p[key] === null)) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: nonAgent ? `${key} must be null for ${p.kind}` : `${key} is required for ${p.kind}`,
      });
    }
  }
  if ((p.kind === "WITHDRAW_RESERVE") !== (p.lineKey === null)) {
    ctx.addIssue({ code: "custom", path: ["lineKey"], message: "lineKey is null exactly for WITHDRAW_RESERVE" });
  }
}

export const Payment = PaymentFields.superRefine(checkPaymentKindFields);
export type Payment = z.infer<typeof Payment>;

// ---- Spend proposals (D6: the caller never supplies payee or amount) ---------------------------------
// G0-REVIEW (D6/H1): POST /api/proposals/spend names a bound invoice OR a pacing slot of the manifest; the
// server derives payeeId and amountMinor from the invoice (bound payee) or from the line's `pacing`.
// G0-REVIEW decision: a plain union of two strict objects (no extra tag field); exactly one of invoiceId /
// pacingSlot is accepted because each branch rejects the other key.
const Reason = z.string().min(1).max(500);
export const InvoiceSpendProposal = z.strictObject({ lineKey: LineKey, invoiceId: Id, reason: Reason });
export const PacingSpendProposal = z.strictObject({
  lineKey: LineKey,
  // Index of the pacing slot; becomes the line's on-chain sequence number (lineSequence, uint64).
  pacingSlot: NonNegInt,
  reason: Reason,
});
export const SpendProposal = z.union([InvoiceSpendProposal, PacingSpendProposal]);
export type SpendProposal = z.infer<typeof SpendProposal>;

/**
 * A spend proposal after the server derived payee and amount (stored in POLICY_ESCALATION.proposal).
 * payeeId and amountMinor are SERVER-DERIVED from the bound invoice or the manifest's pacing, never from the caller.
 */
export const DerivedSpendProposal = z
  .strictObject({
    lineKey: LineKey,
    payeeId: PayeeId,
    amountMinor: Minor,
    invoiceId: Id.optional(),
    pacingSlot: NonNegInt.optional(),
  })
  .refine((p) => (p.invoiceId === undefined) !== (p.pacingSlot === undefined), {
    message: "exactly one of invoiceId or pacingSlot",
    path: ["invoiceId"],
  });
export type DerivedSpendProposal = z.infer<typeof DerivedSpendProposal>;

export const SpendProposalResult = z.strictObject({
  verdict: PolicyVerdict,
  reasonCode: ReasonCode,
  traceId: Id,
  paymentId: Id.optional(),
});
export type SpendProposalResult = z.infer<typeof SpendProposalResult>;
