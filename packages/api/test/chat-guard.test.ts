/**
 * G0 §9 "still open", at the routes: POST /api/chat answers 429 past its rate limits (per persona chat session, client
 * address, server) before anything is read, redacted or stored; a used-up model budget refuses chat and eval model
 * calls with a 503 before any call is sent; both refusals are logged every time and traced once per window; health
 * reports a used-up budget. No database or chain: a recording fake database.
 */
import { describe, expect, it } from "vitest";
import type { Db } from "@hogee/db";
import { ApiError, Health, exampleE1AttackRow } from "@hogee/core";
import { createApiApp } from "../src/app";
import type { ApiDeps } from "../src/context";
import { LOCAL_CLIENT } from "../src/http/rate-limit";
import { ModelBudget, type ModelBudgetLimits } from "../src/services/model-budget";
import { CHAT_RATE_LIMITED, MODEL_BUDGET_EXHAUSTED, RATE_LIMITED } from "../src/services/refusals";
import { scriptedAgent, type ScriptedAgent } from "./support/agent";
import { testCatalog, testChecks } from "./support/catalog";
import { fakeDeps } from "./support/fake-deps";

interface Recorded {
  readonly db: Db;
  readonly sql: string[];
  /** Params of each `insert into traces`. */
  readonly traces: unknown[][];
}

/** One opened facility; every other statement succeeds with no rows and is recorded. */
function recordingDb(): Recorded {
  const sql: string[] = [];
  const traces: unknown[][] = [];
  const query = async (text: string, params: unknown[] = []) => {
    sql.push(text);
    if (/insert into traces/.test(text)) traces.push(params);
    return { rows: /from facilities/.test(text) ? [{ facility_id: "fac-rina", currency: "MYR" }] : [], rowCount: 1 };
  };
  return { db: { $client: { query, connect: async () => ({ query, release: () => undefined }) } } as unknown as Db, sql, traces };
}

const BUDGET: ModelBudgetLimits = { windowMs: 86_400_000, windowCalls: 100, windowChars: 10_000_000, totalCalls: 1_000, totalChars: 100_000_000, outputReserveChars: 1_000 };

function usedUp(over: Partial<ModelBudgetLimits> = {}): ModelBudget {
  const b = new ModelBudget({ ...BUDGET, windowCalls: 1, ...over });
  b.reserve(0);
  return b;
}

function world(opts: { chatRate?: ApiDeps["config"]["chatRate"]; agent?: ScriptedAgent } = {}) {
  const rec = recordingDb();
  const agent = opts.agent ?? scriptedAgent();
  const f = fakeDeps({ deps: { catalog: testCatalog, checks: testChecks, agent, db: rec.db } });
  const deps: ApiDeps = { ...f.deps, config: { ...f.deps.config, ...(opts.chatRate ? { chatRate: opts.chatRate } : {}) } };
  const app = createApiApp(async () => deps);
  const post = (path: string, body: unknown, env?: unknown) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json", cookie: f.cookie("founder:rina") }, body: JSON.stringify(body) }, env as never);
  return { app, rec, agent, logs: f.logs, post };
}

const session = (n: number) => `01a14202-2800-7000-8000-${String(n).padStart(12, "0")}`;
const turn = (n: number) => ({ sessionId: session(n), message: "I sell tumblers on Shopee with a 5,000 budget" });
const errorOf = async (res: Response) => ApiError.parse(await res.json()).error;

describe("POST /api/chat rate limit", () => {
  it("answers 429 UPSTREAM RATE_LIMITED with Retry-After past the per-session limit, before anything is read or stored", async () => {
    const w = world({ chatRate: { perSession: 2, perClient: 100, perServer: 100 } });
    for (let i = 0; i < 2; i += 1) expect((await w.post("/api/chat", turn(1))).status).not.toBe(429);
    const before = w.rec.sql.length;
    const res = await w.post("/api/chat", turn(1));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await errorOf(res)).toMatchObject({ code: "UPSTREAM", details: { reason: RATE_LIMITED, scope: "session" } });
    // Only the refusal's own trace was written: no facility read, no chat history, no message, no model call.
    const after = w.rec.sql.slice(before);
    expect(after.some((q) => /chat_messages|from facilities|llm_calls/.test(q))).toBe(false);
    expect(w.agent.calls()).toBe(0);
    expect(w.logs.filter((l) => l.event === "chat_rate_limited")).toHaveLength(1);
    // Another chat session of the same persona still has room.
    expect((await w.post("/api/chat", turn(2))).status).not.toBe(429);
  });

  it("limits a client address across sessions, and never reads X-Forwarded-For", async () => {
    const w = world({ chatRate: { perSession: 100, perClient: 2, perServer: 100 } });
    const a = { incoming: { socket: { remoteAddress: "10.0.0.1" } } };
    expect((await w.post("/api/chat", turn(1), a)).status).not.toBe(429);
    expect((await w.post("/api/chat", turn(2), a)).status).not.toBe(429);
    const res = await w.post("/api/chat", turn(3), a);
    expect(res.status).toBe(429);
    expect((await errorOf(res)).details).toMatchObject({ scope: "client" });
    expect((await w.post("/api/chat", turn(4), { incoming: { socket: { remoteAddress: "10.0.0.2" } } })).status).not.toBe(429);
  });

  it("mounted without a socket address (Next), every caller is one local client whatever X-Forwarded-For says", async () => {
    const w = world({ chatRate: { perSession: 100, perClient: 1, perServer: 100 } });
    const spoof = (ip: string) =>
      w.app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(turn(Number(ip.split(".")[3]))) });
    expect((await spoof("203.0.113.1")).status).not.toBe(429);
    const res = await spoof("203.0.113.2");
    expect(res.status).toBe(429);
    expect((await errorOf(res)).details).toMatchObject({ scope: "client" });
    expect(LOCAL_CLIENT).toBe("local");
  });

  it("limits the whole server, and traces only the first refusal of a window", async () => {
    const w = world({ chatRate: { perSession: 100, perClient: 100, perServer: 1 } });
    expect((await w.post("/api/chat", turn(1))).status).not.toBe(429);
    const tracesBefore = w.rec.traces.length;
    for (let i = 2; i < 7; i += 1) {
      const res = await w.post("/api/chat", turn(i), { incoming: { socket: { remoteAddress: `10.0.0.${i}` } } });
      expect(res.status).toBe(429);
      expect((await errorOf(res)).details).toMatchObject({ scope: "server" });
    }
    const alerts = w.rec.traces.slice(tracesBefore).filter((p) => p.includes(CHAT_RATE_LIMITED));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("ALERT");
    expect(w.logs.filter((l) => l.event === "chat_rate_limited")).toHaveLength(5);
  });

  it("uses the safe defaults when the config names no limits", async () => {
    const w = world();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) statuses.push((await w.post("/api/chat", turn(1))).status);
    expect(statuses.filter((s) => s === 429)).toHaveLength(1); // DEFAULT_CHAT_RATE.perSession = 10
  });
});

