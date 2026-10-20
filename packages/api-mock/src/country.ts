/**
 * POST /api/plans/preview-country (project.md §10.3): the off-chain country switch. Singapore is the main demo and
 * Malaysia the switch (SG-DECISIONS); Indonesia still previews (switch only). Each country shows its own rules and
 * entity (country-rules.ts): there is no fallback country, so an SG draft never shows Malaysia's rules or labels and
 * a country without rules throws. Amounts stay in budget units of the facility, as before.
 */
import type { CountryCode, PlanDraft, PlanManifest, PlanRule } from "@hogee/core";
import { countryRulesOf } from "./country-rules";
import { mockHash } from "./mock-hash";

/** `<base draftId>-<cc>`: a preview's id names its country, so previewing a preview starts from the base draft. */
const PREVIEW_SUFFIX = /-(sg|my|id)$/;

export const baseDraftIdOf = (draftId: string): string => draftId.replace(PREVIEW_SUFFIX, "");

function diffOf(from: PlanManifest, to: PlanManifest): PlanDraft["diff"] {
  const keys = ["countryCode", "countryPackVersion", "countryPackHash"] as const;
  const entries: PlanDraft["diff"] = keys
    .filter((k) => from[k] !== to[k])
    .map((k) => ({ path: `/${k}`, baseline: from[k], proposed: to[k] }));
  entries.push({ path: "/rules", baseline: from.rules.length, proposed: to.rules.length });
  return entries;
}

/**
 * Base rules that hold in every country: what the constitution states, and the compiler's own rules except the
 * entity (each country states its own entity). Pack-cited rules (sourceRef "/…") belong to the base country.
 */
const keepsAcrossCountries = (r: PlanRule): boolean =>
  r.sourceRef.startsWith("constitution:") || (r.sourceRef.startsWith("compiler:") && r.sourceRef !== "compiler:entity");

/** The draft as it would compile for `country`; the base country returns the draft unchanged. Throws for a country without rules. */
export function previewCountry(draft: PlanDraft, country: CountryCode): PlanDraft {
  const target = countryRulesOf(country);
  if (country === draft.intent.countryCode) return draft;
  const own = new Set(target.rules.map((r) => r.ruleId));
  const kept = draft.manifest.rules.filter((r) => keepsAcrossCountries(r) && !own.has(r.ruleId));
  const manifest: PlanManifest = {
    ...draft.manifest,
    countryCode: target.countryCode,
    countryPackVersion: target.countryPackVersion,
    countryPackHash: mockHash(`countryPack:${target.countryCode}`),
    rules: [...target.rules, ...kept],
  };
  return {
    ...draft,
    draftId: `${draft.draftId}-${country.toLowerCase()}`,
    intent: { ...draft.intent, countryCode: target.countryCode, entityType: target.entityType },
    manifest,
    diff: diffOf(draft.manifest, manifest),
  };
}
