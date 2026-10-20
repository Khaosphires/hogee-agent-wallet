/**
 * Audit run-9 lead 2 in the mock (parity with the live API, api test/chat-bounds.test.ts): a chat session holds at most
 * CHAT_SESSION_MAX_MESSAGES messages, in both scenarios (the canned script and the fresh journey). A full session
 * answers core's full-session sentence, stores and runs nothing and is traced once; GET /api/chat returns the newest
 * CHAT_HISTORY_WINDOW messages.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CHAT_HISTORY_WINDOW, CHAT_SESSION_MAX_MESSAGES, TEXT, type ChatAction, type ChatMessage } from "@hogee/core";
import { app } from "../src/index";
import { readEnv } from "../src/env";
import { getState, resetState } from "../src/store";
import { harness, json, secret } from "./support/harness";

const SESSION = "01a14202-2800-7000-8000-00000000f0c1";
const h = harness(app);

beforeAll(() => {
  process.env.DEMO_MODE = "1";
  process.env.PERSONA_COOKIE_SECRET = secret();
  process.env.OFFICER_TOKEN = secret();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetState(readEnv());
});

interface Chunk {
  type: string;
  delta?: string;
}
async function post(body: unknown): Promise<Chunk[]> {
  const res = await app.request("/api/chat", { ...json(body), headers: { "content-type": "application/json", cookie: await h.cookie("founder") } });
  expect(res.status).toBe(200);
  return (await res.text())
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)) as Chunk);
}
const textOf = (chunks: readonly Chunk[]) => chunks.filter((c) => c.type === "text-delta").map((c) => c.delta).join("");
const dataTypes = (chunks: readonly Chunk[]) => chunks.filter((c) => c.type.startsWith("data-")).map((c) => c.type);
const action: ChatAction = { type: "show_cfo", actionId: "01a14202-2800-7000-8000-0000000000e1", view: "overview" };

/** A session of `n` stored filler messages. */
function filled(n: number): ChatMessage[] {
  const st = getState(readEnv());
  const messages: ChatMessage[] = Array.from({ length: n }, (_, i) => ({ id: `msg-fill-${i + 1}`, role: i % 2 === 0 ? "user" : "assistant", parts: [{ type: "text", text: `filler ${i + 1}` }] }));
  st.chats.set(SESSION, { messages, turn: 99 });
  return messages;
}
const fullTraces = () => getState(readEnv()).traces.filter((t) => t.traceId === `chat-full-${SESSION}`);

describe("a full chat session in the mock", () => {
  it("the canned script: a text turn answers the full-session sentence, stores nothing, traced once", async () => {
    const messages = filled(CHAT_SESSION_MAX_MESSAGES - 1);
    expect(textOf(await post({ sessionId: SESSION, message: "hello" }))).toBe(TEXT.sessionFull);
    expect(textOf(await post({ sessionId: SESSION, message: "hello again" }))).toBe(TEXT.sessionFull);
    expect(messages).toHaveLength(CHAT_SESSION_MAX_MESSAGES - 1);
    expect(fullTraces()).toHaveLength(1);
  });

  it("the fresh journey: a press and a text turn are refused the same way, nothing runs or is stored", async () => {
    vi.stubEnv("MOCK_SCENARIO", "fresh");
    resetState(readEnv());
    const messages = filled(CHAT_SESSION_MAX_MESSAGES - 1);
    const pressed = await post({ sessionId: SESSION, action });
    expect(textOf(pressed)).toBe(TEXT.sessionFull);
    expect(dataTypes(pressed)).toEqual([]);
    expect(textOf(await post({ sessionId: SESSION, message: "how are we doing?" }))).toBe(TEXT.sessionFull);
    expect(messages).toHaveLength(CHAT_SESSION_MAX_MESSAGES - 1);
    expect(getState(readEnv()).traces.filter((t) => t.traceId === `journey-${SESSION}`)).toEqual([]);
    expect(fullTraces()).toHaveLength(1);
  });

  it("the last turn that fits is taken", async () => {
    vi.stubEnv("MOCK_SCENARIO", "fresh");
    resetState(readEnv());
    const messages = filled(CHAT_SESSION_MAX_MESSAGES - 2);
    expect(textOf(await post({ sessionId: SESSION, action }))).not.toBe(TEXT.sessionFull);
    expect(messages).toHaveLength(CHAT_SESSION_MAX_MESSAGES);
  });
});

describe("GET /api/chat in the mock", () => {
  it("returns the newest CHAT_HISTORY_WINDOW messages, oldest first", async () => {
    filled(CHAT_HISTORY_WINDOW + 50);
    const res = await h.call<{ id: string }[]>(`/api/chat/${SESSION}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(CHAT_HISTORY_WINDOW);
    expect(res.body[0]?.id).toBe("msg-fill-51");
    expect(res.body.at(-1)?.id).toBe(`msg-fill-${CHAT_HISTORY_WINDOW + 50}`);
  });
});
