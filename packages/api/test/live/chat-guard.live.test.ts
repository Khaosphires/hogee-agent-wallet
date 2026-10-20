/**
 * G0 §9 "still open" on the live API (Postgres + Anvil; the model is an AI SDK mock behind the real guard and the real
 * budget): a planner call the model budget refuses in the middle of a chat turn ends the turn with a 503 and nothing
 * of that turn stored; the refused call is in the call log and never reached the provider; the next turn is refused up
 * front; the chat rate limit answers 429 before anything is read or stored.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError, Health } from "@hogee/core";
import { ModelBudget } from "../../src/services/model-budget";
import { MODEL_BUDGET_EXHAUSTED, RATE_LIMITED } from "../../src/services/refusals";
import { scriptedAgent, toolCall, type ScriptedAgent } from "../support/agent";
import { LIVE, LIVE_TIMEOUT_MS, openLive, type Live } from "../support/live";
import { openAndRegister, streamChunks } from "../support/steps";
import { newWorld, type World } from "../support/world";

const SESSION = "01a14202-2800-7000-8000-0000000000c1";

describe.skipIf(!LIVE)("chat rate limit and model budget (live)", { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  let w: World;
  let agent: ScriptedAgent;
  const count = async (sql: string) => Number((await live.db.$client.query(sql, [w.facilityId])).rows[0]?.n ?? 0);
  const messages = () => count("select count(*) as n from chat_messages where facility_id = $1");
  const calls = () => count("select count(*) as n from llm_calls where facility_id = $1");

  beforeAll(async () => {
    live = await openLive();
    agent = scriptedAgent({
      budget: new ModelBudget({ windowMs: 86_400_000, windowCalls: 2, windowChars: 10_000_000, totalCalls: 100, totalChars: 100_000_000, outputReserveChars: 16_384 }),
    });
    w = await newWorld(live, { agent });
    await openAndRegister(w);
  }, LIVE_TIMEOUT_MS);
  afterAll(async () => {
    await live?.close();
  });

  it("a turn within the budget is stored as usual", async () => {
    agent.queue(toolCall("askClarifyingQuestions", { slots: ["residency"] }));
    const chunks = await streamChunks(await w.founder.post("/api/chat", { sessionId: SESSION, message: "Tumblers on Shopee from China, budget RM10,000." }));
    expect(chunks.some((c) => c.type === "data-question")).toBe(true);
    expect(await messages()).toBe(2);
    expect(await calls()).toBe(1);
  });

  it("a planner step the budget refuses mid-turn ends the turn with a 503 and stores nothing of it", async () => {
    // Step 1 (the 2nd call of the window) reads the pack; step 2 would be the 3rd call and is refused before it is sent.
    agent.queue(toolCall("getCountryPack", { country: "MY" }), toolCall("askClarifyingQuestions", { slots: ["productCategory"] }));
    const before = agent.calls();
    const res = await w.founder.post("/api/chat", { sessionId: SESSION, message: "citizen" });
    expect(res.status).toBe(503);
    expect(ApiError.parse(await res.json()).error).toMatchObject({ code: "UPSTREAM", details: { reason: MODEL_BUDGET_EXHAUSTED, scope: "window" } });
    expect(res.headers.get("retry-after")).not.toBeNull();
    expect(agent.calls() - before).toBe(1); // the provider saw step 1 only
    expect(await messages()).toBe(2); // no user turn, no reply, no memory of this turn
    expect(await count("select count(*) as n from memory_entries where facility_id = $1")).toBe(0);
    const logged = await live.db.$client.query("select response_hash from llm_calls where facility_id = $1 order by created_at", [w.facilityId]);
    expect(logged.rows.map((r) => r.response_hash === null)).toEqual([false, false, true]); // the refused call is logged as failed
    const alerts = await live.db.$client.query("select actor, kind from traces where facility_id = $1 and reason_code = $2", [w.facilityId, MODEL_BUDGET_EXHAUSTED]);
    expect(alerts.rows).toEqual([{ actor: "planner", kind: "ALERT" }]);
  });

  it("the next turn is refused up front: no redaction, no read, no call log row, no second trace", async () => {
    const res = await w.founder.post("/api/chat", { sessionId: SESSION, message: "citizen" });
    expect(res.status).toBe(503);
    expect(await calls()).toBe(3);
    expect(await messages()).toBe(2);
    expect(await count(`select count(*) as n from traces where facility_id = $1 and reason_code = '${MODEL_BUDGET_EXHAUSTED}'`)).toBe(1);
    expect(Health.parse(await (await w.founder.get("/api/health")).json()).llm).toBe("degraded");
  });

  it("past the per-session rate limit a turn is 429 and leaves one ALERT trace per window", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) statuses.push((await w.founder.post("/api/chat", { sessionId: SESSION, message: "hello" })).status);
    // Turns 1..10 of this minute pass the limiter (the earlier 3 count too) and are refused by the budget (503).
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(2);
    const limited = await w.founder.post("/api/chat", { sessionId: SESSION, message: "hello" });
    expect(limited.status).toBe(429);
    expect(ApiError.parse(await limited.json()).error.details).toMatchObject({ reason: RATE_LIMITED, scope: "session" });
    expect(await count("select count(*) as n from traces where facility_id = $1 and reason_code = 'CHAT_RATE_LIMITED'")).toBe(1);
    expect(await messages()).toBe(2);
  });
});
