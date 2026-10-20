/**
 * Mock web supplier search (VISION-DECISIONS §5, §9): POST /api/suppliers/search and GET /api/suppliers/search/:id.
 * It runs the live API's recorded path through the same code: the committed plan's enums → core supplierQuery →
 * checks recordedSearch (the one Tavily parser) over data/suppliers/search/recorded → the recorded Reader outputs →
 * core webVerdict / assembleWebSearch, with the real offline sanctions screen. Only the country pack and FX are mock
 * values (the mock holds no country pack): labelled mock/tier3, example.invalid sources. Every card says "recorded sample"
 * (provider "recorded").
 *
 * The search is computed when it starts and shown PENDING for SEARCH_DELAY_MS (stages SEARCHING → READING → CHECKING →
 * SCORING), then READY with exactly the body computed. Same refusals as the live API: NO_PLAN, UNSUPPORTED, IN_FLIGHT;
 * an identical READY search from the last 24 h is reused. The handlers never read the hono Context (the chat journey
 * calls them without one).
 *
 * @hogee/checks is imported by file (as the API imports @hogee/chain through chain-lib.ts): api-mock does not list it as
 * a dependency, and adding one would change the lockfile. P1 may swap these three imports for "@hogee/checks" after adding
 * the dependency.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CountryPack,
  DEFAULT_SEARCH_QUANTITY,
  PlanIntent,
  RecordedListingReading,
  SupplierSearch,
  WEB_SUPPLIER_ID_RE,
  assembleWebSearch,
  coreWebAnswer,
  isWebSupplierId,
  pricedDrafts,
  screenWebDrafts,
  supplierQuery,
  textPreGate,
  webSupplierIdOf,
  webVerdict,
  type CountryCode,
  type SearchStage,
  type Shortlist,
  type ShortlistSpec,
  type Sourced,
  type WebListing,
  type WebScreening,
  type WebSearchAnswer,
} from "@hogee/core";
import { screenSanctions } from "../../../checks/src/sanctions";
import { CheckInputError } from "../../../checks/src/types";
import { LISTING_DOMAINS, listingTextOf, recordedSearch } from "../../../checks/src/websearch";
import { ROUTE_EXAMPLES } from "@hogee/api-contract";
import type { Handlers } from "../http";
import type { MockEnv } from "../env";
import type { Failure } from "../result";
import { appendTrace, currentPlan, nextId, nowIso, type MockState } from "../store";

/** PENDING → READY after this long (wall clock), like the live pipeline's few seconds. */
export const SEARCH_DELAY_MS = 2_000;
const REUSE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_READING_BYTES = 256 * 1024;

const mockLeaf = <T>(path: string, value: T): Sourced<T> => ({
  value,
  sourceUrl: `https://example.invalid/mock/web-search/${path}`,
  retrievedAt: "2026-10-19T00:00:00Z",
  snippetHash: `0x${"0".repeat(63)}1`,
  evidence: "tier3",
  sourceType: "mock",
});

/** Mock country packs: only the import facts landed cost reads (SG-DECISIONS model; MY: Form E from CN, 10% sales tax). */
const MOCK_PACKS: Partial<Record<CountryCode, CountryPack>> = {
  SG: CountryPack.parse({
    countryCode: "SG",
    version: "mock-web-search",
    tier: "RESEARCHED",
    currency: "SGD",
    reserveFloorBps: mockLeaf("sg/reserve-floor", 300),
    indirectTax: { rate: mockLeaf("sg/gst-rate", 900), registrationThreshold: mockLeaf("sg/gst-threshold", "100000000") },
    imports: {
      taxBase: mockLeaf("sg/tax-base", "CIF"),
      dutySources: [mockLeaf("sg/duty-source", "Mock: SG customs duty applies to a short list of goods only")],
      ftaCertificates: [],
      mfnDutyRateBps: { drinkware_food_contact: mockLeaf("sg/mfn/drinkware", 0) },
    },
  }),
  MY: CountryPack.parse({
    countryCode: "MY",
    version: "mock-web-search",
    tier: "RESEARCHED",
    currency: "MYR",
    reserveFloorBps: mockLeaf("my/reserve-floor", 300),
    indirectTax: { rate: mockLeaf("my/sst-rate", 1000), registrationThreshold: mockLeaf("my/sst-threshold", "50000000") },
    imports: {
      taxBase: mockLeaf("my/tax-base", "CIF"),
      dutySources: [mockLeaf("my/duty-source", "Mock: Royal Malaysian Customs tariff finder")],
      ftaCertificates: [{ route: "FORM_E", partnerCountry: "CN", name: mockLeaf("my/form-e", "Form E (ACFTA)"), dutyRateBps: mockLeaf("my/form-e-rate", 0) }],
    },
  }),
};

/** Mock FX into the facility currency (labelled mock, never a quoted rate). */
const MOCK_FX: Readonly<Record<string, number>> = { "USD/SGD": 1.35, "CNY/SGD": 0.19, "USD/MYR": 4.4, "CNY/MYR": 0.62 };

