/**
 * Supplier web search (VISION-DECISIONS §8, §9). One outbound host, api.tavily.com; result URLs are never fetched.
 * - tavilySearch: POST /search through httpPostJson (bearer key, 4 KiB request cap, 2 MiB answer cap, one retry only
 *   on 429/5xx). No answer, no images; raw page text; only the listing domains below.
 * - parseTavilyBody: the ONE parser for live and recorded answers. Strict types on every field it reads (unknown keys
 *   are dropped, never read); a result whose URL is not an https listing on an allow-listed domain is dropped and
 *   counted; each text is normalised and capped BEFORE the answer is assembled; `score` is never kept.
 * - recordedSearch: the same parser over data/suppliers/search/recorded/<category>-<buyFrom>.json (raw Tavily JSON
 *   plus `label: "recorded sample"` and `recordedAt`). Used only when no key is set; never a silent fallback.
 * Everything fails closed: a search that cannot run throws CheckUnavailableError (WebSearchLimitError for a provider
 * limit); bad input throws CheckInputError. Messages never carry the key, the query or listing text.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { canonicalListingUrl, jcs, sha256Utf8 } from "@hogee/core";
import { HttpStatusError, httpPostJson, isoNow, parseJsonBody, type HttpAnswer, type HttpOptions, type HttpPostTarget } from "./http";
import { CheckInputError, CheckUnavailableError } from "./types";

// ---- types (plain TS mirrors of VISION-DECISIONS §3 search.ts; core's zod versions replace them at merge) ----------

export type SearchProvider = "tavily" | "recorded";

export interface WebSearchQuery {
  /** 1-200 characters, built server-side from the committed plan (never founder text). */
  readonly query: string;
  /** 1-20 domains, each one of LISTING_DOMAINS. */
  readonly includeDomains: readonly string[];
  /** 1-8. */
  readonly maxResults: number;
}

export interface WebSearchResult {
  /** https origin + path of the listing (no query, no fragment). */
  readonly url: string;
  readonly host: string;
  /** ≤ 300 characters. */
  readonly title: string;
  /** ≤ 2000 characters. */
  readonly snippet: string;
  /** ≤ 12000 characters. */
  readonly rawText: string;
}

export interface WebSearchAnswer {
  readonly provider: SearchProvider;
  /** ≤ 8, in the provider's rank order. */
  readonly results: readonly WebSearchResult[];
  /** Results dropped because their URL is not an allow-listed listing (or not in the query's domains). */
  readonly droppedOffList: number;
  readonly retrievedAt: string;
  /**
   * 0x + sha256 of the RFC 8785 canonical JSON of the whole PARSED answer body (not its raw bytes; whitespace and key
   * order do not change it). A recorded sample hashes its whole file JSON, `label` and `recordedAt` included.
   */
  readonly bodySha256: string;
}

// ---- constants ------------------------------------------------------------------------------------------------

export const TAVILY_HOST = "api.tavily.com";
export const TAVILY_SEARCH_URL = `https://${TAVILY_HOST}/search`;
export const LISTING_DOMAINS = ["alibaba.com", "made-in-china.com", "globalsources.com", "1688.com"] as const;
export type ListingDomain = (typeof LISTING_DOMAINS)[number];
export const RECORDED_LABEL = "recorded sample";
export const WEB_SEARCH_MAX_RESULTS = 10;
export const TITLE_MAX_CHARS = 300;
export const SNIPPET_MAX_CHARS = 2_000;
export const LISTING_TEXT_MAX_CHARS = 12_000;

const TAVILY_TARGET: HttpPostTarget = { service: "Tavily", host: TAVILY_HOST, accept: "application/json", maxBytes: 2 * 1024 * 1024, maxRequestBytes: 4 * 1024 };
/** Tavily's own ceiling on results per call; more fails the answer. */
const TAVILY_MAX_RAW_RESULTS = 20;
const MAX_URL_CHARS = 2_048;
const MAX_RECORDED_FILES = 64;
const RECORDED_FILE_RE = /^[a-z0-9_]{1,64}-[A-Z]{2}\.json$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

