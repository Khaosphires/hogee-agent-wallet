/**
 * Live infrastructure for the API tests: Anvil (TEST_RPC_URL) + a throwaway Postgres 16 (TEST_DATABASE_URL), both
 * started by the developer (see packages/api/README.md). Each world deploys a fresh final-1 set with
 * contracts/script/DeployFinal.s.sol (the deployer is an Anvil default account broadcasting with --unlocked, so no key
 * reaches forge) and generates fresh role keys at runtime. The same session advisory lock as apps/worker's live tests
 * keeps files that share the database and the Anvil clock from running at the same time.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createDb, type Db } from "@hogee/db";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createTestClient, http, parseEther, type Address } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { anvil } from "viem/chains";
import { migrateWorkerSchema } from "@hogee/worker";
import { createHogeePublicClient, type HogeePublicClient } from "../../src/chain-lib";
import { parseDeploymentJson, type Deployment } from "../../src/deployment";
import { platformPayeeDeployArgs } from "../../src/catalog/payees";

const run = promisify(execFile);

export const DB_URL = process.env.TEST_DATABASE_URL;
export const RPC_URL = process.env.TEST_RPC_URL;
export const LIVE = Boolean(DB_URL && RPC_URL);
export const LIVE_TIMEOUT_MS = 300_000;
/** Same key as apps/worker's and packages/chain's live tests (shared DB tables, shared Anvil clock). */
const LIVE_LOCK_KEY = 0x4e0_1e05;
export const DAY = 86_400n;
const migrationsFolder = fileURLToPath(new URL("../../../db/drizzle/", import.meta.url));
const CONTRACTS_DIR = fileURLToPath(new URL("../../../../contracts/", import.meta.url));

/** Anvil's public test mnemonic: its default accounts only ever hold Anvil ETH. */
export const anvilAccount = (index: number) => mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: index });

export interface Live {
  readonly db: Db;
  readonly client: HogeePublicClient;
  readonly test: ReturnType<typeof createTestClient>;
  close(): Promise<void>;
}

export async function openLive(): Promise<Live> {
  if (!DB_URL || !RPC_URL) throw new Error("TEST_DATABASE_URL and TEST_RPC_URL are required");
  const db = createDb(DB_URL, { maxConnections: 16 });
  db.$client.on("error", () => undefined);
  const lock = await db.$client.connect();
  await lock.query("select pg_advisory_lock($1)", [LIVE_LOCK_KEY]);
  await migrate(db as unknown as Parameters<typeof migrate>[0], { migrationsFolder });
  await migrateWorkerSchema(db.$client);
  await db.$client.query(`update hogee_worker.halts set cleared_at = now(), cleared_by = 'test-setup' where cleared_at is null`);
  const client = createHogeePublicClient({ chain: "local", rpcUrls: [RPC_URL], pollingIntervalMs: 50 });
  const test = createTestClient({ mode: "anvil", chain: anvil, transport: http(RPC_URL) });
  await test.setAutomine(true);
  return {
    db,
    client,
    test,
    async close() {
      await test.setAutomine(true);
      await lock.query("select pg_advisory_unlock($1)", [LIVE_LOCK_KEY]);
      lock.release();
      await db.$client.end();
    },
  };
}

export interface DeployFinalOptions {
  readonly lender: Address;
  readonly oracle: Address;
  readonly judgingWindowEnd: bigint;
  readonly coolingSeconds?: number;
  readonly timelockSeconds?: number;
}

/** contracts/script/DeployFinal.s.sol on Anvil; returns the printed manifest. The child gets a minimal env. */
export async function deployFinal(o: DeployFinalOptions): Promise<Deployment> {
  const payees = platformPayeeDeployArgs();
  const env: Record<string, string> = {
    PATH: `${homedir()}/.foundry/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
    HOME: homedir(),
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    DEPLOYMENT_ID: `final-${randomUUID().slice(0, 8)}`,
    CHAIN_TAG: "anvil",
    LENDER_ADDRESS: o.lender,
    ORACLE_ADDRESS: o.oracle,
    JUDGING_WINDOW_END: o.judgingWindowEnd.toString(),
    COOLING_SECONDS: String(o.coolingSeconds ?? 120),
    LOOSEN_TIMELOCK_SECONDS: String(o.timelockSeconds ?? 120),
    PLATFORM_PAYEE_IDS: payees.ids,
    PLATFORM_PAYOUT_HASHES: payees.hashes,
  };
  const { stdout } = await run(
    "forge",
    ["script", "script/DeployFinal.s.sol:DeployFinal", "--rpc-url", RPC_URL as string, "--broadcast", "--unlocked", "--sender", anvilAccount(0).address],
    { cwd: CONTRACTS_DIR, env, maxBuffer: 16 * 1024 * 1024 },
  );
  const start = stdout.indexOf("BEGIN DEPLOYMENT JSON");
  const end = stdout.indexOf("END DEPLOYMENT JSON");
  if (start < 0 || end < start) throw new Error("DeployFinal printed no manifest");
  return parseDeploymentJson(JSON.parse(stdout.slice(start + "BEGIN DEPLOYMENT JSON".length, end).trim()) as unknown);
}

export async function fund(live: Live, addresses: readonly Address[]): Promise<void> {
  for (const address of addresses) await live.test.setBalance({ address, value: parseEther("10") });
}

/** Moves the chain clock and mines one block. */
export async function warp(live: Live, seconds: bigint): Promise<void> {
  await live.test.increaseTime({ seconds: Number(seconds) });
  await live.test.mine({ blocks: 1 });
}

/** Anvil's `finalized` is latest − 64: mine past it so every earlier block is final. */
export async function finalizeAll(live: Live): Promise<void> {
  await live.test.mine({ blocks: 70 });
}
