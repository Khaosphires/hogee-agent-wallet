import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { computeDrift, maxWindowSum, type PaymentFact, type SpentFact } from '../../src/harness/report';

const h = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const DAY = 86_400n;

function spent(n: number, over: Partial<SpentFact> = {}): SpentFact {
  return { spendId: h(n), txHash: h(100 + n), lineId: h(7), amountMinor: 7_500n, timestamp: BigInt(n) * DAY, rationaleHash: h(200 + n), ...over };
}
function pay(n: number, over: Partial<PaymentFact> = {}): PaymentFact {
  return { id: `p-${n}`, intentId: h(n), txHash: h(100 + n), state: 'SETTLED', amountMinor: 7_500n, rationaleHash: h(200 + n), ...over };
}

describe('computeDrift', () => {
  it('is zero when every Spent matches one mined payment and every mined payment has its Spent', () => {
    expect(computeDrift([spent(1), spent(2)], [pay(1), pay(2), pay(3, { state: 'SIGNED', txHash: null })])).toEqual({ orphanLogs: [], missingLogs: [], mismatches: [], total: 0 });
  });

  it('counts a Spent without its payment row (orphan), a mined row without a Spent, and amount/rationale mismatches', () => {
    const d = computeDrift([spent(1), spent(2, { amountMinor: 9_000n }), spent(4, { rationaleHash: h(999) })], [pay(1), pay(2), pay(3, { state: 'FINALIZED' }), pay(4)]);
    expect(d.orphanLogs.map((l) => l.spendId)).toEqual([h(4)]);
    expect(d.missingLogs.map((p) => p.id)).toEqual(['p-3', 'p-4']);
    expect(d.mismatches).toEqual(['p-2: amount 7500 on the row, 9000 on chain']);
    expect(d.total).toBe(4);
  });
});

describe('maxWindowSum', () => {
  it('is the largest rolling-window sum seen at any spend (entries live while spentAt + window > now)', () => {
    const daily = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((d) => spent(d, { timestamp: BigInt(d) * DAY }));
    expect(maxWindowSum(daily, 7n * DAY)).toBe(52_500n); // the day-0 spend leaves the window exactly at day 7
    const jittered = [...daily.slice(0, 7), spent(9, { timestamp: 7n * DAY - 1n })];
    expect(maxWindowSum(jittered, 7n * DAY)).toBe(60_000n);
  });
});
