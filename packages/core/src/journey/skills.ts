/**
 * The text path after the plan is signed (VISION-DECISIONS §9, plan §1): the founder's REDACTED message is classified
 * into one SkillCall (agent classifySkill, or the mock's regex), then this code mapping decides the reply. The model's
 * output is only the skill enum, a few ranks and a CFO view; nothing it says is shown.
 *
 * A text path never starts a search, never moves money and never signs: its only effects are read-only
 * (RESOLVE_RANKS, TERMS_PREFILL). Starting a search or picking from text answers with a BUTTON the founder presses.
 * Terms typed in chat ("went with #2, 30% deposit, 70% on delivery", "actually 40/60") only pre-fill the terms card
 * (core parseTermsHint on the redacted text); the payout account and the submit happen in the REST form.
 */
import { parseTermsHint } from "../escrow-terms/hint";
import type { SupplierId } from "../schemas/primitives";
import type { JourneyState, SkillCall } from "../schemas/journey";
import { TERMS_PRESET_MILESTONES, type MilestoneInput, type TermsPrefill } from "../schemas/orders";
import { TERMS_PRESETS, type TermsPreset } from "../schemas/enums";
import { cfoReply, reply, webSearchReady, withState, type JourneyReply } from "./actions";
import { hasOrder, planSigned } from "./derive";
import type { EffectOutcomes, JourneyEffect, PresetCheck } from "./effects";
import {
  DEFAULT_JOURNEY_ENV,
  candidatesPart,
  findSuppliers,
  nextPart,
  partsForState,
  planDraftPart,
  searchPart,
  stageCards,
  startTerms,
  termsPart,
  textPart,
  type JourneyEnv,
} from "./parts";
import { FAILURE_TEXT, PRESET_BUTTON, TEXT, pickRanksLabel } from "./templates";

type Target = { readonly supplierId: SupplierId } | { readonly rank: number };

/** Whose terms the message reports: a named rank, else the open form's, the saved terms', or the only pick. */
function termsTarget(call: SkillCall, state: JourneyState): Target | null {
  const rank = call.candidateRanks?.[0];
  if (rank !== undefined) return { rank };
  const f = state.facts;
  if (f.termsDraft) return { supplierId: f.termsDraft.supplierId };
  if (f.terms?.status === "CONFIRMED") return { supplierId: f.terms.supplierId };
  const only = f.pickedSupplierIds.length === 1 ? f.pickedSupplierIds[0] : undefined;
  return only ? { supplierId: only } : null;
}

const readySearchId = (state: JourneyState): string | null => {
  const s = state.facts.search;
  return s && webSearchReady(state, s.searchId) ? s.searchId : null;
};

/** The read-only effects a classified message needs, judged on the current state. */
export function effectsForSkill(call: SkillCall, state: JourneyState): JourneyEffect[] {
  const searchId = readySearchId(state);
  if (!searchId) return [];
  if (call.skill === "pick_suppliers" && call.candidateRanks && call.candidateRanks.length > 0) {
    return [{ kind: "RESOLVE_RANKS", searchId, ranks: call.candidateRanks }];
  }
  if (call.skill === "report_terms" && !hasOrder(state.stage)) {
    const supplier = termsTarget(call, state);
    return supplier ? [{ kind: "TERMS_PREFILL", searchId, supplier }] : [];
  }
  return [];
}

const sameMilestones = (a: readonly MilestoneInput[], b: readonly MilestoneInput[]): boolean =>
  a.length === b.length && a.every((m, i) => m.bps === b[i]?.bps && m.trigger === b[i]?.trigger);

/** The preset these milestones are exactly, if any (so the card can select it). */
export const presetOf = (milestones: readonly MilestoneInput[]): TermsPreset | null =>
  TERMS_PRESETS.find((p) => sameMilestones(TERMS_PRESET_MILESTONES[p], milestones)) ?? null;

/** The terms card from the founder's words (parseTermsHint on the REDACTED text) and the current preset checks. */
export function textPrefill(supplierId: SupplierId, searchId: string | null, redactedText: string, availability: readonly PresetCheck[]): TermsPrefill {
  const hint = parseTermsHint(redactedText);
  const presetAvailability = availability.map((a) => ({ ...a }));
  const none = { supplierId, searchId, milestones: null, preset: null, question: null, presetAvailability } as const;
  if (hint.ambiguous) return { ...none, source: "founder_text", question: "DEPOSIT_TRIGGER" };
  if (!hint.milestones) return { ...none, source: "none" };
  const milestones = hint.milestones.map((m) => ({ bps: m.bps, trigger: m.trigger }));
  return { ...none, milestones, preset: presetOf(milestones), source: "founder_text" };
}

