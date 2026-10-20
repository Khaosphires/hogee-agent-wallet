/**
 * POST /api/chat with {sessionId, action}: a button press. No model, no redaction (an action carries ids only, no free
 * text), its own rate bucket (routes/chat.ts). The actionId is single use per session: a replay answers "already done,
 * here is where you are", runs nothing and stores nothing (a trace records it). Answers an AI SDK UI-message stream
 * like a text turn.
 *
 * Order: a full session answers sessionFullReply (nothing stored or run) → the session's history (the journey's
 * projection of the whole session, chat-store loadHistoryParts) → the press is CLAIMED (stored under the session lock
 * after re-checking its id in the database and the session's room) → facts → core effectsForAction → the effects
 * (search, catalog list, enquiry, terms pre-fill: each re-checks ids against the facility's latest list) → facts again
 * → core replyToAction → the reply is stored with a TOOL_CALL trace {journeyAction, stage}. Presses of one session
 * also run one at a time per process. No action reaches submitOrderTerms or a signature: the terms form and the sign
 * dialog are REST flows of their own.
 */
import { actionLabel, actionUserParts, alreadyDone, deriveJourney, effectsForAction, readHistory, replyToAction, type ChatAction, type HistoryMessage, type JourneyEnv, type JourneyReply, type JourneyStage, type Persona } from "@hogee/core";
import type { ApiDeps, Scope } from "../context";
import { actionIdUsed, lastSeq, loadHistoryParts } from "../services/chat-store";
import { requireFacility } from "../services/facility";
import { newId, uuidv7 } from "../services/ids";
import { inTx, pool } from "../services/sql";
import { appendTrace } from "../services/traces";
import { decideChatTurn, serialized } from "../services/writer-bounds";
import { runEffects } from "./effects";
import { journeyView } from "./facts";
import { TURN_MESSAGES, persistTurn, refuseFullSession, stored, turnFits, type NewChatMessage } from "./persist";
import { streamParts } from "./stream";

/** One hash-chained trace per chat session for its journey steps (shown on /timeline). */
export const journeyTraceId = (sessionId: string): string => `journey-${sessionId}`;

export const JOURNEY_ENV: JourneyEnv = { newActionId: () => uuidv7() };

export function journeySummary(what: string, before: JourneyStage, after: JourneyStage, reply: JourneyReply): string {
  return `Journey ${what} at ${before} → ${after}: ${reply.summary}`.slice(0, 500);
}

async function replay(deps: ApiDeps, scope: Scope, sessionId: string, action: ChatAction, persona: Persona, messages: readonly HistoryMessage[]): Promise<Response> {
  const view = await journeyView(deps, pool(deps.db), scope, persona, messages);
  const state = deriveJourney(view.facts);
  const r = alreadyDone(action, state, JOURNEY_ENV);
  await inTx(deps.db, (q) =>
    appendTrace(q, { facilityId: scope.facilityId, traceId: journeyTraceId(sessionId), actor: "founder", kind: "TOOL_CALL", summary: journeySummary(`action ${action.type} (replayed id)`, state.stage, state.stage, r) }),
  );
  return streamParts(newId("msg"), r.parts);
}

/**
 * Claims the action id: the user's press is stored first, in its own transaction under the session's advisory lock,
 * after re-checking there that the id is unused (in the database, over the whole session) and that the session has
 * room for the press and its reply (so two processes cannot both run it, nor pass the cap). Only a claimed press runs
 * its effects; if anything fails after the claim, the id stays used and a retry is a replay (fail closed).
 */
async function claim(deps: ApiDeps, scope: Scope, sessionId: string, action: ChatAction, user: NewChatMessage): Promise<"claimed" | "used" | "full"> {
  return inTx(deps.db, async (q) => {
    await q.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`chat:${scope.facilityId}:${sessionId}`]);
    if (await actionIdUsed(q, scope, sessionId, action.actionId)) return "used";
    if ("refuse" in decideChatTurn(await lastSeq(q, scope, sessionId), TURN_MESSAGES)) return "full";
    await persistTurn(q, scope, sessionId, [user]);
    return "claimed";
  });
}

async function press(deps: ApiDeps, scope: Scope, sessionId: string, action: ChatAction, persona: Persona): Promise<Response> {
  const db = pool(deps.db);
  if (!(await turnFits(db, scope, sessionId))) return refuseFullSession(deps, scope, sessionId, `action ${action.type}`);
  const messages = await loadHistoryParts(db, scope, sessionId);
  const history = readHistory(messages);
  if (history.usedActionIds.has(action.actionId)) return replay(deps, scope, sessionId, action, persona, messages);
  const user: NewChatMessage = { id: newId("msg"), role: "user", parts: stored(actionUserParts(action, history.buttonLabel(action.actionId) ?? actionLabel(action))) };
  const claimed = await claim(deps, scope, sessionId, action, user);
  if (claimed === "used") return replay(deps, scope, sessionId, action, persona, await loadHistoryParts(db, scope, sessionId));
  if (claimed === "full") return refuseFullSession(deps, scope, sessionId, `action ${action.type}`);
  const withUser = [...messages, user];
  const first = await journeyView(deps, db, scope, persona, withUser);
  const before = deriveJourney(first.facts);
  const effects = effectsForAction(action, before);
  const outcomes = await runEffects(deps, scope, { persona, list: first.list }, effects);
  const after = effects.length > 0 ? deriveJourney((await journeyView(deps, db, scope, persona, withUser)).facts) : before;
  const reply = replyToAction(action, after, outcomes, JOURNEY_ENV);
  const assistant: NewChatMessage = { id: newId("msg"), role: "assistant", parts: stored(reply.parts) };
  await inTx(deps.db, async (q) => {
    await persistTurn(q, scope, sessionId, [assistant]);
    await appendTrace(q, { facilityId: scope.facilityId, traceId: journeyTraceId(sessionId), actor: "founder", kind: "TOOL_CALL", summary: journeySummary(`action ${action.type}`, before.stage, after.stage, reply) });
  });
  return streamParts(assistant.id, reply.parts);
}

export async function chatAction(deps: ApiDeps, scope: Scope, sessionId: string, action: ChatAction, persona: Persona): Promise<Response> {
  await requireFacility(pool(deps.db), scope);
  return serialized(`chat:${scope.facilityId}:${sessionId}`, () => press(deps, scope, sessionId, action, persona));
}
