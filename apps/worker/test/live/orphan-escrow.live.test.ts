/**
 * T29 on final-1 (Anvil + Postgres): the worker never calls MilestoneEscrow.fundMilestone, so a MilestoneFunded from
 * the agent key is key use outside the backend. Reconcile must read the escrow's finalized logs on their own cursor,
 * halt (ORPHAN_SPEND) and pause the treasury, as it does for an orphan Treasury `Spent` (the control case here).
 */
import {
  buildBindPayee,
  buildFundMilestone,
  decisionIdToBytes32,
  hogeeDomain,
  hogeeTypedData,
  iTreasuryAbi,
  LINE_SUPPLIER,
  scheduleHash,
  toBytes32Tag,
  type SupplierApprovalMessage,
} from '@hogee/chain';
import { keccak256Utf8 } from '@hogee/core';
import { createWalletClient, getAddress, http, type Hex } from 'viem';
import { anvil } from 'viem/chains';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { anvilAccount } from '../../src/harness/deploy';
import { runReconcile } from '../../src/jobs/reconcile';
import { uuidv7 } from '../../src/runtime/ids';
import { silentLogger } from '../../src/runtime/log';
import { activeHalt, clearHalt, haltReasons } from '../../src/store/halt';
import {
  DAY,
  finalizeAll,
  leakedSpend,
  LIVE,
  LIVE_TIMEOUT_MS,
  newWorld,
  openLive,
  primeAgentNonce,
  RPC_URL,
  treasuryPaused,
  warp,
  type Live,
  type World,
} from '../support/live';

const SCHEDULE = [30_000n, 120_000n] as const;
const AUTO_RELEASE = [false, false] as const;

/** The founder signs a SupplierApproval for a two-milestone order on SUPPLIER; anyone submits bindPayee. */
async function bindSupplierOrder(w: World): Promise<Hex> {
  const treasury = w.deployment.contracts.Treasury.address;
  const now = (await w.live.client.getBlock({ blockTag: 'latest' })).timestamp;
  const orderId = keccak256Utf8(`order/${w.facilityId}`) as Hex;
  const approval: SupplierApprovalMessage = {
    orderId,
    supplierId: toBytes32Tag('supplier-a'),
    payee: toBytes32Tag('supplier-a'),
    payoutAccountHash: keccak256Utf8('supplier-a/account') as Hex,
    lineId: LINE_SUPPLIER,
    scheduleHash: scheduleHash([...SCHEDULE], [...AUTO_RELEASE]),
    totalMinor: SCHEDULE[0] + SCHEDULE[1],
    quoteHash: keccak256Utf8('quote') as Hex,
    shortlistHash: keccak256Utf8('shortlist') as Hex,
    chosenIndex: 0,
    inspectionRequired: false,
    deploymentId: toBytes32Tag(w.deployment.deploymentId),
    nonce: 77n,
    expiry: now + DAY,
  };
  const domain = hogeeDomain({ verifyingContract: treasury, chainTag: toBytes32Tag(w.deployment.chainTag), deploymentId: toBytes32Tag(w.deployment.deploymentId) });
  const founder = await anvilAccount(1).signTypedData(hogeeTypedData('SupplierApproval', domain, approval) as never);
  const call = buildBindPayee({ approval, schedule: [...SCHEDULE], autoRelease: [...AUTO_RELEASE], founder: { kind: 0, data: founder } });
  const anyone = createWalletClient({ account: anvilAccount(2), chain: anvil, transport: http(RPC_URL) });
  const receipt = await w.live.client.waitForTransactionReceipt({ hash: await anyone.sendTransaction({ to: treasury, data: call.data }) });
  if (receipt.status !== 'success') throw new Error('bindPayee reverted');
  await warp(w.live, 121n); // past the payee's cooling window (COOLING_SECONDS 120 on Anvil)
  return orderId;
}

