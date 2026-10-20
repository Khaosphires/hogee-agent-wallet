/**
 * Audit run-9 lead 2 (chat-session-history-unbounded) over the in-memory store: a session takes turns only while they
 * fit under CHAT_SESSION_MAX_MESSAGES (a full one answers one templated sentence, stores and runs nothing, makes no
 * model call and is traced once); GET /api/chat returns the newest CHAT_HISTORY_WINDOW messages; every read of the
 * messages is bounded, and the journey's facts (saved terms, used action ids, picks) still come from the whole session.
 * The same on Postgres: test/live/writer-bounds-chat.live.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_HISTORY_WINDOW,
  CHAT_SESSION_MAX_MESSAGES,
  TEXT,
  exampleChatActions,
  examplePlanIntent,
  examplePlanManifest,
  exampleSupplierSearch,
  exampleWebCandidate,
  type ChatAction,
} from "@hogee/core";
import { createApiApp } from "../src/app";
import type { ApiDeps } from "../src/context";
import { persistTurn } from "../src/journey/persist";
import { scriptedAgent, toolCall, type ScriptedAgent } from "./support/agent";
import { testCatalog, testChecks } from "./support/catalog";
import { fakeDeps } from "./support/fake-deps";
import { journeyDb, type JourneyDb } from "./support/journey-db";
import { streamChunks, type StreamChunk } from "./support/steps";

const search = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../src/services/web-search", () => ({
  startWebSearch: async () => {
    search.calls += 1;
    return { searchId: "search-new" };
  },
  readWebSearch: async () => {
    throw new Error("not used");
  },
}));

const SESSION = "01a14202-2800-7000-8000-0000000000c1";
const W1 = exampleWebCandidate.supplierId;
const READY_LIST = { id: exampleSupplierSearch.searchId, source: "web" as const, status: "READY" as const, search_json: exampleSupplierSearch };
const FULL_TRACE = `chat-full-${SESSION}`;

let k = 0;
const id = () => `01a14202-2800-7000-8000-${String((k += 1)).padStart(12, "0")}`;
const textOf = (chunks: readonly StreamChunk[]) => chunks.filter((c) => c.type === "text-delta").map((c) => c.delta).join("");
const dataTypes = (chunks: readonly StreamChunk[]) => chunks.filter((c) => c.type.startsWith("data-")).map((c) => c.type);

interface World {
  readonly store: JourneyDb;
  readonly agent: ScriptedAgent;
  act(a: ChatAction): Promise<StreamChunk[]>;
  say(message: string): Promise<StreamChunk[]>;
  get(path: string): Response | Promise<Response>;
}

function world(): World {
  const store = journeyDb({ committedDraftId: "draft-1", manifest: examplePlanManifest, intent: examplePlanIntent, list: READY_LIST });
  const agent = scriptedAgent();
  const f = fakeDeps({ deps: { catalog: testCatalog, checks: testChecks, agent, db: store.db, client: store.client } });
  const deps: ApiDeps = f.deps;
  const app = createApiApp(async () => deps);
  const headers = { "content-type": "application/json", cookie: f.cookie("founder:rina") };
  const post = (body: unknown) => app.request("/api/chat", { method: "POST", headers, body: JSON.stringify(body) });
  return {
    store,
    agent,
    act: async (a) => streamChunks(await post({ sessionId: SESSION, action: a })),
    say: async (message) => streamChunks(await post({ sessionId: SESSION, message })),
    get: (path) => app.request(path, { headers }),
  };
}

/** `n` stored filler messages (alternating roles, text only) in SESSION. */
function fill(w: World, n: number): void {
  for (let i = 0; i < n; i += 1) w.store.seed({ id: `msg-fill-${i + 1}`, session_id: SESSION, role: i % 2 === 0 ? "user" : "assistant", parts_json: [{ type: "text", text: `filler ${i + 1}` }] });
}

const press = (action: ChatAction, label = "x") => [{ type: "text", text: label }, { type: "data-action", data: { action } }];
const signCard = (termsId: string) => ({ type: "data-sign", id: `sign-${termsId}`, data: { kind: "SupplierApproval", refId: termsId, title: "Sign the supplier order", summary: "s", cta: "Sign" } });

beforeEach(() => {
  search.calls = 0;
});

