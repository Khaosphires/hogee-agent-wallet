import type { ConstitutionCode } from "../schemas/enums";

/**
 * Why the compiler refused. COMPILE_FAILED with violations maps to API 409 COMPILE_FAILED{violations}; a
 * PackFactMissingError to 409 COMPILE_FAILED{reason: PACK_FACT_MISSING, missingFacts}; the rest to 422.
 */
export type CompileErrorCode =
  | "INVALID_INPUT"
  | "COUNTRY_MISMATCH"
  | "CURRENCY_MISMATCH"
  | "BUDGET_TOO_SMALL"
  | "ENTITY_INELIGIBLE"
  | "AGENT_EXPIRY_INFEASIBLE"
  | "LICENSING_EXCEEDS_CONTINGENCY"
  | "FEE_TOO_LARGE"
  | "COMPILE_FAILED";

export class CompileError extends Error {
  override readonly name = "CompileError";
  constructor(
    readonly code: CompileErrorCode,
    message: string,
    /** Constitution codes the compiled manifest would violate (COMPILE_FAILED only). */
    readonly violations: readonly ConstitutionCode[] = [],
  ) {
    super(message);
  }
}

/**
 * The country pack lacks facts this compile needs (see pack-facts/index.ts). Fails closed with code COMPILE_FAILED and
 * no constitution violation; the message is `PACK_FACT_MISSING:<leaf>[,<leaf>...] (...)` and `leaves` lists every
 * missing leaf, so one compile tells the pack author everything the intent needs.
 */
export class PackFactMissingError extends CompileError {
  constructor(
    readonly leaves: readonly string[],
    message: string,
  ) {
    super("COMPILE_FAILED", message);
  }
}
