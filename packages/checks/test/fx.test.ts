import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { snippetHash } from "@hogee/core";
import { BNM_ACCEPT, CheckInputError, CheckUnavailableError, getFx, type FxOptions } from "../src/index";
import { toDecimal } from "../src/fx";
import { httpGet } from "../src/http";
import { fakeFetch, fixture, hang, headersOf, noSleep, respond, type Route } from "./helpers";

// BNM answers recorded from https://api.bnm.gov.my/public/exchange-rate/<CCY>/date/2026-10-15?session=1200&quote=rm
// with Accept: application/vnd.BNM.API.v1+json on 2026-10-18 (raw bytes kept: snippetHash is their sha256).
const DATE = "2026-10-15";
const NOW = Date.parse("2026-10-18T14:00:00Z");
const BODY: Record<string, Buffer> = {
  CNY: fixture("bnm/CNY-2026-10-15.json"),
  SGD: fixture("bnm/SGD-2026-10-15.json"),
  JPY: fixture("bnm/JPY-2026-10-15.json"),
  IDR: fixture("bnm/IDR-2026-10-15.json"),
};
const NO_RECORDS = fixture("bnm/no-records.json");
const sha256 = (b: Uint8Array) => `0x${createHash("sha256").update(b).digest("hex")}`;
const parts = (url: URL) => /^\/public\/exchange-rate\/([A-Z]{3})\/date\/(\d{4}-\d{2}-\d{2})$/.exec(url.pathname);

/** Answers each BNM request from the recorded bodies (DATE only); anything else is "No records found." (404). */
const bnm: Route = (url) => {
  const m = parts(url);
  const body = m && m[2] === DATE ? BODY[m[1] ?? ""] : undefined;
  return body ? respond(body) : respond(NO_RECORDS, 404);
};

const opts = (f: typeof fetch, extra: FxOptions = {}): FxOptions => ({ fetch: f, sleep: noSleep, now: () => NOW, ...extra });

describe("getFx: */MYR from BNM", () => {
  it("returns a Sourced value whose snippetHash is the sha256 of the BNM response body", async () => {
    const { fetch, calls } = fakeFetch(bnm);
    const fx = await getFx("CNY/MYR", DATE, opts(fetch));
    expect(fx).toEqual({
      value: 0.6099,
      sourceUrl: "https://api.bnm.gov.my/public/exchange-rate/CNY/date/2026-10-15?session=1200&quote=rm",
      retrievedAt: "2026-10-18T14:00:00Z",
      snippetHash: sha256(BODY.CNY as Buffer),
      evidence: "tier1",
      sourceType: "live",
    });
    expect(calls).toHaveLength(1);
  });

  it("sends the BNM version header, follows no redirects and puts only the currency and date in the URL", async () => {
    const { fetch, calls } = fakeFetch(bnm);
    await getFx("SGD/MYR", DATE, opts(fetch));
    const [call] = calls;
    expect(headersOf(call)).toEqual({ accept: BNM_ACCEPT });
    expect(BNM_ACCEPT).toBe("application/vnd.BNM.API.v1+json");
    expect(call?.init.redirect).toBe("manual");
    expect(call?.init.method).toBe("GET");
    expect(call?.url.host).toBe("api.bnm.gov.my");
    expect([...(call?.url.searchParams.keys() ?? [])]).toEqual(["session", "quote"]);
  });

  it("divides by BNM's unit for currencies quoted per 100", async () => {
    const { fetch } = fakeFetch(bnm);
    await expect(getFx("JPY/MYR", DATE, opts(fetch))).resolves.toMatchObject({ value: 0.025885 });
    await expect(getFx("IDR/MYR", DATE, opts(fetch))).resolves.toMatchObject({ value: 0.000227 });
  });

  it("uses the latest earlier business day when the date has no rate, and names that date", async () => {
    const { fetch, calls } = fakeFetch(bnm);
    const fx = await getFx("CNY/MYR", "2026-10-17", opts(fetch));
    expect(fx.sourceUrl).toContain("/CNY/date/2026-10-15?");
    expect(calls.map((c) => parts(c.url)?.[2])).toEqual(["2026-10-17", "2026-10-16", "2026-10-15"]);
  });

  it("does not walk back on a 404 that is not BNM's no-records answer (e.g. the HTML page sent without the Accept header)", async () => {
    const { fetch, calls } = fakeFetch(() => respond("<!DOCTYPE html><html><title>BNM.API</title></html>", 404, "text/html"));
    await expect(getFx("CNY/MYR", DATE, opts(fetch))).rejects.toThrow("BNM: answer is not valid JSON");
    expect(calls).toHaveLength(1);
    const other = fakeFetch(() => respond('{"message":"Route not found"}', 404));
    await expect(getFx("CNY/MYR", DATE, opts(other.fetch))).rejects.toThrow("BNM answered HTTP 404 without its no-records body");
  });

  it("starts no request once the deadline has passed", async () => {
    const { fetch, calls } = fakeFetch(bnm);
    await expect(getFx("CNY/MYR", DATE, opts(fetch, { deadlineMs: 0 }))).rejects.toThrow("BNM: FX deadline passed");
    expect(calls).toHaveLength(0);
  });

  it("fails closed when no rate exists within the look-back window", async () => {
    const { fetch, calls } = fakeFetch(() => respond(NO_RECORDS, 404));
    await expect(getFx("CNY/MYR", DATE, opts(fetch, { lookbackDays: 2 }))).rejects.toThrow(CheckUnavailableError);
    expect(calls).toHaveLength(3);
  });
});

