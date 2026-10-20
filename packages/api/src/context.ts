/**
 * What every route handler gets (task 1.12): config, per-request flags, the database, a READ-ONLY chain client, the
 * job queue and the outside services. Every port is injectable, so tests build the app against a test Postgres,
 * Anvil and fakes for Stripe, the model provider and the country-pack/supplier catalog.
 *
 * Hard rule (D19): nothing here can sign. The chain port is a public client (reads, eth_call simulations); every
 * transaction is a `chain_actions` / `payments` row the worker signs after a queue job.
 */
import type { AgentModels, GuardContext, LlmCallSink, Redactor } from "@hogee/agent";
import type {
  Address,
  CountryCode,
  CountryPack,
  CurrencyCode,
  E2PromptRow,
  LineKey,
  SearchProvider,
  SellChannel,
  ShortlistSpec,
  Sourced,
  Supplier,
  SupplierEvidence,
  WebSearchAnswer,
  WebSearchQuery,
} from "@hogee/core";
import type { Db } from "@hogee/db";
import type { HogeePublicClient } from "./chain-lib";
import type { Deployment } from "./deployment";
import type { ChatRateLimits } from "./http/rate-limit";
import type { ModelBudget } from "./services/model-budget";

export interface WebAuthnConfig {
  /** Relying-party id (RP ID): "localhost" in the demo. */
  readonly rpId: string;
  readonly rpName: string;
  /** Origins a passkey ceremony may come from, e.g. http://localhost:3000. */
  readonly origins: readonly string[];
}

/** Static configuration, read once when the app starts. */
export interface ApiConfig {
  /** The single demo tenant served by this process (HOGEE_FACILITY_ID, default fac-rina). */
  readonly facilityId: string;
  /** Its founder (HOGEE_FOUNDER_ID, default founder-rina). */
  readonly founderId: string;
  readonly countryCode: CountryCode;
  readonly currency: CurrencyCode;
  /** CHAIN: `local` (Anvil) or `sepolia`. Demo reset only ever runs on `local`. */
  readonly chain: "local" | "sepolia";
  readonly webauthn: WebAuthnConfig;
  /** FOUNDER_WALLET_ADDRESS: the founder's backup owner EOA (public address; ECDSA / MetaMask path). */
  readonly founderWallet: Address | null;
  /** PRESIDIO_ANALYZER_URL (health only; redaction itself is @hogee/privacy's). */
  readonly presidioUrl: string | null;
  /** PAYOUT_RAIL as the worker will use it (health only; the worker pays out). */
  readonly payoutRail: { readonly kind: "mock" | "xendit"; readonly configured: boolean };
  /** Task 1.16: evidence/ (HOGEE_EVIDENCE_DIR, else <repo>/evidence next to data/). Unset: no export, no runs. */
  readonly evidenceDir?: string;
  /** POST /api/chat rate limits (CHAT_RATE_*_PER_MIN). Absent: DEFAULT_CHAT_RATE, never "no limit". */
  readonly chatRate?: ChatRateLimits;
}

/** Secrets and switches read per request, so rotating a secret needs no restart. Never logged. */
export interface RuntimeFlags {
  readonly demoMode: boolean;
  readonly cookieSecret: string | undefined;
  readonly officerToken: string | undefined;
  readonly stripeWebhookSecret: string | undefined;
}

/** Queues the worker consumes (apps/worker runtime/boss.ts WORKER_QUEUES). The API only sends; the worker signs. Demo flags go to hogee_worker.flags. */
// VISION-DECISIONS §7: + cfo-guard (the CFO's bounded tightening, v-cfo), so the API can wake it after a sale.
export const API_JOBS = ["relay", "record-sale", "agent-actions", "timelock-executor", "stage-gate", "cfo-guard"] as const;
export type ApiJob = (typeof API_JOBS)[number];

export interface QueuePort {
  send(job: ApiJob, data?: Readonly<Record<string, unknown>>): Promise<void>;
}

/** A demo supplier as P3 delivers it: the structured record, its evidence and the raw (untrusted) listing text. */
export interface SupplierFixture {
  readonly supplier: Supplier;
  readonly evidence: readonly SupplierEvidence[];
  /** null: the record's rawTextRef could not be read, so its gates cannot be checked (a shortlist with it fails closed). */
  readonly listingText: string | null;
}

/**
 * A payee from verified onboarding (§5 trust boundary 3): its payout destination is known server-side, never taken
 * from text. `platform` payees are the deployment's static registry (their payout hash is fixed in Treasury at
 * deploy); `vendor` payees (e.g. a packaging printer) can only be added to a line by a founder + lender ADD_PAYEE.
 */
export interface OnboardedPayee {
  readonly payeeId: string;
  readonly displayName: string;
  readonly source: "platform" | "vendor";
  /** The line a platform payee serves (absent for the tax payee, which only receives reserve withdrawals). */
  readonly lineKey?: LineKey;
  readonly channels?: readonly SellChannel[];
  readonly account: { readonly channel: string; readonly accountNumber: string; readonly holderName: string };
}

/** An E2 prompt (evals/datasets/e2/prompts.jsonl) and the true value of its hidden slot as the founder would type it. */
export interface E2PromptCase {
  readonly row: E2PromptRow;
  /** evals/datasets/e2/hidden-answers.jsonl `answer` for the row's hiddenSlot; null when the row has none. */
  readonly hiddenAnswer: string | null;
}

