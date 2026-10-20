/**
 * Web supplier search (VISION-DECISIONS §8-§9): the query from the COMMITTED plan (core supplierQuery: two enums through
 * outboundArgSink(trusted(...))), the provider through deps.webSearch, then web-candidates.ts; the result is a `web`
 * shortlist row (result_json = the core Shortlist SupplierApproval signs, search_json = the SupplierSearch body).
 *
 * Refused before anything is stored or sent (CONFLICT, details.reason): NO_PLAN, UNSUPPORTED (no fixed query or no
 * pack facts to price it), IN_FLIGHT (1 search in flight per process), RATE_LIMITED (1 a minute per session key,
 * 20 a day per facility), BUDGET (live mode: the model budget cannot cover results × 2 Reader calls; checked before the
 * provider call). An identical READY search (same committed spec, same provider) from the last 24 h is reused: no
 * provider call, same searchId. A search for another QUANTITY of the same category and sourcing country, with the same
 * provider, within 24 h of the listings being read, is re-priced locally (agentsec LOW 6): a new row (it counts toward
 * the 20 a day), the same provider answer and Reader outputs (ReadAnswerCache, per process), every check and the
 * pricing run again for the new quantity; no provider call, no Reader call, so no model budget is needed for it.
 *
 * Otherwise a PENDING row is written and the pipeline runs in-process with a 45 s deadline. A provider failure fails
 * the search (PROVIDER_DOWN / PROVIDER_LIMIT): there is no silent switch to recorded results. A PENDING row older than
 * 2 minutes reads as FAILED, and READY is never published over it (READY_CUTOFF_S): it is stored FAILED instead. Provider and check errors are never logged or stored raw (only their class name), so a
 * key inside an error message cannot leak.
 */
import { LISTING_DOMAINS, WebSearchLimitError } from "@hogee/checks";
import {
  DEFAULT_SEARCH_QUANTITY,
  PlanIntent,
  PlanManifest,
  SupplierSearch,
  WebSearchAnswer,
  fakeHex32,
  landedCostFromPack,
  supplierQuery,
  type Persona,
  type SearchProvider,
  type SearchStage,
  type Supplier,
  type SupplierSearchBody,
  type WebSearchQuery,
} from "@hogee/core";
import type { ApiDeps, Scope, WebSearchPort } from "../context";
import { ConfigError, fail, type ApiProblem } from "../http/problem";
import { WindowCounter } from "../http/rate-limit";
import { packFor, requireServerCountry } from "./compile";
import { requireFacility } from "./facility";
import { newId } from "./ids";
import { committedPlanRow } from "./plans";
import { requirePricingCurrency, supersedeOldShortlists } from "./shortlist";
import { inTx, one, pool, type Q } from "./sql";
import { appendTrace } from "./traces";
import { WebSearchFailure, readWebAnswer, scoreReadAnswer, type ReadAnswer, type WebSearchJob } from "./web-candidates";
import { MAX_OPEN_SHORTLISTS, lockWriter } from "./writer-bounds";

/** Who asked (the per-session and per-client limits key on it). */
export interface SearchRequester {
  readonly persona: Persona;
  /** http/rate-limit clientAddress. */
  readonly client: string;
}

export type SearchRefusal = "NO_PLAN" | "UNSUPPORTED" | "IN_FLIGHT" | "RATE_LIMITED" | "BUDGET";

export const SEARCH_DEADLINE_MS = 45_000;
export const PENDING_STALE_S = 120;
/**
 * READY is published only while the row is younger than this (security audit run-9 hardening): well inside
 * PENDING_STALE_S, so a search the read path has already reported FAILED never turns READY afterwards.
 */
