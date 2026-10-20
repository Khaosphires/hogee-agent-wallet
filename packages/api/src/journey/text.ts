/**
 * POST /api/chat with {sessionId, message} (routes/chat.ts has already applied the text rate limit and the model
 * budget check). Redaction first (down → 502, nothing stored or sent); a quick question (core quickIntent over the
 * REDACTED text: safety, what next, who is the supplier; UX-PLAN D5) is answered from core's templates with no model
 * call; otherwise the journey stage decides:
 *   - INTAKE / NEEDS_REVIEW / FOUNDER_KEY_PENDING: the planner turn (journey/planner.ts);
 *   - later stages: agent classifySkill over the REDACTED text, the stage and the candidate count only (never web
 *     text), then core's code mapping (effectsForSkill → read-only effects → replyToSkill); the `plan` skill hands the
 *     message to the planner (a replan, signed again like the first plan). No model configured: the message is
 *     answered as `help` (the buttons still work).
 * Model text is never shown; replies are core templates and data parts. No text path reaches submitOrderTerms or a
 * signature, and no text starts a search: those answer with a button.
 * A full session (writer-bounds decideChatTurn) answers sessionFullReply before any model call; the planner and the
 * router read the newest CHAT_HISTORY_WINDOW messages, the journey's facts the projection of the whole session.
 */
import { classifySkill } from "@hogee/agent";
import { deriveJourney, effectsForSkill, plannerStage, quickIntent, quickReply, replyToSkill, type JourneyState, type Persona, type QuickIntent, type SkillCall } from "@hogee/core";
import type { ApiDeps, Scope } from "../context";
import { llmCallSink, loadHistoryParts, type StoredMessage } from "../services/chat-store";
import { requireFacility } from "../services/facility";
import { newId } from "../services/ids";
import { inTx, pool } from "../services/sql";
import { appendTrace } from "../services/traces";
import { serialized } from "../services/writer-bounds";
import { JOURNEY_ENV, journeySummary } from "./actions";
import { runEffects } from "./effects";
import { journeyView } from "./facts";
import { persistTurn, readChatHistory, refuseFullSession, stored, turnFits, type NewChatMessage } from "./persist";
import { plannerTurn, redactOrFail } from "./planner";
import { streamParts } from "./stream";

/** The router's view of the candidate list is bounded like the list itself (≤ 8 cards). */
const MAX_CANDIDATES = 8;
/** agent router CLASSIFY_MAX_CHARS (a chat message is ≤ 4,000 characters before redaction). */
const CLASSIFY_MAX_CHARS = 4_000;
const HELP: SkillCall = { skill: "help", candidateRanks: null, cfoView: null };

async function classify(deps: ApiDeps, scope: Scope, traceId: string, redacted: string, state: JourneyState, candidateCount: number): Promise<{ call: SkillCall; llmCallIds: string[] }> {
  if (!deps.agent.configured) return { call: HELP, llmCallIds: [] };
  const models = deps.agent.models({ facilityId: scope.facilityId, traceId }, llmCallSink(deps));
  const call = await classifySkill({ text: redacted.slice(0, CLASSIFY_MAX_CHARS), stage: state.stage, candidateCount: Math.min(candidateCount, MAX_CANDIDATES) }, { model: models.planner });
  return { call, llmCallIds: models.planner.records.map((r) => r.id) };
}

async function traceRouter(deps: ApiDeps, scope: Scope, traceId: string, llmCallIds: readonly string[]): Promise<void> {
  if (llmCallIds.length === 0) return;
  await inTx(deps.db, async (q) => {
    for (const llmCallId of llmCallIds) {
      await appendTrace(q, { facilityId: scope.facilityId, traceId, actor: "planner", kind: "LLM_CALL", summary: "Router model call (redacted prompt; hashes in llm_calls)", refs: { llmCallId } });
    }
  });
}

