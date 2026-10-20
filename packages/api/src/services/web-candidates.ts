/**
 * Web results → candidate cards (VISION-DECISIONS §9). The pure part (verdicts, pricing, gates, scorer, cards) is core
 * search/assemble.ts, shared with the mock; this file does the I/O around it:
 *
 * - the quarantined Reader: live mode reads each allow-listed listing with the guarded reader model (concurrency 2,
 *   the search's deadline as the abort signal); recorded mode reads the committed Reader output for that listing
 *   (data/suppliers/search/reader/<supplierId>.json), so it needs no model key. A Reader refusal or failure omits the
 *   listing (READER_REJECTED); a model budget refusal fails the whole search (BUDGET);
 * - sanctions on every seller name that would be priced, each on its own: a name the screen refuses as input
 *   (CheckInputError: nothing to screen) omits only that listing (NO_SELLER); a screen that cannot run fails the whole
 *   search (SANCTIONS_UNAVAILABLE), never "no hit";
 * - registry ids written in the listing, each through its own validator: core keeps only failed checks (a red flag);
 *   a copied id never earns points (a validator that cannot run gives no result);
 * - FX per offer currency: unavailable → those listings are omitted (CURRENCY), never priced at a guessed rate.
 * Web candidates are always unverified. Nothing here logs listing text, seller names or provider errors.
 */
import { ReaderRejectedError, readDocument } from "@hogee/agent";
import { CheckInputError, listingTextOf, recordedSearch, tavilySearch } from "@hogee/checks";
import {
  RecordedListingReading,
  WEB_SUPPLIER_ID_RE,
  assembleWebSearch,
  coreWebAnswer,
  pricedDrafts,
  registryIdsInText,
  screenWebDrafts,
  textPreGate,
  webSupplierIdOf,
  webVerdict,
  type CandidateCard,
  type CountryPack,
  type RegistryIdChecks,
  type ShortlistSpec,
  type Sourced,
  type SupplierSearch,
  type WebAssembly,
  type WebListing,
  type WebReading,
  type WebScreening,
  type WebSearchAnswer,
} from "@hogee/core";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isRegistryKind, type ApiDeps, type Scope, type WebSearchPort } from "../context";
import { budgetRefusalIn } from "./model-budget";
import { llmCallSink } from "./chat-store";
import { searchJob } from "./web-search";

export interface WebCandidatesOutcome {
  readonly candidates: readonly CandidateCard[];
  readonly omitted: SupplierSearch["omitted"];
  readonly excludedByGate: SupplierSearch["excludedByGate"];
}

/** Reader calls in flight at once (VISION-DECISIONS §9). */
export const READER_CONCURRENCY = 2;
const MAX_READING_BYTES = 256 * 1024;

/** A search that cannot finish; `failure` is stored on the search (SupplierSearch.failure). */
export class WebSearchFailure extends Error {
  override readonly name = "WebSearchFailure";
  constructor(readonly failure: "PROVIDER_DOWN" | "PROVIDER_LIMIT" | "BUDGET" | "SANCTIONS_UNAVAILABLE" | "TOO_LARGE") {
    super(`web search failed: ${failure}`);
  }
}

/**
 * Recorded mode's provider also serves the recorded Reader outputs (no model key needed). A live (Tavily) port has no
 * `reading`, so its listings always go to the real Reader.
 */
export interface RecordedWebSearchPort extends WebSearchPort {
  readonly provider: "recorded";
  reading(supplierId: string): Promise<RecordedListingReading | null>;
}

export const isRecordedPort = (p: WebSearchPort): p is RecordedWebSearchPort =>
  p.provider === "recorded" && typeof (p as Partial<RecordedWebSearchPort>).reading === "function";