describe("a full session (CHAT_SESSION_MAX_MESSAGES)", () => {
  it("refuses a press: one templated sentence, nothing stored or run, traced once", async () => {
    const w = world();
    fill(w, CHAT_SESSION_MAX_MESSAGES - 1);
    const first = await w.act({ type: "start_search", actionId: id() });
    expect(textOf(first)).toBe(TEXT.sessionFull);
    expect(dataTypes(first)).toEqual([]);
    expect(search.calls).toBe(0);
    expect(w.store.messages).toHaveLength(CHAT_SESSION_MAX_MESSAGES - 1);
    expect(textOf(await w.act({ type: "show_cfo", actionId: id(), view: "overview" }))).toBe(TEXT.sessionFull);
    expect(w.store.messages).toHaveLength(CHAT_SESSION_MAX_MESSAGES - 1);
    expect(w.store.traces.filter((t) => t.traceId === FULL_TRACE)).toMatchObject([{ kind: "ALERT" }]);
    expect(w.store.traces.filter((t) => t.traceId === `journey-${SESSION}`)).toEqual([]);
  });

  it("refuses a text turn before the model is called", async () => {
    const w = world();
    fill(w, CHAT_SESSION_MAX_MESSAGES - 1);
    expect(textOf(await w.say("how are we doing?"))).toBe(TEXT.sessionFull);
    expect(w.agent.calls()).toBe(0);
    expect(w.store.messages).toHaveLength(CHAT_SESSION_MAX_MESSAGES - 1);
  });

  it("takes the last turn that fits, then refuses", async () => {
    const w = world();
    fill(w, CHAT_SESSION_MAX_MESSAGES - 2);
    expect(dataTypes(await w.act({ type: "show_cfo", actionId: id(), view: "overview" }))).toContain("data-cfo");
    expect(w.store.messages).toHaveLength(CHAT_SESSION_MAX_MESSAGES);
    expect(textOf(await w.act({ type: "show_cfo", actionId: id(), view: "reserve" }))).toBe(TEXT.sessionFull);
    expect(w.store.messages).toHaveLength(CHAT_SESSION_MAX_MESSAGES);
  });

  it("the store refuses a write past the cap (CONFLICT CHAT_SESSION_FULL), whoever asks", async () => {
    const w = world();
    fill(w, CHAT_SESSION_MAX_MESSAGES - 1);
    const q = { query: (t: string, v?: unknown[]) => (w.store.db.$client as unknown as { query: (t: string, v?: unknown[]) => unknown }).query(t, v) };
    const two = [
      { id: "m1", role: "user" as const, parts: [{ type: "text", text: "a" }] },
      { id: "m2", role: "assistant" as const, parts: [{ type: "text", text: "b" }] },
    ];
    await expect(persistTurn(q as never, { facilityId: "fac-rina", founderId: "founder-rina" }, SESSION, two)).rejects.toMatchObject({ failure: { code: "CONFLICT", details: { reason: "CHAT_SESSION_FULL" } } });
    expect(w.store.messages).toHaveLength(CHAT_SESSION_MAX_MESSAGES - 1);
  });
});

describe("bounded reads", () => {
  it("GET /api/chat returns the newest CHAT_HISTORY_WINDOW messages, oldest first", async () => {
    const w = world();
    fill(w, CHAT_HISTORY_WINDOW + 50);
    const history = (await (await w.get(`/api/chat/${SESSION}`)).json()) as { id: string }[];
    expect(history).toHaveLength(CHAT_HISTORY_WINDOW);
    expect(history[0]?.id).toBe("msg-fill-51");
    expect(history.at(-1)?.id).toBe(`msg-fill-${CHAT_HISTORY_WINDOW + 50}`);
  });

  it("no read of a session's messages is unbounded", async () => {
    const w = world();
    fill(w, 10);
    await w.act({ type: "show_cfo", actionId: id(), view: "overview" });
    w.agent.queue(toolCall("chooseSkill", { skill: "help", candidateRanks: null, cfoView: null }));
    await w.say("hello");
    await w.get(`/api/chat/${SESSION}`);
    const reads = w.store.sql.filter((q) => /^\s*select/.test(q) && /from chat_messages/.test(q));
    expect(reads.length).toBeGreaterThan(0);
    for (const q of reads) expect(q).toMatch(/limit \$\d|exists|max\(seq\)/);
  });

  it("terms saved before the window still give the sign card (facts read the whole session)", async () => {
    const w = world();
    w.store.world.terms = { id: "terms-1", supplier_id: W1, status: "CONFIRMED", order_id: null };
    w.store.seed({ id: "msg-save", session_id: SESSION, role: "user", parts_json: press({ type: "terms_saved", actionId: id(), termsId: "terms-1" }, "Terms saved") });
    w.store.seed({ id: "msg-sign", session_id: SESSION, role: "assistant", parts_json: [{ type: "text", text: TEXT.termsSaved }, signCard("terms-1")] });
    fill(w, CHAT_HISTORY_WINDOW + 20);
    const r = await w.act({ type: "pick", actionId: id(), searchId: "search-old", supplierIds: [W1] });
    expect(textOf(r)).toContain(TEXT.stale);
    expect(r.find((c) => c.type === "data-sign")?.data).toMatchObject({ kind: "SupplierApproval", refId: "terms-1" });
  });

  it("an action id used before the window is still single use", async () => {
    const w = world();
    const old: ChatAction = { ...(exampleChatActions.find((a) => a.type === "show_cfo") as ChatAction), actionId: id() };
    w.store.seed({ id: "msg-old-press", session_id: SESSION, role: "user", parts_json: press(old, "How are we doing?") });
    w.store.seed({ id: "msg-old-reply", session_id: SESSION, role: "assistant", parts_json: [{ type: "text", text: "y" }] });
    fill(w, CHAT_HISTORY_WINDOW + 20);
    const before = w.store.messages.length;
    expect(textOf(await w.act(old))).toContain(TEXT.alreadyDone);
    expect(w.store.messages).toHaveLength(before);
  });
});
