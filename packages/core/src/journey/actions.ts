/**
 * The action → reply mapping (a button press skips the model and redaction, VISION-DECISIONS §9). Two pure steps:
 *   1. effectsForAction(action, state BEFORE): which effects the press needs (none when it is not allowed here);
 *   2. replyToAction(action, state AFTER the effects, outcomes): the templated reply.
 * A button's action carries ids only (no free text), and the server re-checks every id against its own facts; the
 * `signed` action is a hint, so its reply comes from the re-derived state. A replayed actionId is answered by
 * alreadyDone (the caller knows the session's used ids) and runs nothing.
 */
import type { CfoView, TermsPreset } from "../schemas/enums";
import type { ChatAction, JourneyState } from "../schemas/journey";
import type { TermsPrefill } from "../schemas/orders";
import { TERMS_PRESET_MILESTONES } from "../schemas/orders";
import { hasOrder, planSigned } from "./derive";
import type { EffectOutcomes, JourneyEffect, PresetCheck } from "./effects";
import {
  DEFAULT_JOURNEY_ENV,
  candidatesPart,
  cfoButton,
  cfoPart,
  enquiryPart,
  agreedTermsButtons,
  nextPart,
  orderPart,
  partsForState,
  retrySearch,
  searchPart,
  searchWebAgain,
  shortlistPart,
  stageCards,
  supplierSignPart,
  termsPart,
  textPart,
  useCatalog,
  type JourneyEnv,
  type JourneyPart,
} from "./parts";
import { CFO_TEXT, FAILURE_TEXT, STAGE_TEXT, TEXT } from "./templates";

export interface JourneyReply {
  readonly parts: readonly JourneyPart[];
  /** Trace summary (≤ 500 chars, no seller names). */
  readonly summary: string;
}

const SUMMARY_MAX = 500;
export const reply = (parts: readonly JourneyPart[], summary: string): JourneyReply => ({ parts, summary: summary.slice(0, SUMMARY_MAX) });

/** A sentence, then where the founder is. */
export const withState = (lead: string, state: JourneyState, env: JourneyEnv): JourneyPart[] => [textPart(lead), ...partsForState(state, env)];

/** The live web search the facts show (pick and terms need a READY web search). */
export const webSearchReady = (state: JourneyState, searchId: string): boolean =>
  state.facts.search?.searchId === searchId && state.facts.search.status === "READY" && state.facts.search.origin === "web";

/** The effects a press needs, judged on the state BEFORE it (none: not allowed here, or nothing to fetch). */
export function effectsForAction(action: ChatAction, state: JourneyState): JourneyEffect[] {
  const f = state.facts;
  switch (action.type) {
    case "start_search":
      return planSigned(state.stage) ? [{ kind: "START_SEARCH", ...(action.quantity !== undefined ? { quantity: action.quantity } : {}) }] : [];
    case "use_catalog":
      return planSigned(state.stage) ? [{ kind: "USE_CATALOG" }] : [];
    case "pick":
      return webSearchReady(state, action.searchId) ? [{ kind: "ENQUIRY", searchId: action.searchId, supplierIds: action.supplierIds }] : [];
    case "start_terms":
      if (hasOrder(state.stage) || !f.search || !webSearchReady(state, f.search.searchId)) return [];
      return [{ kind: "TERMS_PREFILL", searchId: f.search.searchId, supplier: { supplierId: action.supplierId } }];
    case "show_candidates":
    case "terms_saved":
    case "signed":
    case "show_cfo":
      return [];
  }
}

/**
 * The pre-fill for a start_terms button: the preset it names (the form re-checks every split against the total the
 * founder enters; `presetAvailability` is only the estimate at the listed price), else nothing pre-filled.
 */
export function presetPrefill(supplierId: string, searchId: string | null, availability: readonly PresetCheck[], preset: TermsPreset | undefined): TermsPrefill {
  return {
    supplierId,
    searchId,
    milestones: preset ? TERMS_PRESET_MILESTONES[preset].map((m) => ({ ...m })) : null,
    preset: preset ?? null,
    source: preset ? "preset" : "none",
    question: null,
    presetAvailability: availability.map((a) => ({ ...a })),
  };
}

