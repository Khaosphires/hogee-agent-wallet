/**
 * Chat persistence (§7.1, §7.4, §12.1): the append-only conversation log (REDACTED text only), agent memory with
 * provenance, and the LLM call log. Every query is facility-scoped; a session id is client-generated, so it is only
 * ever looked up together with the server's facility id (T31).
 *
 * Bounded (audit run-9 lead 2): a session holds at most CHAT_SESSION_MAX_MESSAGES messages (appendMessages refuses
 * past it, under the session lock), and no read loads a whole session's messages: `loadMessages` reads the newest
 * CHAT_HISTORY_WINDOW, `loadHistoryParts` only the parts the journey reads (core HISTORY_PART_TYPES), and
 * `actionIdUsed` / `lastSeq` answer in the database.
 */
import { MemoryEntry, createMemoryEntry, toLlmCallRow, verifyMemory, type LlmCallRecord, type LlmCallSink, type PlannerTurn } from "@hogee/agent";
import { CHAT_HISTORY_WINDOW, CHAT_SESSION_MAX_MESSAGES, HISTORY_PART_TYPES, sessionFull, type ChatMessage, type DataQuestion, type HistoryMessage, type IntentSlot } from "@hogee/core";
import type { ApiDeps, Scope } from "../context";
import { fail } from "../http/problem";
import { newId } from "./ids";
import { pool, rows, type Q } from "./sql";

export interface StoredMessage {
  readonly id: string;
  readonly seq: number;
  readonly role: "user" | "assistant";
  readonly parts: readonly Record<string, unknown>[];
}

export async function sessionExists(q: Q, scope: Scope, sessionId: string): Promise<boolean> {
  const r = await rows(q, "select 1 from chat_sessions where facility_id = $1 and id = $2", [scope.facilityId, sessionId]);
  return r.length > 0;
}

/** The refusal reason of a write past the cap (CONFLICT; the chat turns answer core sessionFullReply before that). */
export const CHAT_SESSION_FULL = "CHAT_SESSION_FULL";

/** The newest `limit` messages of the session (CHAT_HISTORY_WINDOW unless asked for fewer), oldest first. */
export async function loadMessages(q: Q, scope: Scope, sessionId: string, limit: number = CHAT_HISTORY_WINDOW): Promise<StoredMessage[]> {
  const r = await rows<{ id: string; seq: number; role: "user" | "assistant"; parts_json: Record<string, unknown>[] }>(
    q,
    `select id, seq, role, parts_json from (
       select id, seq, role, parts_json from chat_messages where facility_id = $1 and session_id = $2 order by seq desc limit $3
     ) newest order by seq`,
    [scope.facilityId, sessionId, Math.min(Math.max(1, Math.floor(limit)), CHAT_HISTORY_WINDOW)],
  );
  return r.map((m) => ({ id: m.id, seq: Number(m.seq), role: m.role, parts: m.parts_json }));
}

/** The session's last sequence number, which is its message count (seq runs 1, 2, ... per session); 0 when empty. */
export async function lastSeq(q: Q, scope: Scope, sessionId: string): Promise<number> {
  const [last] = await rows<{ seq: number | null }>(q, "select max(seq) as seq from chat_messages where facility_id = $1 and session_id = $2", [scope.facilityId, sessionId]);
  return Number(last?.seq ?? 0);
}

/**
 * What the journey reads of the WHOLE session (core readHistory): every message in order, each with only its
 * HISTORY_PART_TYPES parts (a row that is not a JSON array reads as no parts). Bounded by the session cap; the oldest
 * rows of a session stored before the cap would be the ones left out.
 */
export async function loadHistoryParts(q: Q, scope: Scope, sessionId: string): Promise<HistoryMessage[]> {
  const r = await rows<{ seq: number; role: string; parts: unknown[] }>(
    q,
    `select seq, role, parts from (
       select m.seq, m.role,
              coalesce((select jsonb_agg(p.part order by p.n)
                          from jsonb_array_elements(case when jsonb_typeof(m.parts_json) = 'array' then m.parts_json else '[]'::jsonb end)
                               with ordinality as p(part, n)
                         where p.part ->> 'type' = any($3::text[])), '[]'::jsonb) as parts
         from chat_messages m where m.facility_id = $1 and m.session_id = $2 order by m.seq desc limit $4
     ) projected order by seq`,
    [scope.facilityId, sessionId, [...HISTORY_PART_TYPES], CHAT_SESSION_MAX_MESSAGES],
  );
  return r.map((m) => ({ role: m.role, parts: Array.isArray(m.parts) ? m.parts : [] }));
}

