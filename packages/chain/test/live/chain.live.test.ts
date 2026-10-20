/**
 * Live: Postgres nonce allocator, crash-safe sender, fee bump (in place, superseded hashes kept), forced
 * reverts and payment reverts settled only at `finalized`, log watcher, gap repair.
 * Skipped unless TEST_DATABASE_URL and TEST_RPC_URL are set (see harness.ts).
 */
import { chainActions, nonces } from '@hogee/db';
import { and, eq } from 'drizzle-orm';
import { keccak256, parseTransaction, toHex, type Address, type Hex, type Log } from 'viem';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  advanceFinality,
  advanceNonce,
  allocateNonce,
  buildSpend,
  FeeCapExceededError,
  feeBump,
  inspectNonces,
  memoryLogCursor,
  pgLogCursor,
  pollLogs,
  readCheckpoint,
  readNextNonce,
  RedactedError,
  rebroadcastStored,
  reconcileNonce,
  recoverOpenIntents,
  sendForcedRevert,
  sendStored,
  signAndStore,
  SignTargetError,
  SpendActionRefusedError,
  toBytes32Tag,
  TxReplacedError,
  type DecodedHogeeLog,
  type LogReader,
} from '../../src/index';
import {
  actionRow,
  ADS,
  bindTo,
  CAP_WEI,
  CHAIN_ID,
  deployMock,
  deploymentFor,
  finalizeAll,
  freshAccount,
  insertRetry,
  LIVE,
  LIVE_SETUP_TIMEOUT_MS,
  minedNonce,
  MOCK_CAP,
  paymentRow,
  PLAN_ID,
  seedAction,
  seedFacility,
  seedSpend,
  setupLive,
  spentLogs,
  spySigner,
  type Live,
} from './harness';

function feesOf(raw: Hex): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  const tx = parseTransaction(raw);
  return { maxFeePerGas: tx.maxFeePerGas ?? 0n, maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? 0n };
}

