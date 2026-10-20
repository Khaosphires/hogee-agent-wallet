/**
 * The sample business's chat history (MOCK_SCENARIO=lived; run-10 v-6): GET /api/chat/:sessionId is a read. A session
 * not seen yet shows the sample's history without being stored or counted, so no number of GETs (the web's guard checks
 * only Host for a GET) can use up the seeded sessions; the session starts on its first POST (a chat turn, a press, the
 * Plan and Suppliers pages' draftPlan) with exactly the history its GET showed, and only those count.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@hogee/core";
import { app } from "../src/index";
import { readEnv } from "../src/env";
import { readyState } from "../src/scenario-lived/index";
import { MAX_SEEDED_CHATS, openChat, resetState, usedSinceBuilt, type MockState } from "../src/store";
import { harness, json, secret } from "./support/harness";

const h = harness(app);
/** A fresh lowercase UUIDv7 per n (SessionId accepts any). */
const sessionId = (n: number): string => `01a14202-2800-7000-8000-${n.toString(16).padStart(12, "0")}`;

beforeAll(() => {
  process.env.PERSONA_COOKIE_SECRET = secret();
  process.env.OFFICER_TOKEN = secret();
});
beforeEach(() => {
  vi.stubEnv("DEMO_MODE", "1");
  vi.stubEnv("MOCK_SCENARIO", "lived");
  vi.stubEnv("HOGEE_COUNTRY", "SG");
  vi.stubEnv("REPLAY", "");
  resetState(readEnv(), readEnv().scenario);
});
afterEach(() => {
  resetState(readEnv());
  vi.unstubAllEnvs();
});

/** A GET with no cookie and no Origin, as a cross-site page's subresource GET arrives once the guard let it through. */
async function read(id: string): Promise<{ status: number; body: ChatMessage[] }> {
  const res = await app.request(`/api/chat/${id}`);
  return { status: res.status, body: (await res.json()) as ChatMessage[] };
}

async function say(id: string, message: string): Promise<void> {
  const res = await app.request("/api/chat", { ...json({ sessionId: id, message }), headers: { "content-type": "application/json", cookie: await h.cookie("founder") } });
  expect(res.status).toBe(200);
  await res.text();
}

const seeded = (st: MockState): number => st.sample?.seededChats ?? Number.NaN;
const welcomes = (messages: readonly ChatMessage[]): boolean => JSON.stringify(messages[0] ?? null).includes("sample business");

describe("the sample business's chat history (GET /api/chat/:sessionId)", () => {
  it("shows a session not seen yet the sample's history and stores nothing, however many ids are read", { timeout: 60_000 }, async () => {
    const st = await readyState(readEnv());
    const chats = st.chats.size;
    const first = await read(sessionId(1));
    expect(first.status).toBe(200);
    expect(first.body).toHaveLength(5);
    expect(welcomes(first.body)).toBe(true);
    for (let n = 2; n <= MAX_SEEDED_CHATS + 5; n += 1) expect((await read(sessionId(n))).status).toBe(200);
    expect(st.chats.size).toBe(chats);
    expect(seeded(st)).toBe(0);
    expect(usedSinceBuilt(st)).toBe(false);
    // A further new session still gets the sample's history, the same one (reading mints nothing).
    const later = await read(sessionId(10_000));
    expect(later.body).toEqual(first.body);
    expect((await read(sessionId(1))).body).toEqual(first.body);
  });

  it("starts the session on its first chat turn, with exactly the history its GET showed, and counts it then", { timeout: 30_000 }, async () => {
    const st = await readyState(readEnv());
    const id = sessionId(2);
    const shown = (await read(id)).body;
    await say(id, "is my money safe?");
    expect(seeded(st)).toBe(1);
    expect(st.chats.get(id)?.messages).toHaveLength(7);
    const after = (await read(id)).body;
    expect(after.slice(0, 5)).toEqual(shown);
    expect(after.slice(5).map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(usedSinceBuilt(st)).toBe(true);
  });

  it("starts it with the history on the Plan and Suppliers pages' draftPlan too (a POST), before any chat turn", { timeout: 30_000 }, async () => {
    const st = await readyState(readEnv());
    const id = sessionId(3);
    expect((await h.call("/api/plans/draft", json({ sessionId: id }))).status).toBe(200);
    expect(seeded(st)).toBe(1);
    const history = (await read(id)).body;
    expect(history).toHaveLength(5);
    expect(welcomes(history)).toBe(true);
    expect(usedSinceBuilt(st)).toBe(false);
  });

  it("counts only sessions a POST started: past the cap a new session starts empty and its GET says so (404)", { timeout: 30_000 }, async () => {
    const st = await readyState(readEnv());
    for (let n = 1; n <= MAX_SEEDED_CHATS; n += 1) expect(openChat(st, sessionId(n)).messages).toHaveLength(5);
    expect(seeded(st)).toBe(MAX_SEEDED_CHATS);
    const id = sessionId(MAX_SEEDED_CHATS + 1);
    // The GET shows what the session's first POST would start: nothing, so it is new (404), as before any turn.
    expect((await read(id)).status).toBe(404);
    await say(id, "hi");
    const history = (await read(id)).body;
    expect(history.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(welcomes(history)).toBe(false);
    // The officer's switch rebuilds the store, and a new session has the sample's history again.
    const flip = await app.request("/api/demo/sample-business", { ...json({ on: true }), headers: { "content-type": "application/json", cookie: await h.cookie("officer") } });
    expect(flip.status).toBe(200);
    expect((await read(sessionId(MAX_SEEDED_CHATS + 2))).body).toHaveLength(5);
  });
});
