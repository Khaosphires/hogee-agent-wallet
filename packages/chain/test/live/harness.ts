/**
 * Shared setup for the live tests (Anvil + a THROWAWAY Postgres 16). They run only when both
 * TEST_DATABASE_URL and TEST_RPC_URL are set, so plain `pnpm test` skips them.
 *
 *   initdb -D <tmp>/pg -U hogee_test --auth=trust && pg_ctl -D <tmp>/pg -o "-c listen_addresses=127.0.0.1 -p 55432 -c unix_socket_directories=''" start
 *   createdb -h 127.0.0.1 -p 55432 -U hogee_test hogee_chain_test
 *   anvil --port 58545 --silent &
 *   TEST_DATABASE_URL=postgres://hogee_test@127.0.0.1:55432/hogee_chain_test TEST_RPC_URL=http://127.0.0.1:58545 \
 *     pnpm --filter @hogee/chain test:live
 *
 * Migrations from packages/db/drizzle are applied on first use. Every test uses fresh random keys (funded
 * with anvil_setBalance), a fresh MockTreasury and its own facility id, so tests never share a nonce row.
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chainActions, createDb, facilities, payees, payments, type Db } from '@hogee/db';
import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createTestClient, createWalletClient, getAbiItem, http, keccak256, parseEther, toHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import { vi } from 'vitest';
import {
  buildSpend,
  createHogeePublicClient,
  decisionIdToBytes32,
  iTreasuryAbi,
  spendIntentId,
  toBytes32Tag,
  type HogeePublicClient,
  type SignDeployment,
  type SignTarget,
  type TxRequest,
  type TxSigner,
} from '../../src/index';
import { mockTreasuryAbi, mockTreasuryBytecode } from './mock-treasury';

export const DB_URL = process.env.TEST_DATABASE_URL;
export const RPC_URL = process.env.TEST_RPC_URL;
export const LIVE = Boolean(DB_URL && RPC_URL);
export const CHAIN_ID = anvil.id;
/** 1,000 gwei: far above Anvil's estimate, so only the dedicated cap tests hit it. */
export const CAP_WEI = 1_000n * 1_000_000_000n;
export const PLAN_ID: Hex = toBytes32Tag('plan-live-1');
export const ADS = toBytes32Tag('ADS');
export const PAYEE = 'shopee-ads';
export const MOCK_CAP = 1_000_000n;

/** seedFacility's deployment_id; the live facilities all name it. */
export const DEPLOYMENT_ID = 'final-1';
/** Unused PlanRegistry slot of the live deployments (the tests only call the Treasury). */
const NO_REGISTRY: Address = '0x00000000000000000000000000000000000000aa';

/** The deployment (manifest subset) a live facility signs against: `treasury` is its (Mock)Treasury. */
export function deploymentFor(treasury: Address): SignDeployment {
  return { deploymentId: DEPLOYMENT_ID, chainId: CHAIN_ID, contracts: { PlanRegistry: { address: NO_REGISTRY }, Treasury: { address: treasury } } };
}

/** What signAndStore needs to bind a live spend: the facility deployment and the plan id. */
export function bindTo(treasury: Address): { deployment: SignDeployment; planId: Hex } {
  return { deployment: deploymentFor(treasury), planId: PLAN_ID };
}

const SPENT = getAbiItem({ abi: iTreasuryAbi, name: 'Spent' });
const migrationsFolder = fileURLToPath(new URL('../../../db/drizzle/', import.meta.url));

export interface Live {
  readonly db: Db;
  readonly client: HogeePublicClient;
  readonly test: ReturnType<typeof createTestClient>;
  close(): Promise<void>;
}

/** Session advisory lock: live test FILES share one Anvil (and toggle automine), so they run one at a time. */
const LIVE_LOCK_KEY = 0x4e0_1e05;
/** beforeAll may wait for another live file to finish. */
export const LIVE_SETUP_TIMEOUT_MS = 180_000;

export async function setupLive(): Promise<Live> {
  if (!DB_URL || !RPC_URL) throw new Error('TEST_DATABASE_URL and TEST_RPC_URL are required');
  const db = createDb(DB_URL, { maxConnections: 12 });
  const lock = await db.$client.connect();
  await lock.query('select pg_advisory_lock($1)', [LIVE_LOCK_KEY]);
  await migrate(db, { migrationsFolder });
  const client = createHogeePublicClient({ chain: 'local', rpcUrls: [RPC_URL], pollingIntervalMs: 50 });
  const test = createTestClient({ mode: 'anvil', chain: anvil, transport: http(RPC_URL) });
  await test.setAutomine(true);
  const close = async () => {
    await test.setAutomine(true);
    await lock.query('select pg_advisory_unlock($1)', [LIVE_LOCK_KEY]);
    lock.release();
    await db.$client.end();
  };
  return { db, client, test, close };
}

/** A fresh funded key. Ephemeral and local-only: generated per test, never written anywhere. */
export async function freshAccount(live: Live): Promise<{ key: Hex; account: PrivateKeyAccount }> {
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  await live.test.setBalance({ address: account.address, value: parseEther('100') });
  return { key, account };
}

/** Wraps an account so tests can count signatures (recovery must never add one). */
export function spySigner(account: PrivateKeyAccount): TxSigner & { signTransaction: ReturnType<typeof vi.fn> } {
  return { address: account.address, signTransaction: vi.fn((tx) => account.signTransaction(tx)) };
}

