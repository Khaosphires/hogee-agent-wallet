/** Production configuration of the live API: names the bad variable, never echoes a value; secrets read per request. */
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { COUNTRY_CODES } from "@hogee/core";
import { DEFAULT_CHAT_RATE } from "../src/http/rate-limit";
import { currencyFor, DEFAULT_COUNTRY, isCountryCode, loadApiEnv, readFlags } from "../src/runtime/env";
import { DEFAULT_MODEL_BUDGET } from "../src/services/model-budget";

const secret = () => randomBytes(32).toString("hex");
const BASE = { DATABASE_URL: "postgres://u:pw-not-real@127.0.0.1:1/db", CHAIN: "local", DEPLOYMENT_ID: "final-1" };

describe("loadApiEnv", () => {
  it("defaults to the Mei (SG) demo tenant on Anvil with localhost passkeys; HOGEE_COUNTRY=MY gives Rina's", () => {
    const e = loadApiEnv(BASE);
    expect(e.config).toMatchObject({ facilityId: "fac-mei", founderId: "founder-mei", countryCode: "SG", currency: "SGD", chain: "local" });
    expect(loadApiEnv({ ...BASE, HOGEE_COUNTRY: "MY" }).config).toMatchObject({ facilityId: "fac-rina", founderId: "founder-rina", countryCode: "MY", currency: "MYR" });
    expect(e.config.webauthn).toEqual({ rpId: "localhost", rpName: "Hogee", origins: ["http://localhost:3000"] });
    expect(e.config.founderWallet).toBeNull();
    expect(e.memoryKey).toBeNull();
    expect(e.config.payoutRail).toEqual({ kind: "mock", configured: true });
  });

  it("names a missing or invalid variable without echoing its value", () => {
    expect(() => loadApiEnv({ ...BASE, DATABASE_URL: "" })).toThrow(/DATABASE_URL/);
    const bad = "0xNOTanADDRESS-with-secret-ish-text";
    try {
      loadApiEnv({ ...BASE, FOUNDER_WALLET_ADDRESS: bad });
      expect.unreachable();
    } catch (e) {
      expect(String((e as Error).message)).toMatch(/FOUNDER_WALLET_ADDRESS/);
      expect(String((e as Error).message)).not.toContain(bad);
    }
    expect(() => loadApiEnv({ ...BASE, WEBAUTHN_ORIGINS: "not a url" })).toThrow(/WEBAUTHN_ORIGINS/);
    expect(() => loadApiEnv({ ...BASE, HOGEE_COUNTRY: "TH" })).toThrow(/HOGEE_COUNTRY must be MY, ID or SG/);
    expect(() => loadApiEnv({ ...BASE, MEMORY_HMAC_KEY: "short" })).toThrow(/MEMORY_HMAC_KEY/);
    expect(() => loadApiEnv({ ...BASE, PAYOUT_RAIL: "paypal" })).toThrow(/PAYOUT_RAIL/);
  });

  it("serves Singapore in SGD with Mei's tenant ids by default; ID keeps IDR and Rina's ids", () => {
    expect(loadApiEnv({ ...BASE, HOGEE_COUNTRY: "SG" }).config).toMatchObject({ facilityId: "fac-mei", founderId: "founder-mei", countryCode: "SG", currency: "SGD" });
    expect(loadApiEnv({ ...BASE, HOGEE_COUNTRY: "MY" }).config).toMatchObject({ facilityId: "fac-rina", founderId: "founder-rina", countryCode: "MY", currency: "MYR" });
    expect(loadApiEnv({ ...BASE, HOGEE_COUNTRY: "ID" }).config).toMatchObject({ facilityId: "fac-rina", founderId: "founder-rina", countryCode: "ID", currency: "IDR" });
    expect(loadApiEnv({ ...BASE, HOGEE_COUNTRY: "SG", HOGEE_FACILITY_ID: "fac-x", HOGEE_FOUNDER_ID: "founder-x" }).config).toMatchObject({ facilityId: "fac-x", founderId: "founder-x" });
  });

  it("defaults to SG, the main demo (SG-DECISIONS Q3)", () => {
    expect(DEFAULT_COUNTRY).toBe("SG");
    expect(loadApiEnv(BASE).config.countryCode).toBe(DEFAULT_COUNTRY);
  });

  it("refuses a country that is only an inherited object key, or not upper case", () => {
    for (const bad of ["toString", "__proto__", "constructor", "hasOwnProperty", "sg", "MYR", "XX"]) {
      expect(() => loadApiEnv({ ...BASE, HOGEE_COUNTRY: bad }), bad).toThrow(/HOGEE_COUNTRY must be MY, ID or SG/);
    }
  });

  it("maps every country to its currency and refuses anything else", () => {
    expect(COUNTRY_CODES.map((c) => currencyFor(c))).toEqual(["MYR", "IDR", "SGD"]);
    expect(() => currencyFor("toString" as never)).toThrow(/country/);
    expect(isCountryCode("SG")).toBe(true);
    expect(isCountryCode("constructor")).toBe(false);
  });

  it("reads LOCAL_RPC_URL on CHAIN=local only, like the worker", () => {
    expect(loadApiEnv(BASE).chain.rpcUrls).toEqual(["http://127.0.0.1:8545"]);
    expect(loadApiEnv({ ...BASE, LOCAL_RPC_URL: "http://127.0.0.1:8546" }).chain.rpcUrls).toEqual(["http://127.0.0.1:8546"]);
    expect(() => loadApiEnv({ ...BASE, LOCAL_RPC_URL: "not a url" })).toThrow(/not a valid URL/);
    const sepolia = { ...BASE, CHAIN: "sepolia", SEPOLIA_RPC_URL: "https://a.example.invalid", SEPOLIA_RPC_URL_FALLBACK: "https://b.example.invalid", LOCAL_RPC_URL: "http://127.0.0.1:8546" };
    expect(loadApiEnv(sepolia).chain.rpcUrls).toEqual(["https://a.example.invalid", "https://b.example.invalid"]);
  });

  it("takes a 32-byte memory key as hex and reports the Xendit rail unconfigured without its key", () => {
    const e = loadApiEnv({ ...BASE, MEMORY_HMAC_KEY: secret(), PAYOUT_RAIL: "xendit", FOUNDER_WALLET_ADDRESS: "0x" + "ab".repeat(20) });
    expect(e.memoryKey?.length).toBe(32);
    expect(e.config.payoutRail).toEqual({ kind: "xendit", configured: false });
    expect(e.config.founderWallet).toBe("0x" + "ab".repeat(20));
  });
});

