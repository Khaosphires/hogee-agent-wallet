import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { planPacingSlot } from '@hogee/core';
import { buildPolicyContext } from '../../src/chain/context';
import { inFlightAt, NO_LINE_IN_FLIGHT, pacingInFlightOf, type PaymentRow } from '../../src/jobs/inflight';
import { committed, rinaSnapshot, roles } from '../support/fixtures';

const h = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;

function row(over: Partial<PaymentRow>): PaymentRow {
  return {
    id: 'p',
    kind: 'SPEND',
    state: 'SIGNED',
    lineKey: 'ADS',
    payeeId: 'shopee-ads',
    amountMinor: '7500',
    intentId: h(1),
    invoiceHash: h(2),
    planVersion: 1,
    decisionId: '01890000-0000-7000-8000-000000000001',
    rationaleHash: h(3),
    signed: true,
    txHash: h(4),
    supersededTxHashes: [],
    block: null,
    ...over,
  };
}

const noReceipts = async () => null;
const PACING = new Set(['ADS'] as const);

describe('inFlightAt', () => {
  it('counts signed rows without a receipt at or below the snapshot block as in flight', async () => {
    const v = await inFlightAt([row({ id: 'a' }), row({ id: 'b', state: 'BROADCAST', intentId: h(9) })], 100n, noReceipts, PACING);
    expect(v.perLine.get('ADS')).toEqual({ slots: 2, lineMinor: 15_000n, dropped: 0, owner: { slots: 0, lineMinor: 0n } });
    expect(v.totalMinor).toBe(15_000n);
    expect(v.usedIntents.size).toBe(0);
  });

  it('a receipt at or below the block means the chain already shows the spend', async () => {
    const receipts = async (hash: Hex) => (hash === h(4) ? 90n : null);
    const v = await inFlightAt([row({ id: 'a' })], 100n, receipts, PACING);
    expect(v.perLine.get('ADS')).toBeUndefined();
    expect(v.usedIntents.has(h(1))).toBe(true);
    expect(v.paidInvoices.size).toBe(0); // pacing lines mark no invoice paid (Treasury._recordSpend)
  });

  it('a superseded hash that landed also counts as mined', async () => {
    const receipts = async (hash: Hex) => (hash === h(7) ? 95n : null);
    const v = await inFlightAt([row({ id: 'a', supersededTxHashes: [h(7)] })], 100n, receipts, PACING);
    expect(v.perLine.get('ADS')).toBeUndefined();
  });

  it('an INCLUDED row mined after the snapshot block is still in flight for that snapshot', async () => {
    const v = await inFlightAt([row({ id: 'a', state: 'INCLUDED', block: 101n })], 100n, noReceipts, PACING);
    expect(v.perLine.get('ADS')?.slots).toBe(1);
  });

  it('mined rows feed usedIntents and, on invoice lines, paidInvoices', async () => {
    const v = await inFlightAt(
      [row({ id: 'a', state: 'FINALIZED', block: 10n }), row({ id: 'b', state: 'SETTLED', block: 11n, lineKey: 'LOGISTICS', intentId: h(5), invoiceHash: h(6) })],
      100n,
      noReceipts,
      PACING,
    );
    expect([...v.usedIntents]).toEqual([h(1), h(5)]);
    expect([...v.paidInvoices]).toEqual([h(6)]);
    expect(v.totalMinor).toBe(0n);
  });

  it('flags DROPPED rows and ignores unsigned and released rows', async () => {
    const v = await inFlightAt(
      [
        row({ id: 'd', state: 'DROPPED' }),
        row({ id: 'u', state: 'POLICY_OK', signed: false, txHash: null }),
        row({ id: 'r', state: 'REVERTED', block: 5n }),
        row({ id: 'c', state: 'CANCELLED' }),
      ],
      100n,
      noReceipts,
      PACING,
    );
    expect(v.perLine.get('ADS')).toEqual({ slots: 1, lineMinor: 7_500n, dropped: 1, owner: { slots: 0, lineMinor: 0n } });
    expect(v.usedIntents.size).toBe(0);
  });

  it('an in-flight owner spend counts on its line (sequence and spent) and in the total; reserve withdrawals only in the total', async () => {
    const v = await inFlightAt(
      [row({ id: 'o', kind: 'OWNER_SPEND', lineKey: 'PACKAGING', amountMinor: '30000' }), row({ id: 'w', kind: 'WITHDRAW_RESERVE', lineKey: null, amountMinor: '1000' })],
      100n,
      noReceipts,
      PACING,
    );
    expect(v.totalMinor).toBe(30_000n);
    expect(v.perLine.get('PACKAGING')).toEqual({ slots: 0, lineMinor: 0n, dropped: 0, owner: { slots: 1, lineMinor: 30_000n } });
    expect(v.perLine.size).toBe(1);
  });

  it('a DROPPED owner spend is flagged like a dropped agent spend', async () => {
    const v = await inFlightAt([row({ id: 'o', kind: 'OWNER_SPEND', state: 'DROPPED' }), row({ id: 'a', intentId: h(9) })], 100n, noReceipts, PACING);
    expect(v.perLine.get('ADS')).toEqual({ slots: 1, lineMinor: 7_500n, dropped: 1, owner: { slots: 1, lineMinor: 7_500n } });
    expect(v.totalMinor).toBe(15_000n);
  });
});

describe('pacingInFlightOf', () => {
  const mined = { usedIntents: new Set<string>(), paidInvoices: new Set<string>() };

  it('passes the in-flight owner spends of the line to core (they take the next slot)', async () => {
    const v = await inFlightAt([row({ id: 'o', kind: 'OWNER_SPEND' })], 100n, noReceipts, PACING);
    const f = pacingInFlightOf(v.perLine.get('ADS'), v.totalMinor);
    expect(f).toEqual({ slots: 0, lineMinor: '0', owner: { slots: 1, lineMinor: '7500' }, totalMinor: '7500' });
    const ctx = buildPolicyContext({ snapshot: rinaSnapshot(), committed, roles, mined });
    // lineSequence 1 on chain; the founder's ownerSpend in flight holds slot 1, so the agent's next slot is 2.
    expect(planPacingSlot(ctx, 'ADS', f)).toMatchObject({ action: 'PROPOSE', pacingSlot: 2 });
  });

  it('a line with nothing in flight', () => {
    expect(pacingInFlightOf(undefined, 0n)).toEqual({ slots: 0, lineMinor: '0', owner: { slots: 0, lineMinor: '0' }, totalMinor: '0' });
    expect(NO_LINE_IN_FLIGHT).toEqual({ slots: 0, lineMinor: 0n, dropped: 0, owner: { slots: 0, lineMinor: 0n } });
  });
});
