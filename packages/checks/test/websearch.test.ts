// Supplier web search (VISION-DECISIONS §8, §9): listing URL allow-list, listing text cleaning, the supplier id, the one
// Tavily parser, the live client (mocked fetch only: never the real Tavily) and recorded mode.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { jcs, sha256Utf8 } from "@hogee/core";
import { CheckInputError, CheckUnavailableError } from "../src/index";
import {
  LISTING_DOMAINS,
  LISTING_TEXT_MAX_CHARS,
  RECORDED_LABEL,
  TAVILY_SEARCH_URL,
  WebSearchLimitError,
  allowedListingUrl,
  listingTextOf,
  parseTavilyBody,
  recordedSearch,
  tavilySearch,
  webSupplierId,
  type WebSearchQuery,
} from "../src/websearch";
import { REPO, fakeFetch, hang, headersOf, noSleep, respond } from "./helpers";

const KEY = "tvly-test-0000-not-a-real-key";
const DATA = join(REPO, "data");
const RECORDED_PATH = join(DATA, "suppliers", "search", "recorded", "drinkware_food_contact-CN.json");
const RECORDED_BYTES = readFileSync(RECORDED_PATH);
const RECORDED = JSON.parse(RECORDED_BYTES.toString("utf8")) as { label: string; query: string; recordedAt: string; results: Record<string, unknown>[] };
const Q: WebSearchQuery = { query: RECORDED.query, includeDomains: [...LISTING_DOMAINS], maxResults: 8 };
const NOW = Date.parse("2026-10-19T09:30:00Z");
const AT = "2026-10-19T09:30:00Z";

const result = (url: string, extra: Record<string, unknown> = {}) => ({ title: "Tumbler", url, content: "USD 2.00 per piece", score: 0.5, raw_content: "Supplier: Example Co., Ltd.", ...extra });
const body = (results: unknown[], extra: Record<string, unknown> = {}) => ({ query: "q", results, response_time: 0.9, request_id: "req-1", ...extra });

describe("allowedListingUrl", () => {
  it.each([
    ["https://www.alibaba.com/product-detail/x_1.html?spm=a2700&utm=1#reviews", "https://www.alibaba.com/product-detail/x_1.html"],
    ["https://shop.en.alibaba.com/product/1-2/x.html", "https://shop.en.alibaba.com/product/1-2/x.html"],
    ["https://alibaba.com/p", "https://alibaba.com/p"],
    ["https://WWW.Made-In-China.com/p", "https://www.made-in-china.com/p"],
    ["https://www.globalsources.com/x-1p.htm", "https://www.globalsources.com/x-1p.htm"],
    ["https://detail.1688.com/offer/1.html", "https://detail.1688.com/offer/1.html"],
    ["https://detail.1688.com/offer/%31.html", "https://detail.1688.com/offer/1.html"],
    ["https://www.alibaba.com/a%2fb%7e", "https://www.alibaba.com/a%2Fb~"],
  ])("accepts %s as its origin + path", (raw, expected) => {
    expect(allowedListingUrl(raw)?.href).toBe(expected);
  });

  it.each([
    "http://www.alibaba.com/p",
    "javascript:alert(1)//alibaba.com",
    "data:text/html,alibaba.com",
    "ftp://www.alibaba.com/p",
    "https://www.alibaba.com:8443/p",
    "https://user:pass@www.alibaba.com/p",
    "https://user@www.alibaba.com/p",
    "https://47.246.136.1/p",
    "https://[2001:db8::1]/p",
    "https://a1ibaba.com/p",
    "https://www.a1ibaba.com/p",
    "https://xalibaba.com/p",
    "https://alibaba.com.evil.example/p",
    "https://www.alibaba.co/p",
    "https://www.аlibaba.com/p", // Cyrillic а
    "https://www.alibaba.com./p",
    "https://www.example.com/https://www.alibaba.com/p",
    " https://www.alibaba.com/p",
    "https://www.alibaba.com/p\n",
    "https://www.alibaba.com/a b",
    "",
    "not a url",
    `https://www.alibaba.com/${"a".repeat(2100)}`,
  ])("refuses %j", (raw) => {
    expect(allowedListingUrl(raw)).toBeNull();
  });
});

