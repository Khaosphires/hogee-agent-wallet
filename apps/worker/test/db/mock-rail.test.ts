/** MockRail on Postgres (TEST_DATABASE_URL): idempotent per key, same key = same body, Xendit's staged test failures (§9.1 step 5). */
import type { Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockRail } from '../../src/rail/mock-rail';
import { PayoutConflictError, parsePayoutAccountRef, payoutAccountRef, payoutIdempotencyKey, type PayoutDestination } from '../../src/rail/rail';
import { DB_SETUP_TIMEOUT_MS, DB_URL, openTestDb, type TestDb } from '../support/db';

const h = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const account = (accountNumber = '1000000001'): PayoutDestination => ({ channel: 'MY_DUITNOW', accountNumber, holderName: 'Shopee Ads Test' });

describe('payoutIdempotencyKey', () => {
  it('derives from the on-chain spendId, the invoice and the attempt only, and fits Xendit’s 100-char limit', () => {
    const base = { settlementId: h(9), invoiceHash: h(3), attempt: 1 };
    const key = payoutIdempotencyKey(base);
    expect(key).toMatch(/^0x[0-9a-f]{64}$/);
    expect(payoutIdempotencyKey({ ...base, attempt: 2 })).not.toBe(key);
    expect(payoutIdempotencyKey({ ...base, settlementId: h(10) })).not.toBe(key); // two pacing lines, same slot
    expect(payoutIdempotencyKey({ ...base, invoiceHash: h(4) })).not.toBe(key);
    expect(payoutIdempotencyKey(base)).toBe(key);
  });
});

describe('payout account refs', () => {
  it('round-trip the exact account fields and refuse anything else', () => {
    const ref = payoutAccountRef(account());
    expect(parsePayoutAccountRef(ref)).toEqual(account());
    expect(parsePayoutAccountRef('test-1000000001')).toBeNull();
    expect(parsePayoutAccountRef(null)).toBeNull();
    expect(parsePayoutAccountRef(JSON.stringify({ ...account(), extra: 1 }))).toBeNull();
  });
});

describe.skipIf(!DB_URL)('MockRail (Postgres)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await openTestDb();
    await t.db.$client.query('truncate hogee_worker.mock_payouts');
  }, DB_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await t?.close();
  });

  const req = (key: string, destination = account()) => ({ idempotencyKey: key, referenceId: `0xabc:1`, amountMinor: 7_500n, currency: 'MYR', destination });

  it('the same idempotency key with the same body returns the original payout (no second payout)', async () => {
    const rail = new MockRail(t.db.$client);
    const first = await rail.requestPayout(req('k-1'));
    const again = await rail.requestPayout(req('k-1'));
    expect(first.status).toBe('SUCCEEDED');
    expect(again).toEqual(first);
    const n = await t.db.$client.query(`select count(*)::int as n from hogee_worker.mock_payouts where idempotency_key = 'k-1'`);
    expect(n.rows[0].n).toBe(1);
    expect(await rail.getPayout(first.payoutId)).toEqual(first);
    expect(await rail.findPayout({ idempotencyKey: 'k-1', referenceId: '0xabc:1' })).toEqual(first);
    expect(await rail.findPayout({ idempotencyKey: 'k-unknown', referenceId: '0xabc:9' })).toBeNull();
  });

  it.each([
    ['amount', { amountMinor: 9_999n }],
    ['currency', { currency: 'IDR' }],
    ['destination', { destination: account('1000000009') }],
  ])('refuses a reused key with another %s (Xendit: same key, same body)', async (_l, patch) => {
    const rail = new MockRail(t.db.$client);
    const key = `k-conflict-${_l}`;
    await rail.requestPayout(req(key));
    await expect(rail.requestPayout({ ...req(key), ...patch })).rejects.toBeInstanceOf(PayoutConflictError);
  });

  it('stages Xendit test failures by destination account', async () => {
    const rail = new MockRail(t.db.$client);
    expect(await rail.requestPayout(req('k-2', account('9000121212')))).toMatchObject({ status: 'FAILED', failureCode: 'INVALID_DESTINATION' });
    expect(await rail.requestPayout(req('k-3', account('9000123456')))).toMatchObject({ status: 'FAILED', failureCode: 'TEMPORARY_TRANSFER_ERROR' });
  });

  it('a pending payout settles on the next poll', async () => {
    const rail = new MockRail(t.db.$client, { pending: true });
    const p = await rail.requestPayout(req('k-4'));
    expect(p.status).toBe('PENDING');
    expect((await rail.getPayout(p.payoutId)).status).toBe('SUCCEEDED');
  });
});
