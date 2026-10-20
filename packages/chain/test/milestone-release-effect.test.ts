/**
 * RELEASE_MILESTONE after a failed payout (final-1, M8, re-check M-1). Treasury.failSettlement returns the BU to the
 * supplier line; MilestoneEscrow.milestones(orderId)[idx].released stays true and Treasury.settlementState of the
 * milestone's settlementId reads FAILED (closed for good). Intent reads must see the release as executed: recovery
 * never re-sends it and the nonce watcher never CANCELs it. The settlement read also covers an escrow that reads the
 * milestone unreleased beside a closed settlement (the pre-M-1 escrow did so after a failed payout): still executed.
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  advanceFinalityWithStore,
  HOGEE_KINDS,
  intentEffect,
  probeIntent,
  recoverWithStore,
  releaseMilestoneIntentId,
  shortIdToBytes32,
  toBytes32Tag,
  type FinalityClient,
  type PaymentIntentFields,
  type RecoveryClient,
} from '../src/index';
import { FakeChain, signedTx } from './fixtures/fake-chain';
import { MemoryRowStore } from './fixtures/memory-rows';
import { CHAIN, DEPLOYMENT, ESCROW, FACILITY, paymentRow, spendPayment, TREASURY } from './fixtures/signed-rows';

const account = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const CONTRACTS = { Treasury: TREASURY, MilestoneEscrow: ESCROW };
const ORDER = 'order-a-001';
const IDX = 2;
const SETTLEMENT_ID = releaseMilestoneIntentId({ orderId: shortIdToBytes32(ORDER), idx: IDX });
const OPTS = { chainId: CHAIN, deployment: DEPLOYMENT, facilityId: FACILITY };

const RELEASE: PaymentIntentFields = {
  ...spendPayment('inv-release').payment,
  kind: 'RELEASE_MILESTONE',
  intentId: SETTLEMENT_ID,
  lineId: toBytes32Tag('SUPPLIER'),
  payeeId: 'supplier-a',
  orderId: ORDER,
  milestoneIdx: IDX,
  amountMinor: '280000',
  decisionId: null,
  rationaleHash: null,
};

const { SETTLEMENT_NONE: NONE, SETTLEMENT_CONFIRMED: CONFIRMED, SETTLEMENT_FAILED: FAILED } = HOGEE_KINDS;
const ZERO = `0x${'0'.repeat(64)}` as const;
const milestone = (released: boolean) => ({ amountMinor: 280_000n, fundedMinor: 280_000n, autoRelease: false, released, evidenceHash: ZERO });

/** Escrow and Treasury views: the balance milestone's `released` flag and its settlement state. */
function setViews(chain: FakeChain, s: { released: boolean; settlement: number }): void {
  chain.view = (fn, args) => {
    if (fn === 'milestones') return [milestone(true), milestone(true), milestone(s.released)];
    if (fn === 'settlementState') return String(args[0]).toLowerCase() === SETTLEMENT_ID.toLowerCase() ? s.settlement : NONE;
    throw new Error(`unexpected view ${fn}`);
  };
}

const releasedLog = { address: ESCROW, eventName: 'MilestoneReleased', args: { orderId: shortIdToBytes32(ORDER), idx: IDX } };

describe('intentEffect: RELEASE_MILESTONE = released, or a closed settlement for the milestone', () => {
  it.each<[string, string, boolean, number]>([
    ['released, payout open', 'present', true, NONE],
    ['released, payout confirmed', 'present', true, CONFIRMED],
    ['released, then the payout failed (released stays true: re-check M-1)', 'present', true, FAILED],
    ['reads unreleased beside a FAILED settlement (pre-M-1 escrow)', 'present', false, FAILED],
    ['reads unreleased beside a CONFIRMED settlement', 'present', false, CONFIRMED],
    ['never released', 'absent', false, NONE],
  ])('%s → %s', async (_name, want, released, settlement) => {
    const chain = new FakeChain();
    setViews(chain, { released, settlement });
    expect(await intentEffect(chain.client as unknown as FinalityClient, RELEASE, { contracts: CONTRACTS, blockNumber: 136n })).toBe(want);
  });

  it('reads Treasury.settlementState of the milestone settlementId at the same block', async () => {
    const chain = new FakeChain();
    setViews(chain, { released: false, settlement: FAILED });
    await intentEffect(chain.client as unknown as FinalityClient, RELEASE, { contracts: CONTRACTS, blockNumber: 136n });
    expect(chain.reads).toEqual([
      { address: ESCROW, functionName: 'milestones', args: [shortIdToBytes32(ORDER)], blockNumber: 136n },
      { address: TREASURY, functionName: 'settlementState', args: [SETTLEMENT_ID], blockNumber: 136n },
    ]);
  });

  it('probeIntent: executed (not "not_executed") once the payout failed, with no event in the lookback window', async () => {
    const chain = new FakeChain();
    setViews(chain, { released: false, settlement: FAILED });
    expect(await probeIntent(chain.client as unknown as RecoveryClient, RELEASE, { contracts: CONTRACTS })).toEqual({ status: 'executed' });
  });
});

