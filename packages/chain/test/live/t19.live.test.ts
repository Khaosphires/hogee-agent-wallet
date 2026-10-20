/**
 * T19 (§13.2): "kill -9 after broadcast, before DB write → one Spent, drift 0, no second tx", plus the
 * G0-AUDIT (v-4) DROPPED / CANCELLED rules (§12.3).
 * Runs on Anvil against MockTreasury (same spend/isIntentUsed/Spent surface as ITreasury) until task 1.4's
 * Treasury lands; the Treasury-based run is the `describe.skip` block at the bottom (task 1.4 is not merged
 * into p1/g1-build yet).
 * Skipped unless TEST_DATABASE_URL and TEST_RPC_URL are set (see harness.ts).
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { keccak256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { advanceFinality, broadcast, feeBump, iTreasuryAbi, recoverOpenIntents, sendStored, signAndStore, type RecoveryOptions } from '../../src/index';
import {
  bindTo,
  CAP_WEI,
  CHAIN_ID,
  DB_URL,
  deployMock,
  deploymentFor,
  finalizeAll,
  freshAccount,
  insertRetry,
  LIVE,
  LIVE_SETUP_TIMEOUT_MS,
  minedNonce,
  paymentRow,
  RPC_URL,
  seedFacility,
  seedSpend,
  setupLive,
  spentLogs,
  spySigner,
  type Live,
  type SpendFixture,
} from './harness';

interface Scenario {
  readonly key: Hex;
  readonly signer: ReturnType<typeof spySigner>;
  readonly treasury: { address: `0x${string}`; block: bigint };
  readonly facility: string;
  readonly spend: SpendFixture;
  readonly opts: RecoveryOptions;
}

describe.skipIf(!LIVE)('T19 crash safety on Anvil (MockTreasury)', { timeout: 90_000 }, () => {
  let live: Live;
  beforeAll(async () => {
    live = await setupLive();
  }, LIVE_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await live?.close();
  });

  async function scenario(): Promise<Scenario> {
    const { key, account } = await freshAccount(live);
    const treasury = await deployMock(live, account.address);
    const facility = await seedFacility(live.db);
    const spend = await seedSpend(live.db, facility, treasury.address);
    return {
      key,
      signer: spySigner(account),
      treasury,
      facility,
      spend,
      opts: { chainId: CHAIN_ID, deployment: deploymentFor(treasury.address), facilityId: facility },
    };
  }

  const store = (s: Scenario) =>
    signAndStore(live.db, { target: s.spend.target, request: s.spend.request, account: s.signer, client: live.client, chainId: CHAIN_ID, capWei: CAP_WEI, ...bindTo(s.treasury.address) });

  /** The T19 pass criterion: one Spent for the intent, the key used exactly once, nothing signed by recovery. */
  async function expectExactlyOnce(s: Scenario, signaturesBefore: number) {
    expect(await spentLogs(live, s.treasury.address, s.spend.intentId, s.treasury.block)).toHaveLength(1);
    expect(await minedNonce(live, s.signer.address)).toBe(1);
    expect(await live.client.readContract({ address: s.treasury.address, abi: iTreasuryAbi, functionName: 'isIntentUsed', args: [s.spend.intentId] })).toBe(true);
    expect(s.signer.signTransaction).toHaveBeenCalledTimes(signaturesBefore);
  }

  it('crash AFTER broadcast, BEFORE the db write: recovery finds the mined tx and sends nothing', async () => {
    const s = await scenario();
    const stored = await store(s);
    await broadcast(live.client, stored.rawTx); // …process dies here: markBroadcast never runs
    expect((await paymentRow(live.db, s.spend.target))?.state).toBe('SIGNED');
    await live.client.waitForTransactionReceipt({ hash: stored.txHash }); // the worker restarts after it was mined

    const outcomes = await recoverOpenIntents(live.db, live.client, s.opts);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ action: 'included', fromState: 'SIGNED', toState: 'INCLUDED', onchainTxHash: stored.txHash });
    expect(await paymentRow(live.db, s.spend.target)).toMatchObject({ state: 'INCLUDED', txHash: stored.txHash, rawSignedTx: stored.rawTx });
    await expectExactlyOnce(s, 1);
    expect(await recoverOpenIntents(live.db, live.client, s.opts)).toEqual([]); // idempotent
  });

  it('crash AFTER commit, BEFORE broadcast: recovery re-sends the SAME bytes (no new signature)', async () => {
    const s = await scenario();
    const stored = await store(s); // …process dies before broadcast
    const first = await recoverOpenIntents(live.db, live.client, s.opts);
    expect(first[0]).toMatchObject({ action: 'rebroadcast', storedTxHash: stored.txHash, toState: 'BROADCAST' });
    const receipt = await live.client.waitForTransactionReceipt({ hash: stored.txHash });
    expect(receipt.transactionHash).toBe(keccak256(stored.rawTx));
    const second = await recoverOpenIntents(live.db, live.client, s.opts);
    expect(second[0]).toMatchObject({ action: 'included', toState: 'INCLUDED' });
    await expectExactlyOnce(s, 1);
  });

  it('crash while the tx is still in the mempool: recovery marks BROADCAST and waits', async () => {
    const s = await scenario();
    await live.test.setAutomine(false);
    try {
      const stored = await store(s);
      await broadcast(live.client, stored.rawTx);
      const pending = await recoverOpenIntents(live.db, live.client, s.opts);
      expect(pending[0]).toMatchObject({ action: 'pending', toState: 'BROADCAST' });
      await live.test.mine({ blocks: 1 });
    } finally {
      await live.test.setAutomine(true);
    }
    const done = await recoverOpenIntents(live.db, live.client, s.opts);
    expect(done[0]).toMatchObject({ action: 'included', fromState: 'BROADCAST', toState: 'INCLUDED' });
    await expectExactlyOnce(s, 1);
  });

  it('a fee-bumped twin was mined instead of the stored bytes: its superseded hash is recorded as landed, no resend', async () => {
    const s = await scenario();
    await live.test.setAutomine(false);
    let original: Hex;
    let bumpedHash: Hex;
    try {
      const stored = await store(s);
      original = stored.txHash;
      await sendStored(live.db, live.client, stored);
      const bumped = await feeBump(live.db, { target: s.spend.target, account: s.signer, client: live.client, capWei: CAP_WEI, chainId: CHAIN_ID, ...bindTo(s.treasury.address) });
      bumpedHash = bumped.txHash;
      expect(bumped.previousTxHash).toBe(original); // the bump is stored but crashes before it is sent
      await live.test.mine({ blocks: 1 }); // the ORIGINAL bytes are mined
    } finally {
      await live.test.setAutomine(true);
    }
    const outcomes = await recoverOpenIntents(live.db, live.client, s.opts);
    expect(outcomes[0]).toMatchObject({ action: 'included', toState: 'INCLUDED', onchainTxHash: original, receiptStatus: 'success' });
    expect(await paymentRow(live.db, s.spend.target)).toMatchObject({ txHash: original, supersededTxHashes: [bumpedHash] });
    await expectExactlyOnce(s, 2); // signAndStore + feeBump; recovery added none
  });

  it('the nonce was consumed by a cancel before the stored tx went out: DROPPED keeps the intent; CANCELLED only at finalized', async () => {
    const s = await scenario();
    const stored = await store(s);
    const fees = await live.client.estimateFeesPerGas();
    const cancel = await privateKeyToAccount(s.key).signTransaction({
      type: 'eip1559', chainId: CHAIN_ID, nonce: Number(stored.nonce), to: s.signer.address, value: 0n, gas: 21_000n, ...fees,
    });
    const cancelHash = await live.client.sendRawTransaction({ serializedTransaction: cancel });
    await live.client.waitForTransactionReceipt({ hash: cancelHash });

    const outcomes = await recoverOpenIntents(live.db, live.client, s.opts);
    expect(outcomes[0]).toMatchObject({ action: 'dropped', toState: 'DROPPED' });
    expect(await spentLogs(live, s.treasury.address, s.spend.intentId, s.treasury.block)).toHaveLength(0);
    // G0-AUDIT (v-4): a DROPPED row still holds its intent (partial unique index), so no second row yet.
    await expect(insertRetry(live.db, s.spend.target, 'too-early')).rejects.toThrow();
    expect(await advanceFinality(live.db, live.client, s.opts)).toEqual([expect.objectContaining({ action: 'pending', toState: 'DROPPED' })]);

    await finalizeAll(live);
    const [settled] = await advanceFinality(live.db, live.client, s.opts);
    expect(settled).toMatchObject({ action: 'cancelled', toState: 'CANCELLED', consumedBy: cancelHash });
    expect(await paymentRow(live.db, s.spend.target)).toMatchObject({ state: 'CANCELLED', nonceConsumedByTxHash: cancelHash, txHash: stored.txHash });
    await insertRetry(live.db, s.spend.target); // CANCELLED released the intent: policy may retry it as a NEW row
    expect(s.signer.signTransaction).toHaveBeenCalledTimes(1);
  });

  it('recovery never signs a new tx for a DROPPED intent: the node forgot the tx, the SAME bytes are re-sent and mined', async () => {
    const s = await scenario();
    await live.test.setAutomine(false);
    let stored: Awaited<ReturnType<typeof store>>;
    try {
      stored = await store(s);
      await sendStored(live.db, live.client, stored);
      await live.test.dropTransaction({ hash: stored.txHash }); // evicted from the mempool
      const [dropped] = await recoverOpenIntents(live.db, live.client, s.opts);
      expect(dropped).toMatchObject({ action: 'rebroadcast', fromState: 'BROADCAST', toState: 'DROPPED' });
      const [again] = await recoverOpenIntents(live.db, live.client, s.opts);
      expect(again).toMatchObject({ action: 'pending', fromState: 'DROPPED', toState: 'DROPPED' });
      await live.test.mine({ blocks: 1 });
    } finally {
      await live.test.setAutomine(true);
    }
    const [mined] = await recoverOpenIntents(live.db, live.client, s.opts);
    expect(mined).toMatchObject({ action: 'included', fromState: 'DROPPED', toState: 'INCLUDED', onchainTxHash: stored.txHash });
    await expectExactlyOnce(s, 1); // only signAndStore ever signed
  });

  it('a bumped original that lands while the row is DROPPED is recorded as landed (FINALIZED), not CANCELLED', async () => {
    const s = await scenario();
    await live.test.setAutomine(false);
    let original: Hex;
    let bumped: Hex;
    try {
      const stored = await store(s);
      original = stored.txHash;
      await sendStored(live.db, live.client, stored);
      await live.test.dropTransaction({ hash: original });
      bumped = (await feeBump(live.db, { target: s.spend.target, account: s.signer, client: live.client, capWei: CAP_WEI, chainId: CHAIN_ID, ...bindTo(s.treasury.address) })).txHash;
      const [dropped] = await recoverOpenIntents(live.db, live.client, s.opts); // re-sends the bump
      expect(dropped).toMatchObject({ toState: 'DROPPED', storedTxHash: bumped });
      // Another node still had the ORIGINAL bytes: the bump is evicted and the original is mined instead.
      await live.test.dropTransaction({ hash: bumped });
      await broadcast(live.client, stored.rawTx);
      await live.test.mine({ blocks: 1 });
    } finally {
      await live.test.setAutomine(true);
    }
    expect((await live.client.getTransactionReceipt({ hash: original })).status).toBe('success');
    await finalizeAll(live);
    const [settled] = await advanceFinality(live.db, live.client, s.opts);
    expect(settled).toMatchObject({ action: 'landed', fromState: 'DROPPED', toState: 'FINALIZED', txHash: original });
    expect(await paymentRow(live.db, s.spend.target)).toMatchObject({
      state: 'FINALIZED', txHash: original, supersededTxHashes: [bumped], nonceConsumedByTxHash: null,
    });
    await expectExactlyOnce(s, 2); // signAndStore + feeBump
  });

  it('real kill -9 (SIGKILL) of a worker process after broadcast, before the db write', async () => {
    const s = await scenario();
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./t19-child.ts', import.meta.url))], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: {
        ...process.env,
        T19_CHILD: JSON.stringify({
          dbUrl: DB_URL, rpcUrl: RPC_URL, key: s.key, target: s.spend.target, to: s.spend.request.to, data: s.spend.request.data, chainId: CHAIN_ID, capWei: CAP_WEI.toString(),
          ...bindTo(s.treasury.address),
        }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    expect(err).toBe('');
    expect(exit.signal).toBe('SIGKILL');
    const reported = JSON.parse(out.trim()) as { status: string; txHash: Hex };
    expect(reported.status).toBe('sent');

    const row = await paymentRow(live.db, s.spend.target);
    expect(row).toMatchObject({ state: 'SIGNED', txHash: reported.txHash }); // stored before broadcast; BROADCAST never written
    await live.client.waitForTransactionReceipt({ hash: reported.txHash }); // the worker restarts after it was mined
    const outcomes = await recoverOpenIntents(live.db, live.client, s.opts);
    expect(outcomes[0]).toMatchObject({ action: 'included', toState: 'INCLUDED', onchainTxHash: reported.txHash });
    await expectExactlyOnce(s, 0); // the parent never signed anything
    expect(await recoverOpenIntents(live.db, live.client, s.opts)).toEqual([]);
  });
});

