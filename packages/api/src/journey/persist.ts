/**
 * Chat persistence for the journey (VISION-DECISIONS §4):
 *   - writes: every data part passes core ChatDataPart.parse BEFORE it is written, a text part is plain text, and a
 *     data-action rides on a user message only. A part that fails is a server bug: the write is refused (502) and
 *     nothing of the turn is stored;
 *   - reads: a stored part that no longer parses (an older shape, a hand-edited row) is dropped and traced once per
 *     message instead of failing the whole history, so GET /api/chat never breaks. Reads see the newest
 *     CHAT_HISTORY_WINDOW messages (chat-store loadMessages);
 *   - a full session (writer-bounds decideChatTurn): the turn answers core sessionFullReply, stores nothing, and the
 *     session's first refusal leaves one ALERT (audit run-9 lead 2).
 */
import { ChatDataPart, ChatOtherPart, sessionFullReply } from "@hogee/core";
import type { ApiDeps, Scope } from "../context";
import { fail } from "../http/problem";
import { CHAT_SESSION_FULL, appendMessages, lastSeq, loadMessages, type StoredMessage } from "../services/chat-store";
import { newId } from "../services/ids";
import { pool, rows, type Q } from "../services/sql";
import { appendTrace } from "../services/traces";
import { chatFullTraceId, decideChatTurn } from "../services/writer-bounds";
import { streamParts } from "./stream";

/** A message to append (the store assigns `seq`). */
export type NewChatMessage = Omit<StoredMessage, "seq">;

/** Parts as the store keeps them (plain JSON objects). */
export const stored = (parts: readonly object[]): Record<string, unknown>[] => parts.map((p) => ({ ...p }) as Record<string, unknown>);

type Part = Record<string, unknown>;

/** Why a part may not be stored, or null when it may. */
function partProblem(role: string, p: unknown): string | null {
  if (typeof p !== "object" || p === null) return "not an object";
  const type = (p as Part).type;
  if (typeof type !== "string") return "no type";
  if (type === "text") return typeof (p as Part).text === "string" && Object.keys(p).length === 2 ? null : "malformed text part";
  if (type.startsWith("data-")) {
    if (!ChatDataPart.safeParse(p).success) return `${type} does not parse`;
    return type === "data-action" && role !== "user" ? "data-action on a non-user message" : null;
  }
  return ChatOtherPart.safeParse(p).success ? null : "malformed part";
}

/** Throws (UPSTREAM) on the first part that may not be written; nothing is stored then. */
export function assertWritable(messages: readonly NewChatMessage[]): void {
  for (const m of messages) {
    for (const p of m.parts) {
      const problem = partProblem(m.role, p);
      if (problem) throw fail("UPSTREAM", "The reply could not be stored, so nothing was saved. Try again.", { details: { reason: "CHAT_PART_INVALID" } });
    }
  }
}

export async function persistTurn(q: Q, scope: Scope, sessionId: string, messages: readonly NewChatMessage[], intent?: unknown): Promise<void> {
  assertWritable(messages);
  await appendMessages(q, scope, sessionId, messages, intent);
}

const historyTraceId = (messageId: string): string => `chat-parts-${messageId}`.slice(0, 128);

async function traceDropped(deps: ApiDeps, q: Q, scope: Scope, m: StoredMessage, problems: readonly string[]): Promise<void> {
  try {
    const traceId = historyTraceId(m.id);
    const [seen] = await rows<{ n: number }>(q, "select count(*)::int as n from traces where facility_id = $1 and trace_id = $2", [scope.facilityId, traceId]);
    if ((seen?.n ?? 0) > 0) return;
    const summary = `Chat history: dropped ${problems.length} stored part(s) of message ${m.id} that failed validation (${[...new Set(problems)].join("; ")})`;
    await appendTrace(deps.db, { facilityId: scope.facilityId, traceId, actor: "reconciler", kind: "ALERT", summary });
  } catch {
    deps.log.warn("chat_history_trace_failed", { messageId: m.id });
  }
}

/** The session's history with every invalid stored part dropped (and traced once per message). */
export async function readChatHistory(deps: ApiDeps, q: Q, scope: Scope, sessionId: string): Promise<StoredMessage[]> {
  const loaded = await loadMessages(q, scope, sessionId);
  const out: StoredMessage[] = [];
  for (const m of loaded) {
    const problems = m.parts.map((p) => partProblem(m.role, p)).filter((x): x is string => x !== null);
    if (problems.length === 0) {
      out.push(m);
      continue;
    }
    deps.log.warn("chat_history_parts_dropped", { messageId: m.id, count: problems.length });
    await traceDropped(deps, q, scope, m, problems);
    out.push({ ...m, parts: m.parts.filter((p) => partProblem(m.role, p) === null) });
  }
  return out;
}

/** Messages a chat turn stores: the founder's (text or press) and the reply. */
export const TURN_MESSAGES = 2;

/** The session still has room for a turn (writer-bounds decideChatTurn on its stored message count). */
export async function turnFits(q: Q, scope: Scope, sessionId: string): Promise<boolean> {
  return "create" in decideChatTurn(await lastSeq(q, scope, sessionId), TURN_MESSAGES);
}

/**
 * A turn in a full session: core sessionFullReply (one sentence, no card or button), nothing stored, nothing run. Only
 * the session's first refusal is traced, so refused turns cannot grow the trace table; a trace that cannot be written
 * is logged and the refusal stands.
 */
export async function refuseFullSession(deps: ApiDeps, scope: Scope, sessionId: string, what: string): Promise<Response> {
  const r = sessionFullReply();
  deps.log.warn("chat_session_full", { what });
  try {
    const traceId = chatFullTraceId(sessionId);
    const [seen] = await rows<{ n: number }>(pool(deps.db), "select count(*)::int as n from traces where facility_id = $1 and trace_id = $2", [scope.facilityId, traceId]);
    if ((seen?.n ?? 0) === 0) {
      await appendTrace(deps.db, { facilityId: scope.facilityId, traceId, actor: "planner", kind: "ALERT", reasonCode: CHAT_SESSION_FULL, summary: `${r.summary} (first refused turn: ${what})` });
    }
  } catch {
    deps.log.warn("chat_session_full_trace_failed", { what });
  }
  return streamParts(newId("msg"), r.parts);
}