/** A user message of the session already carries this action id (single use per session, VISION-DECISIONS §9). */
export async function actionIdUsed(q: Q, scope: Scope, sessionId: string, actionId: string): Promise<boolean> {
  const [r] = await rows<{ used: boolean }>(
    q,
    `select exists (select 1 from chat_messages where facility_id = $1 and session_id = $2 and role = 'user' and parts_json @> $3::jsonb) as used`,
    [scope.facilityId, sessionId, JSON.stringify([{ type: "data-action", data: { action: { actionId } } }])],
  );
  return r?.used === true;
}

export const toChatMessage = (m: StoredMessage): ChatMessage => ({ id: m.id, role: m.role, parts: [...m.parts] as ChatMessage["parts"] });

/** The text the planner sees for a stored message: its text parts and the templated question texts. */
export function turnOf(m: StoredMessage): PlannerTurn | undefined {
  const texts = m.parts.flatMap((p) => {
    if (p.type === "text" && typeof p.text === "string") return [p.text];
    if (p.type === "data-question") return [(p.data as DataQuestion).text];
    return [];
  });
  const text = texts.join("\n").trim();
  return text ? { role: m.role, text } : undefined;
}

/** The questions the assistant asked last (data-question parts of the latest assistant message). */
export function lastQuestions(history: readonly StoredMessage[]): DataQuestion[] {
  const last = [...history].reverse().find((m) => m.role === "assistant");
  return (last?.parts ?? []).filter((p) => p.type === "data-question").map((p) => p.data as DataQuestion);
}

/**
 * A founder reply that is exactly one template option (value or label) of exactly one question asked last. Only
 * enumerated template values can become memory: never free text, never model output.
 */
export function answeredSlot(message: string, questions: readonly DataQuestion[]): { slot: IntentSlot; value: string } | undefined {
  const said = message.trim().toLowerCase();
  const hits = questions.flatMap((q) => q.options.filter((o) => o.value.toLowerCase() === said || o.label.toLowerCase() === said).map((o) => ({ slot: q.slot, value: o.value })));
  return hits.length === 1 ? hits[0] : undefined;
}

// ---- memory ------------------------------------------------------------------------------------

interface MemoryRow {
  id: string;
  facility_id: string;
  session_id: string | null;
  key: string;
  value: unknown;
  source: "USER_TURN" | "ORACLE_FACT";
  source_ref: string;
  hmac: string;
  created_at: string;
}

/** Exactly the ISO string that was signed (toISOString: millisecond precision, Z). */
const CREATED_AT_SQL = `to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at`;

/** Verified memory of this facility only (bad HMAC, other tenants, bad keys are dropped and logged). */
export async function readMemory(deps: ApiDeps, scope: Scope): Promise<MemoryEntry[]> {
  const key = deps.agent.memoryKey;
  if (!key) return [];
  const r = await rows<MemoryRow>(
    pool(deps.db),
    `select id, facility_id, session_id, key, value, source, source_ref, hmac, ${CREATED_AT_SQL}
       from memory_entries where facility_id = $1 order by created_at, id`,
    [scope.facilityId],
  );
  const raw = r.map((m) => ({
    id: m.id,
    facilityId: m.facility_id,
    sessionId: m.session_id,
    key: m.key,
    value: m.value,
    source: m.source,
    sourceRef: m.source_ref,
    createdAt: m.created_at,
    taint: { trust: "trusted", sensitivity: m.source === "USER_TURN" ? "private" : "public" },
    hmac: m.hmac,
  }));
  const { valid, rejected } = verifyMemory(raw, key, scope.facilityId);
  if (rejected.length > 0) deps.log.warn("memory_rejected", { count: rejected.length, reasons: rejected.map((x) => x.reason) });
  return [...valid];
}

