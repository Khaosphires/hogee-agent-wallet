/**
 * Live worlds for the worker tests: Anvil (TEST_RPC_URL) + a throwaway Postgres 16 (TEST_DATABASE_URL). Each world
 * deploys a fresh loop-1 set with contracts/script/DeployLoop.s.sol, generates fresh role keys at runtime (set into
 * process.env and read back through the worker's own key loader), and sets up Rina's facility through the outbox.
 *
 *   anvil --port 18547 --silent &
 *   TEST_DATABASE_URL=postgres://hogee_test@127.0.0.1:55434/hogee_worker_test TEST_RPC_URL=http://127.0.0.1:18547 \
 *     pnpm --filter @hogee/worker test:live
 */
import { randomUUID } from 'node:crypto';
import {
  buildSpend,
  createHogeePublicClient,
  decisionIdToBytes32,
  iTreasuryAbi,
  sequenceInvoiceHash,
  shortIdToBytes32,
  toBytes32Tag,
  type DeploymentManifest,
  type HogeePublicClient,
} from '@hogee/chain';
import { keccak256Utf8 } from '@hogee/core';
import { createDb, type Db } from '@hogee/db';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { createTestClient, createWalletClient, getAbiItem, http, parseEther, type Address, type Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { anvil } from 'viem/chains';
import { keyEnvName, loadSigners, SIGNER_ROLES, type WorkerSigners } from '../../src/config/keys';
import { anvilAccount, deployFinal, deployLoop } from '../../src/harness/deploy';
import { platformPayeeHashes, platformPayees, setupRina, type RinaManifestInput } from '../../src/harness/rina';
import type { PayoutDestination } from '../../src/rail/rail';
import type { JobDeps } from '../../src/jobs/deps';
import { runReconcile } from '../../src/jobs/reconcile';
import { runTick } from '../../src/jobs/tick';
import { uuidv7 } from '../../src/runtime/ids';
import { silentLogger, type Logger } from '../../src/runtime/log';
import { activeHalt, haltReasons } from '../../src/store/halt';
import { migrateWorkerSchema } from '../../src/store/schema';
import type { PlanManifest } from '@hogee/core';

export const DB_URL = process.env.TEST_DATABASE_URL;
export const RPC_URL = process.env.TEST_RPC_URL;
export const LIVE = Boolean(DB_URL && RPC_URL);
/** Same key as packages/chain's live tests: files that share one Anvil (and warp its clock) run one at a time. */
const LIVE_LOCK_KEY = 0x4e0_1e05;
export const LIVE_TIMEOUT_MS = 240_000;
/** 1,000 gwei: far above Anvil's fees, so only the fee-cap test hits a cap. */
export const CAP_WEI = 1_000n * 1_000_000_000n;
export const DAY = 86_400n;
const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/drizzle/', import.meta.url));

export interface Live {
  readonly db: Db;
  readonly client: HogeePublicClient;
  readonly test: ReturnType<typeof createTestClient>;
  close(): Promise<void>;
}

export async function openLive(): Promise<Live> {
  if (!DB_URL || !RPC_URL) throw new Error('TEST_DATABASE_URL and TEST_RPC_URL are required');
  const db = createDb(DB_URL, { maxConnections: 12 });
  db.$client.on('error', () => undefined);
  const lock = await db.$client.connect();
  await lock.query('select pg_advisory_lock($1)', [LIVE_LOCK_KEY]);
  await migrate(db as unknown as Parameters<typeof migrate>[0], { migrationsFolder });
  await migrateWorkerSchema(db.$client);
  await db.$client.query(`update hogee_worker.halts set cleared_at = now(), cleared_by = 'test-setup' where cleared_at is null`);
  const client = createHogeePublicClient({ chain: 'local', rpcUrls: [RPC_URL], pollingIntervalMs: 50 });
  const test = createTestClient({ mode: 'anvil', chain: anvil, transport: http(RPC_URL) });
  await test.setAutomine(true);
  return {
    db,
    client,
    test,
    async close() {
      await test.setAutomine(true);
      await lock.query('select pg_advisory_unlock($1)', [LIVE_LOCK_KEY]);
      lock.release();
      await db.$client.end();
    },
  };
}

/** Runtime-generated role keys (never written anywhere but this process's env and a child's env). */
export type RoleKeys = Record<string, Hex>;

export interface World {
  readonly live: Live;
  readonly keys: RoleKeys;
  readonly signers: WorkerSigners;
  readonly deployment: DeploymentManifest;
  readonly facilityId: string;
  readonly manifest: PlanManifest;
  readonly founder: Address;
  deps(over?: Partial<JobDeps>): JobDeps;
}

export interface WorldOptions {
  readonly windowCapMinor?: RinaManifestInput['windowCapMinor'];
  readonly log?: Logger;
  /** Deploy the final-1 set (with MilestoneEscrow and SalesOracle) instead of loop-1. */
  readonly final?: boolean;
  /** Override platform payee payout accounts (settlement tamper tests). */
  readonly accounts?: Readonly<Record<string, PayoutDestination>>;
}

export async function newWorld(live: Live, opts: WorldOptions = {}): Promise<World> {
  const payees = platformPayees(opts.accounts);
  const keys: RoleKeys = Object.fromEntries(SIGNER_ROLES.map((role) => [keyEnvName(role, 'LOOP'), generatePrivateKey()]));
  Object.assign(process.env, keys);
  const signers = loadSigners(process.env, 'LOOP', { scrub: true });
  for (const a of [signers.agent, signers.oracle, signers.lender, signers.relayer]) await live.test.setBalance({ address: a.address, value: parseEther('10') });
  const now = (await live.client.getBlock({ blockTag: 'latest' })).timestamp;
  const deploy = opts.final ? deployFinal : deployLoop;
  const deployment = await deploy({
    // A label per world: facilities name their deployment by label, and every world shares one Anvil.
    deploymentId: `${opts.final ? 'final' : 'loop'}-${randomUUID().slice(0, 8)}`,
    rpcUrl: RPC_URL as string,
    deployer: anvilAccount(0).address,
    lender: signers.lender.address,
    oracle: signers.oracle.address,
    judgingWindowEnd: now + 30n * DAY,
    platformPayees: platformPayeeHashes(payees),
  });
  const founder = anvilAccount(1);
  const facilityId = `fac-${randomUUID().slice(0, 8)}`;
  const setup = await setupRina({
    db: live.db,
    client: live.client,
    deployment,
    signers,
    founder,
    facilityId,
    capWei: CAP_WEI,
    payees,
    ...(opts.windowCapMinor ? { windowCapMinor: opts.windowCapMinor } : {}),
  });
  const log = opts.log ?? silentLogger;
  return {
    live,
    keys,
    signers,
    deployment,
    facilityId,
    manifest: setup.manifest,
    founder: founder.address,
    deps: (over = {}) => ({
      db: live.db,
      client: live.client,
      signers,
      deployment,
      config: { maxFeeWei: CAP_WEI, lowBalanceWei: parseEther('0.05'), stuckPendingPasses: 3, payoutMaxAttempts: 3 },
      log,
      ...over,
    }),
  };
}

/** Waits until every tx a tick broadcast is mined (Anvil's automine mines just after the RPC returns). */
export async function mined(live: Live, report: { lines: readonly { txHash?: Hex }[] }): Promise<void> {
  for (const l of report.lines) if (l.txHash) await live.client.waitForTransactionReceipt({ hash: l.txHash });
}

/** `ops resume` argv acknowledging every reason of the active halt (what an operator does after `ops status`). */
export async function resumeArgs(live: Live, note: string): Promise<string[]> {
  const halt = await activeHalt(live.db.$client);
  const last = halt ? (await haltReasons(live.db.$client, halt.id)).at(-1)?.id : undefined;
  return ['resume', '--note', note, ...(last ? ['--ack-through', last] : [])];
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

const SPENT = getAbiItem({ abi: iTreasuryAbi, name: 'Spent' });
const DENIED = getAbiItem({ abi: iTreasuryAbi, name: 'Denied' });

export async function spentLogs(w: World) {
  return w.live.client.getLogs({ address: w.deployment.contracts.Treasury.address, event: SPENT, fromBlock: BigInt(w.deployment.blockNumber), toBlock: 'latest' });
}

export async function deniedLogs(w: World) {
  return w.live.client.getLogs({ address: w.deployment.contracts.Treasury.address, event: DENIED, fromBlock: BigInt(w.deployment.blockNumber), toBlock: 'latest' });
}

export async function paymentRows(w: World): Promise<{ id: string; state: string; amount_minor: string; tx_hash: string | null; raw_signed_tx: string | null }[]> {
  const r = await w.live.db.$client.query(`select id, state, amount_minor, tx_hash, raw_signed_tx from payments where facility_id = $1 order by created_at, id`, [w.facilityId]);
  return r.rows;
}

export async function denialRows(w: World): Promise<number> {
  const d = await w.live.db.$client.query(`select count(*)::int as n from denials where facility_id = $1`, [w.facilityId]);
  const a = await w.live.db.$client.query(`select count(*)::int as n from chain_actions where facility_id = $1 and kind = 'Treasury.recordDenied'`, [w.facilityId]);
  return Number(d.rows[0].n) + Number(a.rows[0].n);
}

export async function lineSequence(w: World, lineKey: string): Promise<bigint> {
  const { toBytes32Tag } = await import('@hogee/chain');
  return w.live.client.readContract({ address: w.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: 'lineSequence', args: [toBytes32Tag(lineKey)] });
}

/** Treasury.paused() at latest, after one more block (Anvil's automine includes a just-sent tx asynchronously). */
export async function treasuryPaused(w: World): Promise<boolean> {
  await w.live.test.mine({ blocks: 1 });
  return w.live.client.readContract({ address: w.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: 'paused', blockTag: 'latest' });
}

/**
 * The worker signs and lands one agent spend (ADS slot 1) and reconciles it, so the agent key has a `nonces` row: the
 * state in which external use of the key leaves the stored next_nonce behind the chain.
 */
export async function primeAgentNonce(w: World): Promise<void> {
  const tick = await runTick(w.deps(), w.facilityId);
  if (tick.lines[0]?.decision !== 'propose') throw new Error(`priming tick did not propose: ${JSON.stringify(tick.lines[0])}`);
  await mined(w.live, tick);
  await finalizeAll(w.live);
  await runReconcile(w.deps(), [w.facilityId]);
}

/** The leaked agent key spends ADS slot `slot` directly (outside the backend, T29); returns the mined tx hash. */
export async function leakedSpend(w: World, slot: bigint): Promise<Hex> {
  const wallet = createWalletClient({ account: w.signers.agent, chain: anvil, transport: http(RPC_URL) });
  const call = buildSpend({
    lineId: toBytes32Tag('ADS'),
    payeeId: shortIdToBytes32('shopee-ads'),
    amountMinor: 7_500n,
    invoiceHash: sequenceInvoiceHash(slot),
    planVersion: 1,
    decisionId: decisionIdToBytes32(uuidv7()),
    rationaleHash: keccak256Utf8(`leaked key ${slot}`) as Hex,
  });
  const hash = await wallet.sendTransaction({ to: w.deployment.contracts.Treasury.address, data: call.data });
  const receipt = await w.live.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('the leaked spend reverted');
  return hash;
}
