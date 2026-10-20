/**
 * The mock chat journey (VISION-DECISIONS §7): the same core journey as the live API (core deriveJourney, replies,
 * templates), over facts from the in-memory store, with the mock's effects and a regex router in place of the model.
 *   - mockChatAction: a button's ChatAction, single use per session (a replay answers "already done" and stores
 *     nothing), traced as a TOOL_CALL like live;
 *   - mockJourneyText: typed text. A quick question (core quickIntent: safety, what next, who is the supplier, what the
 *     AI paid by itself) gets its template first, at any stage; otherwise intake replays the scripted questions
 *     (chat-script.ts, Mei for SG) and then the plan reply (+ the needs card and the PlanApproval card); after the plan,
 *     the regex router (classify.ts) and core's code mapping. Used for MOCK_SCENARIO=fresh and lived in SG. A lived
 *     session starts with the sample business's history on its first POST (store.ts openChat; a GET reads it, chatHistory);
 *   - mockCannedQuick: the default scenario (and Malaysia) keep the canned script (chat.ts), except that a quick
 *     question or a CFO question ("how are we doing?") gets the same templated answer first (first-timer #30).
 * Presses and messages of one session run one at a time. A session holds at most core CHAT_SESSION_MAX_MESSAGES
 * messages, as live (audit run-9 lead 2): a turn that would pass it answers core sessionFullReply, stores and runs
 * nothing, and the session's first refusal leaves one ALERT (`refuseFullSession`, also used by the canned script).
 */
import {
  examplePasskeyRegistrationResult,
  actionLabel,
  actionUserParts,
  alreadyDone,
  deriveJourney,
  effectsForAction,
  effectsForSkill,
  journeyFactsOf,
  needsPart,
  partsForState,
  planSignPart,
  plannerStage,
  quickIntent,
  quickReply,
  readHistory,
  replyToAction,
  replyToSkill,
  sessionFull,
  sessionFullReply,
  textPart,
  TEXT,
  type ChatAction,
  type ChatMessage,
  type JourneyEnv,
  type JourneyFacts,
  type JourneyPart,
  type JourneyReply,
  type JourneyState,
  type Persona,
  type QuickHints,
  type QuickIntent,
  type SkillCall,
} from "@hogee/core";
import { CHAT_SCRIPTS, type ChatPart } from "../chat-script";
import { readEnv, type MockEnv } from "../env";
import type { Failure } from "../result";
import { appendTrace, chatHistory, nextId, openChat, uuidV7, type ChatSession, type MockState } from "../store";
import { classifyByRules } from "./classify";
import { runMockEffects } from "./effects";
import { mockNeeds } from "./needs";
import { mockSourceFacts } from "./facts";
import { streamReply } from "./stream";

const queues = new Map<string, Promise<unknown>>();
async function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  try {
    return await run;
  } finally {
    if (queues.get(key) === tail) queues.delete(key);
  }
}

/** The session a turn writes to, started if new (a lived session with the sample's history: store.ts openChat). */
const session = (st: MockState, sessionId: string): ChatSession => openChat(st, sessionId);

const envOf = (st: MockState): JourneyEnv => ({ newActionId: () => uuidV7(st) });

/** Messages a chat turn stores: the founder's (text or press) and the reply. */
const TURN_MESSAGES = 2;

/** The session cannot take another turn (as live writer-bounds decideChatTurn). */
export const mockSessionFull = (st: MockState, sessionId: string): boolean => sessionFull(st.chats.get(sessionId)?.messages.length ?? 0, TURN_MESSAGES);

/** A turn in a full session: the templated sentence, nothing stored; only the session's first refusal is traced. */
export function refuseFullSession(st: MockState, sessionId: string, what: string, delayMs?: number): Response {
  const r = sessionFullReply();
  const traceId = `chat-full-${sessionId}`;
  if (!st.traces.some((t) => t.traceId === traceId)) {
    appendTrace(st, { traceId, actor: "planner", kind: "ALERT", reasonCode: "CHAT_SESSION_FULL", summary: `${r.summary} (first refused turn: ${what})`.slice(0, 500), refs: {} });
  }
  return streamReply(nextId(st, "msg"), r.parts, delayMs);
}
const toChat = (id: string, role: "user" | "assistant", parts: readonly JourneyPart[] | readonly ChatPart[]): ChatMessage => ({ id, role, parts: parts.map((p) => ({ ...p })) as ChatMessage["parts"] });

async function view(st: MockState, env: MockEnv, sessionId: string, persona: Persona, extra: readonly ChatMessage[] = []) {
  // A read: a lived session not started yet reads as the sample's history, and nothing is stored (store.ts chatHistory).
  const history = readHistory([...(chatHistory(st, sessionId) ?? []), ...extra]);
  const src = await mockSourceFacts(st, env, persona, history);
  return { facts: journeyFactsOf(src, history), list: src.list, history };
}