// ---- listing URLs and text ------------------------------------------------------------------------------------

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * The listing URL in core's canonical form (canonicalListingUrl: https origin + path, percent-encoding normalised so
 * one listing has one id), or null unless: https, no port, no user info, a host name (not an IP) that is an
 * allow-listed domain or a subdomain of one, and no whitespace or control characters in the raw string.
 * Look-alike hosts (a1ibaba.com, alibaba.com.evil.example, Cyrillic letters → punycode) do not match.
 */
export function allowedListingUrl(raw: string): URL | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_CHARS || /[\s\p{Cc}]/u.test(raw)) return null;
  const canonical = canonicalListingUrl(raw);
  if (canonical === null) return null;
  const url = new URL(canonical);
  const host = url.hostname;
  if (host.startsWith("[") || IPV4_RE.test(host)) return null;
  if (!LISTING_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return null;
  return url;
}

/** At most `max` UTF-16 units, never splitting a surrogate pair. */
function capChars(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** `data:` URIs (media type optional), linear: no part of the pattern can backtrack into another. */
const DATA_URI_RE = /\bdata:(?:[a-z]+\/[a-z0-9.+-]+)?(?:;[a-z0-9=.+-]+)*,[^\s"'<>()[\]]*/giu;
/**
 * Markdown images `![alt](target)`, with the lookahead-capture idiom so neither part backtracks (alt ≤ 300 and target
 * ≤ 2048 characters on one line); the cost per `!` is bounded.
 */
const MARKDOWN_IMAGE_RE = /!\[(?=([^\]\n]{0,300}))\1\]\((?=([^)\n]{0,2048}))\2\)/gu;

/**
 * Control characters other than tab, CR and LF (C0, DEL, C1). Blanked to a space, not removed, so a word gap they make
 * stays a gap for detectImperativeText (security audit run-9: U+0000 in any listing-derived string would make Postgres
 * jsonb refuse the whole search).
 */
const CONTROL_RE = /(?![\t\n\r])\p{Cc}/gu;

/**
 * Untrusted page text, cleaned: NFKC, control characters blanked (CONTROL_RE), `data:` URIs and markdown images removed,
 * trimmed, capped at `max`. The input is bounded first (NFKC can lengthen it). Invisible and bidi characters are KEPT,
 * so detectImperativeText still sees them.
 */
function cleanText(s: string, max: number): string {
  const bounded = capChars(s.replace(DATA_URI_RE, ""), max * 4).normalize("NFKC").replace(CONTROL_RE, " ");
  return capChars(bounded.replace(DATA_URI_RE, "").replace(MARKDOWN_IMAGE_RE, "").trim(), max);
}

/**
 * The text the Reader reads for one result: title, snippet and page text on separate lines, NFKC, `data:` URIs and
 * markdown images removed, at most 12000 characters.
 */
export function listingTextOf(r: { readonly title: string; readonly snippet: string; readonly rawText: string }): string {
  const parts = [r.title, r.snippet, r.rawText].map((p) => cleanText(p, LISTING_TEXT_MAX_CHARS)).filter((p) => p.length > 0);
  return capChars(parts.join("\n"), LISTING_TEXT_MAX_CHARS);
}

function base32Lower(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return bits > 0 ? out + BASE32[(value << (5 - bits)) & 31] : out;
}

/** "supplier-w" + base32lower(sha256(canonical listing URL)).slice(0, 12) (VISION-DECISIONS §3). */
export function webSupplierId(rawUrl: string): string {
  const url = allowedListingUrl(rawUrl);
  if (!url) throw new CheckInputError("not an allow-listed listing URL");
  return `supplier-w${base32Lower(createHash("sha256").update(url.href, "utf8").digest()).slice(0, 12)}`;
}

// ---- query --------------------------------------------------------------------------------------------------

