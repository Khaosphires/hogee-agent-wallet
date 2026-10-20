/**
 * Crash recovery decisions (§12.3, G0-AUDIT v-4) against an in-memory chain and row store. Recovery takes no
 * signer at all; these tests also check that the only bytes it ever hands to the node are the stored ones.
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildPause, DeploymentMismatchError, recoverWithStore, type RecoveryClient, type RecoveryOptions } from '../src/index';
import { FakeChain, signedTx } from './fixtures/fake-chain';
import { MemoryRowStore } from './fixtures/memory-rows';
import { actionRow, CHAIN, DEPLOYMENT, FACILITY, originalAndBump, paymentRow, spendPayment, TREASURY } from './fixtures/signed-rows';

const account = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const OPTS: RecoveryOptions = { chainId: CHAIN, deployment: DEPLOYMENT, facilityId: FACILITY };

describe('recoverWithStore', () => {
  let chain: FakeChain;
  let store: MemoryRowStore;
  let used: boolean;
  const recover = () => recoverWithStore(store, chain.client as unknown as RecoveryClient, OPTS);

  beforeEach(() => {
    chain = new FakeChain();
    store = new MemoryRowStore();
    used = false;
    chain.view = (fn) => {
      if (fn === 'isIntentUsed') return used;
      throw new Error(`unexpected view ${fn}`);
    };
  });

  it('never signs a new tx for a DROPPED intent: it re-sends the SAME stored bytes and the row stays DROPPED', async () => {
    const spend = spendPayment('inv-dropped');
    const { bump } = await originalAndBump(account, 0n, TREASURY, spend.data);
    const row = store.add(paymentRow({ id: 'p1', state: 'DROPPED', account, nonce: 0n, raw: bump.raw, txHash: bump.hash, payment: spend.payment }));

    const [out] = await recover();
    expect(out).toMatchObject({ action: 'rebroadcast', fromState: 'DROPPED', toState: 'DROPPED', storedTxHash: bump.hash });
    expect(chain.sent).toEqual([bump.raw]);
    expect(store.get(row.target)).toMatchObject({ state: 'DROPPED', rawSignedTx: bump.raw, txHash: bump.hash });
    expect(store.holdsIntent(row.target)).toBe(true);
  });

  it('a DROPPED row whose nonce is consumed is left for the finalized nonce watcher; nothing is sent', async () => {
    const spend = spendPayment('inv-consumed');
    const mine = await signedTx(account, { nonce: 0n, to: TREASURY, data: spend.data });
    const cancel = await signedTx(account, { nonce: 0n, to: account.address, data: '0x' });
    chain.add({ hash: cancel.hash, from: account.address, nonce: 0n, to: account.address, block: chain.head });
    const row = store.add(paymentRow({ id: 'p2', state: 'DROPPED', account, nonce: 0n, raw: mine.raw, txHash: mine.hash, payment: spend.payment }));

    const [out] = await recover();
    expect(out).toMatchObject({ action: 'dropped', toState: 'DROPPED' });
    expect(chain.sent).toEqual([]);
    expect(store.holdsIntent(row.target)).toBe(true);
  });

  it('a BROADCAST row whose nonce a foreign tx consumed becomes DROPPED and keeps its intent', async () => {
    const spend = spendPayment('inv-foreign');
    const mine = await signedTx(account, { nonce: 0n, to: TREASURY, data: spend.data });
    const cancel = await signedTx(account, { nonce: 0n, to: account.address, data: '0x' });
    chain.add({ hash: cancel.hash, from: account.address, nonce: 0n, to: account.address, block: chain.head });
    const row = store.add(paymentRow({ id: 'p3', state: 'BROADCAST', account, nonce: 0n, raw: mine.raw, txHash: mine.hash, payment: spend.payment }));

    const [out] = await recover();
    expect(out).toMatchObject({ action: 'dropped', fromState: 'BROADCAST', toState: 'DROPPED' });
    expect(store.get(row.target).state).toBe('DROPPED');
    expect(store.holdsIntent(row.target)).toBe(true);
    expect(chain.sent).toEqual([]);
  });

  it('records the landing of a superseded (pre-bump) hash: tx_hash = the landed hash, the bump moves to superseded', async () => {
    const spend = spendPayment('inv-bumped');
    const { original, bump } = await originalAndBump(account, 0n, TREASURY, spend.data);
    chain.add({ hash: original.hash, raw: original.raw, from: account.address, nonce: 0n, to: TREASURY, input: spend.data, block: chain.head });
    const row = store.add(
      paymentRow({ id: 'p4', state: 'BROADCAST', account, nonce: 0n, raw: bump.raw, txHash: bump.hash, superseded: [original.hash], payment: spend.payment }),
    );

    const [out] = await recover();
    expect(out).toMatchObject({ action: 'included', toState: 'INCLUDED', onchainTxHash: original.hash, receiptStatus: 'success', block: chain.head });
    expect(store.get(row.target)).toMatchObject({ state: 'INCLUDED', txHash: original.hash, supersededTxHashes: [bump.hash], block: chain.head });
    // The row's bytes are the mined tx's own (rebuilt from the node's copy), so keccak256(raw) = tx_hash in the evidence.
    expect(store.get(row.target).rawSignedTx).toBe(original.raw);
    expect(chain.sent).toEqual([]);
  });

  it('a revert receipt that is not final leaves the row INCLUDED, still holding its intent', async () => {
    const spend = spendPayment('inv-revert');
    const mine = await signedTx(account, { nonce: 0n, to: TREASURY, data: spend.data });
    chain.add({ hash: mine.hash, from: account.address, nonce: 0n, to: TREASURY, input: spend.data, block: chain.head, status: 'reverted' });
    const row = store.add(paymentRow({ id: 'p5', state: 'BROADCAST', account, nonce: 0n, raw: mine.raw, txHash: mine.hash, payment: spend.payment }));

    const [out] = await recover();
    expect(out).toMatchObject({ action: 'included', toState: 'INCLUDED', receiptStatus: 'reverted' });
    expect(store.get(row.target).state).toBe('INCLUDED');
    expect(store.holdsIntent(row.target)).toBe(true);
  });

  it('a BROADCAST row the node forgot, with its nonce still free, becomes DROPPED and its same bytes are re-sent', async () => {
    const spend = spendPayment('inv-forgotten');
    const mine = await signedTx(account, { nonce: 0n, to: TREASURY, data: spend.data });
    const row = store.add(paymentRow({ id: 'p6', state: 'BROADCAST', account, nonce: 0n, raw: mine.raw, txHash: mine.hash, payment: spend.payment }));

    const [out] = await recover();
    expect(out).toMatchObject({ action: 'rebroadcast', fromState: 'BROADCAST', toState: 'DROPPED' });
    expect(chain.sent).toEqual([mine.raw]);
    expect(store.holdsIntent(row.target)).toBe(true);
  });

  it('a SIGNED row that never reached the node is sent as stored and marked BROADCAST', async () => {
    const spend = spendPayment('inv-signed');
    const mine = await signedTx(account, { nonce: 0n, to: TREASURY, data: spend.data });
    store.add(paymentRow({ id: 'p7', state: 'SIGNED', account, nonce: 0n, raw: mine.raw, txHash: mine.hash, payment: spend.payment }));

    const [out] = await recover();
    expect(out).toMatchObject({ action: 'rebroadcast', fromState: 'SIGNED', toState: 'BROADCAST' });
    expect(chain.sent).toEqual([mine.raw]);
  });

  it('does not re-send when the intent was executed by a tx that is not the row’s; reports unresolved', async () => {
    const spend = spendPayment('inv-elsewhere');
    const mine = await signedTx(account, { nonce: 0n, to: TREASURY, data: spend.data });
    const other = await signedTx(stranger, { nonce: 0n, to: TREASURY, data: spend.data });
    chain.add({
      hash: other.hash, from: stranger.address, nonce: 0n, to: TREASURY, block: chain.head,
      logs: [{ address: TREASURY, eventName: 'Spent', args: { spendId: spend.payment.intentId } }],
    });
    used = true;
    const row = store.add(paymentRow({ id: 'p8', state: 'BROADCAST', account, nonce: 0n, raw: mine.raw, txHash: mine.hash, payment: spend.payment }));

    const [out] = await recover();
    expect(out).toMatchObject({ action: 'unresolved', toState: 'BROADCAST' });
    expect(chain.sent).toEqual([]);
    expect(store.get(row.target).txHash).toBe(mine.hash);
  });

  it('isolates rows: one whose RPC reads fail is an `error` outcome (short reason, no provider URL); other signers’ rows still recover', async () => {
    const poisoned = privateKeyToAccount(generatePrivateKey());
    chain.poisoned.add(poisoned.address.toLowerCase());
    const bad = spendPayment('inv-poisoned');
    const badTx = await signedTx(poisoned, { nonce: 0n, to: TREASURY, data: bad.data });
    store.add(paymentRow({ id: 'x1', state: 'BROADCAST', account: poisoned, nonce: 0n, raw: badTx.raw, txHash: badTx.hash, payment: bad.payment }));
    const good = spendPayment('inv-healthy');
    const goodTx = await signedTx(account, { nonce: 0n, to: TREASURY, data: good.data });
    store.add(paymentRow({ id: 'x2', state: 'SIGNED', account, nonce: 0n, raw: goodTx.raw, txHash: goodTx.hash, payment: good.payment }));

    const outs = await recover();
    const failed = outs.find((o) => o.target.id === 'x1');
    expect(failed).toMatchObject({ action: 'error', fromState: 'BROADCAST', toState: 'BROADCAST', storedTxHash: badTx.hash });
    expect(failed?.detail).toMatch(/HTTP request failed/);
    expect(failed?.detail).not.toMatch(/sk-not-a-real-key|https?:\/\//);
    expect(outs.find((o) => o.target.id === 'x2')).toMatchObject({ action: 'rebroadcast', toState: 'BROADCAST' });
    expect(chain.sent).toEqual([goodTx.raw]);
  });

  it('is scoped to one facility (one deployment): facilityId is required and other facilities’ rows are not touched', async () => {
    const spend = spendPayment('inv-other-facility');
    const tx = await signedTx(account, { nonce: 0n, to: TREASURY, data: spend.data });
    const row = paymentRow({ id: 'o1', state: 'SIGNED', account, nonce: 0n, raw: tx.raw, txHash: tx.hash, payment: spend.payment });
    store.add({ ...row, target: { ...row.target, facilityId: 'fac-other' } });
    expect(await recover()).toEqual([]);
    expect(chain.sent).toEqual([]);
    const client = chain.client as unknown as RecoveryClient;
    await expect(recoverWithStore(store, client, { ...OPTS, facilityId: '' })).rejects.toThrow(/facilityId/);
    const unscoped = { chainId: CHAIN, deployment: DEPLOYMENT } as unknown as RecoveryOptions;
    await expect(recoverWithStore(store, client, unscoped)).rejects.toThrow(/facilityId/);
    expect(chain.sent).toEqual([]);
  });

  it('is bound to the facility deployment: another deployment, or an unknown facility, throws before any row or chain read', async () => {
    const spend = spendPayment('inv-wrong-deployment');
    const mine = await signedTx(account, { nonce: 0n, to: TREASURY, data: spend.data });
    const row = store.add(paymentRow({ id: 'w1', state: 'BROADCAST', account, nonce: 0n, raw: mine.raw, txHash: mine.hash, payment: spend.payment }));
    const client = chain.client as unknown as RecoveryClient;
    const loop = { ...DEPLOYMENT, deploymentId: 'loop-1' };
    await expect(recoverWithStore(store, client, { ...OPTS, deployment: loop })).rejects.toThrow(DeploymentMismatchError);
    await expect(recoverWithStore(store, client, { ...OPTS, facilityId: 'fac-missing' })).rejects.toThrow(/facility not found/);
    const otherChain = { ...DEPLOYMENT, chainId: 11155111 };
    await expect(recoverWithStore(store, client, { ...OPTS, deployment: otherChain })).rejects.toThrow(DeploymentMismatchError);
    expect(store.listCalls).toBe(0);
    expect([chain.sent, chain.reads, chain.countCalls]).toEqual([[], [], []]);
    expect(store.get(row.target).state).toBe('BROADCAST');
  });

  it('a twin whose bytes cannot be rebuilt (or do not hash back) still lands; the stored bytes stay as they were', async () => {
    const data = buildPause().data;
    const { original, bump } = await originalAndBump(account, 0n, TREASURY, data);
    chain.add({ hash: original.hash, from: account.address, nonce: 0n, to: TREASURY, input: data, block: chain.head });
    const twin = store.add(actionRow({ id: 'a3', state: 'BROADCAST', account, nonce: 0n, raw: bump.raw, txHash: bump.hash }));
    const [out] = await recover();
    expect(out).toMatchObject({ action: 'included', toState: 'INCLUDED', onchainTxHash: original.hash });
    expect(store.get(twin.target)).toMatchObject({ state: 'INCLUDED', txHash: original.hash, rawSignedTx: bump.raw });
  });

  it('chain action: a same-call twin at its nonce is recorded INCLUDED; a different call is left unresolved', async () => {
    const data = buildPause().data;
    const { original, bump } = await originalAndBump(account, 0n, TREASURY, data);
    chain.add({ hash: original.hash, raw: original.raw, from: account.address, nonce: 0n, to: TREASURY, input: data, block: chain.head });
    const twin = store.add(actionRow({ id: 'a1', state: 'BROADCAST', account, nonce: 0n, raw: bump.raw, txHash: bump.hash }));

    const other = privateKeyToAccount(generatePrivateKey());
    const mine = await signedTx(other, { nonce: 0n, to: TREASURY, data });
    const cancel = await signedTx(other, { nonce: 0n, to: other.address, data: '0x' });
    chain.add({ hash: cancel.hash, from: other.address, nonce: 0n, to: other.address, block: chain.head });
    const foreign = store.add(actionRow({ id: 'a2', state: 'BROADCAST', account: other, nonce: 0n, raw: mine.raw, txHash: mine.hash }));

    const outs = await recover();
    expect(outs.find((o) => o.target.id === 'a1')).toMatchObject({ action: 'included', toState: 'INCLUDED', onchainTxHash: original.hash });
    expect(store.get(twin.target)).toMatchObject({ state: 'INCLUDED', txHash: original.hash, rawSignedTx: original.raw });
    expect(outs.find((o) => o.target.id === 'a2')).toMatchObject({ action: 'unresolved', toState: 'BROADCAST' });
    expect(store.get(foreign.target).state).toBe('BROADCAST');
    expect(chain.sent).toEqual([]);
  });
});