async function routedTurn(deps: ApiDeps, scope: Scope, sessionId: string, persona: Persona, redacted: string, history: readonly StoredMessage[], view: Awaited<ReturnType<typeof journeyView>>): Promise<Response> {
  const state = deriveJourney(view.facts);
  const traceId = newId("trace");
  const { call, llmCallIds } = await classify(deps, scope, traceId, redacted, state, view.list?.candidates.length ?? 0);
  // "Change my plan": the planner drafts a new plan (a replan), which the founder signs again; the compiler and the
  // constitution decide what may change, exactly as for the first plan.
  if (call.skill === "plan" && llmCallIds.length > 0) {
    await traceRouter(deps, scope, traceId, llmCallIds);
    return plannerTurn(deps, scope, sessionId, redacted, history);
  }
  const outcomes = await runEffects(deps, scope, { persona, list: view.list }, effectsForSkill(call, state));
  const reply = replyToSkill(call, state, redacted, outcomes, JOURNEY_ENV);
  const user: NewChatMessage = { id: newId("msg"), role: "user", parts: [{ type: "text", text: redacted }] };
  const assistant: NewChatMessage = { id: newId("msg"), role: "assistant", parts: stored(reply.parts) };
  await inTx(deps.db, async (q) => {
    await persistTurn(q, scope, sessionId, [user, assistant]);
    for (const llmCallId of llmCallIds) {
      await appendTrace(q, { facilityId: scope.facilityId, traceId, actor: "planner", kind: "LLM_CALL", summary: "Router model call (redacted prompt; hashes in llm_calls)", refs: { llmCallId } });
    }
    // Like a planner turn: the turn's decision is a PROPOSAL on its own trace (the model's only output is the skill).
    const summary = journeySummary(`text routed to skill ${call.skill}`, state.stage, state.stage, reply);
    await appendTrace(q, { facilityId: scope.facilityId, traceId, actor: "planner", kind: "PROPOSAL", summary });
  });
  return streamParts(assistant.id, reply.parts);
}

/**
 * A quick question (UX-PLAN D5: is my money safe, what now, who is the supplier): core's template from the journey
 * state, before the planner and the router. No model call; stored and traced like a routed turn.
 */
async function quickTurn(deps: ApiDeps, scope: Scope, sessionId: string, redacted: string, intent: QuickIntent, state: JourneyState): Promise<Response> {
  const reply = quickReply(intent, state, JOURNEY_ENV);
  const user: NewChatMessage = { id: newId("msg"), role: "user", parts: [{ type: "text", text: redacted }] };
  const assistant: NewChatMessage = { id: newId("msg"), role: "assistant", parts: stored(reply.parts) };
  await inTx(deps.db, async (q) => {
    await persistTurn(q, scope, sessionId, [user, assistant]);
    const summary = journeySummary(`text answered by the quick reply ${intent}`, state.stage, state.stage, reply);
    await appendTrace(q, { facilityId: scope.facilityId, traceId: newId("trace"), actor: "planner", kind: "PROPOSAL", summary });
  });
  return streamParts(assistant.id, reply.parts);
}

export async function chatText(deps: ApiDeps, scope: Scope, sessionId: string, message: string, persona: Persona): Promise<Response> {
  const db = pool(deps.db);
  await requireFacility(db, scope);
  const redacted = await redactOrFail(deps, message);
  return serialized(`chat:${scope.facilityId}:${sessionId}`, async () => {
    if (!(await turnFits(db, scope, sessionId))) return refuseFullSession(deps, scope, sessionId, "text");
    const history = await readChatHistory(deps, db, scope, sessionId);
    const view = await journeyView(deps, db, scope, persona, await loadHistoryParts(db, scope, sessionId));
    const state = deriveJourney(view.facts);
    const quick = quickIntent(redacted);
    if (quick) return quickTurn(deps, scope, sessionId, redacted, quick, state);
    if (plannerStage(state.stage)) return plannerTurn(deps, scope, sessionId, redacted, history);
    return routedTurn(deps, scope, sessionId, persona, redacted, history, view);
  });
}