interface MockSearchJob {
  readonly spec: ShortlistSpec;
  readonly createdAtMs: number;
  readonly readyAtMs: number;
  /** The body shown from readyAtMs on (READY or FAILED). */
  readonly final: SupplierSearch;
  /** The shortlist SupplierApproval would sign (null when the search failed). */
  readonly shortlist: Shortlist | null;
}

const EXAMPLE = ROUTE_EXAMPLES.getSupplierSearch;

const searches = new WeakMap<MockState, Map<string, MockSearchJob>>();

function jobsOf(st: MockState): Map<string, MockSearchJob> {
  let m = searches.get(st);
  if (!m) {
    m = new Map();
    searches.set(st, m);
  }
  return m;
}

/** The committed plan's intent and its SUPPLIER budget (the draft whose manifest is the committed one). */
function committed(st: MockState): { intent: PlanIntent; budgetMinor: string } | null {
  const plan = currentPlan(st);
  if (!plan || plan.status !== "COMMITTED") return null;
  const draft = [...st.drafts.values()].find((d) => d.manifest.planId === plan.manifest.planId && d.manifest.version === plan.manifest.version);
  const supplier = plan.manifest.lines.find((l) => l.lineKey === "SUPPLIER");
  const intent = PlanIntent.safeParse(draft?.intent);
  return intent.success && supplier ? { intent: intent.data, budgetMinor: supplier.amountMinor } : null;
}

function readReading(dataDir: string, supplierId: string): RecordedListingReading | null {
  if (!WEB_SUPPLIER_ID_RE.test(supplierId)) return null;
  const path = join(dataDir, "suppliers", "search", "reader", `${supplierId}.json`);
  try {
    if (!statSync(path).isFile() || statSync(path).size > MAX_READING_BYTES) return null;
    const parsed = RecordedListingReading.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success && parsed.data.docId === supplierId ? parsed.data : null;
  } catch {
    return null;
  }
}

const refuse = (reason: string, message: string): Failure => ({ code: "CONFLICT", message, details: { reason } });

const baseBody = (searchId: string, quantity: number, createdAtMs: number): SupplierSearch => ({
  searchId,
  status: "PENDING",
  stage: "SEARCHING",
  provider: "recorded",
  sourcesFound: 0,
  omitted: [],
  excludedByGate: [],
  failure: null,
  shortlistRequestId: null,
  candidates: [],
  quantity,
  createdAt: new Date(createdAtMs).toISOString(),
});

/** Runs the recorded pipeline now; the result is shown after SEARCH_DELAY_MS. */
async function runRecorded(st: MockState, env: MockEnv, searchId: string, spec: ShortlistSpec, query: string, now: number): Promise<MockSearchJob> {
  const dataDir = join(env.repoRoot, "data");
  const base = baseBody(searchId, spec.quantity, now);
  const failed = (failure: SupplierSearch["failure"]): MockSearchJob => ({ spec, createdAtMs: now, readyAtMs: now + SEARCH_DELAY_MS, final: SupplierSearch.parse({ ...base, status: "FAILED", failure }), shortlist: null });
  const pack = MOCK_PACKS[st.profile.country];
  if (!pack) return failed("PROVIDER_DOWN");
  let answer: WebSearchAnswer;
  try {
    answer = coreWebAnswer(await recordedSearch(dataDir, { query, includeDomains: [...LISTING_DOMAINS], maxResults: 10 }));
  } catch {
    return failed("PROVIDER_DOWN");
  }
  const listings: WebListing[] = answer.results.map((r) => {
    const supplierId = webSupplierIdOf(r.url);
    const listingText = listingTextOf(r);
    return { supplierId, url: r.url, host: r.host, listingText, reading: textPreGate(listingText) ? null : readReading(dataDir, supplierId) };
  });
  const verdicts = listings.map(webVerdict);
  const fx = new Map<string, Sourced<number> | null>();
  for (const v of verdicts) {
    if (v.kind !== "draft") continue;
    const pair = `${v.draft.currency}/${pack.currency}`;
    fx.set(v.draft.currency, Object.hasOwn(MOCK_FX, pair) ? mockLeaf(`fx/${pair}`, MOCK_FX[pair] as number) : null);
  }
  const csvPath = join(dataDir, "sanctions", "un_sc.csv");
  let screening: WebScreening;
  try {
    // Like the live API: a name the screen refuses as input omits only that listing (NO_SELLER, audit run-9 lead 1).
    screening = await screenWebDrafts(pricedDrafts(verdicts, fx), async (name) => (await screenSanctions(name, { csvPath })).hit, (error) => error instanceof CheckInputError);
  } catch {
    return failed("SANCTIONS_UNAVAILABLE");
  }
  const out = assembleWebSearch({
    requestId: searchId,
    spec,
    pack,
    sourceType: "mock",
    retrievedAt: answer.retrievedAt,
    rawTextRef: () => `data/suppliers/search/recorded/${spec.productCategory}-${spec.buyFrom}.json`,
    droppedOffList: answer.droppedOffList,
    verdicts,
    fx,
    sanctionsHit: screening.sanctionsHit,
    unscreenable: screening.unscreenable,
  });
  for (const s of out.suppliers) st.suppliers.set(s.supplier.supplierId, { ...s.supplier, evidence: [] });
  const final = SupplierSearch.parse({
    ...base,
    status: "READY",
    stage: "DONE",
    sourcesFound: answer.results.length + answer.droppedOffList,
    omitted: out.omitted,
    excludedByGate: out.excludedByGate,
    shortlistRequestId: searchId,
    candidates: out.candidates,
  });
  return { spec, createdAtMs: now, readyAtMs: now + SEARCH_DELAY_MS, final, shortlist: out.shortlist };
}

