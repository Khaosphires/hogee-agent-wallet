/**
 * One red-team world: final-1 (deployed fresh on Anvil, or the Sepolia manifest), the worker's role keys (generated at
 * runtime on Anvil; the worker's own loader on Sepolia), a facility and founder of its own, the REAL API app wired to
 * Postgres and the chain, and the worker's job functions run in-process by `pump()` (the worker is still the only
 * signer: every transaction below goes through its relay, agent-actions, tick, settle and reconcile jobs, or through
 * @hogee/chain's crash-safe sender for the forced sends). Modelled on packages/api/test/support/world.ts.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHogeePublicClient, type HogeePublicClient } from "@hogee/chain";
import { PERSONA_COOKIE, type Persona as PersonaId } from "@hogee/core";
import { createDb, type Db } from "@hogee/db";
import {
  createLogger,
  loadSigners,
  migrateWorkerSchema,
  MockRail,
  publishRoles,
  runAgentActions,
  runReconcile,
  runRelay,
  runSettle,
  runStageGate,
  runTick,
  runTimelockExecutor,
  XENDIT_SECRET_KEY_ENV,
  xenditRailFromEnv,
  type JobDeps,
  type Logger,
  type PayoutRail,
  type WorkerSigners,
} from "@hogee/worker";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Hono } from "hono";
import { parseEther, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  createApiApp,
  parseDeploymentJson,
  scriptedAgent,
  signPersonaCookie,
  SoftAuthenticator,
  testCatalog,
  testChecks,
  type ApiDeps,
  type ApiJob,
  type ChecksPort,
  type Deployment,
  type RuntimeFlags,
  type ScriptedAgent,
  type WebSearchPort,
} from "./api-internals";
import { anvilClock, sepoliaClock, type ChainClock } from "./clock";
import type { RunConfig } from "./config";
import { demoCountry, type DemoCountry, type DemoCountryCode } from "./country";
import { deployFinalAnvil } from "./deploy";
import { databasePreflight, founderSecrets, gasPreflight, sepoliaChainPreflight } from "./safety";

const MIGRATIONS = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
/** Same key as the API's and the worker's live tests: they share tables and the Anvil clock. */
const LIVE_LOCK_KEY = 0x4e0_1e05;
export const DAY = 86_400n;

export interface Persona {
  get(path: string): Promise<Response>;
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  form(path: string, form: FormData): Promise<Response>;
}

export interface Infra {
  readonly cfg: RunConfig;
  readonly db: Db;
  readonly client: HogeePublicClient;
  readonly clock: ChainClock;
  readonly log: Logger;
  close(): Promise<void>;
}

export interface Stack {
  readonly label: string;
  /** The world's country (the API's HOGEE_COUNTRY, currency, founder persona and payee registry). */
  readonly country: DemoCountry;
  readonly infra: Infra;
  readonly db: Db;
  readonly client: HogeePublicClient;
  readonly clock: ChainClock;
  readonly deployment: Deployment;
  readonly signers: WorkerSigners;
  /** The founder's backup owner EOA (registered with the passkey; an ECDSA key generated at runtime). */
  readonly founderWallet: PrivateKeyAccount;
  /** The founder's passkey: a software P-256 authenticator generated at runtime (same on-chain WebAuthn path). */
  readonly auth: SoftAuthenticator;
  /** The scripted model behind the real guard; `resetAgent()` swaps in a fresh one (same memory key). */
  readonly agent: ScriptedAgent;
  resetAgent(): void;
  readonly flags: RuntimeFlags;
  readonly deps: ApiDeps;
  readonly app: Hono;
  readonly facilityId: string;
  readonly founderId: string;
  readonly founder: Persona;
  readonly officer: Persona;
  readonly anon: Persona;
  readonly jobs: { job: ApiJob; data: unknown }[];
  readonly rail: PayoutRail;
  /** FINAL key env values for the plug child's env only. */
  readonly childKeyEnv: Readonly<Record<string, string>>;
  /** Other loaded secrets (the Xendit key, read before the worker's loader scrubs it): only for the secret scan. */
  readonly loadedSecrets: readonly string[];
  /** The founder secrets this stack generated (backup-wallet key, soft-passkey private key): only for the secret scan. */
  readonly generatedSecrets: readonly string[];
  workerDeps(over?: Partial<JobDeps>): JobDeps;
  cookie(p: PersonaId): string;
  /** Relay, timelock-executor, stage-gate and reconcile until nothing new is signed. */
  pump(): Promise<void>;
  /** The agent's actions and pacing tick, then the pump. */
  agentRound(): Promise<void>;
  /** Finality, then settle-spend (payout + the oracle's confirm), repeated until the queue is empty. */
  settleRound(): Promise<void>;
}