describe("chat rate limits and the model budget (api-guard)", () => {
  it("default to safe limits when unset, never to no limit", () => {
    const e = loadApiEnv(BASE);
    expect(e.config.chatRate).toEqual(DEFAULT_CHAT_RATE);
    expect(e.modelBudget).toEqual(DEFAULT_MODEL_BUDGET);
    expect(e.modelBudget.windowMs).toBe(24 * 60 * 60 * 1000);
  });

  it("reads each limit from its variable", () => {
    const e = loadApiEnv({
      ...BASE,
      CHAT_RATE_SESSION_PER_MIN: "3",
      CHAT_RATE_CLIENT_PER_MIN: "4",
      CHAT_RATE_SERVER_PER_MIN: "5",
      MODEL_BUDGET_WINDOW_HOURS: "6",
      MODEL_BUDGET_WINDOW_CALLS: "70",
      MODEL_BUDGET_WINDOW_CHARS: "800000",
      MODEL_BUDGET_TOTAL_CALLS: "900",
      MODEL_BUDGET_TOTAL_CHARS: "10000000",
      MODEL_BUDGET_OUTPUT_RESERVE_CHARS: "2048",
    });
    expect(e.config.chatRate).toEqual({ perSession: 3, perClient: 4, perServer: 5 });
    expect(e.modelBudget).toEqual({ windowMs: 6 * 60 * 60 * 1000, windowCalls: 70, windowChars: 800_000, totalCalls: 900, totalChars: 10_000_000, outputReserveChars: 2048 });
  });

  it.each([
    ["CHAT_RATE_SESSION_PER_MIN", "0"],
    ["CHAT_RATE_CLIENT_PER_MIN", "-1"],
    ["CHAT_RATE_SERVER_PER_MIN", "1e3"],
    ["CHAT_RATE_SERVER_PER_MIN", "100000"],
    ["MODEL_BUDGET_WINDOW_HOURS", "0.5"],
    ["MODEL_BUDGET_WINDOW_HOURS", "721"],
    ["MODEL_BUDGET_WINDOW_CALLS", "unlimited"],
    ["MODEL_BUDGET_TOTAL_CHARS", "0x10"],
    ["MODEL_BUDGET_OUTPUT_RESERVE_CHARS", "0"],
  ])("refuses %s=%s at start-up (fail closed), naming the variable", (name, value) => {
    expect(() => loadApiEnv({ ...BASE, [name]: value })).toThrow(new RegExp(name));
  });

  it("refuses an output allowance larger than a whole window", () => {
    expect(() => loadApiEnv({ ...BASE, MODEL_BUDGET_WINDOW_CHARS: "1000", MODEL_BUDGET_OUTPUT_RESERVE_CHARS: "2000" })).toThrow(/MODEL_BUDGET_OUTPUT_RESERVE_CHARS/);
  });
});

