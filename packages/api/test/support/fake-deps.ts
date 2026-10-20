/**
 * Deps for tests that need no database or chain: every port that is touched without being faked throws, so a test
 * shows exactly which routes need real infrastructure. Secrets are generated per run (never committed).
 */
import { randomBytes } from "node:crypto";
import { PERSONA_COOKIE } from "@hogee/core";
import type { Db } from "@hogee/db";
import type { ApiDeps, ApiJob, RuntimeFlags } from "../../src/context";
import type { HogeePublicClient } from "../../src/chain-lib";
import { parseDeploymentJson, type Deployment } from "../../src/deployment";
import { signPersonaCookie } from "../../src/persona-cookie";

export const randomSecret = (): string => randomBytes(32).toString("base64url");

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

export const FAKE_DEPLOYMENT: Deployment = parseDeploymentJson({
  chainId: 31337,
  deploymentId: "final-1",
  chainTag: "anvil",
  contracts: {
    PlanRegistry: { address: addr(0xa1) },
    Treasury: { address: addr(0xa2) },
    MilestoneEscrow: { address: addr(0xa3) },
    SalesOracle: { address: addr(0xa4) },
  },
  blockNumber: 1,
  deployedAt: "2026-10-16T00:00:00Z",
});

function unavailable<T extends object>(what: string): T {
  return new Proxy({} as T, {
    get(_t, prop) {
      if (prop === "then") return undefined;
      throw new Error(`${what}.${String(prop)} is not available in this test`);
    },
  });
}

export interface FakeOptions {
  readonly flags?: Partial<RuntimeFlags>;
  readonly deps?: Partial<ApiDeps>;
}

export interface Fake {
  readonly deps: ApiDeps;
  readonly flags: RuntimeFlags;
  readonly jobs: { job: ApiJob; data: unknown }[];
  readonly logs: { level: string; event: string; fields: unknown }[];
  cookie(persona: "founder:rina" | "officer"): string;
}

export function fakeDeps(opts: FakeOptions = {}): Fake {
  const flags: RuntimeFlags = { demoMode: true, cookieSecret: randomSecret(), officerToken: randomSecret(), stripeWebhookSecret: randomSecret(), ...opts.flags };
  const jobs: { job: ApiJob; data: unknown }[] = [];
  const logs: { level: string; event: string; fields: unknown }[] = [];
  const log = (level: string) => (event: string, fields?: unknown) => logs.push({ level, event, fields });
  const deps: ApiDeps = {
    config: {
      facilityId: "fac-rina",
      founderId: "founder-rina",
      countryCode: "MY",
      currency: "MYR",
      chain: "local",
      webauthn: { rpId: "localhost", rpName: "Hogee", origins: ["http://localhost:3000"] },
      founderWallet: null,
      presidioUrl: null,
      payoutRail: { kind: "mock", configured: true },
    },
    flags: () => flags,
    db: unavailable<Db>("db"),
    client: unavailable<HogeePublicClient>("client"),
    deployment: FAKE_DEPLOYMENT,
    queue: { send: async (job, data) => void jobs.push({ job, data }) },
    clock: () => Date.now(),
    catalog: unavailable("catalog"),
    checks: unavailable("checks"),
    agent: unavailable("agent"),
    stripe: null,
    log: { info: log("info"), warn: log("warn"), error: log("error") },
    ...opts.deps,
  };
  return {
    deps,
    flags,
    jobs,
    logs,
    cookie: (persona) =>
      `${PERSONA_COOKIE}=${signPersonaCookie(persona, { secret: flags.cookieSecret as string, officerToken: flags.officerToken, now: Date.now() })}`,
  };
}

/**
 * A database that knows one opened facility (or none) and accepts any other statement (trace appends, the LLM call
 * log) with no rows: enough for routes that only check the facility and then write traces.
 */
export function facilityOnlyDb(opened = true): Db {
  const query = async (sql: string) => ({ rows: opened && /from facilities/.test(sql) ? [{ facility_id: "fac-rina", currency: "MYR" }] : [], rowCount: 1 });
  return { $client: { query, connect: async () => ({ query, release: () => undefined }) } } as unknown as Db;
}
