/**
 * One API world: a fresh final-1 deployment, fresh role keys (the WORKER's; the API never sees them), a facility and
 * founder id of its own, the live app wired to the test Postgres and Anvil, and the worker's job functions run
 * in-process by `pump()` (the worker is still the only signer). Jobs the API sends are recorded.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { PERSONA_COOKIE } from "@hogee/core";
import { MockRail, publishRoles, runReconcile, runRelay, runStageGate, runTimelockExecutor, silentLogger, type JobDeps, type WorkerSigners } from "@hogee/worker";
import { parseEther, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Hono } from "hono";
import { createApiApp } from "../../src/app";
import type { AgentPort, ApiDeps, ApiJob, RuntimeFlags, StripePort } from "../../src/context";
import type { Deployment } from "../../src/deployment";
import type { RouteGroup } from "../../src/http/register";
import { signPersonaCookie } from "../../src/persona-cookie";
import { ModelBudget } from "../../src/services/model-budget";
import { testCatalog, testChecks } from "./catalog";
import { DAY, deployFinal, fund, type Live } from "./live";
import { randomSecret } from "./fake-deps";
import { regexRedactor } from "./agent";

export interface WorldOptions {
  readonly flags?: Partial<RuntimeFlags>;
  readonly agent?: AgentPort;
  readonly stripe?: StripePort | null;
  readonly coolingSeconds?: number;
  /** Route handlers that replace the default groups' (a group not yet wired in routes/index.ts). */
  readonly routes?: RouteGroup;
  /** evidence/ for the evidence routes (task 1.16); unset: none configured. */
  readonly evidenceDir?: string;
}

export interface Persona {
  get(path: string): Promise<Response>;
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
}

export interface World {
  readonly live: Live;
  readonly deployment: Deployment;
  readonly signers: WorkerSigners;
  /** The founder's backup owner EOA (an ECDSA test account generated at runtime). */
  readonly founderWallet: PrivateKeyAccount;
  readonly deps: ApiDeps;
  readonly app: Hono;
  readonly flags: RuntimeFlags;
  readonly jobs: { job: ApiJob; data: unknown }[];
  readonly facilityId: string;
  readonly founderId: string;
  readonly founder: Persona;
  readonly officer: Persona;
  readonly anon: Persona;
  workerDeps(over?: Partial<JobDeps>): JobDeps;
  cookie(persona: "founder:rina" | "officer"): string;
  /** Runs the worker's queues in-process until nothing new is signed (Anvil automines each broadcast). */
  pump(): Promise<void>;
}

const unconfiguredAgent: AgentPort = {
  configured: false,
  memoryKey: null,
  redactor: regexRedactor,
  budget: new ModelBudget(),
  models: () => {
    throw new Error("no model in this world");
  },
};

function persona(app: Hono, cookie: string): Persona {
  const headers = (extra: Record<string, string> = {}) => ({ ...(cookie ? { cookie } : {}), ...extra });
  return {
    get: async (path) => app.request(path, { headers: headers() }),
    post: async (path, body, extra = {}) =>
      app.request(path, { method: "POST", headers: headers({ "content-type": "application/json", ...extra }), body: body === undefined ? "{}" : JSON.stringify(body) }),
  };
}

export async function newWorld(live: Live, opts: WorldOptions = {}): Promise<World> {
  const key = () => privateKeyToAccount(generatePrivateKey());
  const signers: WorkerSigners = { set: "FINAL", agent: key(), oracle: key(), lender: key(), relayer: key() };
  const founderWallet = key();
  await fund(live, [signers.agent.address, signers.oracle.address, signers.lender.address, signers.relayer.address]);
  const now = (await live.client.getBlock({ blockTag: "latest" })).timestamp;
  const deployment = await deployFinal({
    lender: signers.lender.address,
    oracle: signers.oracle.address,
    judgingWindowEnd: now + 30n * DAY,
    ...(opts.coolingSeconds ? { coolingSeconds: opts.coolingSeconds } : {}),
  });
  await publishRoles(live.db.$client, deployment, signers);
  const flags: RuntimeFlags = { demoMode: true, cookieSecret: randomSecret(), officerToken: randomSecret(), stripeWebhookSecret: randomSecret(), ...opts.flags };
  const jobs: { job: ApiJob; data: unknown }[] = [];
  const facilityId = `fac-${randomUUID().slice(0, 8)}`;
  const founderId = `founder-${randomUUID().slice(0, 8)}`;
  const deps: ApiDeps = {
    config: {
      facilityId,
      founderId,
      countryCode: "MY",
      currency: "MYR",
      chain: "local",
      webauthn: { rpId: "localhost", rpName: "Hogee", origins: ["http://localhost:3000"] },
      founderWallet: founderWallet.address.toLowerCase() as Address,
      presidioUrl: null,
      payoutRail: { kind: "mock", configured: true },
      ...(opts.evidenceDir ? { evidenceDir: opts.evidenceDir } : {}),
    },
    flags: () => flags,
    db: live.db,
    client: live.client,
    deployment,
    queue: { send: async (job, data) => void jobs.push({ job, data }) },
    clock: () => Date.now(),
    catalog: testCatalog,
    checks: testChecks,
    agent: opts.agent ?? { ...unconfiguredAgent, memoryKey: randomBytes(32) },
    stripe: opts.stripe ?? null,
    // API_TEST_LOG=1 prints handler errors while debugging a live test.
    log: process.env.API_TEST_LOG
      ? { info: () => undefined, warn: (e, f) => console.warn(e, f), error: (e, f) => console.error(e, f) }
      : { info: () => undefined, warn: () => undefined, error: () => undefined },
  };
  const app = createApiApp(async () => deps, opts.routes ?? {});
  const cookie = (p: "founder:rina" | "officer") =>
    `${PERSONA_COOKIE}=${signPersonaCookie(p, { secret: flags.cookieSecret as string, officerToken: flags.officerToken, now: Date.now() })}`;
  const workerDeps = (over: Partial<JobDeps> = {}): JobDeps => ({
    db: live.db,
    client: live.client,
    signers,
    deployment: { ...deployment, contracts: { ...deployment.contracts } },
    config: { maxFeeWei: 1_000n * 1_000_000_000n, lowBalanceWei: parseEther("0.05"), stuckPendingPasses: 3, payoutMaxAttempts: 3 },
    log: silentLogger,
    rail: new MockRail(live.db.$client),
    ...over,
  });
  const pump = async (): Promise<void> => {
    for (let round = 0; round < 12; round += 1) {
      const d = workerDeps();
      await runTimelockExecutor(d, [facilityId]);
      await runStageGate(d, [facilityId]);
      const sent = [...(await runRelay(d, [facilityId])), ...(await runRelay(d, [facilityId], { oracle: true }))].flatMap((r) => r.actions).filter((a) => a.result === "sent");
      await runReconcile(d, [facilityId]);
      if (sent.length === 0) {
        await runRelay(d, [facilityId]); // final sync with every landed tx recorded
        return;
      }
    }
    throw new Error("pump did not settle in 12 rounds");
  };
  return {
    live,
    deployment,
    signers,
    founderWallet,
    deps,
    app,
    flags,
    jobs,
    facilityId,
    founderId,
    founder: persona(app, cookie("founder:rina")),
    officer: persona(app, cookie("officer")),
    anon: persona(app, ""),
    cookie,
    workerDeps,
    pump,
  };
}
