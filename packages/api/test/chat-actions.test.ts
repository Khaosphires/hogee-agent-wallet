/**
 * VISION-DECISIONS §5, §9: POST /api/chat with {sessionId, action}. A button press runs the journey (journey/actions.ts)
 * with no model and no redaction; it counts in its own 30/min/session bucket (429 past it), never in the text-turn
 * bucket; its actionId is single use per session (a replay runs and stores nothing); every press is traced.
 * (v-chat-server replaced the wave-0 "501 until v-chat-server" expectations: the brief changes that behaviour.)
 */
import { describe, expect, it } from "vitest";
import { ApiError, TEXT, exampleChatActions } from "@hogee/core";
import { createApiApp } from "../src/app";
import type { ApiDeps } from "../src/context";
import { RATE_LIMITED } from "../src/services/refusals";
import { scriptedAgent } from "./support/agent";
import { testCatalog, testChecks } from "./support/catalog";
import { fakeDeps } from "./support/fake-deps";
import { journeyDb } from "./support/journey-db";
import { streamChunks } from "./support/steps";

function world(chatRate?: ApiDeps["config"]["chatRate"]) {
  const store = journeyDb();
  const agent = scriptedAgent();
  let redactions = 0;
  const redactor = { redact: async (t: string) => ((redactions += 1), agent.redactor.redact(t)) };
  const f = fakeDeps({ deps: { catalog: testCatalog, checks: testChecks, agent: { ...agent, redactor }, db: store.db } });
  const deps: ApiDeps = { ...f.deps, config: { ...f.deps.config, ...(chatRate ? { chatRate } : {}) } };
  const app = createApiApp(async () => deps);
  const post = (body: unknown) =>
    app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json", cookie: f.cookie("founder:rina") }, body: JSON.stringify(body) });
  return { store, agent, post, redactions: () => redactions };
}

const sessionId = "01a14202-2800-7000-8000-0000000000a1";
const action = (n: number) => ({ ...exampleChatActions[0], actionId: `01a14202-2800-7000-8000-${String(n).padStart(12, "0")}` });
const errorOf = async (res: Response) => ApiError.parse(await res.json()).error;
const textOf = (chunks: readonly { type: string; delta?: string }[]) => chunks.filter((c) => c.type === "text-delta").map((c) => c.delta).join("");

describe("POST /api/chat with an action", () => {
  it("answers from the journey with no model and no redaction, stores the press and the reply, and traces it", async () => {
    const w = world();
    const res = await w.post({ sessionId, action: action(1) });
    expect(res.status).toBe(200);
    // No plan yet: a search is not allowed, so the reply says so and shows where the founder is.
    expect(textOf(await streamChunks(res))).toContain(TEXT.needPlanFirst);
    expect(w.agent.calls()).toBe(0);
    expect(w.redactions()).toBe(0);
    expect(w.store.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(w.store.messages[0]?.parts_json).toEqual([{ type: "text", text: "Find suppliers" }, { type: "data-action", data: { action: action(1) } }]);
    expect(w.store.traces).toMatchObject([{ traceId: `journey-${sessionId}`, actor: "founder", kind: "TOOL_CALL" }]);
    expect(w.store.traces[0]?.summary).toMatch(/^Journey action start_search at INTAKE → INTAKE/);
  });

  it("answers a replayed actionId 'already done', runs and stores nothing, and traces the replay", async () => {
    const w = world();
    await streamChunks(await w.post({ sessionId, action: action(1) }));
    const res = await w.post({ sessionId, action: action(1) });
    expect(res.status).toBe(200);
    expect(textOf(await streamChunks(res))).toContain(TEXT.alreadyDone);
    expect(w.store.messages).toHaveLength(2);
    expect(w.store.traces.at(-1)?.summary).toContain("replayed id");
  });

  it("refuses a body with both a message and an action (422)", async () => {
    const w = world();
    expect((await w.post({ sessionId, message: "hi", action: action(1) })).status).toBe(422);
  });

  it("is limited to 30 a minute per session in its own bucket (429 RATE_LIMITED past it)", async () => {
    const w = world();
    for (let i = 0; i < 30; i += 1) expect((await w.post({ sessionId, action: action(i) })).status).toBe(200);
    const res = await w.post({ sessionId, action: action(99) });
    expect(res.status).toBe(429);
    expect(await errorOf(res)).toMatchObject({ code: "UPSTREAM", details: { reason: RATE_LIMITED, scope: "session" } });
  });

  it("never spends the text-turn bucket", async () => {
    const w = world({ perSession: 1, perClient: 100, perServer: 100 });
    for (let i = 0; i < 5; i += 1) expect((await w.post({ sessionId, action: action(i) })).status).toBe(200);
    expect((await w.post({ sessionId, message: "I sell tumblers on Shopee with a 5,000 budget" })).status).not.toBe(429);
  });
});