describe("readFlags", () => {
  it("reads secrets per call; DEMO_MODE=1 needs a strong cookie secret", () => {
    const env: Record<string, string | undefined> = { DEMO_MODE: "0" };
    expect(readFlags(env)).toEqual({ demoMode: false, cookieSecret: undefined, officerToken: undefined, stripeWebhookSecret: undefined });
    env.DEMO_MODE = "1";
    expect(() => readFlags(env)).toThrow(/PERSONA_COOKIE_SECRET/);
    const s = secret();
    env.PERSONA_COOKIE_SECRET = s;
    env.OFFICER_TOKEN = "weak";
    expect(readFlags(env)).toMatchObject({ demoMode: true, cookieSecret: s, officerToken: "weak" });
  });
});

// VISION-DECISIONS §7: TAVILY_API_KEY is optional, format-checked, never echoed and never part of ApiConfig.
describe("TAVILY_API_KEY", () => {
  const KEY = `tvly-${"Ab1_-".repeat(4)}xyz`;

  it("is optional: unset leaves web search in recorded mode", () => {
    expect(loadApiEnv(BASE).tavilyKey).toBeUndefined();
  });

  it("is read when well formed, and kept out of ApiConfig", () => {
    const e = loadApiEnv({ ...BASE, TAVILY_API_KEY: ` ${KEY} ` });
    expect(e.tavilyKey).toBe(KEY);
    expect(JSON.stringify(e.config)).not.toContain(KEY);
    expect(JSON.stringify(e.config)).not.toContain("tvly-");
  });

  it.each(["not-a-tavily-key-0123456789", "tvly-short", `tvly-${"a".repeat(15)}`, `tvly-${"a".repeat(16)}!`, `tvly-${"a".repeat(300)}`])(
    "refuses a malformed key (%#) without echoing it",
    (bad) => {
      try {
        loadApiEnv({ ...BASE, TAVILY_API_KEY: bad });
        expect.unreachable();
      } catch (e) {
        expect(String((e as Error).message)).toMatch(/TAVILY_API_KEY is malformed/);
        expect(String((e as Error).message)).not.toContain(bad);
      }
    },
  );
});