/** A signed USER_TURN entry for the founder's own message (source and ref from server context, never the body). */
export function userTurnMemory(deps: ApiDeps, scope: Scope, sessionId: string, messageId: string, answer: { slot: IntentSlot; value: string }): MemoryEntry | undefined {
  const key = deps.agent.memoryKey;
  if (!key) return undefined;
  return createMemoryEntry(
    { id: newId("mem"), facilityId: scope.facilityId, sessionId, key: `slot:${answer.slot}`, value: answer.value, source: "USER_TURN", sourceRef: messageId, createdAt: new Date(deps.clock()).toISOString() },
    key,
  );
}

export async function insertMemory(q: Q, e: MemoryEntry): Promise<void> {
  await q.query(
    `insert into memory_entries (id, facility_id, session_id, key, value, source, source_ref, hmac, created_at)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::timestamptz)`,
    [e.id, e.facilityId, e.sessionId, e.key, JSON.stringify(e.value), e.source, e.sourceRef, e.hmac, e.createdAt],
  );
}

// ---- messages ----------------------------------------------------------------------------------

/**
 * Append messages to a session (created on first use) with the next sequence numbers, under a per-session lock. A
 * write past CHAT_SESSION_MAX_MESSAGES is refused (CONFLICT CHAT_SESSION_FULL) and nothing is written.
 */
export async function appendMessages(q: Q, scope: Scope, sessionId: string, messages: readonly Omit<StoredMessage, "seq">[], intent?: unknown): Promise<void> {
  await q.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`chat:${scope.facilityId}:${sessionId}`]);
  let seq = await lastSeq(q, scope, sessionId);
  if (sessionFull(seq, messages.length)) {
    throw fail("CONFLICT", "This chat session is full; start a new conversation.", { details: { reason: CHAT_SESSION_FULL, maxMessages: CHAT_SESSION_MAX_MESSAGES } });
  }
  await q.query(
    `insert into chat_sessions (id, facility_id, founder_id) values ($1, $2, $3)
     on conflict (facility_id, id) do update set updated_at = now()`,
    [sessionId, scope.facilityId, scope.founderId],
  );
  if (intent !== undefined) {
    await q.query("update chat_sessions set intent_json = $3::jsonb where facility_id = $1 and id = $2", [scope.facilityId, sessionId, JSON.stringify(intent)]);
  }
  for (const m of messages) {
    seq += 1;
    await q.query("insert into chat_messages (id, facility_id, session_id, seq, role, parts_json) values ($1, $2, $3, $4, $5, $6::jsonb)", [
      m.id,
      scope.facilityId,
      sessionId,
      seq,
      m.role,
      JSON.stringify(m.parts),
    ]);
  }
}

export async function sessionIntent(q: Q, scope: Scope, sessionId: string): Promise<unknown> {
  const [r] = await rows<{ intent_json: unknown }>(q, "select intent_json from chat_sessions where facility_id = $1 and id = $2", [scope.facilityId, sessionId]);
  return r?.intent_json ?? undefined;
}

// ---- LLM call log ------------------------------------------------------------------------------

/** Writes every guarded model call to llm_calls (hashes and redaction offsets only, never prompt text). */
export function llmCallSink(deps: ApiDeps): LlmCallSink {
  return {
    async record(record: LlmCallRecord): Promise<void> {
      const r = toLlmCallRow(record);
      await pool(deps.db).query(
        `insert into llm_calls (id, facility_id, trace_id, role, provider, model_id, params_json, prompt_hash, response_hash, redaction_report, latency_ms, tokens)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11, $12::jsonb)`,
        [
          r.id,
          r.facilityId,
          r.traceId,
          r.role,
          r.provider,
          r.modelId,
          JSON.stringify(r.paramsJson),
          r.promptHash,
          r.responseHash,
          JSON.stringify(r.redactionReport),
          Math.round(r.latencyMs),
          r.tokens ? JSON.stringify(r.tokens) : null,
        ],
      );
    },
  };
}
