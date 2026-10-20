/**
 * The finalized watcher for signed rows (§12.3, G0-AUDIT v-4): INCLUDED → FINALIZED / REVERTED only from
 * receipts at `finalized`, and the nonce watcher that settles a DROPPED row as landed (one of its own
 * hashes, or a tx that applied its intent) or CANCELLED (a foreign tx consumed the nonce and the intent's
 * on-chain effect is absent). In-memory chain and row store.
 */
import { encodeErrorResult, keccak256, toHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  advanceFinalityWithStore,
  DeploymentMismatchError,
  findNonceConsumer,
  fundMilestoneIntentId,
  HOGEE_KINDS,
  intentEffect,
  iTreasuryAbi,
  shortIdToBytes32,
  type FinalityClient,
  type FinalityOptions,
  type PaymentIntentFields,
} from '../src/index';
import { FakeChain, signedTx } from './fixtures/fake-chain';
import { MemoryRowStore } from './fixtures/memory-rows';
import { actionRow, CHAIN, DEPLOYMENT, ESCROW, FACILITY, originalAndBump, paymentRow, spendPayment, TREASURY } from './fixtures/signed-rows';

const account = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const OPTS: FinalityOptions = { chainId: CHAIN, deployment: DEPLOYMENT, facilityId: FACILITY };
const CONTRACTS = { Treasury: TREASURY, MilestoneEscrow: ESCROW };
const ORDER = 'order-a-001';

function fundPayment(cumulativeAfterMinor: bigint): PaymentIntentFields {
  return {
    ...spendPayment('inv-fund').payment,
    kind: 'FUND_MILESTONE',
    orderId: ORDER,
    milestoneIdx: 1,
    amountMinor: '120000',
    intentId: fundMilestoneIntentId({ orderId: shortIdToBytes32(ORDER), idx: 1, amountMinor: 120_000n, cumulativeAfterMinor }),
  };
}

const milestone = (fundedMinor: bigint, released = false) => ({ amountMinor: 200_000n, fundedMinor, autoRelease: false, released, evidenceHash: `0x${'0'.repeat(64)}` });

describe('findNonceConsumer', () => {
  it('binary-searches the first block whose nonce count passes the nonce and returns that tx', async () => {
    const chain = new FakeChain();
    const blocks = [10n, 50n, 51n, 120n, 130n];
    const hashes: Hex[] = [];
    for (const [nonce, block] of blocks.entries()) {
      const tx = await signedTx(account, { nonce: BigInt(nonce), to: TREASURY, data: '0x' });
      hashes.push(tx.hash);
      chain.add({ hash: tx.hash, from: account.address, nonce: BigInt(nonce), to: TREASURY, block });
    }
    const found = await findNonceConsumer(chain.client as unknown as FinalityClient, { signer: account.address, nonce: 2n, toBlock: chain.finalized });
    expect(found).toMatchObject({ hash: hashes[2], blockNumber: 51n, nonce: 2n });
    expect(chain.countCalls.length).toBeLessThanOrEqual(2 + Math.ceil(Math.log2(Number(chain.finalized))));
  });

  it('returns null when the nonce is not consumed at toBlock', async () => {
    const chain = new FakeChain();
    const tx = await signedTx(account, { nonce: 0n, to: TREASURY, data: '0x' });
    chain.add({ hash: tx.hash, from: account.address, nonce: 0n, block: chain.head });
    expect(await findNonceConsumer(chain.client as unknown as FinalityClient, { signer: account.address, nonce: 0n, toBlock: chain.finalized })).toBeNull();
  });
});

