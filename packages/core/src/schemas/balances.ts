/** GET /api/balances and GET /api/stats/autonomy (project.md §26.6). */
import { z } from "zod";
import { LineKey } from "./enums";
import { Address, IsoDateTime, Minor, NonNegInt, UnixSeconds } from "./primitives";

export const Pocket = z.strictObject({
  lineKey: LineKey,
  allocated: Minor,
  spent: Minor,
  available: Minor,
  perTxCap: Minor,
  windowCap: Minor,
  windowSpent: Minor,
  validUntil: UnixSeconds,
  paused: z.boolean(),
  circuitOpen: z.boolean(),
});
export type Pocket = z.infer<typeof Pocket>;

export const Balances = z.strictObject({
  fundedMinor: Minor,
  releasedMinor: Minor,
  revenueMinor: Minor,
  reserveMinor: Minor,
  escrowMinor: Minor,
  pockets: z.array(Pocket),
  agent: z.strictObject({ address: Address, expiresAt: UnixSeconds, revoked: z.boolean() }),
  paused: z.boolean(),
  drift: NonNegInt.describe("Reconciler drift count"),
});
export type Balances = z.infer<typeof Balances>;

export const AutonomyStats = z.strictObject({
  agentTxs: NonNegInt,
  humanSigs: NonNegInt,
  autoPct: z.number().min(0).max(100),
  escalatedPct: z.number().min(0).max(100),
  startedAt: IsoDateTime,
  hours: z.number().min(0),
  drift: NonNegInt,
});
export type AutonomyStats = z.infer<typeof AutonomyStats>;