describe("getFx: */SGD as a documented BNM cross rate", () => {
  it("derives X/SGD = (X/MYR) / (SGD/MYR) from the same date, labelled tier2 with both bodies hashed", async () => {
    const { fetch, calls } = fakeFetch(bnm);
    const fx = await getFx("CNY/SGD", DATE, opts(fetch));
    expect(fx).toEqual({
      value: 0.19150339, // 0.6099 / 3.1848, 8 significant digits
      sourceUrl:
        "https://api.bnm.gov.my/public/exchange-rate/CNY/date/2026-10-15?session=1200&quote=rm#bnm-cross-rate=CNY/MYR,SGD/MYR" +
        `&sgd-myr=${encodeURIComponent("https://api.bnm.gov.my/public/exchange-rate/SGD/date/2026-10-15?session=1200&quote=rm")}`,
      retrievedAt: "2026-10-18T14:00:00Z",
      snippetHash: sha256(Buffer.concat([BODY.CNY as Buffer, Buffer.from("\n"), BODY.SGD as Buffer])),
      evidence: "tier2",
      sourceType: "live",
    });
    expect(calls.map((c) => parts(c.url)?.[1])).toEqual(["CNY", "SGD"]);
  });

  it("inverts SGD/MYR for MYR/SGD", async () => {
    const { fetch } = fakeFetch(bnm);
    const fx = await getFx("MYR/SGD", DATE, opts(fetch));
    expect(fx).toMatchObject({ value: 0.31399146, evidence: "tier2", snippetHash: sha256(BODY.SGD as Buffer) });
    expect(fx.sourceUrl).toMatch(/\/SGD\/date\/2026-10-15\?session=1200&quote=rm#bnm-inverse-rate=SGD\/MYR$/);
  });

  it("handles per-100 currencies in the cross", async () => {
    const { fetch } = fakeFetch(bnm);
    await expect(getFx("JPY/SGD", DATE, opts(fetch))).resolves.toMatchObject({ value: 0.0081276689 });
  });

  it("never contacts any host but BNM", async () => {
    const { fetch, calls } = fakeFetch(bnm);
    await getFx("CNY/SGD", DATE, opts(fetch));
    expect(new Set(calls.map((c) => c.url.host))).toEqual(new Set(["api.bnm.gov.my"]));
  });

  it("fails closed when one leg is unavailable", async () => {
    const { fetch } = fakeFetch((url) => (parts(url)?.[1] === "SGD" ? respond("{}", 503) : bnm(url, {}, 0)));
    await expect(getFx("CNY/SGD", DATE, opts(fetch))).rejects.toThrow(/BNM unavailable after 3 attempts \(HTTP 503\)/);
  });
});

describe("getFx: inputs", () => {
  it("returns 1 for a same-currency pair without any request", async () => {
    const { fetch, calls } = fakeFetch(bnm);
    const fx = await getFx("SGD/SGD", DATE, opts(fetch));
    expect(fx).toMatchObject({ value: 1, evidence: "tier3", sourceType: "live", snippetHash: snippetHash("1 SGD = 1 SGD (same currency, no conversion)") });
    expect(calls).toHaveLength(0);
  });

  it.each([["CNY/USD"], ["cny/myr"], ["CNYMYR"], ["CNY/MYR/X"], ["../MYR"]])("refuses the pair %s without any request", async (pair) => {
    const { fetch, calls } = fakeFetch(bnm);
    await expect(getFx(pair as `${string}/${string}`, DATE, opts(fetch))).rejects.toBeInstanceOf(CheckInputError);
    expect(calls).toHaveLength(0);
  });

  it.each([["2026-02-30"], ["15/10/2026"], ["2026-10-15T00:00:00Z"]])("refuses the date %s", async (date) => {
    const { fetch, calls } = fakeFetch(bnm);
    await expect(getFx("CNY/MYR", date, opts(fetch))).rejects.toBeInstanceOf(CheckInputError);
    expect(calls).toHaveLength(0);
  });
});

describe("getFx: timeouts, retries and malformed answers fail closed", () => {
  it("retries a 503 and a 429 with doubling backoff, then succeeds", async () => {
    const sleeps: number[] = [];
    const { fetch, calls } = fakeFetch((url, init, n) => (n === 1 ? respond("", 503) : n === 2 ? respond("", 429) : bnm(url, init, n)));
    const fx = await getFx("CNY/MYR", DATE, opts(fetch, { sleep: async (ms) => void sleeps.push(ms) }));
    expect(fx.value).toBe(0.6099);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([300, 600]);
  });

  it("times out a request that never answers, retries, then throws", async () => {
    const { fetch, calls } = fakeFetch((_url, init) => hang(init));
    await expect(getFx("CNY/MYR", DATE, opts(fetch, { timeoutMs: 15 }))).rejects.toThrow(/BNM unavailable after 3 attempts \(timeout\)/);
    expect(calls).toHaveLength(3);
  });

  it("times out a body that stalls after the headers", async () => {
    const stalled = () => new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode("{")) }), { status: 200 });
    const { fetch } = fakeFetch(stalled);
    await expect(getFx("CNY/MYR", DATE, opts(fetch, { timeoutMs: 15, retries: 0 }))).rejects.toThrow(/\(timeout\)/);
  });

  it("refuses to follow a redirect, without retrying", async () => {
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }));
    await expect(getFx("CNY/MYR", DATE, opts(fetch))).rejects.toThrow("BNM: refused to follow a redirect");
    expect(calls).toHaveLength(1);
  });

  it("retries a connection lost while reading the body", async () => {
    const broken = () => new Response(new ReadableStream({ pull: (c) => c.error(new TypeError("socket hang up")) }), { status: 200 });
    const { fetch, calls } = fakeFetch((url, init, n) => (n === 1 ? broken() : bnm(url, init, n)));
    await expect(getFx("CNY/MYR", DATE, opts(fetch))).resolves.toMatchObject({ value: 0.6099 });
    expect(calls).toHaveLength(2);
  });

  it("retries network errors", async () => {
    const { fetch, calls } = fakeFetch(() => Promise.reject(new TypeError("fetch failed")));
    await expect(getFx("CNY/MYR", DATE, opts(fetch))).rejects.toThrow(/\(network error\)/);
    expect(calls).toHaveLength(3);
  });

  it("does not retry other non-200 answers", async () => {
    const { fetch, calls } = fakeFetch(() => respond('{"message":"Forbidden"}', 403));
    await expect(getFx("CNY/MYR", DATE, opts(fetch))).rejects.toThrow("BNM answered HTTP 403");
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["malformed JSON", respond("{not json"), "BNM: answer is not valid JSON"],
    ["invalid UTF-8", respond(new Uint8Array([0x7b, 0xff, 0x7d])), "BNM: answer is not valid JSON"],
    ["the 1130 counter-rate session", respond(fixture("bnm/SGD-2026-10-15-session1130.json")), "BNM answer has an unexpected shape"],
    ["another currency", respond(BODY.SGD as Buffer), "BNM answered for another currency or date"],
    ["no middle rate", respond(String(BODY.CNY).replace('"middle_rate":0.6099', '"middle_rate":null')), "BNM has no middle rate for CNY on 2026-10-15"],
    ["a zero rate", respond(String(BODY.CNY).replace('"middle_rate":0.6099', '"middle_rate":0')), "BNM answer has an unexpected shape"],
    ["an oversized body", respond(`{"pad":"${"x".repeat(20_000)}"}`), "BNM: answer larger than 16384 bytes"],
  ])("rejects %s", async (_label, response, message) => {
    const { fetch } = fakeFetch(() => response.clone());
    await expect(getFx("CNY/MYR", DATE, opts(fetch))).rejects.toThrow(message);
  });

  it("rejects a declared Content-Length over the cap before reading", async () => {
    const big = new Response("{}", { status: 200, headers: { "content-length": "999999" } });
    const { fetch } = fakeFetch(() => big);
    await expect(getFx("CNY/MYR", DATE, opts(fetch))).rejects.toThrow("larger than");
  });
});

describe("httpGet host policy", () => {
  const target = { service: "BNM", host: "api.bnm.gov.my", accept: BNM_ACCEPT, maxBytes: 1024 };
  it.each(["https://evil.example/public", "http://api.bnm.gov.my/public", "https://api.bnm.gov.my:8443/public", "https://u:p@api.bnm.gov.my/public"])(
    "refuses %s without a request",
    async (href) => {
      const { fetch, calls } = fakeFetch(bnm);
      await expect(httpGet(new URL(href), target, { fetch })).rejects.toThrow(CheckUnavailableError);
      expect(calls).toHaveLength(0);
    },
  );
});

describe("toDecimal", () => {
  it("rounds half up to significant digits and keeps exact short values", () => {
    expect(toDecimal({ num: 6099n, den: 10000n }, 8)).toBe("0.6099");
    expect(toDecimal({ num: 2n, den: 3n }, 8)).toBe("0.66666667");
    expect(toDecimal({ num: 123456789n, den: 1n }, 8)).toBe("123456790");
    expect(toDecimal({ num: 1n, den: 8n }, 2)).toBe("0.13");
  });
});
