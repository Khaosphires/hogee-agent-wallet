/**
 * The mock web supplier search (v-search): the live API's recorded path through the same code (recordedSearch, the
 * recorded Reader outputs, core assembly, the real offline sanctions screen), PENDING for 2 s then READY with the very
 * body the card renders, the live refusals (NO_PLAN, IN_FLIGHT), reuse, and the helpers v-terms / v-chat-server read.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SupplierSearch, isWebSupplierId, type Persona } from "@hogee/core";
import { app } from "../src/index";
import { readEnv } from "../src/env";
import { getState, resetState } from "../src/store";
import { SEARCH_DELAY_MS, mockLatestWebSearchId, mockWebSearch, mockWebSupplier, searchHandlers } from "../src/features/search";
import { harness, json, secret } from "./support/harness";

beforeAll(() => {
  process.env.DEMO_MODE = "1";
  process.env.PERSONA_COOKIE_SECRET = secret();
  process.env.OFFICER_TOKEN = secret();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetState(readEnv());
});

const h = harness(app);
const INJECTED = ["supplier-w6yrjswhernrr", "supplier-w5nwa6flp3s5t"];

function clock(start = Date.parse("2026-10-19T09:00:00Z")) {
  let now = start;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  return { advance: (ms: number) => void (now += ms) };
}

async function start(quantity?: number) {
  return h.call<{ searchId?: string; error?: { code: string; details?: { reason?: string } } }>("/api/suppliers/search", json(quantity === undefined ? {} : { quantity }));
}

describe("mock web search (recorded sample, Mei)", () => {
  it("is PENDING with stages, then READY with the recorded candidates; injected pages are counted, never shown", async () => {
    const t = clock();
    const res = await start(1000);
    expect(res.status).toBe(200);
    const id = res.body.searchId as string;
    const pending = SupplierSearch.parse((await h.call(`/api/suppliers/search/${id}`)).body);
    expect(pending).toMatchObject({ status: "PENDING", stage: "SEARCHING", provider: "recorded", candidates: [] });
    t.advance(SEARCH_DELAY_MS * 0.5);
    expect(SupplierSearch.parse((await h.call(`/api/suppliers/search/${id}`)).body).stage).toBe("READING");
    t.advance(SEARCH_DELAY_MS);
    const ready = SupplierSearch.parse((await h.call(`/api/suppliers/search/${id}`)).body);
    expect(ready).toMatchObject({ status: "READY", stage: "DONE", provider: "recorded", quantity: 1000, sourcesFound: 10, shortlistRequestId: id, failure: null });
    expect(ready.omitted).toEqual([{ reason: "OFF_LIST", count: 1 }]);
    expect(ready.excludedByGate).toEqual([
      { gate: "MISSING_CERT", count: 1 },
      { gate: "OFF_PLATFORM_DISCOUNT", count: 1 },
      { gate: "AI_INJECTION", count: 2 },
    ]);
    expect(ready.candidates).toHaveLength(5);
    expect(ready.candidates.every((c) => c.origin === "web" && c.unverified && c.canOrder && isWebSupplierId(c.supplierId))).toBe(true);
    for (const bad of INJECTED) expect(ready.candidates.map((c) => c.supplierId)).not.toContain(bad);
    expect(JSON.stringify(ready)).not.toMatch(/Veltrix|Marrowind|Glintora/);
  });

  it("reuses an identical READY search, refuses a second one while one runs (IN_FLIGHT)", async () => {
    const t = clock();
    const first = (await start(1000)).body.searchId;
    const busy = await start(500);
    expect(busy.status).toBe(409);
    expect(busy.body.error?.details?.reason).toBe("IN_FLIGHT");
    t.advance(SEARCH_DELAY_MS + 1);
    expect((await start(1000)).body.searchId).toBe(first);
    expect((await start(500)).body.searchId).not.toBe(first);
  });

  it("refuses NO_PLAN before a plan is committed (fresh scenario)", async () => {
    vi.stubEnv("MOCK_SCENARIO", "fresh");
    const res = await start();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "CONFLICT", details: { reason: "NO_PLAN" } });
  });

  it("runs without a hono Context (the chat journey calls the handlers directly) and feeds the v-terms / journey helpers", async () => {
    const t = clock();
    const env = readEnv();
    const st = getState(env);
    const persona: Persona = "founder:mei";
    const out = (await searchHandlers.startSupplierSearch({ req: { body: {} }, st, env, persona, c: undefined as never })) as { searchId: string };
    expect(mockLatestWebSearchId(st)).toBe(out.searchId);
    expect(mockWebSearch(st, out.searchId)?.shortlist).toBeNull();
    t.advance(SEARCH_DELAY_MS);
    const seen = mockWebSearch(st, out.searchId);
    expect(seen?.search.status).toBe("READY");
    expect(seen?.search.quantity).toBe(1000);
    expect(seen?.shortlist?.shortlistHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(seen?.shortlist?.candidates.map((c) => c.supplierId)).toEqual(seen?.search.candidates.map((c) => c.supplierId));
    const top = seen?.search.candidates[0];
    expect(mockWebSupplier(st, top?.supplierId ?? "")).toEqual({ sellerName: top?.displayName, listingHost: top?.listingHost });
    expect(mockWebSupplier(st, "supplier-a")).toBeUndefined();
    const viaGet = await searchHandlers.getSupplierSearch({ req: { params: { id: out.searchId } }, st, env, persona, c: undefined as never });
    expect(viaGet).toEqual(seen?.search);
  });
});