/** JourneyFacts of a session in the mock (async: the facts read the feature handlers). */
export async function mockJourneyFacts(st: MockState, sessionId: string, persona: Persona): Promise<JourneyFacts> {
  return (await view(st, readEnv(), sessionId, persona)).facts;
}

/** A press's reply, and the press's TOOL_CALL on the session's journey trace (as live). */
function store(st: MockState, sessionId: string, messages: readonly ChatMessage[], summary: string): void {
  session(st, sessionId).messages.push(...messages);
  appendTrace(st, { traceId: `journey-${sessionId}`, actor: "founder", kind: "TOOL_CALL", summary: summary.slice(0, 500), refs: {} });
}

const summaryOf = (what: string, before: JourneyState, after: JourneyState, reply: JourneyReply) => `Journey ${what} at ${before.stage} → ${after.stage}: ${reply.summary}`;

async function press(st: MockState, sessionId: string, action: ChatAction): Promise<Response> {
  if (mockSessionFull(st, sessionId)) return refuseFullSession(st, sessionId, `action ${action.type}`);
  const env = readEnv();
  const persona = st.profile.founderPersona;
  const first = await view(st, env, sessionId, persona);
  if (first.history.usedActionIds.has(action.actionId)) {
    const state = deriveJourney(first.facts);
    const r = alreadyDone(action, state, envOf(st));
    appendTrace(st, { traceId: `journey-${sessionId}`, actor: "founder", kind: "TOOL_CALL", summary: summaryOf(`action ${action.type} (replayed id)`, state, state, r).slice(0, 500), refs: {} });
    return streamReply(nextId(st, "msg"), r.parts);
  }
  // Claim the id first (as live): the press is stored before its effects run, so a failure later never frees it.
  session(st, sessionId).messages.push(toChat(nextId(st, "msg"), "user", actionUserParts(action, first.history.buttonLabel(action.actionId) ?? actionLabel(action))));
  const before = await view(st, env, sessionId, persona);
  const beforeState = deriveJourney(before.facts);
  const effects = effectsForAction(action, beforeState);
  const outcomes = await runMockEffects({ st, env, persona, list: before.list }, effects);
  const after = effects.length > 0 ? deriveJourney((await view(st, env, sessionId, persona)).facts) : beforeState;
  const reply = replyToAction(action, after, outcomes, envOf(st));
  const assistant = toChat(nextId(st, "msg"), "assistant", reply.parts);
  store(st, sessionId, [assistant], summaryOf(`action ${action.type}`, beforeState, after, reply));
  return streamReply(assistant.id, reply.parts);
}

/** A UI-message stream answering the action. */
export function mockChatAction(st: MockState, sessionId: string, action: ChatAction): Promise<Response | Failure> {
  return oneAtATime(`chat:${sessionId}`, () => press(st, sessionId, action));
}

/** The scripted intake turn: the questions, then the plan reply with the needs card and the PlanApproval card. */
function intakeReply(st: MockState, s: ChatSession, state: JourneyState): JourneyReply {
  const script = CHAT_SCRIPTS[st.profile.country];
  const turn = script.turns[s.turn];
  const plan = s.turn === script.turns.length - 2;
  if (!turn || s.turn >= script.turns.length - 1) return { parts: partsForState(state, envOf(st)), summary: `Intake done; status at ${state.stage}` };
  s.turn += 1;
  const draft = st.loaded.scenario["plan-draft.json"];
  const parts = turn.parts({ draft, shortlistRequestId: st.loaded.scenario["shortlist.json"].requestId }) as JourneyPart[];
  // As live (planCards): the needs card only when it can be vouched for; the PlanApproval card always.
  const checklist = plan ? mockNeeds(st, readEnv(), draft) : undefined;
  const cards = plan ? [...(checklist ? [needsPart(checklist)] : []), planSignPart(draft.draftId)] : [];
  return { parts: [textPart(turn.text), ...parts, ...cards], summary: plan ? `Scripted plan reply (draft ${draft.draftId})` : `Scripted intake question ${s.turn}` };
}

/**
 * QuickHints from the store: the founder made a passkey (pending or registered, never the seeded core example or a
 * rejected one). The fresh scenario's facts count the key as active to skip enrolment, but the web still asks for one.
 */
const quickHints = (st: MockState): QuickHints => ({
  passkeySetUp: [...st.founderKeys.values()].some(
    (k) => !st.rejectedFounderKeys.has(k.credentialId) && (k.onchain === "REGISTERED" || k.credentialId !== examplePasskeyRegistrationResult.credentialId),
  ),
});

