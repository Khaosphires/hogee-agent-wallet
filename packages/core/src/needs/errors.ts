/**
 * Why buildNeeds refused. It never returns a partial or guessed checklist:
 * - INVALID_INPUT: the draft, the pack or the options fail their schema;
 * - PACK_MISMATCH: the pack is not the one the draft was compiled with (country, currency or countryPackHash);
 * - DRAFT_MISMATCH: the draft's rules do not carry a fact the pack derives (a registration, the approval, the reserve);
 * - LIMITS: the checklist would break a VISION-DECISIONS §3 limit (1..40 items, title ≤ 120, detail ≤ 300, formats).
 */
export type NeedsErrorCode = "INVALID_INPUT" | "PACK_MISMATCH" | "DRAFT_MISMATCH" | "LIMITS";

export class NeedsError extends Error {
  override readonly name = "NeedsError";
  constructor(
    readonly code: NeedsErrorCode,
    message: string,
  ) {
    super(message);
  }
}