describe.skipIf(!LIVE)('chain core on Anvil + Postgres', { timeout: 60_000 }, () => {
  let live: Live;
  beforeAll(async () => {
    live = await setupLive();
  }, LIVE_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await live?.close();
  });

  describe('Postgres nonce allocator', () => {
    it('25 concurrent allocations get 25 distinct, contiguous nonces starting at the pending count', async () => {
      const { account } = await freshAccount(live);
      // Two txs outside the allocator first, so the row is initialised from pending = 2.
      for (let i = 0; i < 2; i += 1) {
        await live.client.waitForTransactionReceipt({
          hash: await live.client.sendRawTransaction({
            serializedTransaction: await account.signTransaction({
              type: 'eip1559', chainId: CHAIN_ID, nonce: i, to: account.address, value: 0n, gas: 21_000n, ...(await live.client.estimateFeesPerGas()),
            }),
          }),
        });
      }
      const key = { signer: account.address, chainId: CHAIN_ID, client: live.client };
      const got = await Promise.all(Array.from({ length: 25 }, () => live.db.transaction((tx) => allocateNonce(tx, key))));
      expect(new Set(got.map(String)).size).toBe(25);
      expect([...got].sort((a, b) => (a < b ? -1 : 1))).toEqual(Array.from({ length: 25 }, (_, i) => BigInt(i + 2)));
      expect(await readNextNonce(live.db, key)).toBe(27n);
    });

    it('a second allocation waits for the row lock; a rollback gives the nonce back to it', async () => {
      const { account } = await freshAccount(live);
      const key = { signer: account.address, chainId: CHAIN_ID, client: live.client };
      await live.db.transaction((tx) => allocateNonce(tx, key)); // row exists, next = 1
      let releaseFirst: () => void = () => undefined;
      const firstHolds = new Promise<void>((r) => {
        releaseFirst = r;
      });
      let firstGot = -1n;
      const first = live.db
        .transaction(async (tx) => {
          firstGot = await allocateNonce(tx, key);
          await firstHolds;
          throw new Error('crash before COMMIT');
        })
        .catch((e: Error) => e.message);
      await vi.waitFor(() => expect(firstGot).toBe(1n));
      let secondDone = false;
      const second = live.db.transaction((tx) => allocateNonce(tx, key)).then((n) => {
        secondDone = true;
        return n;
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(secondDone).toBe(false); // blocked on SELECT … FOR UPDATE
      releaseFirst();
      expect(await first).toBe('crash before COMMIT');
      expect(await second).toBe(1n); // the rolled-back nonce is reused, never skipped
    });
  });

  describe('signAndStore + broadcast', () => {
    it('stores raw tx, nonce, signer and chainId (state SIGNED) before anything reaches the node', async () => {
      const { account } = await freshAccount(live);
      const treasury = await deployMock(live, account.address);
      const facility = await seedFacility(live.db);
      const spend = await seedSpend(live.db, facility, treasury.address);
      const stored = await signAndStore(live.db, { target: spend.target, request: spend.request, account, client: live.client, chainId: CHAIN_ID, capWei: CAP_WEI, ...bindTo(treasury.address) });

      const row = await paymentRow(live.db, spend.target);
      expect(row).toMatchObject({ state: 'SIGNED', rawSignedTx: stored.rawTx, nonce: 0n, signerAddress: account.address.toLowerCase(), chainId: CHAIN_ID, txHash: keccak256(stored.rawTx) });
      await expect(live.client.getTransaction({ hash: stored.txHash })).rejects.toThrow(/could not be found/);
      expect(await live.client.getTransactionCount({ address: account.address, blockTag: 'pending' })).toBe(0);

      expect((await sendStored(live.db, live.client, stored)).status).toBe('sent');
      const receipt = await live.client.waitForTransactionReceipt({ hash: stored.txHash });
      expect(receipt.status).toBe('success');
      expect((await paymentRow(live.db, spend.target))?.state).toBe('BROADCAST');
      expect(await spentLogs(live, treasury.address, spend.intentId, treasury.block)).toHaveLength(1);
    });

    it('is idempotent: a second call returns the stored bytes and signs nothing', async () => {
      const { account } = await freshAccount(live);
      const treasury = await deployMock(live, account.address);
      const spend = await seedSpend(live.db, await seedFacility(live.db), treasury.address);
      const signer = spySigner(account);
      const p = { target: spend.target, request: spend.request, account: signer, client: live.client, chainId: CHAIN_ID, capWei: CAP_WEI, ...bindTo(treasury.address) };
      const a = await signAndStore(live.db, p);
      const b = await signAndStore(live.db, p);
      expect(b).toMatchObject({ reused: true, rawTx: a.rawTx, nonce: a.nonce });
      expect(signer.signTransaction).toHaveBeenCalledTimes(1);
    });

    it('a crash inside the signing transaction leaves the row unsigned and the nonce unused', async () => {
      const { account } = await freshAccount(live);
      const treasury = await deployMock(live, account.address);
      const spend = await seedSpend(live.db, await seedFacility(live.db), treasury.address);
      const crashing = { address: account.address, signTransaction: async () => Promise.reject(new Error('HSM unavailable')) };
      await expect(
        signAndStore(live.db, { target: spend.target, request: spend.request, account: crashing, client: live.client, chainId: CHAIN_ID, capWei: CAP_WEI, ...bindTo(treasury.address) }),
      ).rejects.toThrow(/HSM unavailable/);
      expect(await paymentRow(live.db, spend.target)).toMatchObject({ state: 'POLICY_OK', rawSignedTx: null, nonce: null });
      expect(await readNextNonce(live.db, { signer: account.address, chainId: CHAIN_ID })).toBeNull();
      const stored = await signAndStore(live.db, { target: spend.target, request: spend.request, account, client: live.client, chainId: CHAIN_ID, capWei: CAP_WEI, ...bindTo(treasury.address) });
      expect(stored.nonce).toBe(0n);
    });

    it('refuses calldata that differs from the payment row, and a fee estimate above MAX_FEE_GWEI, before using a nonce', async () => {
      const { account } = await freshAccount(live);
      const treasury = await deployMock(live, account.address);
      const spend = await seedSpend(live.db, await seedFacility(live.db), treasury.address);
      const evil = buildSpend({ lineId: ADS, payeeId: toBytes32Tag('evil'), amountMinor: spend.amountMinor, invoiceHash: spend.invoiceHash, planVersion: 1, decisionId: `0x${'1'.repeat(64)}`, rationaleHash: `0x${'2'.repeat(64)}` });
      const base = { target: spend.target, account, client: live.client, chainId: CHAIN_ID, ...bindTo(treasury.address) };
      await expect(signAndStore(live.db, { ...base, request: { to: treasury.address, data: evil.data }, capWei: CAP_WEI })).rejects.toThrow(SignTargetError);
      await expect(signAndStore(live.db, { ...base, request: spend.request, capWei: 1n })).rejects.toThrow(FeeCapExceededError);
      expect(await readNextNonce(live.db, { signer: account.address, chainId: CHAIN_ID })).toBeNull();
    });
  });

  describe('signAndStore binds the tx to the facility deployment (one key serves several facilities)', () => {
    it('refuses another facility’s Treasury, a non-zero value, another deployment, or a chain action whose calldata is not its kind, before using a nonce', async () => {
      const { account } = await freshAccount(live);
      const treasury = await deployMock(live, account.address);
      const other = await deployMock(live, account.address); // another facility's Treasury on the same chain
      const facility = await seedFacility(live.db);
      const spend = await seedSpend(live.db, facility, treasury.address);
      const pause = await seedAction(live.db, facility, 'Treasury.pause');
      const base = { account, client: live.client, chainId: CHAIN_ID, capWei: CAP_WEI, ...bindTo(treasury.address) };

      const wrongTo = signAndStore(live.db, { ...base, target: spend.target, request: { ...spend.request, to: other.address } });
      await expect(wrongTo).rejects.toThrow(/to is not the deployment's Treasury/);
      const paid = signAndStore(live.db, { ...base, target: spend.target, request: { ...spend.request, value: 1n } });
      await expect(paid).rejects.toThrow(/value must be 0/);
      const loop = { ...deploymentFor(treasury.address), deploymentId: 'loop-1' };
      await expect(signAndStore(live.db, { ...base, deployment: loop, target: spend.target, request: spend.request })).rejects.toThrow(/deployment_id/);
      const spendAsPause = signAndStore(live.db, { ...base, target: pause, request: { to: treasury.address, data: spend.request.data } });
      await expect(spendAsPause).rejects.toThrow(/calldata is not Treasury.pause/);
      expect(await readNextNonce(live.db, { signer: account.address, chainId: CHAIN_ID })).toBeNull();
      expect(await paymentRow(live.db, spend.target)).toMatchObject({ state: 'POLICY_OK', rawSignedTx: null });

      const stored = await signAndStore(live.db, { ...base, target: spend.target, request: spend.request });
      expect(stored.nonce).toBe(0n);
    });

    it('recomputes a SPEND intent_id from the calldata and the plan id: another plan, or none, is refused before using a nonce', async () => {
      const { account } = await freshAccount(live);
      const treasury = await deployMock(live, account.address);
      const spend = await seedSpend(live.db, await seedFacility(live.db), treasury.address);
      const { deployment } = bindTo(treasury.address);
      const base = { account, client: live.client, chainId: CHAIN_ID, capWei: CAP_WEI, deployment, target: spend.target, request: spend.request };
      await expect(signAndStore(live.db, { ...base, planId: toBytes32Tag('plan-other') })).rejects.toThrow(/intent_id/);
      await expect(signAndStore(live.db, base)).rejects.toThrow(/planId is required/);
      expect(await readNextNonce(live.db, { signer: account.address, chainId: CHAIN_ID })).toBeNull();
      expect((await signAndStore(live.db, { ...base, planId: PLAN_ID })).nonce).toBe(0n);
    });
  });

  it('signAndStore rethrows a provider error carrying its URL redacted (original as cause) and uses no nonce', async () => {
    const { account } = await freshAccount(live);
    const treasury = await deployMock(live, account.address);
    const spend = await seedSpend(live.db, await seedFacility(live.db), treasury.address);
    const failing = {
      ...live.client,
      estimateFeesPerGas: async () => Promise.reject(Object.assign(new Error('HTTP request failed.\nURL: https://eth-sepolia.example/v2/not-a-real-key'), { shortMessage: 'HTTP request failed.' })),
    } as unknown as typeof live.client;
    const err = await signAndStore(live.db, { target: spend.target, request: spend.request, account, client: failing, chainId: CHAIN_ID, capWei: CAP_WEI, ...bindTo(treasury.address) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedactedError);
    expect((err as Error).message).not.toMatch(/not-a-real-key|https?:/);
    expect(((err as Error).cause as Error).message).toMatch(/HTTP request failed/);
    expect(await readNextNonce(live.db, { signer: account.address, chainId: CHAIN_ID })).toBeNull();
  });

  it('feeBump re-signs the SAME nonce in place (both fees ≥ +10 %), appends each old hash to superseded_tx_hashes, and the last bump is mined', async () => {
    const { account } = await freshAccount(live);
    const treasury = await deployMock(live, account.address);
    const spend = await seedSpend(live.db, await seedFacility(live.db), treasury.address);
    await live.test.setAutomine(false);
    try {
      const stored = await signAndStore(live.db, { target: spend.target, request: spend.request, account, client: live.client, chainId: CHAIN_ID, capWei: CAP_WEI, ...bindTo(treasury.address) });
      expect((await paymentRow(live.db, spend.target))?.supersededTxHashes).toEqual([]);
      await sendStored(live.db, live.client, stored);
      const bumped = await feeBump(live.db, { target: spend.target, account, client: live.client, capWei: CAP_WEI, chainId: CHAIN_ID, ...bindTo(treasury.address) });
      expect(bumped).toMatchObject({ nonce: stored.nonce, previousTxHash: stored.txHash, supersededTxHashes: [stored.txHash] });
      const before = feesOf(stored.rawTx);
      expect(bumped.fees.maxFeePerGas * 100n).toBeGreaterThanOrEqual(before.maxFeePerGas * 110n);
      expect(bumped.fees.maxPriorityFeePerGas * 100n).toBeGreaterThanOrEqual(before.maxPriorityFeePerGas * 110n);
      expect(await paymentRow(live.db, spend.target)).toMatchObject({
        state: 'BROADCAST', rawSignedTx: bumped.rawTx, txHash: bumped.txHash, nonce: stored.nonce, supersededTxHashes: [stored.txHash],
      });
      const again = await feeBump(live.db, { target: spend.target, account, client: live.client, capWei: CAP_WEI, chainId: CHAIN_ID, ...bindTo(treasury.address) });
      expect(await paymentRow(live.db, spend.target)).toMatchObject({ txHash: again.txHash, supersededTxHashes: [stored.txHash, bumped.txHash] });
      expect((await rebroadcastStored(live.db, live.client, spend.target)).status).toBe('sent');
      await live.test.mine({ blocks: 1 });
      expect((await live.client.getTransactionReceipt({ hash: again.txHash })).status).toBe('success');
      await expect(live.client.getTransactionReceipt({ hash: stored.txHash })).rejects.toThrow();
      expect(await spentLogs(live, treasury.address, spend.intentId, treasury.block)).toHaveLength(1);
      await expect(feeBump(live.db, { target: spend.target, account, client: live.client, capWei: CAP_WEI, chainId: CHAIN_ID, ...bindTo(treasury.address) })).rejects.toThrow(/already mined/);
    } finally {
      await live.test.setAutomine(true);
    }
  });

  it('a mined payment revert stays INCLUDED (holding its intent) until final; then REVERTED with block, hash and error, releasing it', async () => {
    const { account } = await freshAccount(live);
    const treasury = await deployMock(live, account.address);
    const facility = await seedFacility(live.db);
    const spend = await seedSpend(live.db, facility, treasury.address, MOCK_CAP + 1n, 500_000n); // CapExceeded, mined
    const opts = { chainId: CHAIN_ID, deployment: deploymentFor(treasury.address), facilityId: facility };
    const stored = await signAndStore(live.db, { target: spend.target, request: spend.request, account, client: live.client, chainId: CHAIN_ID, capWei: CAP_WEI, ...bindTo(treasury.address) });
    await sendStored(live.db, live.client, stored);
    const receipt = await live.client.waitForTransactionReceipt({ hash: stored.txHash });
    expect(receipt.status).toBe('reverted');

    const [recovered] = await recoverOpenIntents(live.db, live.client, opts);
    expect(recovered).toMatchObject({ action: 'included', toState: 'INCLUDED', receiptStatus: 'reverted' });
    const [early] = await advanceFinality(live.db, live.client, opts);
    expect(early).toMatchObject({ action: 'pending', toState: 'INCLUDED' });
    expect((await paymentRow(live.db, spend.target))?.state).toBe('INCLUDED');
    await expect(insertRetry(live.db, spend.target, 'early')).rejects.toThrow(); // the intent is still held

    await finalizeAll(live);
    const [final] = await advanceFinality(live.db, live.client, opts);
    expect(final).toMatchObject({ action: 'reverted', toState: 'REVERTED', revertReason: 'CapExceeded', block: receipt.blockNumber });
    expect(await paymentRow(live.db, spend.target)).toMatchObject({ state: 'REVERTED', block: receipt.blockNumber, txHash: stored.txHash, revertReason: 'CapExceeded' });
    await insertRetry(live.db, spend.target); // released
  });

  it('forced revert: explicit gas, no eth_estimateGas, the revert is MINED and the custom error decoded', async () => {
    const { account } = await freshAccount(live);
    const treasury = await deployMock(live, account.address);
    const facility = await seedFacility(live.db);
    const target = await seedAction(live.db, facility, 'Treasury.spend', 'T4');
    const overCap = buildSpend({ lineId: ADS, payeeId: toBytes32Tag('shopee-ads'), amountMinor: MOCK_CAP + 1n, invoiceHash: `0x${'3'.repeat(64)}`, planVersion: 1, decisionId: `0x${'4'.repeat(64)}`, rationaleHash: `0x${'5'.repeat(64)}` });
    const estimateGas = vi.spyOn(live.client, 'estimateGas');
    const result = await sendForcedRevert(live.db, {
      action: { facilityId: facility, id: target.id },
      request: { to: treasury.address, data: overCap.data },
      account,
      client: live.client,
      chainId: CHAIN_ID,
      capWei: CAP_WEI,
      deployment: deploymentFor(treasury.address),
    });
    expect(estimateGas).not.toHaveBeenCalled();
    estimateGas.mockRestore();
    expect(result).toMatchObject({ status: 'reverted', nonce: 0n, error: { name: 'CapExceeded' } });
    expect(result.decodedVia).not.toBeNull();
    expect(result.blockNumber).toBeGreaterThan(0n);
    const tx = await live.client.getTransaction({ hash: result.txHash });
    expect(tx.gas).toBe(500_000n);
    expect(await actionRow(live.db, target)).toMatchObject({ state: 'INCLUDED', txHash: result.txHash, nonce: 0n }); // not final yet
    await finalizeAll(live);
    const outs = await advanceFinality(live.db, live.client, { chainId: CHAIN_ID, deployment: deploymentFor(treasury.address), facilityId: facility });
    expect(outs).toEqual([expect.objectContaining({ action: 'reverted', toState: 'REVERTED', revertReason: 'CapExceeded' })]);
    expect(await actionRow(live.db, target)).toMatchObject({ state: 'REVERTED', revertReason: 'CapExceeded', txHash: result.txHash, block: result.blockNumber });
  });

  it('a value-moving chain action signs only when its call reverts: a spend that would succeed is refused, nothing is signed or spent', async () => {
    const { account } = await freshAccount(live);
    const treasury = await deployMock(live, account.address);
    const facility = await seedFacility(live.db);
    const target = await seedAction(live.db, facility, 'Treasury.spend', 'T-spend-via-action');
    const withinCap = buildSpend({ lineId: ADS, payeeId: toBytes32Tag('shopee-ads'), amountMinor: 100n, invoiceHash: `0x${'7'.repeat(64)}`, planVersion: 1, decisionId: `0x${'4'.repeat(64)}`, rationaleHash: `0x${'5'.repeat(64)}` });
    const run = sendForcedRevert(live.db, {
      action: { facilityId: facility, id: target.id },
      request: { to: treasury.address, data: withinCap.data },
      account,
      client: live.client,
      chainId: CHAIN_ID,
      capWei: CAP_WEI,
      deployment: deploymentFor(treasury.address),
    });
    await expect(run).rejects.toThrow(SpendActionRefusedError);
    expect(await actionRow(live.db, target)).toMatchObject({ state: 'PENDING', rawSignedTx: null, nonce: null });
    expect(await readNextNonce(live.db, { signer: account.address, chainId: CHAIN_ID })).toBeNull();
    expect(await minedNonce(live, account.address)).toBe(0);
  });

  it('forced revert: a receipt for another tx (viem returns a replacement’s receipt) is never recorded as the row’s', async () => {
    const { account } = await freshAccount(live);
    const treasury = await deployMock(live, account.address);
    const facility = await seedFacility(live.db);
    const target = await seedAction(live.db, facility, 'Treasury.spend', 'T4');
    const overCap = buildSpend({ lineId: ADS, payeeId: toBytes32Tag('shopee-ads'), amountMinor: MOCK_CAP + 1n, invoiceHash: `0x${'6'.repeat(64)}`, planVersion: 1, decisionId: `0x${'4'.repeat(64)}`, rationaleHash: `0x${'5'.repeat(64)}` });
    const replacement = keccak256(toHex('a replacement mined at the same nonce'));
    const client = {
      ...live.client,
      waitForTransactionReceipt: async (a: { hash: Hex; timeout?: number }) => ({ ...(await live.client.waitForTransactionReceipt(a)), transactionHash: replacement }),
    } as unknown as typeof live.client;
    const run = sendForcedRevert(live.db, {
      action: { facilityId: facility, id: target.id },
      request: { to: treasury.address, data: overCap.data },
      account,
      client,
      chainId: CHAIN_ID,
      capWei: CAP_WEI,
      deployment: deploymentFor(treasury.address),
    });
    await expect(run).rejects.toThrow(TxReplacedError);
    const row = await actionRow(live.db, target);
    expect(row).toMatchObject({ state: 'BROADCAST', nonce: 0n });
    expect(row?.txHash).not.toBe(replacement);
  });

  it('watcher: ≤ 10-block chunks to `finalized`, db checkpoint, handler writes roll back with a crashed chunk', async () => {
    const { account } = await freshAccount(live);
    const treasury = await deployMock(live, account.address);
    const facility = await seedFacility(live.db);
    for (let i = 0; i < 3; i += 1) {
      const spend = await seedSpend(live.db, facility, treasury.address, 100n + BigInt(i));
      const stored = await signAndStore(live.db, { target: spend.target, request: spend.request, account, client: live.client, chainId: CHAIN_ID, capWei: CAP_WEI, ...bindTo(treasury.address) });
      await sendStored(live.db, live.client, stored);
      await live.client.waitForTransactionReceipt({ hash: stored.txHash });
      await live.test.mine({ blocks: 4 });
    }
    await live.test.mine({ blocks: 70 }); // Anvil: finalized = latest - 64
    const ranges: Array<[bigint, bigint]> = [];
    const reader: LogReader = {
      getBlock: (a) => live.client.getBlock(a),
      getLogs: async (a) => {
        ranges.push([a.fromBlock, a.toBlock]);
        return (await live.client.getLogs(a)) as Log[];
      },
    };
    const cursor = pgLogCursor(live.db, { contract: treasury.address, chainId: CHAIN_ID, startBlock: treasury.block });
    let crashed = false;
    const handler = async (batch: readonly DecodedHogeeLog[], ctx: { tx: unknown; range: { fromBlock: bigint } }) => {
      const tx = ctx.tx as Parameters<Parameters<typeof live.db.transaction>[0]>[0];
      for (const l of batch) {
        await tx.insert(chainActions).values({ id: `seen:${l.transactionHash}:${l.logIndex}`, facilityId: facility, kind: `Watcher.${l.eventName}`, state: 'PENDING' });
      }
      if (!crashed && batch.length > 0 && ctx.range.fromBlock > treasury.block + 3n) {
        crashed = true;
        throw new Error('kill -9 mid-chunk');
      }
    };
    await expect(pollLogs(reader, { address: treasury.address, tag: 'finalized', cursor }, handler)).rejects.toThrow(/kill -9/);
    const atCrash = await readCheckpoint(live.db, { contract: treasury.address, chainId: CHAIN_ID });
    const result = await pollLogs(reader, { address: treasury.address, tag: 'finalized', cursor }, handler);
    expect(result.caughtUp).toBe(true);
    expect(await readCheckpoint(live.db, { contract: treasury.address, chainId: CHAIN_ID })).toBe(result.head);
    expect(atCrash).toBeLessThan(result.head);
    for (const [from, to] of ranges) expect(to - from + 1n).toBeLessThanOrEqual(10n);
    const seen = await live.db.select().from(chainActions).where(and(eq(chainActions.facilityId, facility), eq(chainActions.kind, 'Watcher.Spent')));
    expect(seen).toHaveLength(3); // exactly once each, despite the crash
    const again = await pollLogs(reader, { address: treasury.address, tag: 'finalized', cursor }, handler);
    expect(again.ranges).toHaveLength(0);

    // The UI feed reads further, at `safe` (Anvil: latest - 32), from its own in-memory cursor.
    const safe = await pollLogs(reader, { address: treasury.address, tag: 'safe', cursor: memoryLogCursor(treasury.block) }, async () => undefined);
    expect(safe.head).toBeGreaterThan(result.head);
    expect(safe.logCount).toBe(3);
  });

  it('reconcileNonce fills a hole with a no-op cancel and raises next_nonce after external use', async () => {
    const { account } = await freshAccount(live);
    const treasury = await deployMock(live, account.address);
    const spend = await seedSpend(live.db, await seedFacility(live.db), treasury.address);
    const key = { signer: account.address, chainId: CHAIN_ID, client: live.client };
    await live.db.transaction((tx) => allocateNonce(tx, key)); // nonce 0 allocated, no row stores it: a hole
    const stored = await signAndStore(live.db, { target: spend.target, request: spend.request, account, client: live.client, chainId: CHAIN_ID, capWei: CAP_WEI, ...bindTo(treasury.address) });
    expect(stored.nonce).toBe(1n);
    await sendStored(live.db, live.client, stored); // queued behind the hole
    const before = await inspectNonces(live.db, key);
    expect(before).toMatchObject({ chainLatest: 0n, dbNext: 2n, holes: [0n], externalUse: false });
    expect(before.open.map((s) => s.nonce)).toEqual([1n]);

    const fixed = await reconcileNonce(live.db, { ...key, account, capWei: CAP_WEI });
    expect(fixed.cancels.map((c) => c.nonce)).toEqual([0n]);
    expect((await live.client.waitForTransactionReceipt({ hash: stored.txHash })).status).toBe('success');
    expect(await minedNonce(live, account.address)).toBe(2);

    // External use (e.g. a leaked key, T29): the chain moves past next_nonce.
    const fees = await live.client.estimateFeesPerGas();
    const outside = await account.signTransaction({ type: 'eip1559', chainId: CHAIN_ID, nonce: 2, to: account.address, value: 0n, gas: 21_000n, ...fees });
    await live.client.waitForTransactionReceipt({ hash: await live.client.sendRawTransaction({ serializedTransaction: outside }) });
    const after = await reconcileNonce(live.db, { ...key, account, capWei: CAP_WEI });
    expect(after).toMatchObject({ externalUse: true, advancedTo: 3n, holes: [] });
    expect(await readNextNonce(live.db, key)).toBe(3n);
    expect(await live.db.transaction((tx) => advanceNonce(tx, key, 1n))).toBe(3n); // never lowers
    const rows = await live.db.select().from(nonces).where(eq(nonces.signerAddress, account.address.toLowerCase() as Address));
    expect(rows).toHaveLength(1);
  });

  it('reconcileNonce re-run after a crash: a cancel the node already has, a nonce already used, or a slot a pending tx holds is not an error', async () => {
    const { account } = await freshAccount(live);
    const key = { signer: account.address, chainId: CHAIN_ID, client: live.client };
    for (let i = 0; i < 3; i += 1) await live.db.transaction((tx) => allocateNonce(tx, key)); // nonces 0..2, no rows: holes
    const replies = ['already known', 'nonce too low', 'replacement transaction underpriced'];
    const node = {
      getTransactionCount: (a: Parameters<typeof live.client.getTransactionCount>[0]) => live.client.getTransactionCount(a),
      estimateFeesPerGas: () => live.client.estimateFeesPerGas(),
      sendRawTransaction: async (): Promise<Hex> => {
        const details = replies.shift() ?? 'unexpected send';
        throw Object.assign(new Error('Transaction creation failed.'), { details });
      },
    };
    const result = await reconcileNonce(live.db, { ...key, client: node, account, capWei: CAP_WEI });
    expect(result.holes).toEqual([0n, 1n, 2n]);
    expect(result.cancels.map((c) => [c.nonce, c.status])).toEqual([
      [0n, 'already_known'],
      [1n, 'nonce_consumed'],
      [2n, 'occupied'],
    ]);
    for (const c of result.cancels) expect(c.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