async function say(st: MockState, sessionId: string, message: string, delayMs: number): Promise<Response> {
  if (mockSessionFull(st, sessionId)) return refuseFullSession(st, sessionId, "text", delayMs);
  const env = readEnv();
  const persona = st.profile.founderPersona;
  const s = session(st, sessionId);
  const user = toChat(nextId(st, "msg"), "user", [textPart(message)]);
  const v = await view(st, env, sessionId, persona);
  const state = deriveJourney(v.facts);
  let reply: JourneyReply;
  // UX-PLAN D5, as live: "is my money safe?", "what now?", "who is the supplier?" get a template before the script or
  // the router (a quick reply never advances the scripted intake).
  const quick = quickIntent(message);
  if (quick) reply = quickReply(quick, state, envOf(st), quickHints(st));
  else if (plannerStage(state.stage)) reply = intakeReply(st, s, state);
  else {
    const call = classifyByRules(message, Math.min(v.list?.candidates.length ?? 0, 8));
    const outcomes = await runMockEffects({ st, env, persona, list: v.list }, effectsForSkill(call, state));
    reply = replyToSkill(call, state, message, outcomes, envOf(st));
  }
  const assistant = toChat(nextId(st, "msg"), "assistant", reply.parts);
  s.messages.push(user, assistant);
  // Like live: a text turn's decision is a planner PROPOSAL on its own trace; the journey trace holds the presses.
  appendTrace(st, { traceId: nextId(st, "trace"), actor: "planner", kind: "PROPOSAL", summary: summaryOf("text", state, state, reply).slice(0, 500), refs: {} });
  return streamReply(assistant.id, reply.parts, delayMs);
}

/** What a canned-scenario message gets from templates: a quick reply, or the CFO view the router names. */
type CannedTemplate = { readonly intent: QuickIntent } | { readonly cfo: SkillCall };

/**
 * The quick reply in a canned scenario. "Who is my supplier?" points to the Suppliers page: the seeded orders are not in
 * the chat's own history, so the journey's "you haven't picked a supplier yet" would be wrong there.
 */
function cannedQuickReply(intent: QuickIntent, state: JourneyState, st: MockState): JourneyReply {
  if (intent === "supplier") return { parts: [textPart(TEXT.supplierPage)], summary: `Quick reply (supplier) at ${state.stage}: the Suppliers page (canned scenario)` };
  return quickReply(intent, state, envOf(st), quickHints(st));
}

async function cannedTemplate(st: MockState, sessionId: string, message: string, t: CannedTemplate, delayMs: number): Promise<Response> {
  const s = session(st, sessionId);
  const state = deriveJourney((await view(st, readEnv(), sessionId, st.profile.founderPersona)).facts);
  const reply = "cfo" in t ? replyToSkill(t.cfo, state, message, {}, envOf(st)) : cannedQuickReply(t.intent, state, st);
  const assistant = toChat(nextId(st, "msg"), "assistant", reply.parts);
  // The canned script's place (s.turn) stays: a template answer never advances it.
  s.messages.push(toChat(nextId(st, "msg"), "user", [textPart(message)]), assistant);
  appendTrace(st, { traceId: nextId(st, "trace"), actor: "planner", kind: "PROPOSAL", summary: summaryOf("text (canned scenario)", state, state, reply).slice(0, 500), refs: {} });
  return streamReply(assistant.id, reply.parts, delayMs);
}

/**
 * Typed text in the canned scenarios (default, Malaysia), first-timer #30: "is my money safe?", "what do I do now?",
 * "who is my supplier?", "what did the AI pay by itself?" (core quickIntent) and the CFO questions ("how are we
 * doing?", the router's cfo skill) get the journey's templated answer at the current stage, before the canned script.
 * Null: anything else, which the canned script answers.
 */
export function mockCannedQuick(st: MockState, sessionId: string, message: string, delayMs = 18): Promise<Response> | null {
  const intent = quickIntent(message);
  const call = intent ? null : classifyByRules(message, 0);
  const t: CannedTemplate | null = intent ? { intent } : call?.skill === "cfo" ? { cfo: call } : null;
  return t ? oneAtATime(`chat:${sessionId}`, () => cannedTemplate(st, sessionId, message, t, delayMs)) : null;
}

/** A UI-message stream answering typed text in the journey (MOCK_SCENARIO=fresh or lived). */
export function mockJourneyText(st: MockState, sessionId: string, message: string, delayMs = 18): Promise<Response> {
  return oneAtATime(`chat:${sessionId}`, () => say(st, sessionId, message, delayMs));
}

/** Typed text runs the journey in the fresh and lived (sample business) SG scenarios; elsewhere the canned script plays (chat.ts). */
export const journeyTextOn = (st: MockState): boolean => st.scenario !== "default" && st.profile.country === "SG";
