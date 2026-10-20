/**
 * The live API's environment (project.md §18.3 plus task 1.12 additions). Errors name the variable, never its value
 * (URLs can embed provider keys). Static config is read once; secrets and switches (RuntimeFlags) per request.
 *
 * Added by task 1.12: HOGEE_FACILITY_ID, HOGEE_FOUNDER_ID, HOGEE_COUNTRY, WEBAUTHN_RP_ID, WEBAUTHN_RP_NAME,
 * WEBAUTHN_ORIGINS, FOUNDER_WALLET_ADDRESS, MEMORY_HMAC_KEY, HOGEE_DATA_DIR, DEPLOYMENT_FILE. Task 1.16: HOGEE_EVIDENCE_DIR,
 * HOGEE_GIT_COMMIT (read by the exporter).
 * Added by task 1.15: LOCAL_RPC_URL (CHAIN=local only: an Anvil on another port, as the worker already reads it).
 * Added by api-guard (G0 §9 "still open"): CHAT_RATE_SESSION_PER_MIN, CHAT_RATE_CLIENT_PER_MIN, CHAT_RATE_SERVER_PER_MIN
 * and MODEL_BUDGET_WINDOW_HOURS, _WINDOW_CALLS, _WINDOW_CHARS, _TOTAL_CALLS, _TOTAL_CHARS, _OUTPUT_RESERVE_CHARS. Each is
 * optional with a safe default; a value that is set but invalid stops the start-up (never "no limit").
 * Added by v-contract (VISION-DECISIONS §7): TAVILY_API_KEY (web supplier search). Optional; a malformed one stops the
 * start-up. It is a secret: it lives only in ApiEnv.tavilyKey (never ApiConfig, never a log line).
 */
import { COUNTRY_CODES, MEI_IDS, RINA_IDS, type CountryCode, type CurrencyCode } from "@hogee/core";
import type { Address } from "viem";
import { chainConfigFromEnv, validateChainConfig, type ChainConfig } from "../chain-lib";
import type { ApiConfig, RuntimeFlags } from "../context";
import { ConfigError } from "../http/problem";
import { DEFAULT_CHAT_RATE, type ChatRateLimits } from "../http/rate-limit";
import { DEFAULT_MODEL_BUDGET, type ModelBudgetLimits } from "../services/model-budget";
import { parsePersonaCookieSecret } from "../persona-cookie";

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * The API's HOGEE_COUNTRY when the variable is unset: SG, Singapore is the main demo (SG-DECISIONS Q3, flipped once
 * SG.json validated, Mei compiled and api-contract accepted founder:mei). HOGEE_COUNTRY=MY runs Rina's demo.
 * The default tenant ids and persona follow it (DEFAULT_TENANT below, persona-cookie.ts defaultPersonaFor).
 */
export const DEFAULT_COUNTRY: CountryCode = "SG";

/** Each country's facility currency (ISO 4217; amounts stay budget-unit minor units). */
const CURRENCY: Readonly<Record<CountryCode, CurrencyCode>> = { MY: "MYR", ID: "IDR", SG: "SGD" };

/** Each country's demo tenant, used when HOGEE_FACILITY_ID / HOGEE_FOUNDER_ID are unset. ID keeps Rina's (unchanged). */
const DEFAULT_TENANT: Readonly<Record<CountryCode, { readonly facilityId: string; readonly founderId: string }>> = {
  MY: { facilityId: RINA_IDS.facilityId, founderId: RINA_IDS.founderId },
  ID: { facilityId: RINA_IDS.facilityId, founderId: RINA_IDS.founderId },
  SG: { facilityId: MEI_IDS.facilityId, founderId: MEI_IDS.founderId },
};

/** A supported country, by the frozen list (never `in`, which also accepts inherited keys such as "toString"). */
export const isCountryCode = (value: string): value is CountryCode => (COUNTRY_CODES as readonly string[]).includes(value);

/** The currency of a country's facilities. Throws on anything but a supported country. */
export function currencyFor(country: CountryCode): CurrencyCode {
  if (!isCountryCode(country)) throw new ConfigError("Unknown country");
  return CURRENCY[country];
}
const SHORT_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export interface ApiEnv {
  readonly config: ApiConfig;
  readonly databaseUrl: string;
  readonly chain: ChainConfig;
  readonly deploymentId: string;
  readonly chainTag: string;
  readonly deploymentFile: string | undefined;
  readonly memoryKey: Uint8Array | null;
  readonly dataDir: string | undefined;
  /** HOGEE_EVIDENCE_DIR (task 1.16). */
  readonly evidenceDir: string | undefined;
  readonly stripeSecretKey: string | undefined;
  /** The server's model-usage budget (MODEL_BUDGET_*). */
  readonly modelBudget: ModelBudgetLimits;
  /** TAVILY_API_KEY, format-checked; undefined when unset (web search then runs in recorded mode). Never logged. */
  readonly tavilyKey: string | undefined;
}