describe('recovery and the nonce watcher after a failed release payout', () => {
  let chain: FakeChain;
  let store: MemoryRowStore;

  beforeEach(() => {
    chain = new FakeChain(); // head 200, finalized 136
    store = new MemoryRowStore();
    setViews(chain, { released: true, settlement: FAILED }); // re-check M-1: the failed release stays released
  });

  it('recovery does not re-send a release another tx executed (its payout failed since): unresolved, nothing sent', async () => {
    const mine = await signedTx(account, { nonce: 0n, to: ESCROW, data: '0x' });
    const other = await signedTx(stranger, { nonce: 0n, to: ESCROW, data: '0x' });
    chain.add({ hash: other.hash, from: stranger.address, nonce: 0n, to: ESCROW, block: 100n, logs: [releasedLog] }); // outside the lookback
    const row = store.add(paymentRow({ id: 'r1', state: 'BROADCAST', account, nonce: 0n, raw: mine.raw, txHash: mine.hash, payment: RELEASE }));

    const [out] = await recoverWithStore(store, chain.client as unknown as RecoveryClient, OPTS);
    expect(out).toMatchObject({ action: 'unresolved', toState: 'BROADCAST' });
    expect(chain.sent).toEqual([]);
    expect(store.holdsIntent(row.target)).toBe(true);
  });

  it('a DROPPED release whose nonce a foreign tx consumed is not CANCELLED while the release stands (failed payout)', async () => {
    const mine = await signedTx(account, { nonce: 0n, to: ESCROW, data: '0x' });
    const cancel = await signedTx(account, { nonce: 0n, to: account.address, data: '0x' });
    const other = await signedTx(stranger, { nonce: 0n, to: ESCROW, data: '0x' });
    chain.add({ hash: cancel.hash, from: account.address, nonce: 0n, to: account.address, block: 120n });
    chain.add({ hash: other.hash, from: stranger.address, nonce: 0n, to: ESCROW, block: 110n, logs: [releasedLog] });
    const row = store.add(paymentRow({ id: 'r2', state: 'DROPPED', account, nonce: 0n, raw: mine.raw, txHash: mine.hash, payment: RELEASE }));

    const [out] = await advanceFinalityWithStore(store, chain.client as unknown as FinalityClient, OPTS);
    expect(out).toMatchObject({ action: 'unresolved', toState: 'DROPPED' });
    expect(store.holdsIntent(row.target)).toBe(true);
  });

  it('a foreign consumer that itself released the milestone → landed with its hash, even after the payout failed', async () => {
    const mine = await signedTx(account, { nonce: 0n, to: ESCROW, data: '0x' });
    const twin = await signedTx(account, { nonce: 0n, to: ESCROW, data: '0x01' });
    chain.add({ hash: twin.hash, from: account.address, nonce: 0n, to: ESCROW, input: '0x01', block: 120n, logs: [releasedLog] });
    store.add(paymentRow({ id: 'r3', state: 'DROPPED', account, nonce: 0n, raw: mine.raw, txHash: mine.hash, payment: RELEASE }));

    const [out] = await advanceFinalityWithStore(store, chain.client as unknown as FinalityClient, OPTS);
    expect(out).toMatchObject({ action: 'landed', toState: 'FINALIZED', txHash: twin.hash });
  });

  it('a release that never happened is still CANCELLED once a foreign tx took the nonce', async () => {
    setViews(chain, { released: false, settlement: NONE });
    const mine = await signedTx(account, { nonce: 0n, to: ESCROW, data: '0x' });
    const cancel = await signedTx(account, { nonce: 0n, to: account.address, data: '0x' });
    chain.add({ hash: cancel.hash, from: account.address, nonce: 0n, to: account.address, block: 120n });
    const row = store.add(paymentRow({ id: 'r4', state: 'DROPPED', account, nonce: 0n, raw: mine.raw, txHash: mine.hash, payment: RELEASE }));

    const [out] = await advanceFinalityWithStore(store, chain.client as unknown as FinalityClient, OPTS);
    expect(out).toMatchObject({ action: 'cancelled', consumedBy: cancel.hash });
    expect(store.holdsIntent(row.target)).toBe(false);
  });
});