function reportTerms(call: SkillCall, state: JourneyState, text: string, out: EffectOutcomes, env: JourneyEnv): JourneyReply {
  if (hasOrder(state.stage)) return reply(withState(TEXT.termsLocked, state, env), `report_terms at ${state.stage}: order signed`);
  const searchId = readySearchId(state);
  if (!searchId) return reply(withState(TEXT.notYet, state, env), `report_terms at ${state.stage}: no ready web search`);
  const o = out.prefill;
  if (!o) return reply([textPart(TEXT.whichSupplier), candidatesPart(searchId)], "report_terms without a supplier: asked which one");
  if (!o.ok) {
    const lead = o.reason === "NOT_FOUND" ? TEXT.noSuchRank : FAILURE_TEXT[o.reason];
    return reply([textPart(lead), candidatesPart(searchId)], `report_terms refused (${o.reason})`);
  }
  const prefill = textPrefill(o.value.supplierId, searchId, text, o.value.availability);
  if (prefill.question) {
    const buttons = prefill.presetAvailability.filter((a) => a.ok).map((a) => startTerms(prefill.supplierId, PRESET_BUTTON[a.preset], a.preset));
    const tail = buttons.length > 0 ? [nextPart(buttons, env)] : [];
    return reply([textPart(TEXT.termsQuestion), termsPart(prefill), ...tail], "Terms pre-filled from the founder's text: asked when the deposit is due");
  }
  const lead = prefill.milestones ? TEXT.termsFromText : TEXT.termsNoSplit;
  return reply([textPart(lead), termsPart(prefill)], `Terms pre-filled from the founder's text (${prefill.source}${prefill.preset ? ` ${prefill.preset}` : ""})`);
}

function pickSuppliers(state: JourneyState, out: EffectOutcomes, env: JourneyEnv): JourneyReply {
  const searchId = readySearchId(state);
  if (!searchId) return reply(withState(TEXT.notYet, state, env), `pick_suppliers at ${state.stage}: no ready web search`);
  const o = out.ranks;
  if (!o) return reply([textPart(TEXT.pickInList), candidatesPart(searchId)], "pick_suppliers without numbers: showed the list");
  if (!o.ok) return reply([textPart(o.reason === "NOT_FOUND" ? TEXT.noSuchRank : FAILURE_TEXT[o.reason]), candidatesPart(searchId)], `pick_suppliers refused (${o.reason})`);
  const button = { label: pickRanksLabel(o.value.ranks), action: { type: "pick" as const, searchId, supplierIds: [...o.value.supplierIds] } };
  return reply([textPart(TEXT.pickByNumber), nextPart([button], env)], `pick_suppliers by number: offered a pick of ${o.value.ranks.length}`);
}

function findSuppliersReply(state: JourneyState, env: JourneyEnv): JourneyReply {
  if (!planSigned(state.stage)) return reply(withState(TEXT.needPlanFirst, state, env), `find_suppliers before a signed plan (${state.stage})`);
  const s = state.facts.search;
  if (s?.status === "PENDING") return reply([textPart(TEXT.stillSearching), searchPart(s.searchId)], "find_suppliers while a search runs");
  return reply([textPart(TEXT.findSuppliers), nextPart([findSuppliers], env)], "find_suppliers: offered the search button");
}

function planReply(state: JourneyState, env: JourneyEnv): JourneyReply {
  const draftId = state.facts.draftId;
  if (!planSigned(state.stage) || !draftId) return reply(partsForState(state, env), `plan at ${state.stage}`);
  return reply([textPart(TEXT.planInfo), planDraftPart(draftId), ...stageCards(state, env)], "plan: pointed to the signed plan");
}

/**
 * The reply to a classified message. `redactedText` is the founder's message after redaction (only report_terms reads
 * it, through parseTermsHint); `outcomes` are those of effectsForSkill.
 */
export function replyToSkill(call: SkillCall, state: JourneyState, redactedText: string, outcomes: EffectOutcomes = {}, env: JourneyEnv = DEFAULT_JOURNEY_ENV): JourneyReply {
  const r = skillReply(call, state, redactedText, outcomes, env);
  // Free text never brings up a signature card (whatever the router chose): signing starts from the card a button
  // or the plan reply showed, never from a message.
  return { ...r, parts: r.parts.filter((p) => p.type !== "data-sign") };
}

function skillReply(call: SkillCall, state: JourneyState, redactedText: string, outcomes: EffectOutcomes, env: JourneyEnv): JourneyReply {
  switch (call.skill) {
    case "report_terms":
      return reportTerms(call, state, redactedText, outcomes, env);
    case "pick_suppliers":
      return pickSuppliers(state, outcomes, env);
    case "find_suppliers":
      return findSuppliersReply(state, env);
    case "cfo":
      return cfoReply(call.cfoView ?? "overview", state, env);
    case "status":
      return reply(partsForState(state, env), `status at ${state.stage}`);
    case "plan":
      return planReply(state, env);
    case "help":
      return reply([textPart(TEXT.help), ...stageCards(state, env)], `help at ${state.stage}`);
    case "out_of_scope":
      return reply([textPart(TEXT.outOfScope), ...stageCards(state, env)], `out_of_scope at ${state.stage}`);
  }
}