/** What GET shows at `now`: PENDING with a stage by elapsed time, then the final body. */
function viewAt(job: MockSearchJob, now: number): SupplierSearch {
  if (now >= job.readyAtMs) return job.final;
  const elapsed = now - job.createdAtMs;
  const stage: SearchStage = elapsed < SEARCH_DELAY_MS * 0.3 ? "SEARCHING" : elapsed < SEARCH_DELAY_MS * 0.6 ? "READING" : elapsed < SEARCH_DELAY_MS * 0.8 ? "CHECKING" : "SCORING";
  return { ...baseBody(job.final.searchId, job.final.quantity, job.createdAtMs), stage, sourcesFound: stage === "SEARCHING" ? 0 : job.final.sourcesFound };
}

/** POST /api/suppliers/search at `now` (ms): the sample business (scenario-lived/) runs its searches in the past. */
export async function startWebSearchAt(st: MockState, env: MockEnv, quantityIn: number | undefined, now: number): Promise<{ searchId: string } | Failure> {
  const plan = committed(st);
  if (!plan) return refuse("NO_PLAN", "There is no committed plan yet, so there is nothing to search for");
  const query = supplierQuery(plan.intent);
  if (!query) return refuse("UNSUPPORTED", "Web search has no fixed query for this product category or sourcing country");
  const spec: ShortlistSpec = { productCategory: plan.intent.productCategory, buyFrom: plan.intent.buyFrom, quantity: quantityIn ?? DEFAULT_SEARCH_QUANTITY, budgetMinor: plan.budgetMinor };
  const jobs = jobsOf(st);
  const same = JSON.stringify(spec);
  const reuse = [...jobs.entries()].reverse().find(([, j]) => now >= j.readyAtMs && j.final.status === "READY" && now - j.createdAtMs < REUSE_WINDOW_MS && JSON.stringify(j.spec) === same);
  if (reuse) return { searchId: reuse[0] };
  if ([...jobs.values()].some((j) => now < j.readyAtMs)) return refuse("IN_FLIGHT", "A supplier search is already running; wait for it to finish");
  const searchId = nextId(st, "sl-web");
  const job = await runRecorded(st, env, searchId, spec, query, now);
  jobs.set(searchId, job);
  appendTrace(st, { traceId: searchId, actor: "reader", kind: "TOOL_CALL", summary: "Web supplier search started (recorded sample; query built from the committed plan)", refs: {}, ts: nowIso(now) });
  return { searchId };
}

export const searchHandlers: Pick<Handlers, "startSupplierSearch" | "getSupplierSearch"> = {
  startSupplierSearch: ({ req, st, env }) => startWebSearchAt(st, env, req.body.quantity, Date.now()),
  getSupplierSearch: ({ req, st }) => {
    const job = jobsOf(st).get(req.params.id);
    if (job) return viewAt(job, Date.now());
    // Like the store's example aliases: the api-contract example's id still answers its example (never a computed search).
    if (req.params.id === EXAMPLE.req.params.id) return EXAMPLE.res;
    return { code: "NOT_FOUND", message: `No supplier search ${req.params.id}` };
  },
};

/** For the mock journey and the mock terms (v-chat-server, v-terms): one search as GET would show it now. */
export function mockWebSearch(st: MockState, searchId: string): { readonly search: SupplierSearch; readonly createdAtMs: number; readonly shortlist: Shortlist | null } | undefined {
  const job = jobsOf(st).get(searchId);
  if (!job) return undefined;
  const now = Date.now();
  return { search: viewAt(job, now), createdAtMs: job.createdAtMs, shortlist: now >= job.readyAtMs ? job.shortlist : null };
}

/** The newest search of this store (its id), or undefined. */
export function mockLatestWebSearchId(st: MockState): string | undefined {
  return [...jobsOf(st).entries()].sort((a, b) => a[1].createdAtMs - b[1].createdAtMs).at(-1)?.[0];
}

/** A web supplier a READY search stored: the Reader's verbatim seller name (the record's displayName) and the listing host. */
export function mockWebSupplier(st: MockState, supplierId: string): { readonly sellerName: string; readonly listingHost: string } | undefined {
  if (!isWebSupplierId(supplierId)) return undefined;
  const s = st.suppliers.get(supplierId);
  return s ? { sellerName: s.displayName, listingHost: new URL(s.listing.url).hostname } : undefined;
}