/** <dataDir>/suppliers/search/reader/<supplierId>.json, schema-checked and bound to its listing; null when absent or bad. */
export async function readRecordedReading(dataDir: string, supplierId: string): Promise<RecordedListingReading | null> {
  if (!WEB_SUPPLIER_ID_RE.test(supplierId)) return null;
  const path = join(resolve(/*turbopackIgnore: true*/ dataDir), "suppliers", "search", "reader", `${supplierId}.json`);
  try {
    const s = await stat(path);
    if (!s.isFile() || s.size === 0 || s.size > MAX_READING_BYTES) return null;
    const parsed = RecordedListingReading.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success && parsed.data.docId === supplierId ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Recorded mode: data/suppliers/search/recorded (raw Tavily JSON) and the recorded Reader outputs, through the one parser. */
export function recordedWebSearch(dataDir: string): RecordedWebSearchPort {
  return {
    provider: "recorded",
    search: async (q) => coreWebAnswer(await recordedSearch(dataDir, q)),
    reading: (supplierId) => readRecordedReading(dataDir, supplierId),
  };
}

/** Live mode: api.tavily.com with the key (never logged; checks keeps it out of every error message). */
export function tavilyWebSearch(key: string): WebSearchPort {
  return { provider: "tavily", search: async (q, signal) => coreWebAnswer(await tavilySearch(key, q, signal ? { signal } : {})) };
}

/**
 * runtime/deps.ts wiring: Tavily when TAVILY_API_KEY is set, else recorded samples from the data dir, else none. The
 * choice is made once at start-up; a failing Tavily never switches to recorded results.
 */
export function webSearchPortFor(tavilyKey: string | undefined, dataDir: string | undefined): WebSearchPort | undefined {
  if (tavilyKey) return tavilyWebSearch(tavilyKey);
  return dataDir ? recordedWebSearch(dataDir) : undefined;
}

/** Everything one search's scoring needs besides the provider answer. */
export interface WebSearchJob {
  readonly searchId: string;
  readonly spec: ShortlistSpec;
  readonly pack: CountryPack;
  /** The facility's currency (= the pack's). */
  readonly currency: string;
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping the input order. */
async function mapLimited<T, U>(items: readonly T[], limit: number, fn: (item: T) => Promise<U>): Promise<U[]> {
  const out: U[] = new Array<U>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The allow-listed results with their listing text and supplier id (ids are recomputed from the canonical URL). */
function listingsOf(answer: WebSearchAnswer): Omit<WebListing, "reading">[] {
  return answer.results.map((r) => ({ supplierId: webSupplierIdOf(r.url), url: r.url, host: r.host, listingText: listingTextOf(r) }));
}

/** Reads every listing: recorded outputs, or the live Reader (concurrency 2). A budget refusal fails the search. */
async function readListings(deps: ApiDeps, scope: Scope, port: WebSearchPort, searchId: string, listings: readonly Omit<WebListing, "reading">[], signal?: AbortSignal): Promise<WebListing[]> {
  if (isRecordedPort(port)) return Promise.all(listings.map(async (l) => ({ ...l, reading: await port.reading(l.supplierId) })));
  if (listings.length === 0) return [];
  let models: ReturnType<ApiDeps["agent"]["models"]>;
  try {
    models = deps.agent.models({ facilityId: scope.facilityId, traceId: searchId }, llmCallSink(deps));
  } catch (error: unknown) {
    throw new WebSearchFailure(budgetRefusalIn(error) ? "BUDGET" : "PROVIDER_DOWN");
  }
  return mapLimited(listings, READER_CONCURRENCY, async (l) => {
    if (signal?.aborted) throw new WebSearchFailure("PROVIDER_DOWN");
    // A page whose text already trips a gate is excluded without spending a model call on it.
    if (textPreGate(l.listingText)) return { ...l, reading: null };
    try {
      const reading: WebReading = await readDocument({ kind: "listing", docId: l.supplierId, text: l.listingText, sourceUrl: l.url }, { model: models.reader, ...(signal ? { abortSignal: signal } : {}) });
      return { ...l, reading };
    } catch (error: unknown) {
      if (budgetRefusalIn(error)) throw new WebSearchFailure("BUDGET");
      if (signal?.aborted) throw new WebSearchFailure("PROVIDER_DOWN");
      if (!(error instanceof ReaderRejectedError)) deps.log.warn("web_search_reader_failed", { searchId, errorName: error instanceof Error ? error.name : "unknown" });
      return { ...l, reading: null };
    }
  });
}

/** FX per offer currency into the facility's; null (CURRENCY) when the check cannot answer. */
async function fxRates(deps: ApiDeps, currencies: readonly string[], into: string): Promise<Map<string, Sourced<number> | null>> {
  const date = new Date(deps.clock()).toISOString().slice(0, 10);
  const entries = await Promise.all(
    [...new Set(currencies)].map(async (c): Promise<[string, Sourced<number> | null]> => {
      try {
        return [c, await deps.checks.fx(`${c}/${into}`, date)];
      } catch {
        return [c, null];
      }
    }),
  );
  return new Map(entries);
}

/** Every listed registry id through its own validator; one that cannot run earns no points (no result). */
function registryChecksFor(deps: ApiDeps, supplierId: string, text: string): RegistryIdChecks {
  const checks: Record<string, { supplierId: string; id: string; valid: boolean }> = {};
  for (const [kind, id] of Object.entries(registryIdsInText(text))) {
    if (!id || !isRegistryKind(kind)) continue;
    try {
      checks[kind] = { supplierId, id, valid: deps.checks.validateRegistryId(kind, id).valid };
    } catch {
      // no validator answer: no registry points (never a pass)
    }
  }
  return checks;
}

/**
 * One provider answer with every listing read (the Reader's output or null): what a search for another quantity
 * re-prices without calling the provider or the Reader again (agentsec LOW 6; web-search.ts ReadAnswerCache).
 * `searchId` is the search that called the provider (the listing text's rawTextRef).
 */
export interface ReadAnswer {
  readonly searchId: string;
  readonly answer: WebSearchAnswer;
  readonly listings: readonly WebListing[];
}

/** The Reader over one provider answer (recorded outputs, or the live Reader; a budget refusal fails the search). */
export async function readWebAnswer(deps: ApiDeps, scope: Scope, port: WebSearchPort, searchId: string, answer: WebSearchAnswer, signal?: AbortSignal): Promise<ReadAnswer> {
  return { searchId, answer, listings: await readListings(deps, scope, port, searchId, listingsOf(answer), signal) };
}

/**
 * Reader → verdicts → checks → core assembly for one provider answer. Throws WebSearchFailure (BUDGET,
 * SANCTIONS_UNAVAILABLE, PROVIDER_DOWN on the deadline); a pack gap throws its own error (the caller fails closed).
 */
export async function scoreWebAnswer(
  deps: ApiDeps,
  scope: Scope,
  port: WebSearchPort,
  job: WebSearchJob,
  answer: WebSearchAnswer,
  signal?: AbortSignal,
  onStage: (stage: "CHECKING" | "SCORING") => Promise<void> = async () => undefined,
): Promise<WebAssembly> {
  return scoreReadAnswer(deps, port, job, await readWebAnswer(deps, scope, port, job.searchId, answer, signal), signal, onStage);
}

/**
 * Verdicts → FX, sanctions and registry checks → core assembly for listings already read, priced for `job.spec` (its
 * quantity): every check runs again, only the provider call and the Reader are not repeated.
 */
export async function scoreReadAnswer(
  deps: ApiDeps,
  port: WebSearchPort,
  job: WebSearchJob,
  read: ReadAnswer,
  signal?: AbortSignal,
  onStage: (stage: "CHECKING" | "SCORING") => Promise<void> = async () => undefined,
): Promise<WebAssembly> {
  const { answer, listings } = read;
  await onStage("CHECKING");
  const verdicts = listings.map(webVerdict);
  const fx = await fxRates(deps, verdicts.flatMap((v) => (v.kind === "draft" ? [v.draft.currency] : [])), job.currency);
  const priced = pricedDrafts(verdicts, fx);
  let screening: WebScreening;
  try {
    // Each name on its own: one the screen refuses as input omits only that listing (NO_SELLER, audit run-9 lead 1).
    screening = await screenWebDrafts(priced, async (name) => (await deps.checks.screenSanctions(name)).hit, (error) => error instanceof CheckInputError);
  } catch {
    throw new WebSearchFailure("SANCTIONS_UNAVAILABLE");
  }
  if (signal?.aborted) throw new WebSearchFailure("PROVIDER_DOWN");
  await onStage("SCORING");
  return assembleWebSearch({
    requestId: job.searchId,
    spec: job.spec,
    pack: job.pack,
    sourceType: port.provider === "tavily" ? "live" : "mock",
    retrievedAt: answer.retrievedAt,
    rawTextRef: () => (port.provider === "recorded" ? `data/suppliers/search/recorded/${job.spec.productCategory}-${job.spec.buyFrom}.json` : `web-search/${read.searchId}`),
    droppedOffList: answer.droppedOffList,
    verdicts,
    fx,
    sanctionsHit: screening.sanctionsHit,
    unscreenable: screening.unscreenable,
    registryChecks: new Map(priced.map((d) => [d.supplierId, registryChecksFor(deps, d.supplierId, d.listingText)])),
  });
}

/**
 * The v-contract signature: cards and counts for one answer, scored against the committed plan's spec with
 * `quantity` (services/web-search.ts committedSearchSpec). The search pipeline itself calls scoreWebAnswer.
 */
export async function webCandidates(deps: ApiDeps, scope: Scope, answer: WebSearchAnswer, quantity: number, signal?: AbortSignal): Promise<WebCandidatesOutcome> {
  const port = deps.webSearch;
  if (!port) throw new WebSearchFailure("PROVIDER_DOWN");
  const job = await searchJob(deps, scope, quantity, `sl-web-adhoc-${Date.now()}`);
  const out = await scoreWebAnswer(deps, scope, port, job, answer, signal);
  return { candidates: out.candidates, omitted: out.omitted, excludedByGate: out.excludedByGate };
}