const QueryInput = z.strictObject({
  query: z
    .string()
    .min(1)
    .max(200)
    .refine((s) => s.trim() === s && !/[\p{Cc}\p{Cf}]/u.test(s), "no surrounding spaces or control characters"),
  includeDomains: z
    .array(z.enum(LISTING_DOMAINS))
    .min(1)
    .max(20)
    .refine((ds) => new Set(ds).size === ds.length, "no duplicates"),
  maxResults: z.int().min(1).max(WEB_SEARCH_MAX_RESULTS),
});
type QueryInput = z.infer<typeof QueryInput>;

function parseQuery(q: WebSearchQuery): QueryInput {
  const r = QueryInput.safeParse(q);
  if (!r.success) throw new CheckInputError("web search query is malformed (query 1-200 characters, listing domains only, 1-8 results)");
  return r.data;
}

/** Results narrowed to the query's domains (the rest count as off-list) and to its maxResults. */
function fitToQuery(a: WebSearchAnswer, q: QueryInput): WebSearchAnswer {
  const inQuery = (host: string) => q.includeDomains.some((d) => host === d || host.endsWith(`.${d}`));
  const kept = a.results.filter((r) => inQuery(r.host));
  return { ...a, results: kept.slice(0, q.maxResults), droppedOffList: a.droppedOffList + (a.results.length - kept.length) };
}

// ---- parser -------------------------------------------------------------------------------------------------

const TavilyResult = z.object({
  title: z.string(),
  url: z.string(),
  content: z.string(),
  score: z.number().optional(),
  raw_content: z.string().nullable().optional(),
});

const TavilyBody = z.object({
  query: z.string(),
  results: z.array(TavilyResult).max(TAVILY_MAX_RAW_RESULTS),
  response_time: z.union([z.number(), z.string()]).optional(),
  request_id: z.string().optional(),
});

/**
 * A Tavily /search answer (already JSON-parsed) as a WebSearchAnswer with provider "tavily". The same function reads
 * live and recorded answers. Off-list URLs are dropped and counted; a repeated listing URL is kept once; at most 8
 * results, in rank order. bodySha256 = sha256Utf8(jcs(json)) of `json` exactly as given (every key, read or not).
 * Throws CheckUnavailableError on any unexpected shape.
 */
export function parseTavilyBody(json: unknown, retrievedAt: string): WebSearchAnswer {
  if (typeof retrievedAt !== "string" || !ISO_UTC_RE.test(retrievedAt)) throw new CheckInputError("retrievedAt must be an ISO-8601 UTC time");
  const parsed = TavilyBody.safeParse(json);
  if (!parsed.success) throw new CheckUnavailableError("Tavily answer has an unexpected shape");
  let bodySha256: string;
  try {
    bodySha256 = sha256Utf8(jcs(json));
  } catch {
    throw new CheckUnavailableError("Tavily answer is not plain JSON data");
  }
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  let droppedOffList = 0;
  for (const r of parsed.data.results) {
    const url = allowedListingUrl(r.url);
    if (!url) {
      droppedOffList += 1;
      continue;
    }
    if (seen.has(url.href) || results.length >= WEB_SEARCH_MAX_RESULTS) continue;
    seen.add(url.href);
    results.push({
      url: url.href,
      host: url.hostname,
      title: capChars(cleanText(r.title, TITLE_MAX_CHARS * 2).replace(/\s+/g, " "), TITLE_MAX_CHARS).trim(),
      snippet: cleanText(r.content, SNIPPET_MAX_CHARS),
      rawText: cleanText(r.raw_content ?? "", LISTING_TEXT_MAX_CHARS),
    });
  }
  return { provider: "tavily", results, droppedOffList, retrievedAt, bodySha256 };
}

// ---- live ---------------------------------------------------------------------------------------------------

/** Tavily refused for plan or rate limits (429 after the retry, 432, 433): the search fails with PROVIDER_LIMIT. */
export class WebSearchLimitError extends CheckUnavailableError {}

export type TavilyOptions = HttpOptions & { readonly signal?: AbortSignal };

