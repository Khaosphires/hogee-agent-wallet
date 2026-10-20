/** ApiError envelope (project.md §26.5): {error: {code, message, details?, contractError?, traceId?}}. */
import { z } from "zod";
import { ApiErrorCode, ConstitutionCode, ContractErrorName } from "./enums";
import { Hex32, Id } from "./primitives";

// G0-DECISION: contractError carries the decoded custom error; uint args are decimal strings,
// e.g. {name: "PlanInvariantViolated", args: {code: "7"}} (7 = RESERVE_BELOW_FLOOR).
export const ContractErrorInfo = z.strictObject({
  name: ContractErrorName,
  args: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/), z.string()).optional(),
  txHash: Hex32.optional(),
});
export type ContractErrorInfo = z.infer<typeof ContractErrorInfo>;

export const ApiError = z.strictObject({
  error: z.strictObject({
    code: ApiErrorCode,
    message: z.string().min(1).max(1000),
    details: z.record(z.string(), z.json()).optional(),
    contractError: ContractErrorInfo.optional(),
    traceId: Id.optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

/** Documented `details` for COMPILE_FAILED (409): {violations: [{code, message}]}. */
export const CompileFailedDetails = z.strictObject({
  violations: z.array(z.strictObject({ code: ConstitutionCode, message: z.string().min(1).max(500) })).min(1),
});
export type CompileFailedDetails = z.infer<typeof CompileFailedDetails>;

// G0-DECISION: default HTTP status per error code. Routes may override (Stripe webhook: VALIDATION → 400).
// All §8.5 contract errors map to 409 (the chain state rejected the action).
export const API_ERROR_HTTP_STATUS: { readonly [C in ApiErrorCode]: number } = {
  VALIDATION: 422,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  CONFLICT: 409,
  UPSTREAM: 502,
  COMPILE_FAILED: 409,
  PlanInvariantViolated: 409,
  StalePlan: 409,
  PayeeNotBound: 409,
  PayeeCooling: 409,
  CapExceeded: 409,
  LineExpired: 409,
  DuplicateIntent: 409,
  DuplicateInvoice: 409,
  DuplicateSale: 409,
  NotOwner: 409,
  NotLender: 409,
  NotAgent: 409,
  NotOracle: 409,
  AgentExpired: 409,
  ReserveLocked: 409,
  TimelockActive: 409,
  Paused: 409,
  MilestoneLocked: 409,
  EvidenceMissing: 409,
  AmountExceedsSchedule: 409,
  SignatureExpired: 409,
  InvalidSignature: 409,
  CircuitOpen: 409,
  // G0-REVIEW: new contract errors, all 409.
  FounderKeyAlreadySet: 409,
  MissingDecision: 409,
  SettlementClosed: 409,
  EscrowOnly: 409,
};