export const READY_CUTOFF_S = PENDING_STALE_S - 10;
export const REUSE_WINDOW_S = 24 * 60 * 60;
export const DAILY_SEARCHES = 20;
export const SESSION_WINDOW_MS = 60_000;
/** Results asked of the provider (the off-list ones are dropped; up to 10 reach the Reader). */
export const SEARCH_MAX_RESULTS = 10;
/** One read plus at most one repair turn per listing. */
export const READER_CALLS_PER_RESULT = 2;
/** What one Reader call may send: the listing (≤ 12,000 characters) plus the instructions and the output schema. */
export const READER_CALL_CHARS = 16_000;

/** Read answers kept for re-pricing at most (per process; the oldest goes first). */
export const READ_ANSWERS_MAX = 32;

/**
 * Provider answers with their listings read, for re-pricing another quantity (agentsec LOW 6). Keyed by facility,
 * country, currency, category, sourcing country and provider (never the quantity); an entry lives REUSE_WINDOW_S from
 * when its listings were read (re-pricing never refreshes it), and at most READ_ANSWERS_MAX are kept.
 */
export class ReadAnswerCache {
  private readonly entries = new Map<string, { readonly read: ReadAnswer; readonly atMs: number }>();

  constructor(
    private readonly max = READ_ANSWERS_MAX,
    private readonly ttlMs = REUSE_WINDOW_S * 1000,
  ) {}

  get(key: string, nowMs: number): ReadAnswer | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (!(nowMs - e.atMs < this.ttlMs)) {
      this.entries.delete(key);
      return undefined;
    }
    return e.read;
  }

  set(key: string, read: ReadAnswer, nowMs: number): void {
    this.entries.delete(key);
    while (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { read, atMs: nowMs });
  }

  clear(): void {
    this.entries.clear();
  }
}

/** The re-pricing key: everything the provider answer and the Reader outputs depend on, never the quantity. */
export function readAnswerKey(deps: ApiDeps, scope: Scope, job: WebSearchJob, provider: SearchProvider): string {
  return JSON.stringify([scope.facilityId, deps.config.countryCode, job.currency, job.spec.productCategory, job.spec.buyFrom, provider]);
}

/** Per-process limits: 1 search in flight, 1 a minute per session key; the read answers kept for re-pricing. Tests pass their own. */
export class SearchLimits {
  private running = 0;
  readonly perSession = new WindowCounter(1, SESSION_WINDOW_MS);
  readonly answers = new ReadAnswerCache();

  /** Takes the one in-flight slot, or false when a search is already running. */
  enter(): boolean {
    if (this.running >= 1) return false;
    this.running += 1;
    return true;
  }

  leave(): void {
    this.running = Math.max(0, this.running - 1);
  }

  get inFlight(): number {
    return this.running;
  }
}

export const PROCESS_SEARCH_LIMITS = new SearchLimits();

const refuse = (reason: SearchRefusal, message: string, extra: Record<string, number> = {}): ApiProblem => fail("CONFLICT", message, { details: { reason, ...extra } });

/** The committed plan's intent and SUPPLIER line, or null (no committed plan, or one whose draft is unreadable). */
async function committedPlan(q: Q, scope: Scope): Promise<{ intent: PlanIntent; supplierBudgetMinor: string } | null> {
  const plan = await committedPlanRow(q, scope);
  if (!plan?.draft_id) return null;
  const draft = await one<{ intent_json: unknown }>(q, "select intent_json from plan_drafts where facility_id = $1 and id = $2", [scope.facilityId, plan.draft_id]);
  const intent = PlanIntent.safeParse(draft?.intent_json);
  const manifest = PlanManifest.safeParse(plan.manifest_json);
  const supplier = manifest.success ? manifest.data.lines.find((l) => l.lineKey === "SUPPLIER") : undefined;
  return intent.success && supplier ? { intent: intent.data, supplierBudgetMinor: supplier.amountMinor } : null;
}

/** A unit rate, only to ask the pack whether it can price this category from this country (never shown or stored). */
const PROBE_FX = { value: 1, sourceUrl: "https://example.invalid/probe", retrievedAt: "2026-01-01T00:00:00Z", snippetHash: fakeHex32("web-search:probe"), evidence: "tier3", sourceType: "mock" } as const;

