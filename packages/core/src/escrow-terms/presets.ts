/**
 * presetAvailability (VISION-DECISIONS §8): runs each one-click split through termsToSchedule for this total, these
 * line limits and this supplier origin, so the terms card can grey out the ones that would be refused and say why.
 */
import { TERMS_PRESET_MILESTONES, TERMS_PRESETS, type TermsErrorCode, type TermsPreset } from "./constants";
import { termsToSchedule, type TermsLimits, type TermsOrigin } from "./schedule";

export interface PresetAvailability {
  readonly preset: TermsPreset;
  readonly ok: boolean;
  readonly code: TermsErrorCode | null;
}

export function presetAvailability(totalMinor: bigint, limits: TermsLimits, origin: TermsOrigin): PresetAvailability[] {
  return TERMS_PRESETS.map((preset) => {
    const r = termsToSchedule({ totalMinor, milestones: TERMS_PRESET_MILESTONES[preset], origin }, limits);
    return { preset, ok: r.ok, code: r.ok ? null : r.code };
  });
}