const val = (env: Env, name: string): string | undefined => {
  const v = env[name]?.trim();
  return v ? v : undefined;
};

function required(env: Env, name: string): string {
  const v = val(env, name);
  if (!v) throw new ConfigError(`${name} is required`);
  return v;
}

function shortId(env: Env, name: string, fallback: string): string {
  const v = val(env, name) ?? fallback;
  if (!SHORT_ID.test(v)) throw new ConfigError(`${name} must be a short id ([a-z0-9_-], up to 32 chars)`);
  return v;
}

/** An optional whole number in [1, max]; unset → `fallback`. Anything else is a ConfigError naming the variable. */
function wholeNumber(env: Env, name: string, fallback: number, max: number): number {
  const raw = val(env, name);
  if (raw === undefined) return fallback;
  const n = /^[0-9]{1,16}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new ConfigError(`${name} must be a whole number from 1 to ${max}`);
  return n;
}

const MAX_PER_MIN = 10_000;
const MAX_CALLS = 10_000_000;
const MAX_CHARS = 1_000_000_000_000;
const HOUR_MS = 60 * 60 * 1000;

export function chatRateLimits(env: Env): ChatRateLimits {
  return {
    perSession: wholeNumber(env, "CHAT_RATE_SESSION_PER_MIN", DEFAULT_CHAT_RATE.perSession, MAX_PER_MIN),
    perClient: wholeNumber(env, "CHAT_RATE_CLIENT_PER_MIN", DEFAULT_CHAT_RATE.perClient, MAX_PER_MIN),
    perServer: wholeNumber(env, "CHAT_RATE_SERVER_PER_MIN", DEFAULT_CHAT_RATE.perServer, MAX_PER_MIN),
  };
}

export function modelBudgetLimits(env: Env): ModelBudgetLimits {
  const d = DEFAULT_MODEL_BUDGET;
  const limits: ModelBudgetLimits = {
    windowMs: wholeNumber(env, "MODEL_BUDGET_WINDOW_HOURS", d.windowMs / HOUR_MS, 24 * 30) * HOUR_MS,
    windowCalls: wholeNumber(env, "MODEL_BUDGET_WINDOW_CALLS", d.windowCalls, MAX_CALLS),
    windowChars: wholeNumber(env, "MODEL_BUDGET_WINDOW_CHARS", d.windowChars, MAX_CHARS),
    totalCalls: wholeNumber(env, "MODEL_BUDGET_TOTAL_CALLS", d.totalCalls, MAX_CALLS),
    totalChars: wholeNumber(env, "MODEL_BUDGET_TOTAL_CHARS", d.totalChars, MAX_CHARS),
    outputReserveChars: wholeNumber(env, "MODEL_BUDGET_OUTPUT_RESERVE_CHARS", d.outputReserveChars, 1_000_000),
  };
  if (limits.outputReserveChars > limits.windowChars || limits.outputReserveChars > limits.totalChars) {
    throw new ConfigError("MODEL_BUDGET_OUTPUT_RESERVE_CHARS must not exceed MODEL_BUDGET_WINDOW_CHARS or MODEL_BUDGET_TOTAL_CHARS");
  }
  return limits;
}

/** A Tavily API key: "tvly-" + at least 16 base64url-ish characters (VISION-DECISIONS §7). */
export const TAVILY_KEY_RE = /^tvly-[A-Za-z0-9_-]{16,}$/;

/** TAVILY_API_KEY when set and well-formed; a malformed key is a ConfigError that never echoes the value. */
export function tavilyKey(env: Env): string | undefined {
  const raw = val(env, "TAVILY_API_KEY");
  if (raw === undefined) return undefined;
  if (raw.length > 256 || !TAVILY_KEY_RE.test(raw)) throw new ConfigError("TAVILY_API_KEY is malformed (expected tvly- followed by the key)");
  return raw;
}

function origins(env: Env): string[] {
  const raw = val(env, "WEBAUTHN_ORIGINS") ?? "http://localhost:3000";
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  for (const o of list) {
    let u: URL;
    try {
      u = new URL(o);
    } catch {
      throw new ConfigError("WEBAUTHN_ORIGINS must be a comma-separated list of origins (scheme://host[:port])");
    }
    if (u.origin !== o || (u.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(u.hostname))) {
      throw new ConfigError("WEBAUTHN_ORIGINS entries must be bare origins, https except on localhost");
    }
  }
  if (list.length === 0) throw new ConfigError("WEBAUTHN_ORIGINS is empty");
  return list;
}