/**
 * The search a committed plan asks for: spec (category, buyFrom, quantity, the SUPPLIER line as budget), the server
 * country's pack in the facility's currency, and the query. Refuses NO_PLAN / UNSUPPORTED (CONFLICT).
 */
export async function searchJob(deps: ApiDeps, scope: Scope, quantity: number, searchId: string): Promise<WebSearchJob & { readonly query: string }> {
  const db = pool(deps.db);
  const facility = await requireFacility(db, scope);
  await requireServerCountry(deps, db, scope, facility, "nothing was searched");
  requirePricingCurrency(deps, facility.currency);
  const plan = await committedPlan(db, scope);
  if (!plan) throw refuse("NO_PLAN", "There is no committed plan yet, so there is nothing to search for");
  const query = supplierQuery(plan.intent);
  if (!query) throw refuse("UNSUPPORTED", "Web search has no fixed query for this product category or sourcing country");
  const spec = { productCategory: plan.intent.productCategory, buyFrom: plan.intent.buyFrom, quantity, budgetMinor: plan.supplierBudgetMinor };
  let pack;
  try {
    pack = await packFor(deps, deps.config.countryCode);
    if (pack.currency !== facility.currency) throw new Error("pack currency");
    landedCostFromPack({ countryPack: pack, origin: spec.buyFrom, productCategory: spec.productCategory, quantity: 1, fobUnitMinor: "100", freightPerUnitMinor: "0", fx: PROBE_FX });
  } catch {
    throw refuse("UNSUPPORTED", "The country pack cannot price this product from this sourcing country yet, so nothing was searched");
  }
  return { searchId, spec, pack, currency: facility.currency, query };
}

/** The newest identical READY search of this provider from the last 24 h (reuse: no provider call). */
async function reusable(q: Q, scope: Scope, spec: WebSearchJob["spec"], provider: SearchProvider): Promise<string | undefined> {
  const r = await one<{ id: string }>(
    q,
    `select id from shortlists where facility_id = $1 and source = 'web' and status = 'READY' and spec_json = $2::jsonb
        and search_json->>'provider' = $3 and created_at > now() - make_interval(secs => $4) order by created_at desc, id desc limit 1`,
    [scope.facilityId, JSON.stringify(spec), provider, REUSE_WINDOW_S],
  );
  return r?.id;
}

/** Seconds until the facility may start another search today, or 0 when it is under DAILY_SEARCHES. */
async function dailyWaitS(q: Q, scope: Scope): Promise<number> {
  const r = await one<{ n: number; wait_s: number | null }>(
    q,
    `select count(*)::int as n, ceil(extract(epoch from (min(created_at) + make_interval(secs => $2) - now())))::int as wait_s
       from shortlists where facility_id = $1 and source = 'web' and created_at > now() - make_interval(secs => $2)`,
    [scope.facilityId, REUSE_WINDOW_S],
  );
  return (r?.n ?? 0) >= DAILY_SEARCHES ? Math.max(1, r?.wait_s ?? 1) : 0;
}

/** True when the model budget has room for `calls` Reader calls of READER_CALL_CHARS (a check: the calls reserve). */
export function budgetCovers(deps: ApiDeps, calls: number): boolean {
  const budget = deps.agent.budget;
  const s = budget.status();
  const l = budget.limits;
  const chars = calls * (READER_CALL_CHARS + l.outputReserveChars);
  return s.open && s.window.calls + calls <= l.windowCalls && s.total.calls + calls <= l.totalCalls && s.window.chars + chars <= l.windowChars && s.total.chars + chars <= l.totalChars;
}

const searchBody = (searchId: string, provider: SearchProvider, quantity: number, createdAt: string): SupplierSearch => ({
  searchId,
  status: "PENDING",
  stage: "SEARCHING",
  provider,
  sourcesFound: 0,
  omitted: [],
  excludedByGate: [],
  failure: null,
  shortlistRequestId: null,
  candidates: [],
  quantity,
  createdAt,
});

