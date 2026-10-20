import { milestoneSettlementId, toBytes32Tag } from '@hogee/chain';
import { keccak256, parseTransaction, toHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { serializeSignedTx } from '../../src/jobs/settle-adopt';
import { rowSettlementId } from '../../src/jobs/settle-binding';
import { bytes32OfShortId, deploymentKeyScope, shortIdOfBytes32, type SettlementRow } from '../../src/jobs/settle-chain';

const h = (label: string): Hex => keccak256(toHex(label));

function row(over: Partial<SettlementRow> = {}): SettlementRow {
  return {
    kind: 'SPEND',
    intent_id: h('intent'),
    line_id: toBytes32Tag('ADS'),
    payee_id: 'shopee-ads',
    order_id: null,
    milestone_idx: null,
    amount_minor: '7500',
    invoice_hash: h('invoice'),
    plan_version: 1,
    decision_id: null,
    rationale_hash: null,
    tx_hash: h('tx'),
    xendit_account_ref: null,
    payout_account_hash: h('account'),
    ...over,
  };
}

describe('rowSettlementId', () => {
  it('is the intent for spends, owner spends, milestone releases and reserve withdrawals', () => {
    for (const kind of ['SPEND', 'OWNER_SPEND', 'RELEASE_MILESTONE', 'WITHDRAW_RESERVE'] as const) expect(rowSettlementId(row({ kind }))).toBe(h('intent'));
  });

  it("is the milestone's settlement id for a funding that auto-released it (never the funding key)", () => {
    const r = row({ kind: 'FUND_MILESTONE', order_id: 'order-a-001', milestone_idx: 2 });
    expect(rowSettlementId(r)).toBe(milestoneSettlementId(toBytes32Tag('order-a-001'), 2));
    expect(rowSettlementId({ ...r, order_id: 'Not A ShortId' })).toBeNull();
    expect(rowSettlementId({ ...r, milestone_idx: 256 })).toBeNull();
    expect(rowSettlementId({ ...r, milestone_idx: null })).toBeNull();
  });
});

describe('deploymentKeyScope (milestone and reserve keys: no on-chain invoice, and order ids repeat across deployments)', () => {
  it('differs per chain and per Treasury, and is never zero', () => {
    const a = toBytes32Tag('treasury-a').slice(0, 42) as Hex;
    const b = toBytes32Tag('treasury-b').slice(0, 42) as Hex;
    expect(deploymentKeyScope(31337, a)).not.toBe(deploymentKeyScope(31337, b));
    expect(deploymentKeyScope(31337, a)).not.toBe(deploymentKeyScope(11155111, a));
    expect(deploymentKeyScope(31337, a)).not.toBe(`0x${'0'.repeat(64)}`);
  });
});

describe('ShortId <-> bytes32', () => {
  it('round-trips a ShortId and refuses anything else', () => {
    expect(shortIdOfBytes32(toBytes32Tag('lhdn-tax'))).toBe('lhdn-tax');
    expect(bytes32OfShortId('lhdn-tax')).toBe(toBytes32Tag('lhdn-tax'));
    expect(shortIdOfBytes32(toBytes32Tag('Upper Case'))).toBeNull();
    expect(shortIdOfBytes32(`0x${'0'.repeat(64)}`)).toBeNull();
    expect(shortIdOfBytes32(h('not a tag'))).toBeNull();
    expect(bytes32OfShortId('Not A ShortId')).toBeNull();
    expect(bytes32OfShortId('')).toBeNull();
  });
});

describe('serializeSignedTx (a third party executed the loosening: its bytes are rebuilt from the chain)', () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const to = toBytes32Tag('treasury').slice(0, 42) as Hex;

  async function roundTrip(signed: Hex): Promise<Hex | null> {
    const p = parseTransaction(signed);
    return serializeSignedTx({ ...p, input: p.data ?? '0x' } as never);
  }

  it('rebuilds EIP-1559 and legacy (EIP-155) transactions byte for byte', async () => {
    const eip1559 = await account.signTransaction({ type: 'eip1559', chainId: 31337, nonce: 7, gas: 90_000n, maxFeePerGas: 3n, maxPriorityFeePerGas: 1n, to, value: 0n, data: '0xabcdef' });
    expect(await roundTrip(eip1559)).toBe(eip1559);
    const legacy = await account.signTransaction({ type: 'legacy', chainId: 31337, nonce: 8, gas: 90_000n, gasPrice: 2n, to, value: 0n, data: '0x01' });
    expect(await roundTrip(legacy)).toBe(legacy);
  });

  it('refuses a transaction type it cannot rebuild', () => {
    expect(serializeSignedTx({ type: 'eip4844' } as never)).toBeNull();
  });
});
