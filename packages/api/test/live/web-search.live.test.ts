/**
 * Web supplier search on the live API (recorded mode: no TAVILY_API_KEY), Postgres + Anvil: a committed plan → POST
 * /api/suppliers/search → the PENDING row → READY through the recorded Reader outputs and the real offline sanctions
 * screen → the `web` shortlist row (search_json, result_json, shortlist_hash), the supplier rows SupplierApproval
 * needs, the traces, reuse and the per-session limit. No request leaves for any host but the Anvil RPC.
 */
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Shortlist, SupplierSearch, type Sourced } from "@hogee/core";
import { z } from "zod";
import { createApiApp } from "../../src/app";
import type { ApiDeps, ChecksPort } from "../../src/context";
import { findDataDir } from "../../src/runtime/catalog";
import { liveChecks } from "../../src/runtime/ports";
import { recordedWebSearch } from "../../src/services/web-candidates";
import { PENDING_STALE_S, runWebSearch, searchJob } from "../../src/services/web-search";
import { scriptedAgent } from "../support/agent";
import { FX_CNY_MYR, testChecks } from "../support/catalog";
import { LIVE, LIVE_TIMEOUT_MS, RPC_URL, openLive, type Live } from "../support/live";
import { chatToDraft, json, openAndRegister, signPlan } from "../support/steps";
import { newWorld, type World } from "../support/world";

const SESSION = "01a14202-2800-7000-8000-0000000000f5";
const INJECTED = ["supplier-w6yrjswhernrr", "supplier-w5nwa6flp3s5t"];
/** Labelled test rates (MYR facility): USD/MYR is this test's, CNY/MYR the shared fixture's. */
const FX: Readonly<Record<string, Sourced<number>>> = { "USD/MYR": { ...FX_CNY_MYR, value: 4.4, sourceUrl: "https://example.invalid/fx/usd-myr" }, "CNY/MYR": FX_CNY_MYR };

