/** Escrow milestones: GET /api/escrow/:orderId (project.md §8.4, §11, §26.6). */
import { z } from "zod";
import { Hex32, Minor, Uint8 } from "./primitives";

// G0-DECISION: idx is 0-based (0 sample, 1 deposit, 2 balance, 3 holdback); `funded` is the cumulative
// funded amount (Minor), `released` is a boolean (a milestone is released in one call).
export const EscrowMilestone = z.strictObject({
  idx: Uint8,
  amountMinor: Minor,
  funded: Minor,
  released: z.boolean(),
  autoRelease: z.boolean(),
  evidenceHash: Hex32.optional(),
});
export type EscrowMilestone = z.infer<typeof EscrowMilestone>;

export const EscrowSchedule = z.array(EscrowMilestone);
export type EscrowSchedule = z.infer<typeof EscrowSchedule>;