/** The leaked agent key funds milestone 0 directly (the worker never signs fundMilestone). */
async function leakedFunding(w: World, orderId: Hex): Promise<Hex> {
  const escrow = w.deployment.contracts.MilestoneEscrow?.address;
  if (!escrow) throw new Error('not a final-1 deployment');
  const call = buildFundMilestone({ orderId, idx: 0, amountMinor: 10_000n, decisionId: decisionIdToBytes32(uuidv7()), rationaleHash: keccak256Utf8('leaked funding') as Hex });
  const wallet = createWalletClient({ account: w.signers.agent, chain: anvil, transport: http(RPC_URL) });
  const hash = await wallet.sendTransaction({ to: escrow, data: call.data });
  const receipt = await w.live.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('the leaked fundMilestone reverted');
  return hash;
}

async function reasonsOfActiveHalt(live: Live): Promise<string[]> {
  const halt = await activeHalt(live.db.$client);
  return halt ? (await haltReasons(live.db.$client, halt.id)).map((r) => r.reason) : [];
}

describe.skipIf(!LIVE)('reconcile: escrow orphans on final-1 (Anvil + Postgres)', { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  beforeAll(async () => {
    live = await openLive();
  }, LIVE_TIMEOUT_MS);
  afterEach(async () => {
    await clearHalt(live.db.$client, silentLogger, { by: 'test-teardown', note: 'next test', ackThrough: 'all', abandonPause: true });
  });
  afterAll(async () => {
    await live?.close();
  });

  it('an agent-key fundMilestone outside the backend halts and pauses the treasury', async () => {
    const w = await newWorld(live, { final: true });
    expect(w.deployment.contracts.MilestoneEscrow).toBeDefined();
    await primeAgentNonce(w);
    const orderId = await bindSupplierOrder(w);
    const hash = await leakedFunding(w, orderId);
    await finalizeAll(live);
    const pass = await runReconcile(w.deps(), [w.facilityId]);
    expect(pass.orphanWatchError).toBeUndefined();
    expect(pass.orphans).toEqual([expect.objectContaining({ event: 'MilestoneFunded', reason: 'NO_ROW', txHash: hash, orderId, idx: 0, amountMinor: 10_000n })]);
    // The agent key has a nonces row: its leaked use is found by the nonce check first, then the orphan at finalized.
    expect(await reasonsOfActiveHalt(live)).toEqual(['EXTERNAL_AGENT_KEY_USE', 'ORPHAN_SPEND']);
    expect(await treasuryPaused(w)).toBe(true);
    // The escrow has its own finalized cursor, advanced with the halt: the same orphan is not reported twice.
    const cursor = await live.db.$client.query<{ last_block: string }>('select last_block::text as last_block from log_checkpoints where contract = $1', [
      getAddress(w.deployment.contracts.MilestoneEscrow?.address as Hex).toLowerCase(),
    ]);
    expect(BigInt(cursor.rows[0]?.last_block ?? '0')).toBeGreaterThan(BigInt(w.deployment.blockNumber));
    expect((await runReconcile(w.deps(), [w.facilityId])).orphans).toEqual([]);
    // Every facility of the deployment carries the alert.
    const traces = await live.db.$client.query<{ n: number }>(`select count(*)::int as n from traces where facility_id = $1 and reason_code = 'ORPHAN_SPEND'`, [w.facilityId]);
    expect(traces.rows[0]?.n).toBe(1);
  });

  it('control: a direct Treasury.spend on final-1 is still an orphan (both contracts are watched)', async () => {
    const w = await newWorld(live, { final: true });
    await primeAgentNonce(w);
    const hash = await leakedSpend(w, 2n);
    await finalizeAll(live);
    const pass = await runReconcile(w.deps(), [w.facilityId]);
    expect(pass.orphans).toEqual([expect.objectContaining({ event: 'Spent', reason: 'NO_ROW', txHash: hash })]);
    expect(await reasonsOfActiveHalt(live)).toEqual(['EXTERNAL_AGENT_KEY_USE', 'ORPHAN_SPEND']);
    expect(await treasuryPaused(w)).toBe(true);
    expect(await live.client.readContract({ address: w.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: 'paused' })).toBe(true);
  });
});
