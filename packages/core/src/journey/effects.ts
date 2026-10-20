/**
 * Effects: the typed requests a journey step needs from the outside world. Core decides WHICH effects a button or a
 * classified message needs (actions.ts, skills.ts); the live API (api/src/journey/effects.ts) and the mock
 * (api-mock/src/journey/effects.ts) run them and hand back outcomes; core then builds the reply from the outcomes.
 *
 * Nothing here moves money or signs. A text path only ever yields read-only effects (RESOLVE_RANKS, TERMS_PREFILL);
 * a search or the catalog list starts only from a button (VISION-DECISIONS §9: no text path reaches submitOrderTerms
 * or a signature).
 */
import type { DataEnquiry } from "../schemas/chat";
import type { SearchStatus, TermsErrorCode, TermsPreset } from "../schemas/enums";
import type { NeedsChecklist } from "../schemas/needs";
import type { SupplierId } from "../schemas/primitives";

export type JourneyEffect =
  /** v-search startWebSearch (live) / the mock search handler. */
  | { readonly kind: "START_SEARCH"; readonly quantity?: number }
  /** The labelled demo catalog shortlist (the fallback when the web search fails). */
  | { readonly kind: "USE_CATALOG" }
  /** core buildNeeds over the stored draft and the pack it was compiled with. */
  | { readonly kind: "NEEDS"; readonly draftId: string }
  /** core buildEnquiry, after checking every supplier is a candidate of that search. */
  | { readonly kind: "ENQUIRY"; readonly searchId: string; readonly supplierIds: readonly SupplierId[] }
  /** "#2 and #4" → the supplier ids of the latest READY web search. */
  | { readonly kind: "RESOLVE_RANKS"; readonly searchId: string; readonly ranks: readonly number[] }
  /** The terms card's preset availability under the CURRENT wallet limits, for one candidate (by id or rank). */
  | { readonly kind: "TERMS_PREFILL"; readonly searchId: string; readonly supplier: { readonly supplierId: SupplierId } | { readonly rank: number } };

export type JourneyEffectKind = JourneyEffect["kind"];

/** Why an effect could not run, in founder terms (templates FAILURE_TEXT). */
export const JOURNEY_FAILURES = ["NO_PLAN", "BUSY", "BUDGET", "NOT_FOUND", "UNAVAILABLE"] as const;
export type JourneyFailure = (typeof JOURNEY_FAILURES)[number];

export type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: JourneyFailure };

export interface PresetCheck {
  readonly preset: TermsPreset;
  readonly ok: boolean;
  readonly code: TermsErrorCode | null;
}

/** One outcome per effect kind that ran (absent: the effect was not asked for, or was not allowed at this stage). */
export interface EffectOutcomes {
  readonly search?: Outcome<{ readonly searchId: string }>;
  readonly catalog?: Outcome<{ readonly requestId: string; readonly status: SearchStatus }>;
  readonly needs?: Outcome<NeedsChecklist>;
  readonly enquiry?: Outcome<DataEnquiry>;
  readonly ranks?: Outcome<{ readonly supplierIds: readonly SupplierId[]; readonly ranks: readonly number[] }>;
  readonly prefill?: Outcome<{ readonly supplierId: SupplierId; readonly availability: readonly PresetCheck[] }>;
}

export const effectOk = <T>(value: T): Outcome<T> => ({ ok: true, value });
export const effectFailed = <T>(reason: JourneyFailure): Outcome<T> => ({ ok: false, reason });