describe('intentEffect (views read at the given block)', () => {
  const client = (chain: FakeChain) => chain.client as unknown as FinalityClient;

  it('SPEND / OWNER_SPEND: isIntentUsed at that block', async () => {
    const chain = new FakeChain();
    chain.view = (fn, _args, block) => fn === 'isIntentUsed' && block !== undefined && block >= 150n;
    const spend = spendPayment('inv-effect').payment;
    expect(await intentEffect(client(chain), spend, { blockNumber: 136n, contracts: CONTRACTS })).toBe('absent');
    expect(await intentEffect(client(chain), { ...spend, kind: 'OWNER_SPEND' }, { blockNumber: 150n, contracts: CONTRACTS })).toBe('present');
    expect(chain.reads.map((r) => r.blockNumber)).toEqual([136n, 150n]);
  });

  it('FUND_MILESTONE: absent only when the intent key matches fundedMinor + amount; present when it matches fundedMinor; else unknown', async () => {
    const chain = new FakeChain();
    let funded = 30_000n;
    chain.view = (fn) => (fn === 'milestones' ? [milestone(0n), milestone(funded)] : undefined);
    const p = fundPayment(150_000n);
    expect(await intentEffect(client(chain), p, { blockNumber: 136n, contracts: CONTRACTS })).toBe('absent');
    funded = 150_000n;
    expect(await intentEffect(client(chain), p, { blockNumber: 136n, contracts: CONTRACTS })).toBe('present');
    funded = 60_000n;
    expect(await intentEffect(client(chain), p, { blockNumber: 136n, contracts: CONTRACTS })).toBe('unknown');
    expect(await intentEffect(client(chain), p, { blockNumber: 136n, contracts: { Treasury: TREASURY } })).toBe('unknown');
  });

  it('RELEASE_MILESTONE reads `released`; WITHDRAW_RESERVE reads the loosen status', async () => {
    const chain = new FakeChain();
    let released = false;
    let status: number = HOGEE_KINDS.LOOSEN_STATUS_QUEUED;
    chain.view = (fn) => (fn === 'milestones' ? [milestone(0n), milestone(200_000n, released)] : fn === 'queuedLoosen' ? { status } : undefined);
    const release = { ...fundPayment(0n), kind: 'RELEASE_MILESTONE' };
    const reserve = { ...spendPayment('inv-res').payment, kind: 'WITHDRAW_RESERVE', lineId: null, decisionId: null, rationaleHash: null };
    const at = { blockNumber: 136n, contracts: CONTRACTS };
    expect([await intentEffect(client(chain), release, at), await intentEffect(client(chain), reserve, at)]).toEqual(['absent', 'absent']);
    released = true;
    status = HOGEE_KINDS.LOOSEN_STATUS_EXECUTED;
    expect([await intentEffect(client(chain), release, at), await intentEffect(client(chain), reserve, at)]).toEqual(['present', 'present']);
  });
});