/**
 * Starts (or reuses) a web supplier search for the committed plan. Returns at once; the card polls readWebSearch.
 * `limits` is the process's unless a test passes its own.
 */
export async function startWebSearch(deps: ApiDeps, scope: Scope, body: SupplierSearchBody, who: SearchRequester, limits: SearchLimits = PROCESS_SEARCH_LIMITS): Promise<{ searchId: string }> {
  const port = deps.webSearch;
  if (!port) throw new ConfigError("Web supplier search is not configured");
  const quantity = body.quantity ?? DEFAULT_SEARCH_QUANTITY;
  const searchId = newId("sl-web");
  const job = await searchJob(deps, scope, quantity, searchId);
  const db = pool(deps.db);
  const reuse = await reusable(db, scope, job.spec, port.provider);
  if (reuse) return { searchId: reuse };
  if (!limits.enter()) throw refuse("IN_FLIGHT", "A supplier search is already running; wait for it to finish");
  let started = false;
  try {
    const sessionKey = `${who.persona}|${who.client}`;
    const now = deps.clock();
    const waitMs = limits.perSession.waitMs(sessionKey, now);
    if (waitMs > 0) throw refuse("RATE_LIMITED", "One supplier search a minute; try again shortly", { retryAfterSeconds: Math.ceil(waitMs / 1000) });
    const dailyWait = await dailyWaitS(db, scope);
    if (dailyWait > 0) throw refuse("RATE_LIMITED", `${DAILY_SEARCHES} supplier searches a day is the limit; try again later`, { retryAfterSeconds: dailyWait });
    const key = readAnswerKey(deps, scope, job, port.provider);
    const reread = limits.answers.get(key, now);
    if (port.provider === "tavily" && !reread) {
      if (!deps.agent.configured) throw new ConfigError("Live web search needs a configured model provider to read the listings");
      if (!budgetCovers(deps, SEARCH_MAX_RESULTS * READER_CALLS_PER_RESULT)) throw refuse("BUDGET", "The model budget cannot cover reading the search results now; try again later");
    }
    const pending = searchBody(searchId, port.provider, quantity, new Date(now).toISOString());
    await inTx(deps.db, async (q) => {
      await lockWriter(q, "shortlists", scope.facilityId);
      await q.query("insert into shortlists (id, facility_id, status, spec_json, source, search_json) values ($1, $2, 'PENDING', $3::jsonb, 'web', $4::jsonb)", [
        searchId,
        scope.facilityId,
        JSON.stringify(job.spec),
        JSON.stringify(SupplierSearch.parse(pending)),
      ]);
      const how = reread ? "; re-priced for this quantity from the listings already read, no provider or Reader call" : "";
      await appendTrace(q, { facilityId: scope.facilityId, traceId: searchId, actor: "reader", kind: "TOOL_CALL", summary: `Web supplier search started (${port.provider === "recorded" ? "recorded sample" : "live"}; query built from the committed plan${how})` });
    });
    limits.perSession.hit(sessionKey, now);
    started = true;
    void runWebSearch(deps, scope, port, job, pending, { answers: limits.answers, key, ...(reread ? { reread } : {}) }).finally(() => limits.leave());
    return { searchId };
  } finally {
    if (!started) limits.leave();
  }
}

async function setStage(deps: ApiDeps, scope: Scope, body: SupplierSearch, stage: SearchStage, sourcesFound = body.sourcesFound): Promise<SupplierSearch> {
  const next = { ...body, stage, sourcesFound };
  await pool(deps.db).query("update shortlists set search_json = $3::jsonb, updated_at = now() where facility_id = $1 and id = $2 and status = 'PENDING'", [
    scope.facilityId,
    body.searchId,
    JSON.stringify(SupplierSearch.parse(next)),
  ]);
  return next;
}

