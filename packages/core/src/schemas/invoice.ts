/** Invoice (project.md §26.5). Values extracted by the quarantined Reader carry a taint label. */
import { z } from "zod";
import { Hex32, Id, IsoDateTime, Minor, OrderId, PayeeId, Taint, Uint8, UpperSnake } from "./primitives";

export const ExtractedField = z.strictObject({
  // Raw Reader output (untrusted); the normalised money value is Invoice.amountMinor.
  value: z.union([z.string(), z.number()]),
  unit: z.string().min(1).max(32),
  snippetHash: Hex32,
});
export type ExtractedField = z.infer<typeof ExtractedField>;

export const Invoice = z.strictObject({
  invoiceId: Id,
  payeeId: PayeeId,
  orderId: OrderId.optional(),
  // G0-DECISION: milestone idx is 0-based: 0 sample, 1 deposit, 2 balance, 3 holdback.
  milestoneIdx: Uint8.optional(),
  amountMinor: Minor,
  invoiceHash: Hex32,
  extracted: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), ExtractedField),
  taint: Taint,
  flags: z.array(UpperSnake).describe("e.g. IMPERATIVE_TEXT, AMOUNT_MISMATCH"),
  receivedAt: IsoDateTime,
});
export type Invoice = z.infer<typeof Invoice>;