function memoryKey(env: Env): Uint8Array | null {
  const raw = val(env, "MEMORY_HMAC_KEY");
  if (!raw) return null;
  const bytes = /^(0x)?[0-9a-fA-F]+$/.test(raw) ? Buffer.from(raw.replace(/^0x/, ""), "hex") : Buffer.from(raw, "base64");
  if (bytes.length < 32) throw new ConfigError("MEMORY_HMAC_KEY must be at least 32 bytes (hex or base64), e.g. $(openssl rand -hex 32)");
  return new Uint8Array(bytes);
}

function founderWallet(env: Env): Address | null {
  const raw = val(env, "FOUNDER_WALLET_ADDRESS");
  if (!raw) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new ConfigError("FOUNDER_WALLET_ADDRESS must be a 0x-prefixed 20-byte address");
  return raw.toLowerCase() as Address;
}

function payoutRail(env: Env): ApiConfig["payoutRail"] {
  const kind = val(env, "PAYOUT_RAIL") ?? "mock";
  if (kind !== "mock" && kind !== "xendit") throw new ConfigError("PAYOUT_RAIL must be mock or xendit");
  return { kind, configured: kind === "mock" || /^xnd_development_/.test(env.XENDIT_SECRET_KEY ?? "") };
}

export function loadApiEnv(env: Env): ApiEnv {
  const databaseUrl = required(env, "DATABASE_URL");
  let chain: ChainConfig;
  try {
    chain = chainConfigFromEnv(env);
    // Same rule as the worker (apps/worker config/env.ts): LOCAL_RPC_URL replaces the default Anvil URL on CHAIN=local.
    const local = val(env, "LOCAL_RPC_URL");
    if (chain.chain === "local" && local) chain = validateChainConfig({ chain: "local", rpcUrls: [local], pollingIntervalMs: chain.pollingIntervalMs });
  } catch (error: unknown) {
    throw new ConfigError(error instanceof Error ? error.message : "CHAIN is invalid");
  }
  const country = val(env, "HOGEE_COUNTRY") ?? DEFAULT_COUNTRY;
  if (!isCountryCode(country)) throw new ConfigError("HOGEE_COUNTRY must be MY, ID or SG");
  const tenant = DEFAULT_TENANT[country];
  const deploymentId = shortId(env, "DEPLOYMENT_ID", val(env, "FINAL_DEPLOYMENT_ID") ?? "final-1");
  const presidio = val(env, "PRESIDIO_ANALYZER_URL") ?? null;
  return {
    databaseUrl,
    chain,
    deploymentId,
    chainTag: shortId(env, "CHAIN_TAG", chain.chain === "local" ? "anvil" : "sepolia"),
    deploymentFile: val(env, "DEPLOYMENT_FILE"),
    memoryKey: memoryKey(env),
    dataDir: val(env, "HOGEE_DATA_DIR"),
    evidenceDir: val(env, "HOGEE_EVIDENCE_DIR"),
    stripeSecretKey: val(env, "STRIPE_SECRET_KEY"),
    modelBudget: modelBudgetLimits(env),
    tavilyKey: tavilyKey(env),
    config: {
      facilityId: shortId(env, "HOGEE_FACILITY_ID", tenant.facilityId),
      founderId: shortId(env, "HOGEE_FOUNDER_ID", tenant.founderId),
      countryCode: country,
      currency: currencyFor(country),
      chain: chain.chain === "local" ? "local" : "sepolia",
      webauthn: { rpId: val(env, "WEBAUTHN_RP_ID") ?? "localhost", rpName: val(env, "WEBAUTHN_RP_NAME") ?? "Hogee", origins: origins(env) },
      founderWallet: founderWallet(env),
      presidioUrl: presidio,
      payoutRail: payoutRail(env),
      chatRate: chatRateLimits(env),
    },
  };
}

/** Per request: rotating a secret needs no restart. DEMO_MODE=1 requires a strong PERSONA_COOKIE_SECRET. */
export function readFlags(env: Env): RuntimeFlags {
  let cookieSecret: string | undefined;
  try {
    cookieSecret = parsePersonaCookieSecret(env);
  } catch (error: unknown) {
    throw new ConfigError(error instanceof Error ? error.message : "PERSONA_COOKIE_SECRET is invalid");
  }
  return {
    demoMode: val(env, "DEMO_MODE") === "1",
    cookieSecret,
    officerToken: env.OFFICER_TOKEN || undefined,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || undefined,
  };
}
