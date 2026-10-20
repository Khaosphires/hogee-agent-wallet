/**
 * Part builders: the text and data parts an assistant message carries for a journey state. Every data part passes
 * ChatDataPart.parse here, before any caller can write it (VISION-DECISIONS §4); a part that does not parse is a bug and
 * throws. Text parts are templates only (templates.ts), never model text, seller names or listing titles.
 */
import { ChatDataPart, type DataEnquiry, type DataNeeds, type DataSign } from "../schemas/chat";
import type { CfoView, TermsPreset } from "../schemas/enums";
import type { ChatAction, JourneyState } from "../schemas/journey";
import type { TermsPrefill } from "../schemas/orders";
import type { SupplierId } from "../schemas/primitives";
import { BUTTON, CFO_BUTTON, SIGN, STAGE_TEXT, TEXT, agreedTermsWith } from "./templates";

export interface JourneyTextPart {
  readonly type: "text";
  readonly text: string;
}

/** A part of an assistant message: templated text or a chat data part. */
export type JourneyPart = JourneyTextPart | ChatDataPart;

/** Where a reply's button action ids come from (UUIDv7, single use per session). */
export interface JourneyEnv {
  readonly newActionId: () => string;
}

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** RFC 9562 UUIDv7 from the platform's crypto (Node and browsers). */
export function randomActionId(nowMs: number = Date.now()): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  for (let i = 0; i < 6; i += 1) b[i] = Number((BigInt(nowMs) >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x70;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const DEFAULT_JOURNEY_ENV: JourneyEnv = { newActionId: () => randomActionId() };

export const textPart = (text: string): JourneyTextPart => ({ type: "text", text });

const data = (type: ChatDataPart["type"], payload: unknown, id?: string): ChatDataPart =>
  ChatDataPart.parse({ type, ...(id ? { id } : {}), data: payload });

/** A button: a label and an action WITHOUT its id (the reply gives every button a fresh one). */
export type Button = { readonly label: string; readonly action: DistributiveOmit<ChatAction, "actionId"> };
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export function nextPart(buttons: readonly Button[], env: JourneyEnv): ChatDataPart {
  const actions = buttons.slice(0, 4).map((b) => ({ label: b.label, action: { ...b.action, actionId: env.newActionId() } }));
  return data("data-next", { actions });
}

export const signPart = (kind: DataSign["kind"], refId: string, card: { title: string; summary: string; cta: string }): ChatDataPart =>
  data("data-sign", { kind, refId, ...card }, `sign-${refId}`);
export const planSignPart = (draftId: string): ChatDataPart => signPart("PlanApproval", draftId, SIGN.plan);
export const supplierSignPart = (termsId: string): ChatDataPart => signPart("SupplierApproval", termsId, SIGN.supplier);
export const planDraftPart = (draftId: string): ChatDataPart => data("data-plan-draft", { draftId }, draftId);
export const needsPart = (needs: DataNeeds): ChatDataPart => data("data-needs", needs, `needs-${needs.draftId}`);
export const searchPart = (searchId: string): ChatDataPart => data("data-search", { searchId }, searchId);
export const candidatesPart = (searchId: string): ChatDataPart => data("data-candidates", { searchId }, `candidates-${searchId}`);
export const shortlistPart = (requestId: string): ChatDataPart => data("data-shortlist", { requestId }, requestId);
export const enquiryPart = (enquiry: DataEnquiry): ChatDataPart => data("data-enquiry", enquiry);
export const termsPart = (prefill: TermsPrefill): ChatDataPart => data("data-terms", prefill, `terms-prefill-${prefill.supplierId}`);

export const orderPart = (termsId: string): ChatDataPart => data("data-order", { termsId }, `order-${termsId}`);
export const cfoPart = (view: CfoView): ChatDataPart => data("data-cfo", { view });
/** On USER messages only: the button the founder pressed. */
export const actionPart = (action: ChatAction): ChatDataPart => data("data-action", { action });

// ---- buttons ----------------------------------------------------------------------------------------
export const findSuppliers: Button = { label: BUTTON.findSuppliers, action: { type: "start_search" } };
export const retrySearch: Button = { label: BUTTON.retrySearch, action: { type: "start_search" } };
export const searchWebAgain: Button = { label: BUTTON.searchWebAgain, action: { type: "start_search" } };
export const useCatalog: Button = { label: BUTTON.useCatalog, action: { type: "use_catalog" } };
export const cfoButton = (view: CfoView): Button => ({ label: CFO_BUTTON[view], action: { type: "show_cfo", view } });
export const startTerms = (supplierId: SupplierId, label: string, preset?: TermsPreset): Button => ({
  label,
  action: { type: "start_terms", supplierId, ...(preset ? { preset } : {}) },
});

/** One "I've made a deal" button per picked supplier (at most 4). */
export function agreedTermsButtons(state: JourneyState): Button[] {
  const { pickedSupplierIds: ids, pickedRanks } = state.facts;
  if (ids.length === 1 && ids[0]) return [startTerms(ids[0], BUTTON.agreedTerms)];
  return ids.slice(0, 4).map((id, i) => startTerms(id, agreedTermsWith(pickedRanks?.[i] ?? null, i + 1)));
}

// ---- a state's own parts -----------------------------------------------------------------------------
/** The sentence for a state: the stage's, or the variant its facts call for. */
export function stateText(state: JourneyState): string {
  const f = state.facts;
  // Back from a supplier order whose binding failed: say so until the founder picks or opens terms for another one.
  if (f.order?.bindFailed === true && (state.stage === "PLAN_ACTIVE" || state.stage === "CANDIDATES")) return TEXT.bindFailed;
  switch (state.stage) {
    case "NEEDS_REVIEW":
      return f.planStatus === "REVERTED" ? TEXT.planRefused : STAGE_TEXT.NEEDS_REVIEW;
    case "PLAN_ACTIVE":
      return f.search?.status === "FAILED" ? TEXT.searchFailed : STAGE_TEXT.PLAN_ACTIVE;
    case "CANDIDATES":
      return f.search?.origin === "catalog" ? TEXT.catalog : STAGE_TEXT.CANDIDATES;
    case "OPERATING":
      // UX-PLAN D35: once every payment of the order is made, say so in every later reply.
      if (f.order?.balancePaid === true) return TEXT.orderComplete;
      return f.order?.firstPaid ? TEXT.firstPaid : STAGE_TEXT.OPERATING;
    default:
      return STAGE_TEXT[state.stage];
  }
}

const usedTermsId = (state: JourneyState): string | null => (state.facts.terms?.status === "USED" ? state.facts.terms.termsId : null);

/** The cards and buttons that are the next step at a state (no text). */
export function stageCards(state: JourneyState, env: JourneyEnv = DEFAULT_JOURNEY_ENV): ChatDataPart[] {
  const f = state.facts;
  switch (state.stage) {
    case "INTAKE":
      return [];
    case "NEEDS_REVIEW":
    case "FOUNDER_KEY_PENDING":
      return f.draftId ? [planDraftPart(f.draftId), planSignPart(f.draftId)] : [];
    case "PLAN_PENDING":
      return [nextPart([findSuppliers, cfoButton("overview")], env)];
    case "PLAN_ACTIVE":
      return [nextPart(f.search?.status === "FAILED" ? [retrySearch, useCatalog] : [findSuppliers, cfoButton("overview")], env)];
    case "SEARCHING":
      return f.search ? [searchPart(f.search.searchId)] : [];
    case "CANDIDATES":
      if (!f.search) return [];
      return f.search.origin === "catalog" ? [shortlistPart(f.search.searchId), nextPart([searchWebAgain], env)] : [candidatesPart(f.search.searchId)];
    case "PICKED":
      return [nextPart(agreedTermsButtons(state), env)];
    case "TERMS_DRAFT":
      return f.termsDraft ? [nextPart([startTerms(f.termsDraft.supplierId, BUTTON.reopenTerms)], env)] : [];
    case "TERMS_CONFIRMED":
      return f.terms ? [supplierSignPart(f.terms.termsId)] : [];
    case "ORDER_PENDING":
    case "COOLING":
    case "OPERATING": {
      const termsId = usedTermsId(state);
      return [...(termsId ? [orderPart(termsId)] : []), nextPart([cfoButton("overview")], env)];
    }
  }
}

/** Where the founder is: the state's sentence and its next-step cards (a status reply). */
export function partsForState(state: JourneyState, env: JourneyEnv = DEFAULT_JOURNEY_ENV): JourneyPart[] {
  return [textPart(stateText(state)), ...stageCards(state, env)];
}

/** The stored user message for a pressed button: the label the server gave it (else actionLabel) and the action. */
export const actionUserParts = (action: ChatAction, label: string): JourneyPart[] => [textPart(label), actionPart(action)];