/**
 * TODO(lead, after task 1.4 merges): enable this block. Same scenarios against the real contracts:
 * deploy PlanRegistry + Treasury (contracts/script), openFacility + fund + registerFounderKey + commitPlan
 * with the Rina fixture (founder ECDSA sig), then for one ADS pacing spend:
 *   1. signAndStore → broadcast → (crash) → recoverOpenIntents  ⇒ one `Spent`, isIntentUsed, nonce +1;
 *   2. signAndStore → (crash) → recoverOpenIntents re-sends the same bytes ⇒ one `Spent`;
 *   3. the t19-child SIGKILL run with `to` = Treasury;
 *   4. reconciler drift = 0 (balances().spentMinor == sum of INCLUDED SPEND payments).
 * Also replace MockTreasury in the forced-revert test with T1/T4/T7 against Treasury (PayeeNotBound,
 * CapExceeded, DuplicateIntent).
 */
describe.skip('T19 on the real Treasury (enable after task 1.4)', () => {
  it.todo('crash after broadcast → exactly one Spent, drift 0, no second tx');
  it.todo('crash before broadcast → same bytes re-sent');
  it.todo('SIGKILL child against Treasury');
  it.todo('forced reverts T1/T4/T7 decode PayeeNotBound / CapExceeded / DuplicateIntent');
});