function onStartSearch(state: JourneyState, out: EffectOutcomes, env: JourneyEnv): JourneyReply {
  const o = out.search;
  if (!o) return reply(withState(TEXT.needPlanFirst, state, env), `start_search refused at ${state.stage}: plan not signed`);
  if (!o.ok) return reply([textPart(FAILURE_TEXT[o.reason]), nextPart([retrySearch, useCatalog], env)], `start_search refused (${o.reason})`);
  return reply([textPart(TEXT.searchStarted), searchPart(o.value.searchId)], `Web supplier search ${o.value.searchId} started`);
}

function onUseCatalog(state: JourneyState, out: EffectOutcomes, env: JourneyEnv): JourneyReply {
  const o = out.catalog;
  if (!o) return reply(withState(TEXT.needPlanFirst, state, env), `use_catalog refused at ${state.stage}: plan not signed`);
  if (!o.ok) return reply([textPart(FAILURE_TEXT[o.reason]), nextPart([retrySearch], env)], `Catalog shortlist refused (${o.reason})`);
  const lead = o.value.status === "PENDING" ? TEXT.catalogWaiting : TEXT.catalogReady;
  return reply([textPart(lead), shortlistPart(o.value.requestId), nextPart([searchWebAgain], env)], `Catalog shortlist ${o.value.requestId} (${o.value.status})`);
}

function onShowCandidates(action: ChatAction & { type: "show_candidates" }, state: JourneyState, env: JourneyEnv): JourneyReply {
  const s = state.facts.search;
  if (!s || s.searchId !== action.searchId) return reply(withState(TEXT.stale, state, env), `show_candidates for an old search at ${state.stage}`);
  if (s.status === "PENDING") return reply([textPart(TEXT.stillSearching), searchPart(s.searchId)], `Search ${s.searchId} still running`);
  if (s.status === "FAILED") return reply([textPart(TEXT.searchFailed), nextPart([retrySearch, useCatalog], env)], `Search ${s.searchId} failed`);
  if (s.origin === "catalog") return reply([textPart(TEXT.catalog), shortlistPart(s.searchId), nextPart([searchWebAgain], env)], `Catalog list ${s.searchId} shown`);
  return reply([textPart(STAGE_TEXT.CANDIDATES), candidatesPart(s.searchId)], `Candidates of search ${s.searchId} shown`);
}

function onPick(action: ChatAction & { type: "pick" }, state: JourneyState, out: EffectOutcomes, env: JourneyEnv): JourneyReply {
  const o = out.enquiry;
  if (!o) {
    const lead = state.facts.search?.origin === "catalog" && state.facts.search.searchId === action.searchId ? TEXT.catalogPick : TEXT.stale;
    return reply(withState(lead, state, env), `pick refused at ${state.stage}: not the live web search`);
  }
  if (!o.ok) return reply(withState(FAILURE_TEXT[o.reason], state, env), `pick refused (${o.reason})`);
  return reply([textPart(TEXT.enquiry), enquiryPart(o.value), nextPart(agreedTermsButtons(state), env)], `Picked ${action.supplierIds.length} supplier(s); enquiry drafted`);
}

function onStartTerms(action: ChatAction & { type: "start_terms" }, state: JourneyState, out: EffectOutcomes, env: JourneyEnv): JourneyReply {
  if (hasOrder(state.stage)) return reply(withState(TEXT.termsLocked, state, env), `start_terms refused at ${state.stage}: order signed`);
  const o = out.prefill;
  if (!o) return reply(withState(TEXT.notYet, state, env), `start_terms refused at ${state.stage}`);
  if (!o.ok) return reply(withState(FAILURE_TEXT[o.reason], state, env), `start_terms refused (${o.reason})`);
  const prefill = presetPrefill(o.value.supplierId, state.facts.search?.searchId ?? null, o.value.availability, action.preset);
  const fits = o.value.availability.some((a) => a.preset === action.preset && a.ok);
  const lead = !action.preset ? TEXT.termsForm : fits ? TEXT.termsPreset : TEXT.termsPresetCheck;
  return reply([textPart(lead), termsPart(prefill)], `Terms form opened (${prefill.source}${prefill.preset ? ` ${prefill.preset}` : ""})`);
}

function onTermsSaved(action: ChatAction & { type: "terms_saved" }, state: JourneyState, env: JourneyEnv): JourneyReply {
  const t = state.facts.terms;
  if (t?.termsId === action.termsId && t.status === "CONFIRMED") {
    return reply([textPart(TEXT.termsSaved), supplierSignPart(t.termsId)], `Terms ${t.termsId} saved; SupplierApproval offered`);
  }
  if (t?.termsId === action.termsId && t.status === "USED") return reply(withState(TEXT.alreadyDone, state, env), `terms_saved for terms already in an order`);
  return reply(withState(TEXT.termsMissing, state, env), `terms_saved for terms the server does not show as confirmed`);
}