describe.skipIf(!LIVE)("web supplier search (live, recorded mode)", { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  let w: World;
  let app: ReturnType<typeof createApiApp>;
  let deps: ApiDeps;
  const outbound: string[] = [];

  const founder = (path: string, body?: unknown) =>
    app.request(path, body === undefined ? { headers: { cookie: w.cookie("founder:rina") } } : { method: "POST", headers: { cookie: w.cookie("founder:rina"), "content-type": "application/json" }, body: JSON.stringify(body) });

  async function ready(searchId: string): Promise<SupplierSearch> {
    for (let i = 0; i < 100; i += 1) {
      const s = await json(await founder(`/api/suppliers/search/${searchId}`), SupplierSearch);
      if (s.status !== "PENDING") return s;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("search still PENDING");
  }

  beforeAll(async () => {
    live = await openLive();
    const agent = scriptedAgent();
    w = await newWorld(live, { agent });
    const auth = await openAndRegister(w);
    await signPlan(w, auth, await chatToDraft(w, agent, SESSION));
    const dataDir = findDataDir(undefined, join(process.cwd()));
    if (!dataDir) throw new Error("data/ not found");
    const checks: ChecksPort = {
      ...testChecks,
      screenSanctions: liveChecks.screenSanctions,
      fx: async (pair) => {
        const rate = FX[pair];
        if (!rate) throw new Error(`no test FX for ${pair}`);
        return rate;
      },
    };
    deps = { ...w.deps, checks, webSearch: recordedWebSearch(dataDir) };
    app = createApiApp(async () => deps);
    const rpcHost = new URL(RPC_URL as string).host;
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.host !== rpcHost) outbound.push(url.host);
      return realFetch(input, init);
    });
  }, LIVE_TIMEOUT_MS);

  afterAll(async () => {
    vi.restoreAllMocks();
    await live?.close();
  });

  it("refuses the officer persona (founder only)", async () => {
    const res = await app.request("/api/suppliers/search", { method: "POST", headers: { cookie: w.cookie("officer"), "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(403);
  });

  it("searches from the committed plan and stores a READY web shortlist; injected pages never become candidates", async () => {
    const { searchId } = await json(await founder("/api/suppliers/search", { quantity: 300 }), z.object({ searchId: z.string() }));
    const s = await ready(searchId);
    expect(s).toMatchObject({ searchId, status: "READY", stage: "DONE", provider: "recorded", quantity: 300, failure: null, shortlistRequestId: searchId, sourcesFound: 10 });
    expect(s.excludedByGate).toEqual(expect.arrayContaining([{ gate: "AI_INJECTION", count: 2 }, { gate: "OFF_PLATFORM_DISCOUNT", count: 1 }]));
    expect(s.omitted).toContainEqual({ reason: "OFF_LIST", count: 1 });
    expect(s.candidates.length).toBeGreaterThan(0);
    for (const c of s.candidates) {
      expect(c).toMatchObject({ origin: "web", unverified: true, canOrder: true, failedGates: [] });
      expect(INJECTED).not.toContain(c.supplierId);
    }

    const [row] = (
      await live.db.$client.query<{ source: string; status: string; shortlist_hash: string; result_json: unknown; search_json: unknown }>(
        "select source, status, shortlist_hash, result_json, search_json from shortlists where facility_id = $1 and id = $2",
        [w.facilityId, searchId],
      )
    ).rows;
    expect(row).toMatchObject({ source: "web", status: "READY" });
    const shortlist = Shortlist.parse(row?.result_json);
    expect(row?.shortlist_hash).toBe(shortlist.shortlistHash);
    expect(shortlist.candidates.map((c) => c.supplierId)).toEqual(s.candidates.map((c) => c.supplierId));
    expect(SupplierSearch.parse(row?.search_json)).toEqual(s);

    const suppliers = await live.db.$client.query<{ supplier_id: string; display_name: string; record_json: { xenditTest: { channel: string }; listing: { url: string } } }>(
      "select supplier_id, display_name, record_json from suppliers where facility_id = $1 and supplier_id like 'supplier-w%'",
      [w.facilityId],
    );
    const byId = new Map(suppliers.rows.map((r) => [r.supplier_id, r]));
    for (const c of s.candidates) {
      const r = byId.get(c.supplierId);
      expect(r?.display_name).toBe(c.displayName);
      expect(r?.record_json.xenditTest.channel).toBe("UNSET");
      expect(new URL(r?.record_json.listing.url ?? "").hostname).toBe(c.listingHost);
    }
    const traces = await live.db.$client.query<{ summary: string }>("select summary from traces where facility_id = $1 and trace_id = $2 order by seq", [w.facilityId, searchId]);
    expect(traces.rows.map((t) => t.summary).join("\n")).toMatch(/Web supplier search started[\s\S]*Web supplier search ready/);
    expect(JSON.stringify(traces.rows)).not.toMatch(/Veltrix|Marrowind/);
    expect(outbound).toEqual([]);
  });

  it("reuses the identical READY search; a different one within a minute is RATE_LIMITED with Retry-After", async () => {
    const first = await json(await founder("/api/suppliers/search", { quantity: 300 }), z.object({ searchId: z.string() }));
    const again = await json(await founder("/api/suppliers/search", { quantity: 300 }), z.object({ searchId: z.string() }));
    expect(again.searchId).toBe(first.searchId);
    const other = await founder("/api/suppliers/search", { quantity: 250 });
    expect(other.status).toBe(409);
    expect(other.headers.get("retry-after")).toMatch(/^[1-9][0-9]*$/);
    expect(((await other.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe("RATE_LIMITED");
  });

  it("never publishes READY over a search the read path already reported FAILED (PENDING past the stale limit)", async () => {
    const scope = { facilityId: w.facilityId, founderId: w.founderId };
    const searchId = "sl-web-stale-test-0001";
    const job = await searchJob(deps, scope, 275, searchId);
    const pending = SupplierSearch.parse({ searchId, status: "PENDING", stage: "SEARCHING", provider: "recorded", sourcesFound: 0, omitted: [], excludedByGate: [], failure: null, shortlistRequestId: null, candidates: [], quantity: 275, createdAt: new Date(Date.now() - (PENDING_STALE_S + 60) * 1000).toISOString() });
    await live.db.$client.query(
      "insert into shortlists (id, facility_id, status, spec_json, source, search_json, created_at) values ($1, $2, 'PENDING', $3::jsonb, 'web', $4::jsonb, now() - make_interval(secs => $5))",
      [searchId, w.facilityId, JSON.stringify(job.spec), JSON.stringify(pending), PENDING_STALE_S + 60],
    );
    expect(await json(await founder(`/api/suppliers/search/${searchId}`), SupplierSearch)).toMatchObject({ status: "FAILED", failure: "PROVIDER_DOWN" });
    const port = deps.webSearch;
    if (!port) throw new Error("no web search port");
    await runWebSearch(deps, scope, port, job, pending);
    expect(await json(await founder(`/api/suppliers/search/${searchId}`), SupplierSearch)).toMatchObject({ status: "FAILED", failure: "PROVIDER_DOWN", candidates: [], shortlistRequestId: null });
    const [row] = (await live.db.$client.query<{ status: string; result_json: unknown; shortlist_hash: string | null }>("select status, result_json, shortlist_hash from shortlists where facility_id = $1 and id = $2", [w.facilityId, searchId])).rows;
    expect(row).toEqual({ status: "FAILED", result_json: null, shortlist_hash: null });
    const traces = await live.db.$client.query<{ summary: string }>("select summary from traces where facility_id = $1 and trace_id = $2", [w.facilityId, searchId]);
    expect(traces.rows.map((t) => t.summary).join("\n")).not.toMatch(/search ready/);
  });

  it("answers 404 for an unknown search id", async () => {
    expect((await founder("/api/suppliers/search/sl-web-unknown")).status).toBe(404);
  });
});