const randomSecret = (): string => randomBytes(32).toString("base64url");

/** The Drizzle migrations (packages/db/drizzle) and the worker's own schema, as the live tests apply them. */
export async function migrateDatabase(db: Db): Promise<void> {
  await migrate(db as unknown as Parameters<typeof migrate>[0], { migrationsFolder: MIGRATIONS });
  await migrateWorkerSchema(db.$client);
}

/** The deployed final-1 manifest (Sepolia); a manifest of anything but a final-* deployment is refused. */
export function readSepoliaManifest(cfg: RunConfig): Deployment {
  const file = cfg.manifestFile;
  if (!file) throw new Error("sepolia needs the final-1 manifest");
  const deployment = parseDeploymentJson(JSON.parse(readFileSync(file, "utf8")) as unknown);
  if (!/^final-/.test(deployment.deploymentId)) throw new Error("the manifest is not a final-* deployment (its keys are the _FINAL set)");
  return deployment;
}

export async function openInfra(cfg: RunConfig, log: Logger): Promise<Infra> {
  const client =
    cfg.target === "anvil"
      ? createHogeePublicClient({ chain: "local", rpcUrls: [cfg.rpcUrls[0] as string], pollingIntervalMs: 50 })
      : createHogeePublicClient({ chain: "sepolia", rpcUrls: [...cfg.rpcUrls], pollingIntervalMs: 12_000 });
  const clock = cfg.target === "anvil" ? anvilClock(client, cfg.rpcUrls[0] as string) : sepoliaClock(client);
  const db = createDb(cfg.databaseUrl, { maxConnections: 16 });
  db.$client.on("error", (error: unknown) => log.error("pg_pool_error", { error }));
  const lock = await db.$client.connect();
  try {
    await lock.query("select pg_advisory_lock($1)", [LIVE_LOCK_KEY]);
    // Read-only checks first: nothing is migrated, cleared or written on a database (or chain) the run must refuse.
    if (cfg.target === "sepolia") await sepoliaChainPreflight(client, readSepoliaManifest(cfg));
    await databasePreflight(db.$client, cfg.target);
    await migrateDatabase(db);
    if (cfg.target === "anvil") {
      // A throwaway Anvil database may hold a halt from an earlier run; a Sepolia run refused a halted worker above.
      await db.$client.query("update hogee_worker.halts set cleared_at = now(), cleared_by = 'redteam-setup' where cleared_at is null");
    }
  } catch (error: unknown) {
    lock.release();
    await db.$client.end();
    throw error;
  }
  return {
    cfg,
    db,
    client,
    clock,
    log,
    async close() {
      await lock.query("select pg_advisory_unlock($1)", [LIVE_LOCK_KEY]).catch(() => undefined);
      lock.release();
      await db.$client.end();
    },
  };
}

function persona(app: Hono, cookie: string): Persona {
  const headers = (extra: Record<string, string> = {}) => ({ ...(cookie ? { cookie } : {}), ...extra });
  return {
    get: async (path) => app.request(path, { headers: headers() }),
    post: async (path, body, extra = {}) =>
      app.request(path, { method: "POST", headers: headers({ "content-type": "application/json", ...extra }), body: body === undefined ? "{}" : JSON.stringify(body) }),
    form: async (path, form) => app.request(path, { method: "POST", headers: headers(), body: form }),
  };
}

interface Chain {
  readonly deployment: Deployment;
  readonly signers: WorkerSigners;
  /** The four FINAL key env values, kept ONLY to start the plug child (never logged, written or returned in a report). */
  readonly childKeyEnv: Readonly<Record<string, string>>;
}

const KEY_NAMES = ["AGENT", "ORACLE", "LENDER", "RELAYER"].map((r) => `${r}_PRIVATE_KEY_FINAL`);

