/**
 * The "Sample business" switch (demo-data.ts): GET/POST /api/demo/sample-business, mock-only. It rebuilds the store as
 * the sample business (on) or a fresh start (off), for the loan officer only (as POST /api/demo/reset; run-10 v-5),
 * refuses everything else without changing anything (fail closed), is off without DEMO_MODE and in the recorded demo,
 * and does not exist in the live API.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app as liveApp } from "@hogee/api";
import { PERSONA_COOKIE } from "@hogee/core";
import { app } from "../src/index";
import { readEnv } from "../src/env";
import { getState, resetState } from "../src/store";
import { harness, json, secret } from "./support/harness";

const h = harness(app);
const PATH = "/api/demo/sample-business";
const SESSION = "01a14202-2800-7000-8000-00000000d0d0";

interface State {
  available: boolean;
  on: boolean;
  scenario: string | null;
  used: boolean;
}

const state = async () => (await h.call<State>(PATH)).body;
const flip = (body: unknown, as: "founder" | "officer" = "officer") =>
  h.call<{ ok?: true; on?: boolean; error?: { code: string } }>(PATH, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }, as);

beforeAll(() => {
  process.env.PERSONA_COOKIE_SECRET = secret();
  process.env.OFFICER_TOKEN = secret();
});
beforeEach(() => {
  vi.stubEnv("DEMO_MODE", "1");
  vi.stubEnv("DEMO_TIMELOCK_SECONDS", "10");
  resetState(readEnv(), readEnv().scenario);
});
afterEach(() => {
  resetState(readEnv(), readEnv().scenario);
  vi.unstubAllEnvs();
});

describe("the Sample business switch", () => {
  it("reports the demo data: off on the status gallery (MOCK_SCENARIO=default), nothing used yet", async () => {
    expect(await state()).toEqual({ available: true, on: false, scenario: "default", used: false });
  });

  it("off: a fresh start (no plan, an empty chat); on: the sample business again (the officer switches)", { timeout: 30_000 }, async () => {
    expect((await flip({ on: false })).body).toEqual({ ok: true, on: false, scenario: "fresh" });
    expect(await state()).toEqual({ available: true, on: false, scenario: "fresh", used: false });
    expect((await h.call("/api/plans/current")).status).toBe(404);
    expect((await h.call(`/api/chat/${SESSION}`)).status).toBe(404);

    expect((await flip({ on: true }, "officer")).body).toEqual({ ok: true, on: true, scenario: "lived" });
    expect(await state()).toMatchObject({ on: true, scenario: "lived", used: false });
    expect((await h.call<{ status: string }>("/api/plans/current")).body.status).toBe("COMMITTED");
    expect((await h.call<unknown[]>(`/api/chat/${SESSION}`)).body).toHaveLength(5);
    // Reading the sample's own chat is not using the demo; a turn is.
    expect((await state()).used).toBe(false);
    const turn = await app.request("/api/chat", { ...json({ sessionId: SESSION, message: "is my money safe?" }), headers: { "content-type": "application/json", cookie: await h.cookie("founder") } });
    await turn.text();
    expect((await state()).used).toBe(true);
  });

  it("is the loan officer's only, as Reset the demo: no cookie, Mei's or a forged one answers 403 and changes nothing", async () => {
    const before = getState(readEnv());
    const plan = await h.call("/api/plans/current");
    expect(plan.status).toBe(200);
    const post = (cookie?: string) =>
      app.request(PATH, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ on: false }) });
    // A client that sends no cookie (and no Origin: the web's guard lets it through), Mei, and a cookie nobody signed.
    for (const res of [await post(), await post(await h.cookie("founder")), await post(`${PERSONA_COOKIE}=officer`)]) {
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    }
    // Mei is refused before her body is even read (as register(): the persona first).
    expect((await flip({ on: "yes" }, "founder")).status).toBe(403);
    expect(getState(readEnv())).toBe(before);
    expect(await h.call("/api/plans/current")).toEqual(plan);
    expect(await state()).toEqual({ available: true, on: false, scenario: "default", used: false });
    // The same rule as the officer's Reset the demo.
    expect((await app.request("/api/demo/reset", json({}))).status).toBe(403);
  });

  it("keeps its choice through the officer's Reset the demo (it rebuilds the scenario served now)", { timeout: 30_000 }, async () => {
    await flip({ on: true });
    await h.call("/api/chat", { ...json({ sessionId: SESSION, message: "is my money safe?" }) }).catch(() => undefined);
    expect((await h.call("/api/demo/reset", json({}), "officer")).status).toBe(200);
    expect(await state()).toMatchObject({ on: true, scenario: "lived", used: false });
  });

  it("refuses any other body (422) and changes nothing", async () => {
    const before = getState(readEnv());
    for (const body of [{}, { on: "yes" }, { on: 1 }, { on: true, scenario: "default" }, "not json", "", JSON.stringify({ on: true, pad: "x".repeat(300) })]) {
      const res = await flip(body);
      expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(422);
      expect(res.body.error?.code).toBe("VALIDATION");
    }
    expect(getState(readEnv())).toBe(before);
    expect((await state()).scenario).toBe("default");
  });

  it("is off without DEMO_MODE (404), as every demo route", async () => {
    vi.stubEnv("DEMO_MODE", "0");
    // No persona cookie either: the session routes are demo-only too, and the switch needs none to refuse.
    expect((await app.request(PATH)).status).toBe(404);
    expect((await app.request(PATH, json({ on: true }))).status).toBe(404);
    vi.stubEnv("DEMO_MODE", "1");
    expect((await state()).scenario).toBe("default");
  });

  it("is not offered in the recorded demo (REPLAY) or for Malaysia: GET says so, POST refuses (409)", async () => {
    vi.stubEnv("REPLAY", "final-1");
    expect(await state()).toEqual({ available: false, on: false, scenario: null, used: false });
    expect((await flip({ on: true })).status).toBe(409);
    vi.stubEnv("REPLAY", "");
    vi.stubEnv("HOGEE_COUNTRY", "MY");
    expect((await flip({ on: false })).status).toBe(409);
  });

  it("does not exist in the live API (packages/api): 404 for GET and POST", async () => {
    expect((await liveApp.request(PATH)).status).toBe(404);
    expect((await liveApp.request(PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: true }) })).status).toBe(404);
  });
});
