/**
 * VISION-DECISIONS §5, §7 in the mock: MOCK_SCENARIO (default | fresh), the chat-first feature stubs (they answer the
 * api-contract examples where a feature keeps none; search, terms and CFO are real now: search.test.ts, orders.test.ts,
 * cfo.test.ts) and a chat action (the mock journey, v-chat-server).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ROUTE_EXAMPLES, routes } from "@hogee/api-contract";
import { exampleChatActions, type Balances } from "@hogee/core";
import { app } from "../src/index";
import { parseMockScenario, readEnv } from "../src/env";
import { founderKeyActive, getState, resetState } from "../src/store";
import { harness, json, profile, secret } from "./support/harness";

beforeAll(() => {
  process.env.DEMO_MODE = "1";
  process.env.PERSONA_COOKIE_SECRET = secret();
  process.env.OFFICER_TOKEN = secret();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetState(readEnv());
});

const h = harness(app);

describe("MOCK_SCENARIO", () => {
  it("is default unless set; fresh is accepted; anything else fails closed", () => {
    expect(parseMockScenario(undefined)).toBe("default");
    expect(parseMockScenario(" fresh ")).toBe("fresh");
    expect(() => parseMockScenario("empty")).toThrow(/MOCK_SCENARIO/);
  });

  it("default keeps today's seeded demo (a committed plan, payments, revenue)", async () => {
    const st = getState(readEnv());
    expect(st.scenario).toBe("default");
    expect(st.plans.length).toBeGreaterThan(0);
    expect((await h.call("/api/plans/current")).status).toBe(200);
  });

  it("fresh: no plan, no escrow, no payments, revenue 0, founder key active; same founder and supplier catalog", async () => {
    vi.stubEnv("MOCK_SCENARIO", "fresh");
    const st = getState(readEnv());
    expect(st.scenario).toBe("fresh");
    expect(founderKeyActive(st)).toBe(true);
    expect(st.escrow.size).toBe(0);
    expect(st.suppliers.size).toBeGreaterThan(0);
    expect((await h.call("/api/plans/current")).status).toBe(404);
    expect((await h.call<unknown[]>("/api/plans/versions")).body).toEqual([]);
    expect((await h.call<unknown[]>("/api/payments")).body).toEqual([]);
    const balances = (await h.call<Balances>("/api/balances")).body;
    expect(balances).toMatchObject({ revenueMinor: "0", fundedMinor: "0", escrowMinor: "0", reserveMinor: "0", pockets: [] });
    expect((await h.call<{ founderId: string }>("/api/session")).body.founderId).toBe(profile().ids.founderId);
  });

  it("demo reset keeps the fresh scenario", async () => {
    vi.stubEnv("MOCK_SCENARIO", "fresh");
    expect((await h.call("/api/demo/reset", { method: "POST" }, "officer")).status).toBe(200);
    expect(getState(readEnv()).scenario).toBe("fresh");
  });
});

describe("chat-first feature stubs", () => {
  it.each([
    ["POST", "/api/suppliers/search", "startSupplierSearch"],
    ["GET", "/api/suppliers/search/search-mei-001", "getSupplierSearch"],
    ["GET", "/api/cfo", "getCfoReport"],
  ] as const)("%s %s answers the contract example", async (method, path, name) => {
    const body = (ROUTE_EXAMPLES[name].req as { body?: unknown }).body;
    const res = await h.call(path, method === "POST" ? json(body) : {});
    expect(res.status).toBe(200);
    expect(routes[name].res.safeParse(res.body).success).toBe(true);
  });
});

describe("chat actions", () => {
  // v-chat-server replaced the wave-0 "409 until v-chat-server" expectation: the brief makes actions run the journey.
  it("run the mock chat journey and answer a UI-message stream", async () => {
    const res = await app.request("/api/chat", { ...json({ sessionId: ROUTE_EXAMPLES.chat.req.body.sessionId, action: exampleChatActions[0] }), headers: { "content-type": "application/json", cookie: await h.cookie("founder") } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"type":"data-search"');
  });
});