describe("model budget at the routes", () => {
  it("chat: a used-up budget is a 503 UPSTREAM MODEL_BUDGET_EXHAUSTED before the text is redacted, read or stored", async () => {
    const agent = scriptedAgent({ budget: usedUp() });
    const w = world({ agent });
    const res = await w.post("/api/chat", turn(1));
    expect(res.status).toBe(503);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await errorOf(res)).toMatchObject({ code: "UPSTREAM", details: { reason: MODEL_BUDGET_EXHAUSTED, scope: "window" } });
    expect(w.rec.sql.some((q) => /chat_messages|llm_calls|from facilities/.test(q))).toBe(false);
    expect(agent.calls()).toBe(0);
  });

  it("chat: the hard total says no retry time", async () => {
    const w = world({ agent: scriptedAgent({ budget: usedUp({ windowCalls: 100, totalCalls: 1 }) }) });
    const res = await w.post("/api/chat", turn(1));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBeNull();
    expect((await errorOf(res)).details).toEqual({ reason: MODEL_BUDGET_EXHAUSTED, scope: "total" });
  });

  it("logs every refusal and traces only the first of the hour", async () => {
    const w = world({ agent: scriptedAgent({ budget: usedUp() }) });
    for (let i = 0; i < 3; i += 1) expect((await w.post("/api/chat", turn(i))).status).toBe(503);
    expect(w.rec.traces.filter((p) => p.includes(MODEL_BUDGET_EXHAUSTED))).toHaveLength(1);
    expect(w.logs.filter((l) => l.event === "model_budget_refused")).toHaveLength(3);
  });

  it("eval: a model call the budget refuses ends the request with a 503 before the call is sent, traced as an eval measurement", async () => {
    // Open (an empty request still fits) but too full for the real request: the provider-level reservation refuses it.
    const budget = new ModelBudget({ ...BUDGET, windowChars: 100_000 });
    budget.reserve(0).settle(100_000 - 1_100);
    const agent = scriptedAgent({ budget });
    const w = world({ agent });
    const res = await w.post("/api/eval/shortlist", { setId: "set-01", mode: "llm_rank" });
    expect(res.status).toBe(503);
    expect(await errorOf(res)).toMatchObject({ code: "UPSTREAM", details: { reason: MODEL_BUDGET_EXHAUSTED } });
    expect(agent.calls()).toBe(0); // the provider never saw it
    expect(w.rec.sql.filter((q) => /insert into llm_calls/.test(q))).toHaveLength(1); // the guard logged the refused call
    const alert = w.rec.traces.find((p) => p.includes(MODEL_BUDGET_EXHAUSTED));
    expect(String(alert?.[6])).toMatch(/^\[eval guard\] /);
    // The budget now knows a real call does not fit: the next request is refused up front and logs no call.
    expect((await w.post("/api/eval/shortlist", { setId: "set-01", mode: "llm_rank" })).status).toBe(503);
    expect(w.rec.sql.filter((q) => /insert into llm_calls/.test(q))).toHaveLength(1);
  });

  it("eval: a used-up budget builds no model; a case that needs no model still runs", async () => {
    const agent = scriptedAgent({ budget: usedUp() });
    const w = world({ agent });
    expect((await w.post("/api/eval/shortlist", { setId: "set-01", mode: "llm_rank" })).status).toBe(503);
    expect(w.rec.sql.some((q) => /insert into llm_calls/.test(q))).toBe(false);
    const listing = await w.post("/api/eval/case", { arm: "hogee", case: { ...exampleE1AttackRow, vector: "listing" } });
    expect(listing.status).toBe(200);
  });
});

describe("GET /api/health", () => {
  it("reports llm ok while the budget is open and degraded once it is used up", async () => {
    const open = world();
    expect(Health.parse(await (await open.app.request("/api/health")).json()).llm).toBe("ok");
    const closed = world({ agent: scriptedAgent({ budget: usedUp() }) });
    expect(Health.parse(await (await closed.app.request("/api/health")).json()).llm).toBe("degraded");
  });
});