/** Deploys a MockTreasury for `agent` from a separate deployer, so the agent's nonce starts at 0. */
export async function deployMock(live: Live, agent: Address, cap: bigint = MOCK_CAP): Promise<{ address: Address; block: bigint }> {
  const { account: deployer } = await freshAccount(live);
  const wallet = createWalletClient({ account: deployer, chain: anvil, transport: http(RPC_URL) });
  const hash = await wallet.deployContract({ abi: mockTreasuryAbi, bytecode: mockTreasuryBytecode, args: [PLAN_ID, agent, cap] });
  const receipt = await live.client.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error('mock deploy failed');
  return { address: receipt.contractAddress, block: receipt.blockNumber };
}

export async function seedFacility(db: Db, facilityId = `fac-${randomUUID()}`): Promise<string> {
  await db.insert(facilities).values({
    facilityId,
    capMinor: '1000000',
    currency: 'MYR',
    reserveFloorBps: 300,
    lenderAddress: `0x${'ab'.repeat(20)}`,
    deploymentId: DEPLOYMENT_ID,
    chainId: CHAIN_ID,
  });
  await db.insert(payees).values({ id: PAYEE, facilityId, kind: 'platform', displayName: 'Shopee Ads', payoutAccountHash: `0x${'a'.repeat(64)}` });
  return facilityId;
}

export interface SpendFixture {
  readonly target: SignTarget;
  readonly intentId: Hex;
  readonly request: TxRequest;
  readonly invoiceHash: Hex;
  readonly amountMinor: bigint;
}

/** Rina's ADS pacing slot (§26.5): 7,500 minor units per day to shopee-ads. */
export const ADS_PACING_MINOR = 7_500n;

/**
 * A POLICY_OK SPEND payment row and the matching Treasury.spend request against `treasury`. `gas` skips
 * eth_estimateGas (for spends that must be mined as reverts).
 */
export async function seedSpend(
  db: Db,
  facilityId: string,
  treasury: Address,
  amountMinor = ADS_PACING_MINOR,
  gas?: bigint,
): Promise<SpendFixture> {
  const id = `pay-${randomUUID()}`;
  const invoiceHash = keccak256(toHex(id));
  const decisionId = randomUUID();
  const rationaleHash = keccak256(toHex(`why ${id}`));
  const payeeId = toBytes32Tag(PAYEE);
  const intentId = spendIntentId({ planId: PLAN_ID, lineId: ADS, payeeId, invoiceHash, amountMinor });
  await db.insert(payments).values({
    id,
    facilityId,
    kind: 'SPEND',
    intentId,
    lineKey: 'ADS',
    lineId: ADS,
    payeeId: PAYEE,
    amountMinor: amountMinor.toString(),
    invoiceHash,
    planVersion: 1,
    state: 'POLICY_OK',
    decisionId,
    rationaleHash,
    traceId: `trace-${id}`,
  });
  const call = buildSpend({ lineId: ADS, payeeId, amountMinor, invoiceHash, planVersion: 1, decisionId: decisionIdToBytes32(decisionId), rationaleHash });
  const request: TxRequest = gas === undefined ? { to: treasury, data: call.data } : { to: treasury, data: call.data, gas };
  return { target: { table: 'payments', facilityId, id }, intentId, request, invoiceHash, amountMinor };
}

export async function seedAction(db: Db, facilityId: string, kind: string, refId?: string): Promise<SignTarget> {
  const id = `act-${randomUUID()}`;
  await db.insert(chainActions).values({ id, facilityId, kind, refId: refId ?? null, state: 'PENDING' });
  return { table: 'chain_actions', facilityId, id };
}

export async function paymentRow(db: Db, t: SignTarget) {
  const rows = await db.select().from(payments).where(and(eq(payments.facilityId, t.facilityId), eq(payments.id, t.id)));
  return rows[0];
}

export async function actionRow(db: Db, t: SignTarget) {
  const rows = await db.select().from(chainActions).where(and(eq(chainActions.facilityId, t.facilityId), eq(chainActions.id, t.id)));
  return rows[0];
}

/** Every Spent log for `spendId` on `treasury` since `fromBlock` (one call: Anvil has no range limit). */
export async function spentLogs(live: Live, treasury: Address, spendId: Hex, fromBlock: bigint) {
  return live.client.getLogs({ address: treasury, event: SPENT, args: { spendId }, fromBlock, toBlock: 'latest' });
}

export async function minedNonce(live: Live, address: Address): Promise<number> {
  return live.client.getTransactionCount({ address, blockTag: 'latest' });
}

/** Anvil's `finalized` tag is latest − 64: mine past it so every earlier block is final. */
export async function finalizeAll(live: Live): Promise<void> {
  await live.test.mine({ blocks: 70 });
}

/** A second live row for the same intent (what a retry after a release would insert). */
export async function insertRetry(db: Db, t: SignTarget, suffix = 'retry'): Promise<void> {
  const row = await paymentRow(db, t);
  if (!row) throw new Error('payment row missing');
  await db.insert(payments).values({
    ...row,
    id: `${t.id}-${suffix}`,
    state: 'POLICY_OK',
    rawSignedTx: null,
    nonce: null,
    signerAddress: null,
    chainId: null,
    txHash: null,
    supersededTxHashes: [],
    nonceConsumedByTxHash: null,
    block: null,
    revertReason: null,
  });
}