async function anvilChain(infra: Infra, label: string, country: DemoCountry): Promise<Chain> {
  const hex = KEY_NAMES.map(() => generatePrivateKey());
  const [agent, oracle, lender, relayer] = hex.map((k) => privateKeyToAccount(k)) as [PrivateKeyAccount, PrivateKeyAccount, PrivateKeyAccount, PrivateKeyAccount];
  const signers: WorkerSigners = { set: "FINAL", agent, oracle, lender, relayer };
  const childKeyEnv = Object.fromEntries(KEY_NAMES.map((n, i) => [n, hex[i] as string]));
  for (const a of [signers.agent, signers.oracle, signers.lender, signers.relayer]) await infra.clock.setBalance?.(a.address, parseEther("10"));
  const now = await infra.clock.now();
  const { deployment } = await deployFinalAnvil({
    rpcUrl: infra.cfg.rpcUrls[0] as string,
    deploymentId: `final-${label.slice(0, 3)}${randomUUID().slice(0, 6)}`,
    lender: signers.lender.address,
    oracle: signers.oracle.address,
    // The plan's agent expiry (60 days) must stay after the judging window; 30 days leaves room for the T22 warp.
    judgingWindowEnd: now + 30n * DAY,
    coolingSeconds: infra.cfg.coolingSeconds,
    timelockSeconds: infra.cfg.timelockSeconds,
    payees: country.payees,
  });
  return { deployment, signers, childKeyEnv };
}

/** Sepolia: the deployed manifest and the FINAL keys of the worker host (read once, then scrubbed from the env). */
function sepoliaChain(infra: Infra): Chain {
  const deployment = readSepoliaManifest(infra.cfg);
  const childKeyEnv = Object.fromEntries(KEY_NAMES.map((n) => [n, process.env[n]?.trim() ?? ""]));
  return { deployment, signers: loadSigners(process.env, "FINAL", { scrub: true }), childKeyEnv };
}

export interface StackOptions {
  readonly label: string;
  /** Required: the existing cases run MY whatever the API's default HOGEE_COUNTRY becomes. */
  readonly country: DemoCountryCode;
  /** Sepolia: one facility per deployment, so the ids come from the env (as for the API) or the demo defaults. */
  readonly facilityId?: string;
  readonly founderId?: string;
  /** The WEB world: the web search port (recorded, recording every query) and its checks (real sanctions screening). */
  readonly webSearch?: WebSearchPort;
  readonly checks?: ChecksPort;
}