/** Live search on api.tavily.com. `key` is the Tavily API key (never logged, never in a message). */
export async function tavilySearch(key: string, q: WebSearchQuery, opts: TavilyOptions = {}): Promise<WebSearchAnswer> {
  const query = parseQuery(q);
  const body = {
    query: query.query,
    search_depth: "basic",
    max_results: query.maxResults,
    include_raw_content: "text",
    include_answer: false,
    include_images: false,
    include_domains: [...query.includeDomains],
    topic: "general",
  };
  let answer: HttpAnswer;
  try {
    answer = await httpPostJson(new URL(TAVILY_SEARCH_URL), TAVILY_TARGET, body, key, opts);
  } catch (error: unknown) {
    if (error instanceof HttpStatusError && error.status === 429) throw new WebSearchLimitError("Tavily: rate limit reached");
    throw error;
  }
  if (answer.status === 401 || answer.status === 403) throw new CheckUnavailableError(`Tavily refused the API key (HTTP ${answer.status})`);
  if (answer.status === 432 || answer.status === 433) throw new WebSearchLimitError(`Tavily: usage limit reached (HTTP ${answer.status})`);
  if (answer.status !== 200) throw new CheckUnavailableError(`Tavily answered HTTP ${answer.status}`);
  return fitToQuery(parseTavilyBody(parseJsonBody(answer.bytes, "Tavily"), isoNow(opts.now)), query);
}

// ---- recorded -----------------------------------------------------------------------------------------------

const RecordedHead = z.object({
  label: z.literal(RECORDED_LABEL),
  recordedAt: z.string().regex(ISO_UTC_RE),
  query: z.string().max(200),
});

const sameQuery = (a: string, b: string) => a.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase() === b.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

async function readRecorded(path: string, name: string): Promise<unknown> {
  try {
    const s = await stat(path);
    if (!s.isFile() || s.size === 0 || s.size > TAVILY_TARGET.maxBytes) throw new Error("size");
    return parseJsonBody(await readFile(path), "recorded search");
  } catch {
    throw new CheckUnavailableError(`recorded search sample ${name} cannot be read`);
  }
}

/**
 * The recorded answer whose `query` equals `q.query` (NFKC, spaces and case ignored), from
 * <dataDir>/suppliers/search/recorded/<category>-<buyFrom>.json, through parseTavilyBody, with provider "recorded"
 * and retrievedAt = the file's recordedAt. Its bodySha256 covers the whole file JSON (`label` and `recordedAt` too), so
 * it differs from the live answer it was recorded from. Every file must be labelled "recorded sample"; no match, two
 * matches or an unlabelled or malformed file fails closed.
 */
export async function recordedSearch(dataDir: string, q: WebSearchQuery): Promise<WebSearchAnswer> {
  const query = parseQuery(q);
  const dir = join(resolve(/*turbopackIgnore: true*/ dataDir), "suppliers", "search", "recorded");
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => RECORDED_FILE_RE.test(n)).sort();
  } catch {
    throw new CheckUnavailableError("recorded search samples are missing");
  }
  if (names.length > MAX_RECORDED_FILES) throw new CheckUnavailableError("too many recorded search samples");
  const matches: { readonly json: unknown; readonly recordedAt: string }[] = [];
  for (const name of names) {
    const json = await readRecorded(join(dir, name), name);
    const head = RecordedHead.safeParse(json);
    if (!head.success) throw new CheckUnavailableError(`recorded search sample ${name} is not labelled "${RECORDED_LABEL}" or is malformed`);
    if (sameQuery(head.data.query, query.query)) matches.push({ json, recordedAt: head.data.recordedAt });
  }
  const [match] = matches;
  if (!match || matches.length > 1) throw new CheckUnavailableError(matches.length === 0 ? "no recorded search sample for this query" : "more than one recorded search sample for this query");
  return fitToQuery({ ...parseTavilyBody(match.json, match.recordedAt), provider: "recorded" }, query);
}