describe("listingTextOf", () => {
  it("joins title, snippet and page text, applying NFKC", () => {
    expect(listingTextOf({ title: "Ｔｕｍｂｌｅｒ ２０ｏｚ", snippet: "ＵＳＤ　２.３５", rawText: "MOQ: ５００ pieces" })).toBe("Tumbler 20oz\nUSD 2.35\nMOQ: 500 pieces");
  });

  it("removes data: URIs and markdown images, including full-width spellings", () => {
    const raw = [
      "Price: USD 2.35 ![logo](https://cdn.example/x.png) per piece",
      "![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==)",
      "see data:text/html;charset=utf-8,%3Cscript%3Ealert(1)%3C/script%3E end",
      "！［ｘ］（ｈｔｔｐｓ://cdn.example/y.png）full-width",
      "Technical data: 600 ml",
    ].join("\n");
    const text = listingTextOf({ title: "", snippet: "", rawText: raw });
    expect(text).not.toMatch(/data:image|data:text|cdn\.example|base64|!\[/i);
    expect(text).toContain("Price: USD 2.35  per piece");
    expect(text).toContain("Technical data: 600 ml");
    expect(text).toContain("full-width");
  });

  it("keeps invisible and bidi characters, so imperative-text detection still sees them", () => {
    const tag = String.fromCodePoint(0xe0069, 0xe0067, 0xe006e);
    expect(listingTextOf({ title: "", snippet: "", rawText: `Tumbler${tag} ‮evil` })).toBe(`Tumbler${tag} ‮evil`);
  });

  it("blanks control characters other than tab and line breaks (Postgres jsonb refuses U+0000), keeping word gaps", () => {
    const text = listingTextOf({ title: "Corvane\u0000Drinkware", snippet: "x\u0007y\u0085z", rawText: "line1\r\nline2\tend\u001b" });
    expect(text).toBe("Corvane Drinkware\nx y z\nline1\r\nline2\tend");
    expect(/(?![\t\n\r])\p{Cc}/u.test(text)).toBe(false);
  });

  it("caps at 12000 characters without splitting a surrogate pair", () => {
    const text = listingTextOf({ title: "T", snippet: "", rawText: `${"a".repeat(LISTING_TEXT_MAX_CHARS - 3)}😀😀` });
    expect(text.length).toBeLessThanOrEqual(LISTING_TEXT_MAX_CHARS);
    expect(text.endsWith("a")).toBe(true);
    expect(listingTextOf({ title: "x".repeat(20_000), snippet: "y", rawText: "z" })).toHaveLength(LISTING_TEXT_MAX_CHARS);
  });

  it("stays fast on adversarial markdown", () => {
    const started = Date.now();
    listingTextOf({ title: "", snippet: "", rawText: "![".repeat(200_000) });
    listingTextOf({ title: "", snippet: "", rawText: `![a](${"(".repeat(200_000)}` });
    listingTextOf({ title: "", snippet: "", rawText: `data:${"a".repeat(500_000)}` });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("webSupplierId", () => {
  it('is "supplier-w" + base32lower(sha256(canonical URL)).slice(0, 12)', () => {
    // Cross-checked with Python: base64.b32encode(hashlib.sha256(url).digest()).lower()[:12]
    expect(webSupplierId("https://www.alibaba.com/product-detail/x.html")).toBe("supplier-w2axoy2qksqlm");
    expect(webSupplierId("https://www.alibaba.com/product-detail/x.html?spm=1#top")).toBe("supplier-w2axoy2qksqlm");
    expect(webSupplierId("https://detail.1688.com/offer/718304629551.html")).toMatch(/^supplier-w[a-z2-7]{12}$/);
  });

  it("gives every percent-encoding of one listing the same id (core canonicalListingUrl)", () => {
    const id = webSupplierId("https://www.alibaba.com/product-detail/x.html");
    for (const twin of ["https://www.alibaba.com/product-detail/%78.html", "https://www.alibaba.com/product-detail/%78%2e%68tml", "https://www.alibaba.com/%70roduct-detail/x.html"]) {
      expect(webSupplierId(twin), twin).toBe(id);
    }
    expect(webSupplierId("https://www.alibaba.com/a%2fb")).toBe(webSupplierId("https://www.alibaba.com/a%2Fb"));
  });

  it("refuses a URL that is not an allow-listed listing", () => {
    expect(() => webSupplierId("https://a1ibaba.com/p")).toThrow(CheckInputError);
  });
});

describe("parseTavilyBody (one parser for live and recorded)", () => {
  it("keeps allow-listed results as origin + path, counts the rest, never keeps score", () => {
    const a = parseTavilyBody(body([result("https://www.alibaba.com/p?x=1"), result("https://a1ibaba.com/p"), result("http://www.alibaba.com/q"), result("javascript:alert(1)")]), AT);
    expect(a.provider).toBe("tavily");
    expect(a.droppedOffList).toBe(3);
    expect(a.retrievedAt).toBe(AT);
    expect(a.results).toEqual([{ url: "https://www.alibaba.com/p", host: "www.alibaba.com", title: "Tumbler", snippet: "USD 2.00 per piece", rawText: "Supplier: Example Co., Ltd." }]);
    expect(JSON.stringify(a)).not.toContain("score");
  });

  it("hashes the canonical JSON of the whole body", () => {
    const json = body([result("https://www.alibaba.com/p")]);
    const reordered = JSON.parse(`{"request_id":"req-1","results":${JSON.stringify(json.results)},"response_time":0.9,"query":"q"}`) as unknown;
    expect(parseTavilyBody(json, AT).bodySha256).toBe(sha256Utf8(jcs(json)));
    expect(parseTavilyBody(reordered, AT).bodySha256).toBe(parseTavilyBody(json, AT).bodySha256);
  });

  it("truncates each text before assembling the answer", () => {
    const a = parseTavilyBody(body([result("https://www.alibaba.com/p", { title: `t  \n ${"x".repeat(400)}`, content: "c".repeat(3000), raw_content: "r".repeat(20_000) })]), AT);
    const r = a.results[0];
    expect(r?.title.length).toBe(300);
    expect(r?.title.startsWith("t x")).toBe(true);
    expect(r?.snippet.length).toBe(2000);
    expect(r?.rawText.length).toBe(12_000);
  });

  it("keeps at most 10 results in rank order, a repeated listing once, and tolerates a null raw_content", () => {
    const many = Array.from({ length: 12 }, (_, i) => result(`https://www.alibaba.com/p${i % 10}`, i === 0 ? { raw_content: null } : {}));
    const a = parseTavilyBody(body([result("https://www.alibaba.com/p0?dup=1"), ...many]), AT);
    expect(a.results.map((r) => r.url)).toEqual(Array.from({ length: 10 }, (_, i) => `https://www.alibaba.com/p${i}`));
    expect(a.results[0]?.rawText).toBe("Supplier: Example Co., Ltd.");
    expect(parseTavilyBody(body([result("https://www.alibaba.com/p", { raw_content: null })]), AT).results[0]?.rawText).toBe("");
  });

  it("drops unknown keys and accepts response_time as a string", () => {
    const a = parseTavilyBody(body([result("https://www.alibaba.com/p", { favicon: "https://x/f.ico", images: ["x"] })], { answer: null, images: [], response_time: "1.2", auto_parameters: {} }), AT);
    expect(Object.keys(a.results[0] ?? {}).sort()).toEqual(["host", "rawText", "snippet", "title", "url"]);
  });

  it.each([
    ["not an object", "nope"],
    ["no results", { query: "q" }],
    ["results not an array", { query: "q", results: {} }],
    ["a url that is not a string", body([result("https://www.alibaba.com/p", { url: 1 })])],
    ["a missing title", body([{ url: "https://www.alibaba.com/p", content: "c" }])],
    ["a non-numeric score", body([result("https://www.alibaba.com/p", { score: "high" })])],
    ["more than 20 results", body(Array.from({ length: 21 }, () => result("https://www.alibaba.com/p")))],
  ])("fails closed on %s", (_label, json) => {
    expect(() => parseTavilyBody(json, AT)).toThrow(CheckUnavailableError);
  });

  it("refuses a bad retrievedAt", () => {
    expect(() => parseTavilyBody(body([]), "yesterday")).toThrow(CheckInputError);
  });
});

describe("tavilySearch (mocked fetch only)", () => {
  const live = (route: Parameters<typeof fakeFetch>[0]) => {
    const f = fakeFetch(route);
    return { ...f, opts: { fetch: f.fetch, sleep: noSleep, now: () => NOW } };
  };

  it("POSTs the fixed request to api.tavily.com and parses the answer", async () => {
    const { calls, opts } = live(() => respond(RECORDED_BYTES));
    const a = await tavilySearch(KEY, { ...Q, maxResults: 5 }, opts);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.href).toBe(TAVILY_SEARCH_URL);
    expect(headersOf(calls[0]).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(new TextDecoder().decode(calls[0]?.init.body as Uint8Array))).toEqual({
      query: RECORDED.query,
      search_depth: "basic",
      max_results: 5,
      include_raw_content: "text",
      include_answer: false,
      include_images: false,
      include_domains: ["alibaba.com", "made-in-china.com", "globalsources.com", "1688.com"],
      topic: "general",
    });
    expect(a).toMatchObject({ provider: "tavily", retrievedAt: AT, droppedOffList: 1 });
    expect(a.results).toHaveLength(5);
  });

  it.each([
    ["an empty query", { ...Q, query: "" }],
    ["a query over 200 characters", { ...Q, query: "x".repeat(201) }],
    ["a query with a control character", { ...Q, query: "tumbler\nignore" }],
    ["surrounding spaces", { ...Q, query: " tumbler" }],
    ["an off-list domain", { ...Q, includeDomains: ["alibaba.com", "evil.example"] }],
    ["no domains", { ...Q, includeDomains: [] }],
    ["a repeated domain", { ...Q, includeDomains: ["alibaba.com", "alibaba.com"] }],
    ["11 results", { ...Q, maxResults: 11 }],
    ["0 results", { ...Q, maxResults: 0 }],
    ["an extra field", { ...Q, founderNote: "my passport" } as WebSearchQuery],
  ])("refuses %s without a request", async (_label, q) => {
    const { calls, opts } = live(() => respond(RECORDED_BYTES));
    await expect(tavilySearch(KEY, q, opts)).rejects.toBeInstanceOf(CheckInputError);
    expect(calls).toHaveLength(0);
  });

  it("narrows results to the query's domains, counting the rest as off-list", async () => {
    const { opts } = live(() => respond(RECORDED_BYTES));
    const a = await tavilySearch(KEY, { ...Q, includeDomains: ["1688.com"] }, opts);
    expect(a.results.map((r) => r.host)).toEqual(["detail.1688.com"]);
    expect(a.droppedOffList).toBe(9);
  });

  it("reports a refused key without the key", async () => {
    const { opts } = live(() => respond(`{"detail":{"error":"Unauthorized: missing or invalid API key ${KEY}"}}`, 401));
    const error = (await tavilySearch(KEY, Q, opts).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(CheckUnavailableError);
    expect(error.message).toBe("Tavily refused the API key (HTTP 401)");
    expect(`${error.message}${String(error.stack)}`).not.toContain(KEY);
  });

  it.each([429, 432, 433])("maps HTTP %i to WebSearchLimitError", async (status) => {
    const { calls, opts } = live(() => respond("{}", status));
    await expect(tavilySearch(KEY, Q, opts)).rejects.toBeInstanceOf(WebSearchLimitError);
    expect(calls).toHaveLength(status === 429 ? 2 : 1);
  });

  it("retries a 5xx once, never a timeout", async () => {
    const flaky = live((_u, _i, n) => (n === 1 ? respond("", 502) : respond(RECORDED_BYTES)));
    await expect(tavilySearch(KEY, Q, flaky.opts)).resolves.toMatchObject({ provider: "tavily" });
    expect(flaky.calls).toHaveLength(2);
    const slow = live((_u, init) => hang(init));
    await expect(tavilySearch(KEY, Q, { ...slow.opts, timeoutMs: 15 })).rejects.toThrow("Tavily unavailable (timeout, not retried)");
    expect(slow.calls).toHaveLength(1);
  });

  it.each([
    ["a malformed body", respond("{not json"), "Tavily: answer is not valid JSON"],
    ["an unexpected shape", respond('{"query":"q","results":"none"}'), "Tavily answer has an unexpected shape"],
    ["an answer over 2 MiB", respond(`{"pad":"${"x".repeat(2 * 1024 * 1024)}"}`), "Tavily: answer larger than 2097152 bytes"],
    ["another 4xx", respond("{}", 400), "Tavily answered HTTP 400"],
    ["a redirect", new Response(null, { status: 302, headers: { location: "https://evil.example/" } }), "Tavily: refused to follow a redirect"],
  ])("fails closed on %s", async (_label, response, message) => {
    const { opts } = live(() => response.clone());
    await expect(tavilySearch(KEY, Q, opts)).rejects.toThrow(message);
  });
});

describe("recordedSearch", () => {
  it("reads the labelled recorded sample through the same parser", async () => {
    const a = await recordedSearch(DATA, Q);
    expect(a.provider).toBe("recorded");
    expect(a.retrievedAt).toBe(RECORDED.recordedAt);
    expect(a.droppedOffList).toBe(1);
    expect(a.results).toHaveLength(8);
    expect(a.results.every((r) => allowedListingUrl(r.url)?.href === r.url)).toBe(true);
    expect(a.results.every((r) => listingTextOf(r).startsWith(r.title) && listingTextOf(r).includes("Recorded sample: fictional listing"))).toBe(true);
    // bodySha256 (as documented): JCS of the whole parsed file, label and recordedAt included; never its raw bytes.
    expect(a.bodySha256).toBe(sha256Utf8(jcs(RECORDED)));
    const { label: _label, recordedAt: _at, ...bare } = RECORDED;
    expect(a.bodySha256).not.toBe(sha256Utf8(jcs(bare)));
  });

  it("matches the query ignoring case, width and spacing, and honours maxResults", async () => {
    const a = await recordedSearch(DATA, { ...Q, query: "INSULATED  stainless steel tumbler manufacturer ｃｈｉｎａ", maxResults: 3 });
    expect(a.results).toHaveLength(3);
  });

  it("gives the same answer as the live parser for the same body (parity)", async () => {
    const { fetch } = fakeFetch(() => respond(RECORDED_BYTES));
    const live = await tavilySearch(KEY, Q, { fetch, sleep: noSleep, now: () => NOW });
    const recorded = await recordedSearch(DATA, Q);
    expect({ ...recorded, provider: "tavily", retrievedAt: AT }).toEqual(live);
    expect(recorded.bodySha256).toBe(sha256Utf8(jcs(RECORDED)));
  });

  const tempData = (files: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), "hogee-recorded-"));
    const rec = join(dir, "suppliers", "search", "recorded");
    mkdirSync(rec, { recursive: true });
    for (const [name, json] of Object.entries(files)) writeFileSync(join(rec, name), typeof json === "string" ? json : JSON.stringify(json));
    return dir;
  };

  it("fails closed when no sample matches the query", async () => {
    await expect(recordedSearch(DATA, { ...Q, query: "ceramic mug supplier" })).rejects.toThrow("no recorded search sample for this query");
  });

  it("fails closed on a missing directory, an unlabelled or malformed sample, or two samples for one query", async () => {
    await expect(recordedSearch(join(tmpdir(), "hogee-no-such-dir"), Q)).rejects.toThrow("recorded search samples are missing");
    const { label: _label, ...unlabelled } = RECORDED;
    await expect(recordedSearch(tempData({ "drinkware_food_contact-CN.json": unlabelled }), Q)).rejects.toThrow(`is not labelled "${RECORDED_LABEL}"`);
    await expect(recordedSearch(tempData({ "drinkware_food_contact-CN.json": { ...RECORDED, label: "live" } }), Q)).rejects.toThrow(CheckUnavailableError);
    await expect(recordedSearch(tempData({ "drinkware_food_contact-CN.json": "{oops" }), Q)).rejects.toThrow("cannot be read");
    await expect(recordedSearch(tempData({ "drinkware_food_contact-CN.json": RECORDED, "drinkware_food_contact-VN.json": RECORDED }), Q)).rejects.toThrow("more than one recorded search sample");
    await expect(recordedSearch(tempData({ "drinkware_food_contact-CN.json": { ...RECORDED, results: [{ url: 1 }] } }), Q)).rejects.toThrow("unexpected shape");
  });

  it("ignores files that do not follow <category>-<buyFrom>.json", async () => {
    const dir = tempData({ "drinkware_food_contact-CN.json": RECORDED, "notes.json": "{oops", "Drinkware-CN.json": "{oops", "drinkware-cn.json": "{oops" });
    await expect(recordedSearch(dir, Q)).resolves.toMatchObject({ provider: "recorded" });
  });

  it("refuses a malformed query before reading anything", async () => {
    await expect(recordedSearch(DATA, { ...Q, maxResults: 20 })).rejects.toBeInstanceOf(CheckInputError);
  });
});
