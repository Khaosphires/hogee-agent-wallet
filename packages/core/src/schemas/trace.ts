/** TraceEvent (project.md §12.1, §26.5): hash-chained glass-box timeline entries. */
import { z } from "zod";
import { PolicyVerdict, TraceActor, TraceKind } from "./enums";
import { DecisionId, Hex32, Id, IsoDateTime, NonNegInt, PlanVersion, ReasonCode } from "./primitives";

// G0-DECISION: every refs field is optional (an event carries only the refs that apply to it).
export const TraceRefs = z.strictObject({
  planVersion: PlanVersion.optional(),
  paymentId: Id.optional(),
  invoiceHash: Hex32.optional(),
  decisionId: DecisionId.optional(),
  txHash: Hex32.optional(),
  payoutId: Id.optional(),
  exceptionId: Id.optional(),
  llmCallId: Id.optional(),
});
export type TraceRefs = z.infer<typeof TraceRefs>;

export const TraceEvent = z.strictObject({
  traceId: Id,
  seq: NonNegInt,
  ts: IsoDateTime,
  actor: TraceActor,
  kind: TraceKind,
  summary: z.string().min(1).max(500),
  verdict: PolicyVerdict.optional(),
  reasonCode: ReasonCode.optional(),
  refs: TraceRefs,
  prevHash: Hex32.describe("ZERO_HEX32 for the first event"),
  hash: Hex32,
});
export type TraceEvent = z.infer<typeof TraceEvent>;