/** Re-pricing (agentsec LOW 6): where a READY search's read answer is kept, its key, and the one to re-price, if any. */
export interface ReadAnswerReuse {
  readonly answers: ReadAnswerCache;
  readonly key: string;
  /** Listings already read for this key: re-priced for `job.spec`, with no provider or Reader call. */
  readonly reread?: ReadAnswer;
}

/** The provider answer for `job`'s query (no recorded fallback: any failure fails the search). */
async function providerAnswer(port: WebSearchPort, job: WebSearchJob & { readonly query: string }, signal: AbortSignal): Promise<WebSearchAnswer> {
  const q: WebSearchQuery = { query: job.query, includeDomains: [...LISTING_DOMAINS], maxResults: SEARCH_MAX_RESULTS };
  let answer: WebSearchAnswer;
  try {
    answer = WebSearchAnswer.parse(await port.search(q, signal));
  } catch (error: unknown) {
    throw new WebSearchFailure(error instanceof WebSearchLimitError ? "PROVIDER_LIMIT" : "PROVIDER_DOWN");
  }
  if (answer.provider !== port.provider) throw new WebSearchFailure("PROVIDER_DOWN");
  return answer;
}

/** The pipeline behind a PENDING row; always ends READY or FAILED (never throws). */
export async function runWebSearch(
  deps: ApiDeps,
  scope: Scope,
  port: WebSearchPort,
  job: WebSearchJob & { readonly query: string },
  pending: SupplierSearch,
  reuse?: ReadAnswerReuse,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_DEADLINE_MS);
  let body = pending;
  try {
    const answer = reuse?.reread?.answer ?? (await providerAnswer(port, job, controller.signal));
    body = await setStage(deps, scope, body, "READING", answer.results.length + answer.droppedOffList);
    const read = reuse?.reread ?? (await readWebAnswer(deps, scope, port, job.searchId, answer, controller.signal));
    const out = await scoreReadAnswer(deps, port, job, read, controller.signal, async (stage) => {
      body = await setStage(deps, scope, body, stage);
    });
    const ready = SupplierSearch.parse({
      ...body,
      status: "READY",
      stage: "DONE",
      omitted: out.omitted,
      excludedByGate: out.excludedByGate,
      shortlistRequestId: out.shortlist.requestId,
      candidates: out.candidates,
    });
    // Not published (the row went stale or was superseded): it fails closed like the read path already reports it.
    if (!(await storeReady(deps, scope, ready, out))) throw new WebSearchFailure("PROVIDER_DOWN");
    // Kept for another quantity only once READY; a re-priced search keeps the original's read time (never refreshed).
    if (reuse && !reuse.reread) reuse.answers.set(reuse.key, read, deps.clock());
  } catch (error: unknown) {
    const failure = error instanceof WebSearchFailure ? error.failure : "PROVIDER_DOWN";
    deps.log.warn("web_search_failed", { searchId: pending.searchId, failure, errorName: error instanceof Error ? error.name : "unknown" });
    await storeFailed(deps, scope, { ...body, status: "FAILED", failure, candidates: [], shortlistRequestId: null }).catch(() => deps.log.error("web_search_store_failed", { searchId: pending.searchId }));
  } finally {
    clearTimeout(timer);
    controller.abort(); // stops any Reader call still running after a failure (no budget spent on a dead search)
  }
}

/**
 * Web supplier rows are written once and never updated: an id is only a hash of the listing URL, so a later search must
 * not change the name, offer or link of a supplier the founder may already have picked or signed for. Each search's own
 * facts live in its row (result_json, hashed into shortlist_hash; search_json).
 */
async function storeWebSuppliers(q: Q, scope: Scope, suppliers: readonly Supplier[]): Promise<void> {
  for (const s of suppliers) {
    await q.query(
      `insert into suppliers (facility_id, supplier_id, display_name, country, record_json, evidence_tier, source_type)
       values ($1, $2, $3, $4, $5::jsonb, 'tier3', $6) on conflict (facility_id, supplier_id) do nothing`,
      [scope.facilityId, s.supplierId, s.displayName, s.country, JSON.stringify(s), s.listing.sourceType],
    );
  }
}