export async function newStack(infra: Infra, o: StackOptions): Promise<Stack> {
  const country = demoCountry(o.country);
  const { deployment, signers, childKeyEnv } = infra.cfg.target === "anvil" ? await anvilChain(infra, o.label, country) : sepoliaChain(infra);
  const chainId = await infra.client.getChainId();
  if (chainId !== deployment.chainId) throw new Error(`the RPC serves chain ${chainId}, the manifest is for chain ${deployment.chainId}`);
  if (infra.cfg.target === "sepolia") await gasPreflight(infra.client, signers);
  await publishRoles(infra.db.$client, deployment, signers);
  const founderWalletKey = generatePrivateKey();
  const founderWallet = privateKeyToAccount(founderWalletKey);
  const auth = new SoftAuthenticator();
  const first = scriptedAgent();
  const memoryKey = first.memoryKey;
  const flags: RuntimeFlags = { demoMode: true, cookieSecret: randomSecret(), officerToken: randomSecret(), stripeWebhookSecret: randomSecret() };
  const jobs: { job: ApiJob; data: unknown }[] = [];
  const facilityId = o.facilityId ?? `fac-${o.label.slice(0, 6)}-${randomUUID().slice(0, 6)}`;
  const founderId = o.founderId ?? `founder-${randomUUID().slice(0, 8)}`;
  const apiLog = infra.log.child({ svc: "api", world: o.label });
  const xendit = infra.cfg.target === "sepolia" && process.env.PAYOUT_RAIL?.trim() === "xendit";
  const xenditKey = xendit ? process.env[XENDIT_SECRET_KEY_ENV]?.trim() : undefined;
  const rail: PayoutRail = xendit ? xenditRailFromEnv(process.env, { scrub: true }) : new MockRail(infra.db.$client);
  const deps: ApiDeps = {
    config: {
      facilityId,
      founderId,
      countryCode: country.countryCode,
      currency: country.currency,
      chain: infra.cfg.target === "anvil" ? "local" : "sepolia",
      webauthn: { rpId: "localhost", rpName: "Hogee", origins: ["http://localhost:3000"] },
      founderWallet: founderWallet.address.toLowerCase() as Address,
      presidioUrl: null,
      payoutRail: { kind: rail.name === "xendit" ? "xendit" : "mock", configured: true },
    },
    flags: () => flags,
    db: infra.db,
    client: infra.client,
    deployment,
    queue: { send: async (job, data) => void jobs.push({ job, data }) },
    clock: () => Date.now(),
    // The mock packs and suppliers (test/support/catalog.ts); the payee registry is the world's country's.
    catalog: { ...testCatalog, payees: async () => country.payees },
    checks: o.checks ?? testChecks,
    ...(o.webSearch ? { webSearch: o.webSearch } : {}),
    agent: first,
    stripe: null,
    log: { info: (e, f) => apiLog.info(e, f as never), warn: (e, f) => apiLog.warn(e, f as never), error: (e, f) => apiLog.error(e, f as never) },
  };
  const app = createApiApp(async () => deps);
  const cookie = (p: PersonaId) =>
    `${PERSONA_COOKIE}=${signPersonaCookie(p, { secret: flags.cookieSecret as string, officerToken: flags.officerToken, now: Date.now() })}`;
  const workerLog = infra.log.child({ svc: "worker", world: o.label });
  const maxFeeWei = (infra.cfg.target === "anvil" ? 1_000n : BigInt(process.env.REDTEAM_MAX_FEE_GWEI?.trim() || "50")) * 1_000_000_000n;
  const workerDeps = (over: Partial<JobDeps> = {}): JobDeps => ({
    db: infra.db,
    client: infra.client,
    signers,
    deployment: { ...deployment, contracts: { ...deployment.contracts } },
    config: { maxFeeWei, lowBalanceWei: parseEther("0.05"), stuckPendingPasses: 3, payoutMaxAttempts: 3 },
    log: workerLog,
    rail,
    ...over,
  });
  const ids = [facilityId];
  const pump = async (): Promise<void> => {
    for (let round = 0; round < 16; round += 1) {
      const d = workerDeps();
      await runTimelockExecutor(d, ids);
      await runStageGate(d, ids);
      const sent = [...(await runRelay(d, ids)), ...(await runRelay(d, ids, { oracle: true }))].flatMap((r) => r.actions).filter((a) => a.result === "sent");
      if (infra.cfg.target === "sepolia") await waitForSent(infra.client, sent.map((a) => a.detail));
      await runReconcile(d, ids);
      if (sent.length === 0) {
        await runRelay(d, ids);
        return;
      }
    }
    throw new Error("pump did not settle in 16 rounds");
  };
  const agentRound = async (): Promise<void> => {
    const d = workerDeps();
    const reports = await runAgentActions(d, ids);
    if (infra.cfg.target === "sepolia") await waitForSent(infra.client, reports.flatMap((r) => r.actions).map((a) => (a as { txHash?: string }).txHash));
    await runTick(d, facilityId);
    await pump();
  };
  const settleRound = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) {
      await infra.clock.finalize();
      await pump();
      const [r] = await runSettle(workerDeps(), ids);
      await pump();
      if ((r?.payments ?? []).length === 0) return;
    }
  };
  return {
    label: o.label,
    country,
    infra,
    db: infra.db,
    client: infra.client,
    clock: infra.clock,
    deployment,
    signers,
    founderWallet,
    auth,
    get agent(): ScriptedAgent {
      return deps.agent as ScriptedAgent;
    },
    resetAgent() {
      (deps as unknown as { agent: ScriptedAgent }).agent = { ...scriptedAgent(), memoryKey } as ScriptedAgent;
    },
    flags,
    deps,
    app,
    facilityId,
    founderId,
    founder: persona(app, cookie(country.persona)),
    officer: persona(app, cookie("officer")),
    anon: persona(app, ""),
    jobs,
    rail,
    childKeyEnv,
    loadedSecrets: xenditKey ? [xenditKey] : [],
    generatedSecrets: founderSecrets(founderWalletKey, auth),
    workerDeps,
    cookie,
    pump,
    agentRound,
    settleRound,
  };
}

/** Sepolia only: the relay broadcasts without waiting; wait for each receipt so the next job sees the effect. */
async function waitForSent(client: HogeePublicClient, hashes: readonly (string | undefined)[]): Promise<void> {
  for (const h of hashes) if (h && /^0x[0-9a-fA-F]{64}$/.test(h)) await client.waitForTransactionReceipt({ hash: h as `0x${string}`, timeout: 300_000 });
}

export function jsonLogger(sink: (line: string) => void): Logger {
  return createLogger({ sink, base: { svc: "redteam" } });
}