describe('advanceFinalityWithStore', () => {
  let chain: FakeChain;
  let store: MemoryRowStore;
  let used: boolean;
  const advance = () => advanceFinalityWithStore(store, chain.client as unknown as FinalityClient, OPTS);

  beforeEach(() => {
    chain = new FakeChain(); // head 200, finalized 136
    store = new MemoryRowStore();
    used = false;
    chain.view = (fn) => {
      if (fn === 'isIntentUsed') return used;
      throw new Error(`unexpected view ${fn}`);
    };
  });

  describe('DROPPED rows: the nonce watcher', () => {
    it('a bumped original that lands is recorded as landed (FINALIZED with the landed hash), not CANCELLED', async () => {
      const spend = spendPayment('inv-orig-lands');
      const { original, bump } = await originalAndBump(account, 0n, TREASURY, spend.data);
      chain.add({ hash: original.hash, raw: original.raw, from: account.address, nonce: 0n, to: TREASURY, input: spend.data, block: 120n });
      used = true;
      const row = store.add(
        paymentRow({ id: 'd1', state: 'DROPPED', account, nonce: 0n, raw: bump.raw, txHash: bump.hash, superseded: [original.hash], payment: spend.payment }),
      );

      const [out] = await advance();
      expect(out).toMatchObject({ action: 'landed', fromState: 'DROPPED', toState: 'FINALIZED', txHash: original.hash, block: 120n });
      expect(store.get(row.target)).toMatchObject({
        state: 'FINALIZED',
        txHash: original.hash,
        supersededTxHashes: [bump.hash],
        nonceConsumedByTxHash: null,
        block: 120n,
        rawSignedTx: original.raw,
      });
    });

    it('the current bytes landing is FINALIZED with tx_hash unchanged', async () => {
      const spend = spendPayment('inv-current-lands');
      const { original, bump } = await originalAndBump(account, 0n, TREASURY, spend.data);
      chain.add({ hash: bump.hash, from: account.address, nonce: 0n, to: TREASURY, input: spend.data, block: 130n });
      const row = store.add(
        paymentRow({ id: 'd2', state: 'DROPPED', account, nonce: 0n, raw: bump.raw, txHash: bump.hash, superseded: [original.hash], payment: spend.payment }),
      );
      const [out] = await advance();
      expect(out).toMatchObject({ action: 'landed', toState: 'FINALIZED', txHash: bump.hash });
      expect(store.get(row.target)).toMatchObject({ txHash: bump.hash, supersededTxHashes: [original.hash] });
    });

    it('a foreign consumer with the intent not applied → CANCELLED naming that tx; the intent is released', async () => {
      const spend = spendPayment('inv-cancelled');
      const { original, bump } = await originalAndBump(account, 0n, TREASURY, spend.data);
      const cancel = await signedTx(account, { nonce: 0n, to: account.address, data: '0x' });
      chain.add({ hash: cancel.hash, from: account.address, nonce: 0n, to: account.address, block: 120n });
      const row = store.add(
        paymentRow({ id: 'd3', state: 'DROPPED', account, nonce: 0n, raw: bump.raw, txHash: bump.hash, superseded: [original.hash], payment: spend.payment }),
      );

      const [out] = await advance();
      expect(out).toMatchObject({ action: 'cancelled', toState: 'CANCELLED', consumedBy: cancel.hash });
      expect(store.get(row.target)).toMatchObject({ state: 'CANCELLED', nonceConsumedByTxHash: cancel.hash, txHash: bump.hash });
      expect(store.holdsIntent(row.target)).toBe(false);
      expect(chain.reads.filter((r) => r.functionName === 'isIntentUsed').map((r) => r.blockNumber)).toEqual([chain.finalized]);
    });

    it('a foreign consumer that itself applied the intent → landed with the consumer hash', async () => {
      const spend = spendPayment('inv-manual-twin');
      const mine = await signedTx(account, { nonce: 0n, to: TREASURY, data: spend.data });
      const manual = await signedTx(account, { nonce: 0n, to: TREASURY, data: spend.data, maxFeePerGas: 9_000_000_000n });
      chain.add({
        hash: manual.hash, from: account.address, nonce: 0n, to: TREASURY, input: spend.data, block: 120n,
        logs: [{ address: TREASURY, eventName: 'Spent', args: { spendId: spend.payment.intentId } }],
      });
      used = true;
      const row = store.add(paymentRow({ id: 'd4', state: 'DROPPED', account, nonce: 0n, raw: mine.raw, txHash: mine.hash, payment: spend.payment }));

      const [out] = await advance();
      expect(out).toMatchObject({ action: 'landed', toState: 'FINALIZED', txHash: manual.hash });
      expect(store.get(row.target)).toMatchObject({ state: 'FINALIZED', txHash: manual.hash, supersededTxHashes: [mine.hash] });
    });

    it('a foreign consumer while the intent was applied by some other tx → unresolved, stays DROPPED', async () => {
      const spend = spendPayment('inv-applied-elsewhere');
      const mine = await signedTx(account, { nonce: 0n, to: TREASURY, data: spend.data });
      const cancel = await signedTx(account, { nonce: 0n, to: account.address, data: '0x' });
      const other = await signedTx(stranger, { nonce: 0n, to: TREASURY, data: spend.data });
      chain.add({ hash: cancel.hash, from: account.address, nonce: 0n, to: account.address, block: 120n });
      chain.add({
        hash: other.hash, from: stranger.address, nonce: 0n, to: TREASURY, block: 110n,
        logs: [{ address: TREASURY, eventName: 'Spent', args: { spendId: spend.payment.intentId } }],
      });
      used = true;
      const row = store.add(paymentRow({ id: 'd5', state: 'DROPPED', account, nonce: 0n, raw: mine.raw, txHash: mine.hash, payment: spend.payment }));

      const [out] = await advance();
      expect(out).toMatchObject({ action: 'unresolved', toState: 'DROPPED' });
      expect(store.get(row.target).state).toBe('DROPPED');
      expect(store.holdsIntent(row.target)).toBe(true);
    });

    it('a nonce consumed only above `finalized` → pending, stays DROPPED (no CANCELLED from a non-final read)', async () => {
      const spend = spendPayment('inv-not-final');
      const mine = await signedTx(account, { nonce: 0n, to: TREASURY, data: spend.data });
      const cancel = await signedTx(account, { nonce: 0n, to: account.address, data: '0x' });
      chain.add({ hash: cancel.hash, from: account.address, nonce: 0n, to: account.address, block: 190n });
      const row = store.add(paymentRow({ id: 'd6', state: 'DROPPED', account, nonce: 0n, raw: mine.raw, txHash: mine.hash, payment: spend.payment }));

      const [out] = await advance();
      expect(out).toMatchObject({ action: 'pending', toState: 'DROPPED' });
      expect(store.holdsIntent(row.target)).toBe(true);
      chain.head = 260n; // now final
      const [later] = await advance();
      expect(later).toMatchObject({ action: 'cancelled', consumedBy: cancel.hash });
    });

    it('an on-chain effect it cannot establish (FUND_MILESTONE cumulative not derivable) → unresolved', async () => {
      const p = fundPayment(150_000n);
      chain.view = (fn) => (fn === 'milestones' ? [milestone(0n), milestone(60_000n)] : undefined);
      const mine = await signedTx(account, { nonce: 0n, to: ESCROW, data: '0x' });
      const cancel = await signedTx(account, { nonce: 0n, to: account.address, data: '0x' });
      chain.add({ hash: cancel.hash, from: account.address, nonce: 0n, to: account.address, block: 120n });
      const row = store.add(paymentRow({ id: 'd7', state: 'DROPPED', account, nonce: 0n, raw: mine.raw, txHash: mine.hash, payment: p }));
      const [out] = await advance();
      expect(out).toMatchObject({ action: 'unresolved', toState: 'DROPPED' });
      expect(store.holdsIntent(row.target)).toBe(true);
    });
  });

  describe('isolation and scope', () => {
    it('a row whose RPC reads fail is an `error` outcome (short reason, no provider URL); other signers’ rows still settle', async () => {
      const poisoned = privateKeyToAccount(generatePrivateKey());
      chain.poisoned.add(poisoned.address.toLowerCase());
      const bad = spendPayment('inv-poisoned');
      const badTx = await signedTx(poisoned, { nonce: 0n, to: TREASURY, data: bad.data });
      store.add(paymentRow({ id: 'x1', state: 'DROPPED', account: poisoned, nonce: 0n, raw: badTx.raw, txHash: badTx.hash, payment: bad.payment }));
      const good = spendPayment('inv-healthy');
      const goodTx = await signedTx(account, { nonce: 0n, to: TREASURY, data: good.data });
      chain.add({ hash: goodTx.hash, from: account.address, nonce: 0n, to: TREASURY, block: 100n });
      store.add(paymentRow({ id: 'x2', state: 'INCLUDED', account, nonce: 0n, raw: goodTx.raw, txHash: goodTx.hash, payment: good.payment, block: 100n }));

      const outs = await advance();
      const failed = outs.find((o) => o.target.id === 'x1');
      expect(failed).toMatchObject({ action: 'error', fromState: 'DROPPED', toState: 'DROPPED' });
      expect(failed?.detail).toMatch(/HTTP request failed/);
      expect(failed?.detail).not.toMatch(/sk-not-a-real-key|https?:\/\//);
      expect(outs.find((o) => o.target.id === 'x2')).toMatchObject({ action: 'finalized', toState: 'FINALIZED' });
      expect(store.holdsIntent({ table: 'payments', facilityId: FACILITY, id: 'x1' })).toBe(true);
    });

    it('is scoped to one facility (one deployment): facilityId is required and other facilities’ rows are not touched', async () => {
      const spend = spendPayment('inv-other-facility');
      const tx = await signedTx(account, { nonce: 0n, to: TREASURY, data: spend.data });
      chain.add({ hash: tx.hash, from: account.address, nonce: 0n, to: TREASURY, block: 100n });
      const row = paymentRow({ id: 'o1', state: 'INCLUDED', account, nonce: 0n, raw: tx.raw, txHash: tx.hash, payment: spend.payment, block: 100n });
      const other = store.add({ ...row, target: { ...row.target, facilityId: 'fac-other' } });
      expect(await advance()).toEqual([]);
      const client = chain.client as unknown as FinalityClient;
      await expect(advanceFinalityWithStore(store, client, { ...OPTS, facilityId: '' })).rejects.toThrow(/facilityId/);
      const unscoped = { chainId: CHAIN, deployment: DEPLOYMENT } as unknown as FinalityOptions;
      await expect(advanceFinalityWithStore(store, client, unscoped)).rejects.toThrow(/facilityId/);
      expect(store.get(other.target).state).toBe('INCLUDED');
    });
  });

  it('is bound to the facility deployment: a wrong one cannot make isIntentUsed read as absent and CANCEL a row; it throws first', async () => {
    const spend = spendPayment('inv-wrong-deployment');
    const mine = await signedTx(account, { nonce: 0n, to: TREASURY, data: spend.data });
    const cancel = await signedTx(account, { nonce: 0n, to: account.address, data: '0x' });
    chain.add({ hash: cancel.hash, from: account.address, nonce: 0n, to: account.address, block: 120n });
    const row = store.add(paymentRow({ id: 'w1', state: 'DROPPED', account, nonce: 0n, raw: mine.raw, txHash: mine.hash, payment: spend.payment }));
    const client = chain.client as unknown as FinalityClient;
    const elsewhere = { ...DEPLOYMENT, deploymentId: 'loop-1', contracts: { ...DEPLOYMENT.contracts, Treasury: { address: ESCROW } } };
    await expect(advanceFinalityWithStore(store, client, { ...OPTS, deployment: elsewhere })).rejects.toThrow(DeploymentMismatchError);
    await expect(advanceFinalityWithStore(store, client, { ...OPTS, facilityId: 'fac-missing' })).rejects.toThrow(/facility not found/);
    expect(store.listCalls).toBe(0);
    expect([chain.reads, chain.countCalls]).toEqual([[], []]);
    expect(store.get(row.target).state).toBe('DROPPED');
    expect(store.holdsIntent(row.target)).toBe(true);
  });

  describe('INCLUDED rows: receipts read at `finalized`', () => {
    it('a revert above finalized stays INCLUDED; once final it is REVERTED with block, tx hash and the decoded error', async () => {
      const spend = spendPayment('inv-revert');
      const mine = await signedTx(account, { nonce: 0n, to: TREASURY, data: spend.data });
      chain.add({
        hash: mine.hash, from: account.address, nonce: 0n, to: TREASURY, block: 190n, status: 'reverted',
        revertData: encodeErrorResult({ abi: iTreasuryAbi, errorName: 'CapExceeded' }),
      });
      const row = store.add(paymentRow({ id: 'i1', state: 'INCLUDED', account, nonce: 0n, raw: mine.raw, txHash: mine.hash, payment: spend.payment, block: 190n }));

      const [early] = await advance();
      expect(early).toMatchObject({ action: 'pending', toState: 'INCLUDED' });
      expect(store.holdsIntent(row.target)).toBe(true);

      chain.head = 300n; // finalized 236
      const [final] = await advance();
      expect(final).toMatchObject({ action: 'reverted', toState: 'REVERTED', block: 190n, txHash: mine.hash, revertReason: 'CapExceeded' });
      expect(store.get(row.target)).toMatchObject({ state: 'REVERTED', block: 190n, txHash: mine.hash, revertReason: 'CapExceeded' });
      expect(store.holdsIntent(row.target)).toBe(false);
    });

    it('a success at or below finalized becomes FINALIZED (payments and chain actions)', async () => {
      const spend = spendPayment('inv-ok');
      const pay = await signedTx(account, { nonce: 0n, to: TREASURY, data: spend.data });
      const act = await signedTx(account, { nonce: 1n, to: TREASURY, data: '0x' });
      chain.add({ hash: pay.hash, from: account.address, nonce: 0n, to: TREASURY, block: 100n });
      chain.add({ hash: act.hash, from: account.address, nonce: 1n, to: TREASURY, block: 136n });
      store.add(paymentRow({ id: 'i2', state: 'INCLUDED', account, nonce: 0n, raw: pay.raw, txHash: pay.hash, payment: spend.payment, block: 100n }));
      store.add(actionRow({ id: 'i3', state: 'INCLUDED', account, nonce: 1n, raw: act.raw, txHash: act.hash, block: 136n }));
      const outs = await advance();
      expect(outs.map((o) => [o.target.id, o.action, o.toState])).toEqual([
        ['i2', 'finalized', 'FINALIZED'],
        ['i3', 'finalized', 'FINALIZED'],
      ]);
    });

    it('a final receipt from a block that is not the canonical block at its height writes nothing terminal (FINALIZED / REVERTED / landed)', async () => {
      const stale = keccak256(toHex('reorged-out block'));
      const spend = spendPayment('inv-stale');
      const ok = await signedTx(account, { nonce: 0n, to: TREASURY, data: spend.data });
      const act = await signedTx(account, { nonce: 1n, to: TREASURY, data: '0x' });
      const dropped = spendPayment('inv-stale-dropped');
      const mine = await signedTx(account, { nonce: 2n, to: TREASURY, data: dropped.data });
      chain.add({ hash: ok.hash, from: account.address, nonce: 0n, to: TREASURY, block: 100n, receiptBlockHash: stale });
      chain.add({
        hash: act.hash, from: account.address, nonce: 1n, to: TREASURY, block: 101n, status: 'reverted', receiptBlockHash: stale,
        revertData: encodeErrorResult({ abi: iTreasuryAbi, errorName: 'CapExceeded' }),
      });
      chain.add({ hash: mine.hash, from: account.address, nonce: 2n, to: TREASURY, block: 102n, receiptBlockHash: stale });
      const p = store.add(paymentRow({ id: 's1', state: 'INCLUDED', account, nonce: 0n, raw: ok.raw, txHash: ok.hash, payment: spend.payment, block: 100n }));
      const a = store.add(actionRow({ id: 's2', state: 'INCLUDED', account, nonce: 1n, raw: act.raw, txHash: act.hash, block: 101n }));
      const d = store.add(paymentRow({ id: 's3', state: 'DROPPED', account, nonce: 2n, raw: mine.raw, txHash: mine.hash, payment: dropped.payment }));

      const outs = await advance();
      expect(outs.map((o) => [o.target.id, o.toState])).toEqual([
        ['s1', 'INCLUDED'],
        ['s2', 'INCLUDED'],
        ['s3', 'INCLUDED'],
      ]);
      expect(outs.find((o) => o.target.id === 's1')).toMatchObject({ action: 'pending', detail: expect.stringMatching(/canonical/) });
      expect(store.get(p.target).state).toBe('INCLUDED');
      expect(store.get(a.target).state).toBe('INCLUDED');
      expect(store.get(d.target).state).toBe('INCLUDED'); // landed by its canonical consumer block, never finalized from the stale receipt
      expect(store.holdsIntent(d.target)).toBe(true);

      chain.find(ok.hash)!.receiptBlockHash = undefined; // the node now serves the canonical receipt
      const [again] = await advance();
      expect(again).toMatchObject({ target: p.target, action: 'finalized', toState: 'FINALIZED' });
    });

    it('a receipt that vanished (reorg) moves a payment to DROPPED (intent kept) and a chain action back to BROADCAST', async () => {
      const spend = spendPayment('inv-reorg');
      const pay = await signedTx(account, { nonce: 0n, to: TREASURY, data: spend.data });
      const act = await signedTx(account, { nonce: 1n, to: TREASURY, data: '0x' });
      const p = store.add(paymentRow({ id: 'i4', state: 'INCLUDED', account, nonce: 0n, raw: pay.raw, txHash: pay.hash, payment: spend.payment, block: 199n }));
      const a = store.add(actionRow({ id: 'i5', state: 'INCLUDED', account, nonce: 1n, raw: act.raw, txHash: act.hash, block: 199n }));
      const outs = await advance();
      expect(outs.map((o) => [o.target.id, o.action, o.toState])).toEqual([
        ['i4', 'reorged', 'DROPPED'],
        ['i5', 'reorged', 'BROADCAST'],
      ]);
      expect(store.holdsIntent(p.target)).toBe(true);
      expect(store.get(a.target).state).toBe('BROADCAST');
    });
  });
});