/**
 * Publishes one READY search: exactly its own row, only while it is PENDING and younger than READY_CUTOFF_S (the
 * statement's clock, not the transaction's). False when nothing was published (stale, superseded or gone).
 */
async function storeReady(deps: ApiDeps, scope: Scope, ready: SupplierSearch, out: Awaited<ReturnType<typeof scoreReadAnswer>>): Promise<boolean> {
  return inTx(deps.db, async (q) => {
    await lockWriter(q, "shortlists", scope.facilityId);
    const updated = await q.query(
      `update shortlists set status = 'READY', result_json = $3::jsonb, shortlist_hash = $4, weights_version = $5, search_json = $6::jsonb, updated_at = now()
        where facility_id = $1 and id = $2 and source = 'web' and status = 'PENDING' and created_at > clock_timestamp() - make_interval(secs => $7)`,
      [scope.facilityId, ready.searchId, JSON.stringify(out.shortlist), out.shortlist.shortlistHash, out.shortlist.weightsVersion, JSON.stringify(ready), READY_CUTOFF_S],
    );
    if (updated.rowCount !== 1) return false; // stale, superseded or gone meanwhile: nothing to publish
    await storeWebSuppliers(q, scope, out.suppliers.map((s) => s.supplier));
    await supersedeOldShortlists(q, scope, "web", MAX_OPEN_SHORTLISTS);
    const excluded = out.excludedByGate.reduce((n, e) => n + e.count, 0);
    const omitted = out.omitted.reduce((n, e) => n + e.count, 0);
    await appendTrace(q, {
      facilityId: scope.facilityId,
      traceId: ready.searchId,
      actor: "reader",
      kind: "TOOL_CALL",
      summary: `Web supplier search ready: ${ready.candidates.length} unverified candidates ranked, ${excluded} excluded by hard gates, ${omitted} omitted`,
    });
    return true;
  });
}

async function storeFailed(deps: ApiDeps, scope: Scope, failed: SupplierSearch): Promise<void> {
  const body = SupplierSearch.parse(failed);
  await inTx(deps.db, async (q) => {
    const updated = await q.query(
      "update shortlists set status = 'FAILED', error = $3, search_json = $4::jsonb, updated_at = now() where facility_id = $1 and id = $2 and source = 'web' and status = 'PENDING'",
      [scope.facilityId, body.searchId, `web search failed: ${body.failure}`, JSON.stringify(body)],
    );
    if (updated.rowCount !== 1) return;
    await appendTrace(q, { facilityId: scope.facilityId, traceId: body.searchId, actor: "reader", kind: "TOOL_CALL", summary: `Web supplier search failed closed (${body.failure}); nothing was ranked` });
  });
}

/** GET /api/suppliers/search/:id. A PENDING row older than 2 minutes reads as FAILED (PROVIDER_DOWN). */
export async function readWebSearch(deps: ApiDeps, scope: Scope, searchId: string): Promise<SupplierSearch> {
  const r = await one<{ search_json: unknown; stale: boolean }>(
    pool(deps.db),
    `select search_json, (status = 'PENDING' and created_at < now() - make_interval(secs => $3)) as stale
       from shortlists where facility_id = $1 and id = $2 and source = 'web'`,
    [scope.facilityId, searchId, PENDING_STALE_S],
  );
  if (!r) throw fail("NOT_FOUND", "No such supplier search");
  const parsed = SupplierSearch.safeParse(r.search_json);
  if (!parsed.success) throw fail("NOT_FOUND", "That supplier search could not be read");
  if (r.stale) return { ...parsed.data, status: "FAILED", failure: "PROVIDER_DOWN", candidates: [], shortlistRequestId: null };
  return parsed.data;
}
