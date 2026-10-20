/**
 * Escrow terms constants (VISION-DECISIONS §2). Kept in this one file so the merge is a one-line change.
 *
 * Merged (P1, 19 Oct): the enums, labels and presets now come from schemas/ (one source of truth).
 */

export {
  MILESTONE_TRIGGERS,
  TERMS_ERROR_CODES,
  TERMS_PRESETS,
  type MilestoneTrigger,
  type TermsErrorCode,
  type TermsPreset,
} from "../schemas/enums";
import type { MilestoneTrigger } from "../schemas/enums";

/** One milestone of a payment schedule: a share of the total in bps, paid at a trigger. */
export interface TermsMilestone {
  readonly bps: number;
  readonly trigger: MilestoneTrigger;
}

/** Labels and presets live in schemas/orders.ts (one source of truth, shared with the web). */
export { MILESTONE_LABELS, TERMS_PRESET_MILESTONES } from "../schemas/orders";
