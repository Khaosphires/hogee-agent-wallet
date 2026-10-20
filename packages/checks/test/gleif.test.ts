import { describe, expect, it } from "vitest";
import { CheckInputError, CheckUnavailableError, leiChecksumValid, lookupLEI, type HttpOptions } from "../src/index";
import { fakeFetch, fixture, hang, headersOf, noSleep, respond } from "./helpers";

// GLEIF answers recorded from https://api.gleif.org/api/v1/lei-records?filter[entity.legalName]=…&page[size]=10
// (Accept: application/vnd.api+json) on 2026-10-18.
const DBS = fixture("gleif/dbs-bank-ltd.json");
const NONE = fixture("gleif/no-match.json");
const PAGE_400 = fixture("gleif/page-size-400.json");
const API_JSON = "application/vnd.api+json";
const opts = (f: typeof fetch, extra: HttpOptions = {}): HttpOptions => ({ fetch: f, sleep: noSleep, ...extra });

describe("lookupLEI", () => {
  it("maps each GLEIF record to {lei, legalName, country, status}", async () => {
    const { fetch } = fakeFetch(() => respond(DBS, 200, API_JSON));
    await expect(lookupLEI("DBS Bank Ltd.", opts(fetch))).resolves.toEqual([
      { lei: "54930056CTN235SVSI38", legalName: "DBS Bank LTD", country: "HK", status: "DUPLICATE" },
      { lei: "ATUEL7OJR5057F2PV266", legalName: "DBS BANK LTD.", country: "SG", status: "ISSUED" },
    ]);
  });

  it("sends only the legal name (plus the page size) to the fixed GLEIF endpoint", async () => {
    const { fetch, calls } = fakeFetch(() => respond(DBS, 200, API_JSON));
    await lookupLEI("  DBS   Bank Ltd. ", opts(fetch));
    const [call] = calls;
    expect(`${call?.url.origin}${call?.url.pathname}`).toBe("https://api.gleif.org/api/v1/lei-records");
    expect([...(call?.url.searchParams.entries() ?? [])]).toEqual([
      ["filter[entity.legalName]", "DBS Bank Ltd."],
      ["page[size]", "10"],
    ]);
    expect(headersOf(call)).toEqual({ accept: API_JSON });
    expect(call?.init.redirect).toBe("manual");
  });

  it("keeps characters of the name inside the one parameter", async () => {
    const { fetch, calls } = fakeFetch(() => respond(NONE, 200, API_JSON));
    await lookupLEI("Ernst & Young #1 Co=LLP?x", opts(fetch));
    expect([...(calls[0]?.url.searchParams.keys() ?? [])]).toEqual(["filter[entity.legalName]", "page[size]"]);
    expect(calls[0]?.url.searchParams.get("filter[entity.legalName]")).toBe("Ernst & Young #1 Co=LLP?x");
  });

  it("returns an empty list when GLEIF has no record", async () => {
    const { fetch } = fakeFetch(() => respond(NONE, 200, API_JSON));
    await expect(lookupLEI("No Such Company Zzqx Ltd", opts(fetch))).resolves.toEqual([]);
  });

  it.each([
    ["an e-mail address", "mei.tan@example.com"],
    ["a phone or ID number", "Mei Tan 91234567"],
    ["a hyphenated NRIC", "Tan 900101-14-5678 Enterprise"],
    ["a spaced phone number", "Mei Tan +60 12-345 6789"],
    ["a fullwidth @", "mei"+"\uFF20"+"example.com"],
    ["Arabic-Indic digits", "Shop "+"\u0669".repeat(8)],
    ["a control character", "DBS\u0000Bank"],
    ["one character", "D"],
    ["an over-long name", "D".repeat(201)],
  ])("refuses %s without any request", async (_label, name) => {
    const { fetch, calls } = fakeFetch(() => respond(DBS, 200, API_JSON));
    await expect(lookupLEI(name, opts(fetch))).rejects.toBeInstanceOf(CheckInputError);
    expect(calls).toHaveLength(0);
  });
});

describe("lookupLEI fails closed", () => {
  it("does not retry a 400", async () => {
    const { fetch, calls } = fakeFetch(() => respond(PAGE_400, 400, API_JSON));
    await expect(lookupLEI("DBS Bank Ltd.", opts(fetch))).rejects.toThrow("GLEIF answered HTTP 400");
    expect(calls).toHaveLength(1);
  });

  it("retries 429 and 5xx, then succeeds", async () => {
    const { fetch, calls } = fakeFetch((_u, _i, n) => (n === 1 ? respond("", 429) : n === 2 ? respond("", 502) : respond(DBS, 200, API_JSON)));
    await expect(lookupLEI("DBS Bank Ltd.", opts(fetch))).resolves.toHaveLength(2);
    expect(calls).toHaveLength(3);
  });

  it("throws after the last retry", async () => {
    const { fetch, calls } = fakeFetch(() => respond("", 500));
    await expect(lookupLEI("DBS Bank Ltd.", opts(fetch, { retries: 1 }))).rejects.toThrow("GLEIF unavailable after 2 attempts (HTTP 500)");
    expect(calls).toHaveLength(2);
  });

  it("times out", async () => {
    const { fetch } = fakeFetch((_u, init) => hang(init));
    await expect(lookupLEI("DBS Bank Ltd.", opts(fetch, { timeoutMs: 15 }))).rejects.toThrow(/\(timeout\)/);
  });

  it.each([
    ["malformed JSON", "{oops", "GLEIF: answer is not valid JSON"],
    ["an unexpected shape", '{"data":{"lei":"x"}}', "GLEIF answer has an unexpected shape"],
    ["a bad LEI check digit", String(DBS).replace(/ATUEL7OJR5057F2PV266/g, "ATUEL7OJR5057F2PV267"), "GLEIF answer holds an LEI with bad check digits"],
  ])("rejects %s", async (_label, body, message) => {
    const { fetch } = fakeFetch(() => respond(body, 200, API_JSON));
    await expect(lookupLEI("DBS Bank Ltd.", opts(fetch))).rejects.toThrow(message);
  });

  it("errors never carry the supplier name", async () => {
    const { fetch } = fakeFetch(() => respond("", 503));
    const error = await lookupLEI("Secret Supplier Sdn Bhd", opts(fetch)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CheckUnavailableError);
    expect(String((error as Error).message)).not.toContain("Secret");
  });
});

describe("leiChecksumValid (ISO 17442)", () => {
  it("accepts published LEIs and rejects a changed digit", () => {
    expect(leiChecksumValid("ATUEL7OJR5057F2PV266")).toBe(true);
    expect(leiChecksumValid("54930056CTN235SVSI38")).toBe(true);
    expect(leiChecksumValid("ATUEL7OJR5057F2PV267")).toBe(false);
    expect(leiChecksumValid("atuel7ojr5057f2pv266")).toBe(false);
  });
});