/** An E3 supplier set: data/suppliers/eval/<setId>/listings/*.json (+ raw text) and its optional spec.json. */
export interface SupplierEvalSet {
  readonly setId: string;
  readonly listings: readonly SupplierFixture[];
  readonly spec: ShortlistSpec | null;
}

export interface CatalogPort {
  /** data/country-packs/<CC>.json, or null when P3 has not delivered it. */
  countryPack(country: CountryCode): Promise<CountryPack | null>;
  /** data/suppliers/demo/*.json (+ raw listing text). */
  suppliers(): Promise<readonly SupplierFixture[]>;
  /** Static platform payees and onboarded vendors with their TEST payout accounts. */
  payees(): Promise<readonly OnboardedPayee[]>;
  /** One E2 prompt by id (eval only), or null when the dataset or the row is absent. */
  e2Prompt(promptId: string): Promise<E2PromptCase | null>;
  /** One E3 supplier set by id (eval only), or null when it is absent. */
  supplierEvalSet(setId: string): Promise<SupplierEvalSet | null>;
}

/**
 * Registry id kinds with an offline packages/checks validator: China USCC, Malaysia SSM, Singapore UEN. Each kind is
 * checked by its own validator only (SG-DESIGN §4 fail-open 4: nothing defaults to SSM), and any other kind is refused.
 * "uen" is matched as a string until core's Supplier.ids carries it; then this can be Exclude<RegistryIdKind, "lei">.
 */
export const REGISTRY_KINDS = ["uscc", "ssm", "uen"] as const;
export type RegistryKind = (typeof REGISTRY_KINDS)[number];

export const isRegistryKind = (kind: string): kind is RegistryKind => (REGISTRY_KINDS as readonly string[]).includes(kind);

/** packages/checks (P3). Each may throw (stubs fail closed); callers treat a throw as "unavailable". */
export interface ChecksPort {
  screenSanctions(name: string): Promise<{ readonly hit: boolean }>;
  /** The validator of exactly this kind; throws for a kind without one (never another kind's validator). */
  validateRegistryId(kind: RegistryKind, id: string): { readonly valid: boolean };
  fx(pair: `${string}/${string}`, date: string): Promise<Sourced<number>>;
}

export interface AgentPort {
  /** The model provider's key is set (health). */
  readonly configured: boolean;
  /** Guarded planner/reader models for one request (redaction + canary + call log). Throws when unconfigured. */
  models(context: GuardContext, sink: LlmCallSink): AgentModels;
  /** MEMORY_HMAC_KEY (≥ 32 bytes); null when unset (memory is then neither read nor written). */
  readonly memoryKey: Uint8Array | null;
  /** The redactor chat text passes through BEFORE it is stored (production: @hogee/privacy, fail closed). */
  readonly redactor: Redactor;
  /**
   * The server's model-usage budget (MODEL_BUDGET_*), shared by chat and eval: `models` refuses up front once it is used
   * up, and every provider call of the models it returns reserves from it before it is sent (runtime/budgeted-models.ts).
   */
  readonly budget: ModelBudget;
}

/**
 * VISION-DECISIONS §8-§9: web supplier search. `tavily` calls api.tavily.com (the only new outbound host; result URLs are
 * never fetched); `recorded` serves data/suppliers/search/recorded/* and runs only when no TAVILY_API_KEY is set. A
 * provider failure fails the search (PROVIDER_DOWN): there is no silent switch to recorded results. The query comes
 * from the COMMITTED plan (supplierQuery), never from founder text.
 */
export interface WebSearchPort {
  readonly provider: SearchProvider;
  search(q: WebSearchQuery, signal?: AbortSignal): Promise<WebSearchAnswer>;
}

export interface StripeTestPayment {
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly facilityId: string;
  /** Idempotency key for Stripe (one demo sale per click). */
  readonly idempotencyKey: string;
}

export interface StripePort {
  /** Creates and confirms a Stripe TEST-mode PaymentIntent; the sale arrives later as a signed webhook. */
  createTestPayment(p: StripeTestPayment): Promise<{ readonly paymentIntentId: string }>;
}

export interface ApiLogger {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface ApiDeps {
  readonly config: ApiConfig;
  readonly flags: () => RuntimeFlags;
  readonly db: Db;
  readonly client: HogeePublicClient;
  readonly deployment: Deployment;
  readonly queue: QueuePort;
  /** Wall clock, epoch ms (cookie expiry, attempt windows). Chain time comes from the latest block. */
  readonly clock: () => number;
  readonly catalog: CatalogPort;
  readonly checks: ChecksPort;
  readonly agent: AgentPort;
  /** null when STRIPE_SECRET_KEY is unset (POST /api/demo/sale answers 503). */
  readonly stripe: StripePort | null;
  /** Web supplier search (v-search wires it); absent: POST /api/suppliers/search cannot search the web. */
  readonly webSearch?: WebSearchPort;
  readonly log: ApiLogger;
}

/** Builds (or returns the cached) deps; throws a ConfigError when the live API is not configured. */
export type DepsProvider = () => Promise<ApiDeps>;

/** The tenant of the request: always from server config, never from the request (T31). */
export interface Scope {
  readonly facilityId: string;
  readonly founderId: string;
}