function onSigned(action: ChatAction & { type: "signed" }, state: JourneyState, env: JourneyEnv): JourneyReply {
  const f = state.facts;
  if (action.kind === "PlanApproval") {
    if (f.planStatus === "SUBMITTED") return reply([textPart(TEXT.planSigned), ...stageCards(state, env)], "PlanApproval signed; plan submitted");
    if (f.planStatus === "COMMITTED" && planSigned(state.stage)) return reply([textPart(TEXT.planLive), ...stageCards(state, env)], "PlanApproval signed; plan committed");
    return reply(withState(TEXT.signatureNotSeen, state, env), `PlanApproval hint not reflected yet (${state.stage})`);
  }
  if (action.kind === "SupplierApproval") {
    const termsId = f.terms?.status === "USED" ? f.terms.termsId : null;
    if (hasOrder(state.stage) && termsId === action.refId) {
      return reply([textPart(TEXT.orderSigned), orderPart(termsId), nextPart([cfoButton("overview")], env)], `SupplierApproval signed for ${termsId} (${state.stage})`);
    }
    return reply(withState(TEXT.signatureNotSeen, state, env), `SupplierApproval hint not reflected yet (${state.stage})`);
  }
  if (action.kind === "MilestoneRelease" && f.order?.orderId === action.refId) {
    // UX-PLAN D35: never "the balance waits" right after Mei signed to pay it. rcfix-journey A-6: "Signed" only once the
    // server holds her release (the facts' releaseSigned), as PlanApproval and SupplierApproval check theirs.
    if (f.order.balancePaid === true) return reply([textPart(TEXT.orderComplete), ...stageCards(state, env)], `MilestoneRelease signed for ${action.refId} (balance paid)`);
    if (f.order.releaseSigned === true) return reply([textPart(TEXT.releaseSigned), ...stageCards(state, env)], `MilestoneRelease signed for ${action.refId} (balance saving)`);
    return reply(withState(TEXT.signatureNotSeen, state, env), `MilestoneRelease hint not reflected yet (${state.stage})`);
  }
  return reply(withState(TEXT.signatureNoted, state, env), `${action.kind} signed (hint)`);
}

/** A CFO view (the card reads getCfoReport), with buttons for two other views. Before a signed plan: not yet. */
export function cfoReply(view: CfoView, state: JourneyState, env: JourneyEnv): JourneyReply {
  if (!planSigned(state.stage)) return reply(withState(TEXT.cfoLater, state, env), `CFO view ${view} asked before a signed plan (${state.stage})`);
  const others = (["overview", "forecast", "reserve"] as const).filter((v) => v !== view).slice(0, 2).map(cfoButton);
  return reply([textPart(CFO_TEXT[view]), cfoPart(view), nextPart(others, env)], `CFO view ${view} shown`);
}

/**
 * The reply to a press, from the state AFTER its effects ran and their outcomes. Every reply ends in a next step: a
 * card the founder acts on or data-next buttons.
 */
export function replyToAction(action: ChatAction, state: JourneyState, outcomes: EffectOutcomes = {}, env: JourneyEnv = DEFAULT_JOURNEY_ENV): JourneyReply {
  switch (action.type) {
    case "start_search":
      return onStartSearch(state, outcomes, env);
    case "use_catalog":
      return onUseCatalog(state, outcomes, env);
    case "show_candidates":
      return onShowCandidates(action, state, env);
    case "pick":
      return onPick(action, state, outcomes, env);
    case "start_terms":
      return onStartTerms(action, state, outcomes, env);
    case "terms_saved":
      return onTermsSaved(action, state, env);
    case "signed":
      return onSigned(action, state, env);
    case "show_cfo":
      return cfoReply(action.view, state, env);
  }
}

/**
 * A replayed actionId: nothing runs again; say so and show where the founder is, without a signature card (a replay
 * never prompts a signature).
 */
export function alreadyDone(action: ChatAction, state: JourneyState, env: JourneyEnv = DEFAULT_JOURNEY_ENV): JourneyReply {
  const parts = withState(TEXT.alreadyDone, state, env).filter((p) => p.type !== "data-sign");
  return reply(parts, `Replayed ${action.type} action ignored at ${state.stage}`);
}
