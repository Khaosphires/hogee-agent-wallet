/**
 * Audit run-9 lead 2 (chat-session-history-unbounded) on Postgres + Anvil, through the live API WITHOUT a cookie (the
 * anonymous founder persona): the chat writer is bounded like the other founder-persona writers (writer-bounds.ts).
 *   - a session takes turns only while they fit under CHAT_SESSION_MAX_MESSAGES; past it a press or a text turn
 *     answers the full-session sentence, stores and runs nothing, makes no model call, and only the first refusal of
 *     the session leaves a trace event;
 *   - the store refuses a write past the cap (CONFLICT CHAT_SESSION_FULL) under the session lock;
 *   - GET /api/chat returns the newest CHAT_HISTORY_WINDOW messages.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHAT_HISTORY_WINDOW, CHAT_SESSION_MAX_MESSAGES, ChatMessage, TEXT, type ChatAction } from "@hogee/core";
import { z } from "zod";
import { persistTurn } from "../../src/journey/persist";
import { inTx } from "../../src/services/sql";
import { scriptedAgent, type ScriptedAgent } from "../support/agent";
import { LIVE, LIVE_TIMEOUT_MS, openLive, type Live } from "../support/live";
import { json, openAndRegister, streamChunks, type StreamChunk } from "../support/steps";
import { newWorld, type World } from "../support/world";

const FULL = "01a14202-2800-7000-8000-0000000c1f01";
const LONG = "01a14202-2800-7000-8000-0000000c1f02";
let k = 0;
const id = () => `01a14202-2800-7000-8000-${String((k += 1)).padStart(12, "0")}`;
const textOf = (chunks: readonly StreamChunk[]) => chunks.filter((c) => c.type === "text-delta").map((c) => c.delta).join("");
const dataTypes = (chunks: readonly StreamChunk[]) => chunks.filter((c) => c.type.startsWith("data-")).map((c) => c.type);

describe.skipIf(!LIVE)("run-9 bounds: the chat writer (live)", { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  let w: World;
  let agent: ScriptedAgent;
  const n = async (sql: string, values: unknown[] = []) => ((await live.db.$client.query<{ n: number }>(sql, values)).rows[0]?.n ?? -1) as number;
  const messages = (sessionId: string) => n("select count(*)::int as n from chat_messages where facility_id = $1 and session_id = $2", [w.facilityId, sessionId]);
  const traces = () => n("select count(*)::int as n from traces where facility_id = $1", [w.facilityId]);
  const act = async (sessionId: string, action: ChatAction) => streamChunks(await w.anon.post("/api/chat", { sessionId, action }));
  const say = async (sessionId: string, message: string) => streamChunks(await w.anon.post("/api/chat", { sessionId, message }));

  /** `count` text-only messages appended to the session (created if new), as the store numbers them. */
  async function fill(sessionId: string, count: number): Promise<void> {
    const q = live.db.$client;
    await q.query("insert into chat_sessions (id, facility_id, founder_id) values ($1, $2, $3) on conflict do nothing", [sessionId, w.facilityId, w.founderId]);
    const from = (await messages(sessionId)) + 1;
    await q.query(
      `insert into chat_messages (id, facility_id, session_id, seq, role, parts_json)
       select 'msg-fill-' || $2::text || '-' || g, $1, $2::uuid, g, (case when g % 2 = 1 then 'user' else 'assistant' end)::chat_role,
              jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'filler ' || g))
         from generate_series($3::int, $4::int) g`,
      [w.facilityId, sessionId, from, from + count - 1],
    );
  }

  beforeAll(async () => {
    live = await openLive();
    agent = scriptedAgent();
    w = await newWorld(live, { agent });
    await openAndRegister(w);
  }, LIVE_TIMEOUT_MS);
  afterAll(async () => {
    await live?.close();
  });

  it(`a session takes turns up to ${CHAT_SESSION_MAX_MESSAGES} messages; then presses and text are refused, untraced after the first`, async () => {
    await fill(FULL, CHAT_SESSION_MAX_MESSAGES - 2);
    const show: ChatAction = { type: "show_cfo", actionId: id(), view: "overview" };
    expect(textOf(await act(FULL, show))).not.toBe(TEXT.sessionFull);
    expect(await messages(FULL)).toBe(CHAT_SESSION_MAX_MESSAGES);

    const before = await traces();
    const refused = await act(FULL, { type: "start_search", actionId: id() });
    expect(textOf(refused)).toBe(TEXT.sessionFull);
    expect(dataTypes(refused)).toEqual([]);
    expect(await n("select count(*)::int as n from shortlists where facility_id = $1", [w.facilityId])).toBe(0);
    expect(await traces()).toBe(before + 1);
    const [alert] = (await live.db.$client.query<{ kind: string; reason_code: string }>("select kind, reason_code from traces where facility_id = $1 and trace_id = $2", [w.facilityId, `chat-full-${FULL}`])).rows;
    expect(alert).toEqual({ kind: "ALERT", reason_code: "CHAT_SESSION_FULL" });

    const calls = agent.calls();
    for (let i = 0; i < 5; i += 1) expect(textOf(await act(FULL, { type: "show_cfo", actionId: id(), view: "reserve" }))).toBe(TEXT.sessionFull);
    expect(textOf(await act(FULL, show))).toBe(TEXT.sessionFull); // a replay in a full session is refused the same way
    expect(textOf(await say(FULL, "how are we doing?"))).toBe(TEXT.sessionFull);
    expect(agent.calls()).toBe(calls);
    expect(await messages(FULL)).toBe(CHAT_SESSION_MAX_MESSAGES);
    expect(await traces()).toBe(before + 1);
  });

  it("the store refuses a write past the cap under the session lock (CONFLICT CHAT_SESSION_FULL)", async () => {
    const scope = { facilityId: w.facilityId, founderId: w.founderId };
    const write = inTx(live.db, (q) => persistTurn(q, scope, FULL, [{ id: id(), role: "assistant", parts: [{ type: "text", text: "one more" }] }]));
    await expect(write).rejects.toMatchObject({ failure: { code: "CONFLICT", details: { reason: "CHAT_SESSION_FULL" } } });
    expect(await messages(FULL)).toBe(CHAT_SESSION_MAX_MESSAGES);
  });

  it(`GET /api/chat returns the newest ${CHAT_HISTORY_WINDOW} messages, oldest first`, async () => {
    await fill(LONG, CHAT_HISTORY_WINDOW + 50);
    const history = await json(await w.anon.get(`/api/chat/${LONG}`), z.array(ChatMessage));
    expect(history).toHaveLength(CHAT_HISTORY_WINDOW);
    expect(history[0]?.id).toBe(`msg-fill-${LONG}-51`);
    expect(history.at(-1)?.id).toBe(`msg-fill-${LONG}-${CHAT_HISTORY_WINDOW + 50}`);
    const full = await json(await w.anon.get(`/api/chat/${FULL}`), z.array(ChatMessage));
    expect(full).toHaveLength(CHAT_HISTORY_WINDOW);
  });
});
