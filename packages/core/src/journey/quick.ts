/**
 * Quick replies (UX-PLAN D5): the things a first-time founder asks most ("is my money safe?", "what do I do now?", "who
 * is the supplier?", and, UX round 3, "what did the AI pay by itself?") are answered from templates and the journey
 * state, before the planner and the router see the text, in the live API and the mock alike. Deterministic regexes over
 * the REDACTED text; no model call.
 *
 *   - A message with a digit or a percent sign, or one over QUICK_MAX_CHARS, never matches: deal reports
 *     ("went with #2, 30% deposit, 70% on delivery") and amounts always reach the planner or report_terms.
 *   - Replies are core templates plus data parts built from ids (seller names travel only in cards that read REST,
 *     never in a text part), and never carry a signature card: a message never brings up a signature.
 */
import type { JourneyState } from "../schemas/journey";
import { reply, type JourneyReply } from "./actions";
import { hasOrder, planSigned } from "./derive";
import { nextStepText } from "./next";
import { DEFAULT_JOURNEY_ENV, candidatesPart, findSuppliers, nextPart, orderPart, searchPart, shortlistPart, stageCards, textPart, type JourneyEnv, type JourneyPart } from "./parts";
import { TEXT } from "./templates";

export type QuickIntent = "safety" | "next" | "supplier" | "ai";

export const QUICK_MAX_CHARS = 160;

const GUARD = /[0-9%]/;
const SAFETY = /\b(safe|safety|secure|security|protect(ed|s)?|protection|trust(ed)?|scam|risky?|steal|stolen|hack(ed)?|lose my money)\b/i;
const SUPPLIER = /\bwho('s| is| are)?\b.*\bsuppliers?\b|\bsuppliers?('s|s')? (name|names|contact|details|website|web page|page|link)\b|\bwhich supplier\b|\bwho (am i|are we) (buying|ordering) from\b/i;
// "What did the AI pay by itself?", "did Hogee pay anything on its own?", "what has the AI changed?" (never "it" alone,
// so a deal report like "deposit paid automatically, balance on delivery" still reaches report_terms).
const AI =
  /\b(the ai|hogee|the agent)\b[^.?!]*\b(by itself|on its own|alone|automatically|without (me|asking))\b|\bwhat (did|has) (the ai|hogee|the agent)\b[^.?!]*\b(pay|paid|do|done|change|changed|spend|spent)\b/i;
const NEXT = /\bwhat('s| is)? next\b|\bnext step\b|\bwhat (do|should|can) i do\b|\bwhat now\b|\bnow what\b|\bwhere are we\b|\bwhat happens now\b/i;

/** Which quick reply the text asks for, if any. */
export function quickIntent(redactedText: string): QuickIntent | null {
  const text = redactedText.trim();
  if (text.length === 0 || text.length > QUICK_MAX_CHARS || GUARD.test(text)) return null;
  if (SAFETY.test(text)) return "safety";
  if (SUPPLIER.test(text)) return "supplier";
  if (AI.test(text)) return "ai";
  if (NEXT.test(text)) return "next";
  return null;
}

const usedTermsId = (state: JourneyState): string | null => (state.facts.terms?.status === "USED" ? state.facts.terms.termsId : null);

function supplierParts(state: JourneyState, env: JourneyEnv): JourneyPart[] {
  const s = state.facts.search;
  const termsId = usedTermsId(state);
  if (hasOrder(state.stage) && termsId) return [textPart(TEXT.supplierOrder), orderPart(termsId)];
  if (s?.status === "READY") return [textPart(TEXT.supplier), s.origin === "catalog" ? shortlistPart(s.searchId) : candidatesPart(s.searchId)];
  if (s?.status === "PENDING") return [textPart(TEXT.stillSearching), searchPart(s.searchId)];
  if (!planSigned(state.stage)) return [textPart(TEXT.needPlanFirst)];
  return [textPart(TEXT.supplierBeforeSearch), nextPart([findSuppliers], env)];
}

/** What the caller knows beyond the journey facts. */
export interface QuickHints {
  /**
   * The founder has a passkey (created, approved or not). Absent: the facts' founderKeyActive. The mock passes it
   * because its fresh scenario counts the key as active to skip enrolment, while the web still asks for a passkey.
   */
  readonly passkeySetUp?: boolean;
}

/**
 * "What do I do now?" says what the Next step bar says (first-timer #3): before the questions, without a passkey, the
 * passkey comes first, with "Later" for a founder who has no set-up code yet; otherwise "Next: " and the stage's step.
 */
function nextText(state: JourneyState, hints: QuickHints): string {
  const passkey = hints.passkeySetUp ?? state.facts.founderKeyActive;
  return state.stage === "INTAKE" && !passkey ? TEXT.nextPasskey : nextStepText(state);
}

/**
 * "What did the AI pay by itself?" from the journey state alone: what is always true of its paying key, the order's
 * automatic deposit once the facts show it paid, and where every automatic payment is counted (the Wallet's
 * Activity). The facts hold neither a count of automatic payments nor the AI's own limit changes, so this never states
 * either: the Activity line does, from the receipts and the CFO report.
 */
function aiText(state: JourneyState): string {
  if (!planSigned(state.stage)) return TEXT.aiBeforePlan;
  return state.facts.order?.firstPaid === true ? `${TEXT.aiDeposit} ${TEXT.ai}` : TEXT.ai;
}

function partsFor(intent: QuickIntent, state: JourneyState, env: JourneyEnv, hints: QuickHints): JourneyPart[] {
  switch (intent) {
    case "safety":
      return [textPart(planSigned(state.stage) ? TEXT.safety : TEXT.safetyBeforePlan)];
    case "next":
      return [textPart(nextText(state, hints)), ...stageCards(state, env)];
    case "supplier":
      return supplierParts(state, env);
    case "ai":
      return [textPart(aiText(state))];
  }
}

/** The quick reply at a state: templated text and id-only cards, never a signature card. */
export function quickReply(intent: QuickIntent, state: JourneyState, env: JourneyEnv = DEFAULT_JOURNEY_ENV, hints: QuickHints = {}): JourneyReply {
  const parts = partsFor(intent, state, env, hints).filter((p) => p.type !== "data-sign");
  return reply(parts, `Quick reply (${intent}) at ${state.stage}`);
}
