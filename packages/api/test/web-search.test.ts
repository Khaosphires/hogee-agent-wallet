/**
 * Web supplier search (VISION-DECISIONS §9) without Postgres: the real pipeline (recorded port over the committed
 * samples, the real Reader in live mode with a mocked model, the real offline sanctions screen, core assembly) against a
 * SQL-answering fake database. Covers the enum-only query (T33), injected pages excluded, the limits and refusals, the
 * provider failures (no recorded fallback), the key never leaking, and the read path.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { handleFor, type ModelRegistry, type ModelRole, type ModelSpec } from "@hogee/agent";
import { CheckInputError, CheckUnavailableError, LISTING_DOMAINS, WebSearchLimitError, parseTavilyBody } from "@hogee/checks";
import { Shortlist, SupplierSearch, WEB_LISTING_DOMAINS, WebSearchAnswer, webSupplierIdOf, type WebSearchQuery } from "@hogee/core";
import { MockLanguageModelV4 } from "ai/test";
import type { AgentPort, ApiDeps, ChecksPort, WebSearchPort } from "../src/context";
import { ApiProblem } from "../src/http/problem";
import { budgetedAgentModels } from "../src/runtime/budgeted-models";
import { liveChecks } from "../src/runtime/ports";
import { ModelBudget, ModelBudgetExhaustedError } from "../src/services/model-budget";
import { recordedWebSearch, type RecordedWebSearchPort } from "../src/services/web-candidates";
import { SearchLimits, readWebSearch, startWebSearch } from "../src/services/web-search";
import { regexRedactor } from "./support/agent";
import { sgTestCatalog, testChecks } from "./support/catalog";
import { fakeDeps } from "./support/fake-deps";
import { jsonParams, searchDb, searchDbState, type SearchDbState } from "./support/search-db";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DATA = join(REPO, "data");
const RAW = JSON.parse(readFileSync(join(DATA, "suppliers/search/recorded/drinkware_food_contact-CN.json"), "utf8")) as { results: { url: string; title: string }[] };
const QUERY = "insulated stainless steel tumbler manufacturer China";
const FAKE_KEY = "tvly-THISISNOTAREALKEY0123456789";
const ID = { corvane: "supplier-wktbk5xmzmfob", veltrix: "supplier-w6yrjswhernrr", marrowind: "supplier-w5nwa6flp3s5t" };
const FOUNDER = { persona: "founder:mei" as const, client: "local" };
const CHECKS: ChecksPort = { screenSanctions: liveChecks.screenSanctions, validateRegistryId: liveChecks.validateRegistryId, fx: testChecks.fx };

const noModel: AgentPort = { configured: false, memoryKey: null, redactor: regexRedactor, budget: new ModelBudget(), models: () => { throw new Error("no model in this test"); } };

interface Harness {
  readonly deps: ApiDeps;
  readonly db: SearchDbState;
  readonly limits: SearchLimits;
  readonly queries: WebSearchQuery[];
  readonly logs: { level: string; event: string; fields: unknown }[];
  advance(ms: number): void;
  settle(): Promise<void>;
}

/** Records every query the provider receives (v-redteam wraps deps.webSearch the same way). */
function recording(port: WebSearchPort, queries: WebSearchQuery[]): WebSearchPort {
  return { ...port, search: (q, s) => (queries.push(q), port.search(q, s)) } as WebSearchPort;
}

function harness(opts: { port?: WebSearchPort; db?: Partial<SearchDbState>; agent?: AgentPort; checks?: ChecksPort } = {}): Harness {
  const db = searchDbState(opts.db);
  const queries: WebSearchQuery[] = [];
  let now = Date.parse("2026-10-19T09:00:00Z");
  const fake = fakeDeps({ deps: { db: searchDb(db), catalog: sgTestCatalog, checks: opts.checks ?? CHECKS, agent: opts.agent ?? noModel, clock: () => now, webSearch: recording(opts.port ?? recordedWebSearch(DATA), queries) } });
  const deps: ApiDeps = { ...fake.deps, config: { ...fake.deps.config, facilityId: "fac-mei", founderId: "founder-mei", countryCode: "SG", currency: "SGD" } };
  const limits = new SearchLimits();
  return { deps, db, limits, queries, logs: fake.logs, advance: (ms) => void (now += ms), settle: () => vi.waitFor(() => expect(limits.inFlight).toBe(0), { timeout: 10_000 }) };
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; reason: unknown; details: unknown }> {
  try {
    await p;
  } catch (error: unknown) {
    if (error instanceof ApiProblem) return { code: error.failure.code, reason: error.failure.details?.reason, details: error.failure.details };
    throw error;
  }
  throw new Error("expected a refusal");
}

/** The last search_json written (READY or FAILED). */
const lastBody = (h: Harness): SupplierSearch => SupplierSearch.parse(jsonParams(h.db, /update shortlists set/).filter((j) => (j as { searchId?: string }).searchId).at(-1));
const everything = (h: Harness): string => JSON.stringify([h.db.statements, h.logs]);

describe("recorded mode over the committed sample", () => {
  it("sends only the enum-built query and ranks the clean listings; injected pages are excluded, never shown", async () => {
    const h = harness();
    const { searchId } = await startWebSearch(h.deps, { facilityId: "fac-mei", founderId: "founder-mei" }, { quantity: 1000 }, FOUNDER, h.limits);
    await h.settle();
    expect(h.queries).toEqual([{ query: QUERY, includeDomains: [...LISTING_DOMAINS], maxResults: 10 }]);
    const body = lastBody(h);
    expect(body).toMatchObject({ searchId, status: "READY", stage: "DONE", provider: "recorded", sourcesFound: 10, quantity: 1000, failure: null, shortlistRequestId: searchId });
    expect(body.omitted).toEqual([{ reason: "OFF_LIST", count: 1 }]);
    expect(body.excludedByGate).toEqual(expect.arrayContaining([{ gate: "AI_INJECTION", count: 2 }, { gate: "OFF_PLATFORM_DISCOUNT", count: 1 }]));
    expect(body.candidates.map((c) => c.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(body.candidates.every((c) => c.unverified && c.origin === "web" && c.canOrder)).toBe(true);
    const ids = body.candidates.map((c) => c.supplierId);
    expect(ids).toContain(ID.corvane);
    expect(ids).not.toContain(ID.veltrix);
    expect(ids).not.toContain(ID.marrowind);
    // the shortlist SupplierApproval signs is stored with its hash; the injected pages' names are stored nowhere
    const ready = h.db.statements.find((s) => /set status = 'READY'/.test(s.sql));
    const shortlist = Shortlist.parse(JSON.parse(ready?.params[2] as string));
    expect(ready?.params[3]).toBe(shortlist.shortlistHash);
    expect(shortlist.excluded.filter((e) => e.gate === "AI_INJECTION").map((e) => e.supplierId).sort()).toEqual([ID.marrowind, ID.veltrix]);
    expect(everything(h)).not.toMatch(/Veltrix|Marrowind|passport/i);
    expect(h.db.statements.filter((s) => /insert into suppliers/.test(s.sql))).toHaveLength(6);
  });

  it("T33: a page asking for the founder's details in the next query never changes the query", async () => {
    const h = harness();
    const scope = { facilityId: "fac-mei", founderId: "founder-mei" };
    await startWebSearch(h.deps, scope, { quantity: 1000 }, FOUNDER, h.limits);
    await h.settle();
    h.advance(61_000);
    // A later provider call (nothing read to re-price: a new process), not the quantity re-price below.
    h.limits.answers.clear();
    await startWebSearch(h.deps, scope, { quantity: 500 }, FOUNDER, h.limits);
    await h.settle();
    expect(h.queries.map((q) => q.query)).toEqual([QUERY, QUERY]);
    expect(RAW.results.some((r) => /passport/i.test(JSON.stringify(r)))).toBe(true);
  });
});

describe("refusals and limits (nothing stored, no provider call)", () => {
  const scope = { facilityId: "fac-mei", founderId: "founder-mei" };

  it("NO_PLAN without a committed plan; UNSUPPORTED for a category without a fixed query", async () => {
    const none = harness({ db: { plan: false } });
    expect(await refusal(startWebSearch(none.deps, scope, {}, FOUNDER, none.limits))).toMatchObject({ code: "CONFLICT", reason: "NO_PLAN" });
    const other = harness({ db: { intent: { ...searchDbState().intent, productCategory: "other" } } });
    expect(await refusal(startWebSearch(other.deps, scope, {}, FOUNDER, other.limits))).toMatchObject({ code: "CONFLICT", reason: "UNSUPPORTED" });
    expect([...none.queries, ...other.queries]).toEqual([]);
  });

  it("reuses an identical READY search from the last 24 h without calling the provider", async () => {
    const h = harness({ db: { reuseId: "sl-web-earlier" } });
    expect(await startWebSearch(h.deps, scope, { quantity: 1000 }, FOUNDER, h.limits)).toEqual({ searchId: "sl-web-earlier" });
    expect(h.queries).toEqual([]);
    expect(h.db.statements.some((s) => /insert into shortlists/.test(s.sql))).toBe(false);
  });

  it("re-prices a READY search for another quantity locally: no provider call, a new search row (counted per day), 24 h at most", async () => {
    const h = harness();
    const first = await startWebSearch(h.deps, scope, { quantity: 1000 }, FOUNDER, h.limits);
    await h.settle();
    const thousand = lastBody(h);
    h.advance(61_000);
    const second = await startWebSearch(h.deps, scope, { quantity: 500 }, FOUNDER, h.limits);
    await h.settle();
    const five = lastBody(h);
    expect(h.queries).toHaveLength(1);
    expect(second.searchId).not.toBe(first.searchId);
    expect(five).toMatchObject({ searchId: second.searchId, status: "READY", quantity: 500, provider: "recorded", sourcesFound: thousand.sourcesFound });
    // Gates run again for the new quantity: the listing whose MOQ is 1,000 is now OVER_MOQ, the rest are re-ranked.
    const moq1000 = thousand.candidates.filter((c) => (c.moq ?? 0) > 500).map((c) => c.supplierId);
    expect(moq1000).toHaveLength(1);
    expect(five.candidates.map((c) => c.supplierId).sort()).toEqual(thousand.candidates.map((c) => c.supplierId).filter((id) => !moq1000.includes(id)).sort());
    expect(five.excludedByGate).toEqual(expect.arrayContaining([{ gate: "OVER_MOQ", count: 1 }]));
    const landed = (b: SupplierSearch, id: string) => BigInt(b.candidates.find((c) => c.supplierId === id)?.landedCostMinor ?? "0");
    expect(landed(five, ID.corvane)).toBeGreaterThan(0n);
    expect(landed(five, ID.corvane)).toBeLessThan(landed(thousand, ID.corvane));
    // Each search is its own row, so the 20-a-day cap per facility still counts it.
    expect(h.db.statements.filter((x) => /insert into shortlists/.test(x.sql))).toHaveLength(2);
    // After 24 h the listings are read again (a provider call).
    h.advance(24 * 60 * 60 * 1000);
    await startWebSearch(h.deps, scope, { quantity: 700 }, FOUNDER, h.limits);
    await h.settle();
    expect(h.queries).toHaveLength(2);
  });

  it("one search in flight per process (IN_FLIGHT), one a minute per session (RATE_LIMITED), 20 a day per facility", async () => {
    let release: () => void = () => undefined;
    const slow: WebSearchPort = { provider: "recorded", search: async (q) => (await new Promise<void>((r) => (release = r)), recordedWebSearch(DATA).search(q)) };
    const h = harness({ port: { ...recordedWebSearch(DATA), search: slow.search } as WebSearchPort });
    await startWebSearch(h.deps, scope, { quantity: 1000 }, FOUNDER, h.limits);
    expect(await refusal(startWebSearch(h.deps, scope, { quantity: 900 }, { ...FOUNDER, client: "other" }, h.limits))).toMatchObject({ reason: "IN_FLIGHT" });
    release();
    await h.settle();
    const again = await refusal(startWebSearch(h.deps, scope, { quantity: 900 }, FOUNDER, h.limits));
    expect(again).toMatchObject({ code: "CONFLICT", reason: "RATE_LIMITED" });
    expect((again.details as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
    h.advance(60_000);
    const day = harness({ db: { daily: 20 } });
    expect(await refusal(startWebSearch(day.deps, scope, {}, FOUNDER, day.limits))).toMatchObject({ reason: "RATE_LIMITED", details: { retryAfterSeconds: 3_600 } });
    expect(day.queries).toEqual([]);
  });

  it("live mode refuses BUDGET before calling Tavily when the model budget cannot cover results x 2 Reader calls", async () => {
    const tiny = new ModelBudget({ windowMs: 86_400_000, windowCalls: 10, windowChars: 30_000_000, totalCalls: 5_000, totalChars: 100_000_000, outputReserveChars: 16_384 });
    const port: WebSearchPort = { provider: "tavily", search: async () => { throw new Error("must not be called"); } };
    const h = harness({ port, agent: { ...noModel, configured: true, budget: tiny } });
    expect(await refusal(startWebSearch(h.deps, scope, {}, FOUNDER, h.limits))).toMatchObject({ reason: "BUDGET" });
    expect(h.queries).toEqual([]);
    expect(h.limits.inFlight).toBe(0);
  });
});

describe("failures fail the search closed (no recorded fallback, no key in any output)", () => {
  const scope = { facilityId: "fac-mei", founderId: "founder-mei" };
  const live: AgentPort = { ...noModel, configured: true };

  it("a provider error is PROVIDER_DOWN; its message (with a key in it) is stored and logged nowhere", async () => {
    const port: WebSearchPort = { provider: "tavily", search: async () => { throw new Error(`Tavily refused ${FAKE_KEY}`); } };
    const h = harness({ port, agent: live });
    await startWebSearch(h.deps, scope, {}, FOUNDER, h.limits);
    await h.settle();
    expect(lastBody(h)).toMatchObject({ status: "FAILED", failure: "PROVIDER_DOWN", provider: "tavily", candidates: [] });
    expect(everything(h)).not.toContain("tvly-");
    expect(h.logs.find((l) => l.event === "web_search_failed")?.fields).toEqual({ searchId: expect.any(String), failure: "PROVIDER_DOWN", errorName: "WebSearchFailure" });
  });

  it("a provider limit is PROVIDER_LIMIT", async () => {
    const port: WebSearchPort = { provider: "tavily", search: async () => { throw new WebSearchLimitError("Tavily: rate limit reached"); } };
    const h = harness({ port, agent: live });
    await startWebSearch(h.deps, scope, {}, FOUNDER, h.limits);
    await h.settle();
    expect(lastBody(h)).toMatchObject({ status: "FAILED", failure: "PROVIDER_LIMIT" });
  });

  it("a model budget refused after the check fails the search (BUDGET), never PROVIDER_DOWN", async () => {
    const raw = JSON.parse(readFileSync(join(DATA, "suppliers/search/recorded/drinkware_food_contact-CN.json"), "utf8")) as unknown;
    const port: WebSearchPort = { provider: "tavily", search: async () => WebSearchAnswer.parse(parseTavilyBody(raw, "2026-10-19T09:00:00Z")) };
    const closed = harness({ port, agent: { ...live, models: () => { throw new ModelBudgetExhaustedError("window", 1_000); } } });
    await startWebSearch(closed.deps, scope, {}, FOUNDER, closed.limits);
    await closed.settle();
    expect(lastBody(closed)).toMatchObject({ status: "FAILED", failure: "BUDGET", candidates: [] });
  });

  it("a sanctions screen that cannot run fails the whole search (SANCTIONS_UNAVAILABLE)", async () => {
    const h = harness({ checks: { ...CHECKS, screenSanctions: async () => { throw new Error("list missing"); } } });
    await startWebSearch(h.deps, scope, {}, FOUNDER, h.limits);
    await h.settle();
    expect(lastBody(h)).toMatchObject({ status: "FAILED", failure: "SANCTIONS_UNAVAILABLE", candidates: [] });
    expect(h.db.statements.some((s) => /insert into suppliers/.test(s.sql))).toBe(false);
  });

  describe("audit run-9 lead 1: one listing's seller name never fails the whole search", () => {
    const corvaneOnly = (name: string) => name.startsWith("Yongkang Corvane");

    it("a recorded listing whose grounded seller name has nothing to screen (U+02B9 U+02B9, tatweel, fillers) is omitted NO_SELLER", async () => {
      for (const odd of ["ʹʹ", "ـــ", "ᅠᅠ"]) {
        const rec = recordedWebSearch(DATA);
        const port: RecordedWebSearchPort = {
          provider: "recorded",
          search: async (q, s) => {
            const a = await rec.search(q, s);
            return { ...a, results: a.results.map((r) => (webSupplierIdOf(r.url) === ID.corvane ? { ...r, rawText: `${r.rawText}\nCompany: ${odd}\nUnit price: USD 2.10` } : r)) };
          },
          reading: async (id) => {
            const r = await rec.reading(id);
            return r && id === ID.corvane && r.fields.sellerName ? { ...r, fields: { ...r.fields, sellerName: { ...r.fields.sellerName, value: odd } } } : r;
          },
        };
        const h = harness({ port });
        await startWebSearch(h.deps, scope, { quantity: 1000 }, FOUNDER, h.limits);
        await h.settle();
        const body = lastBody(h);
        expect(body, JSON.stringify(odd)).toMatchObject({ status: "READY", failure: null });
        expect(body.candidates.map((c) => c.supplierId)).not.toContain(ID.corvane);
        expect(body.candidates).toHaveLength(4);
        expect(body.omitted).toEqual([{ reason: "OFF_LIST", count: 1 }, { reason: "NO_SELLER", count: 1 }]);
      }
    });

    it("a name the screen refuses as input (CheckInputError) omits only that listing; the rest are ranked", async () => {
      const screenSanctions: ChecksPort["screenSanctions"] = async (name) => (corvaneOnly(name) ? Promise.reject(new CheckInputError("name has no letters or digits to screen")) : CHECKS.screenSanctions(name));
      const h = harness({ checks: { ...CHECKS, screenSanctions } });
      await startWebSearch(h.deps, scope, { quantity: 1000 }, FOUNDER, h.limits);
      await h.settle();
      const body = lastBody(h);
      expect(body).toMatchObject({ status: "READY", failure: null });
      expect(body.candidates.map((c) => c.supplierId)).not.toContain(ID.corvane);
      expect(body.candidates).toHaveLength(4);
      expect(body.omitted).toEqual([{ reason: "OFF_LIST", count: 1 }, { reason: "NO_SELLER", count: 1 }]);
      const stored = h.db.statements.filter((s) => /insert into suppliers/.test(s.sql)).map((s) => s.params[1]);
      expect(stored).not.toContain(ID.corvane);
      expect(everything(h)).not.toContain("Corvane");
    });

    it("a list that cannot be read (CheckUnavailableError) still fails the whole search, even next to an unscreenable name", async () => {
      for (const screenSanctions of [
        async (): Promise<never> => Promise.reject(new CheckUnavailableError("sanctions list is missing")),
        async (name: string): Promise<never> => Promise.reject(corvaneOnly(name) ? new CheckInputError("x") : new CheckUnavailableError("sanctions list is missing")),
      ]) {
        const h = harness({ checks: { ...CHECKS, screenSanctions } });
        await startWebSearch(h.deps, scope, {}, FOUNDER, h.limits);
        await h.settle();
        expect(lastBody(h)).toMatchObject({ status: "FAILED", failure: "SANCTIONS_UNAVAILABLE", candidates: [] });
        expect(h.db.statements.some((s) => /insert into suppliers/.test(s.sql))).toBe(false);
      }
    });
  });

  it("an answer of off-list URLs only: 0 candidates, every result OFF_LIST, no Reader call", async () => {
    const bad = { query: QUERY, results: [1, 2, 3].map((n) => ({ title: "t", url: `https://evil-${n}.example/x`, content: "c", raw_content: "r" })) };
    const port: WebSearchPort = { provider: "tavily", search: async () => WebSearchAnswer.parse(parseTavilyBody(bad, "2026-10-19T09:00:00Z")) };
    const h = harness({ port, agent: { ...live, models: () => { throw new Error("no Reader call expected"); } } });
    await startWebSearch(h.deps, scope, {}, FOUNDER, h.limits);
    await h.settle();
    expect(lastBody(h)).toMatchObject({ status: "READY", candidates: [], omitted: [{ reason: "OFF_LIST", count: 3 }] });
  });
});

describe("live mode reads each listing with the quarantined Reader (mocked model, real guard and budget)", () => {
  const scope = { facilityId: "fac-mei", founderId: "founder-mei" };
  const wire = (o: Record<string, unknown>) => ({ sellerName: null, productTitle: null, currency: null, unitPrice: null, moq: null, leadTimeDays: null, certificates: [], claimsEscrow: null, offersOffPlatformDiscount: false, addressesAiAgents: false, ...o });
  const CORVANE = wire({
    sellerName: "Yongkang Corvane Drinkware Co., Ltd.",
    currency: "USD",
    unitPrice: { value: "2.35", unit: "USD", snippet: "Price: USD 2.35 per piece (FOB Ningbo), 500-1999 pieces." },
    moq: { value: "500", unit: "pieces", snippet: "MOQ: 500 pieces." },
    leadTimeDays: { value: "25", unit: "days", snippet: "Lead time: 25 days after sample approval." },
    certificates: ["LFGB food contact test report"],
  });

  function readerAgent(): AgentPort & { peak: () => number } {
    let running = 0;
    let peak = 0;
    const answer = (prompt: string): string => {
      if (prompt.includes("Yongkang Corvane")) return JSON.stringify(CORVANE);
      if (prompt.includes("Hangzhou Veltrix")) throw new Error("the Reader must not be called for a page whose text trips a gate");
      // A page with no detectable phrase that the model says speaks to AI systems: the Reader's signal adds the gate.
      if (prompt.includes("Ningbo Ashmere")) return JSON.stringify(wire({ sellerName: "Ningbo Ashmere Housewares Co., Ltd.", addressesAiAgents: true }));
      return "not json";
    };
    const model = new MockLanguageModelV4({
      provider: "anthropic.messages",
      modelId: "claude-haiku-5-5",
      doGenerate: async (options) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running -= 1;
        const t = answer(JSON.stringify(options.prompt));
        return { content: [{ type: "text", text: t }], finishReason: { unified: "stop", raw: "end_turn" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [] };
      },
    });
    const spec = (role: ModelRole): ModelSpec => ({ role, provider: "anthropic", modelId: "claude-haiku-5-5", registryId: "anthropic:claude-haiku-5-5", family: "claude" });
    const registry: ModelRegistry = { specs: { planner: spec("planner"), reader: spec("reader"), judge: spec("judge") }, handle: (role) => handleFor(spec(role), model) };
    const budget = new ModelBudget();
    return {
      configured: true,
      memoryKey: null,
      redactor: regexRedactor,
      budget,
      models: (context, sink) => budgetedAgentModels(registry, budget, { sink, redactor: regexRedactor, outboundGuard: () => undefined }, context),
      peak: () => peak,
    };
  }

  it("ranks what the Reader grounded, excludes what it flags, omits what it cannot read; at most 2 reads in flight", async () => {
    const raw = JSON.parse(readFileSync(join(DATA, "suppliers/search/recorded/drinkware_food_contact-CN.json"), "utf8")) as unknown;
    const port: WebSearchPort = { provider: "tavily", search: async () => WebSearchAnswer.parse(parseTavilyBody(raw, "2026-10-19T09:00:00Z")) };
    const agent = readerAgent();
    const h = harness({ port, agent });
    await startWebSearch(h.deps, scope, { quantity: 1000 }, FOUNDER, h.limits);
    await h.settle();
    const body = lastBody(h);
    expect(body.status).toBe("READY");
    expect(body.candidates.map((c) => c.supplierId)).toEqual([ID.corvane]);
    expect(body.candidates[0]).toMatchObject({ displayName: "Yongkang Corvane Drinkware Co., Ltd.", moq: 500, leadTimeDays: 25, unverified: true, listingHost: "www.alibaba.com" });
    expect(body.excludedByGate).toEqual([
      { gate: "OFF_PLATFORM_DISCOUNT", count: 1 },
      { gate: "AI_INJECTION", count: 3 },
    ]);
    expect(body.omitted).toEqual([
      { reason: "OFF_LIST", count: 1 },
      { reason: "READER_REJECTED", count: 4 },
    ]);
    expect(agent.peak()).toBeLessThanOrEqual(2);
    expect(agent.budget.status().window.calls).toBeGreaterThan(0);
  });

  it("agentsec LOW 6: another quantity spends no Tavily call and no Reader call, and needs no model budget headroom", async () => {
    const raw = JSON.parse(readFileSync(join(DATA, "suppliers/search/recorded/drinkware_food_contact-CN.json"), "utf8")) as unknown;
    const port: WebSearchPort = { provider: "tavily", search: async () => WebSearchAnswer.parse(parseTavilyBody(raw, "2026-10-19T09:00:00Z")) };
    const agent = readerAgent();
    const h = harness({ port, agent });
    await startWebSearch(h.deps, scope, { quantity: 1000 }, FOUNDER, h.limits);
    await h.settle();
    const calls = agent.budget.status().window.calls;
    for (const [i, quantity] of [600, 800, 1200].entries()) {
      h.advance(61_000);
      const { searchId } = await startWebSearch(h.deps, scope, { quantity }, { ...FOUNDER, client: `c${i}` }, h.limits);
      await h.settle();
      expect(lastBody(h)).toMatchObject({ searchId, status: "READY", quantity, provider: "tavily" });
      expect(lastBody(h).candidates.map((c) => c.supplierId)).toEqual([ID.corvane]);
    }
    expect(h.queries).toHaveLength(1);
    expect(agent.budget.status().window.calls).toBe(calls);
  });
});

describe("parity and storage", () => {
  it("core's listing sites (the UI's link check) equal the checks client's allow-list", () => {
    expect([...WEB_LISTING_DOMAINS]).toEqual([...LISTING_DOMAINS]);
  });

  it("writes web supplier rows once: a later search never rewrites a supplier the founder may have picked", async () => {
    const h = harness();
    await startWebSearch(h.deps, { facilityId: "fac-mei", founderId: "founder-mei" }, { quantity: 1000 }, FOUNDER, h.limits);
    await h.settle();
    const inserts = h.db.statements.filter((x) => /insert into suppliers/.test(x.sql));
    expect(inserts.length).toBeGreaterThan(0);
    for (const i of inserts) expect(i.sql).toMatch(/on conflict \(facility_id, supplier_id\) do nothing/);
  });
});

describe("readWebSearch", () => {
  const scope = { facilityId: "fac-mei", founderId: "founder-mei" };
  const pending: SupplierSearch = { searchId: "sl-web-1", status: "PENDING", stage: "READING", provider: "recorded", sourcesFound: 3, omitted: [], excludedByGate: [], failure: null, shortlistRequestId: null, candidates: [], quantity: 1000, createdAt: "2026-10-19T09:00:00.000Z" };

  it("answers the stored body; a PENDING row older than 2 minutes reads FAILED (PROVIDER_DOWN); unknown is NOT_FOUND", async () => {
    expect(await readWebSearch(harness({ db: { row: { search_json: pending, stale: false } } }).deps, scope, "sl-web-1")).toEqual(pending);
    expect(await readWebSearch(harness({ db: { row: { search_json: pending, stale: true } } }).deps, scope, "sl-web-1")).toMatchObject({ status: "FAILED", failure: "PROVIDER_DOWN", candidates: [] });
    expect(await refusal(readWebSearch(harness().deps, scope, "sl-web-404"))).toMatchObject({ code: "NOT_FOUND" });
  });
});
