/**
 * settle-spend routes each payout by the payee's channel (SG-DECISIONS "Payout rail", rail/route.ts), on Anvil +
 * Postgres with the worker's real router: MockRail plus a XenditRail (test-mode key) over a local Xendit double.
 *
 * - an SG payee (SG_PAYNOW, SGD facility) settles on MockRail, its PAYOUT trace says "simulated PayNow payout", and
 *   Xendit is never called;
 * - an MY payee (MY_DUITNOW, MYR) still pays out through Xendit test mode;
 * - an unknown channel, or a currency the channel does not carry, is refused before any rail call: no payout, no
 *   oracle attestation, one ALERT, no halt.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runReconcile } from '../../src/jobs/reconcile';
import { runSettle } from '../../src/jobs/settle';
import { runTick } from '../../src/jobs/tick';
import { MockRail } from '../../src/rail/mock-rail';
import type { PayoutDestination } from '../../src/rail/rail';
import { PayoutRouter } from '../../src/rail/route';
import { XenditRail } from '../../src/rail/xendit-rail';
import { activeHalt, clearHalt } from '../../src/store/halt';
import { silentLogger } from '../../src/runtime/log';
import { finalizeAll, LIVE, LIVE_TIMEOUT_MS, mined, newWorld, openLive, type Live, type World } from '../support/live';

/** Mei's Shopee Ads payee account (packages/api catalog/payees.ts): a synthetic PayNow UEN proxy. */
const SG_ADS: PayoutDestination = { channel: 'SG_PAYNOW', accountNumber: 'S99ZZ0001A', holderName: 'Shopee Ads SG Test' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A minimal Xendit Payouts v2 double (POST, GET by id, GET by reference_id): every payout SUCCEEDS; every call is kept. */
class XenditDouble {
  readonly calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  readonly #byId = new Map<string, Record<string, unknown>>();
  readonly fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    this.calls.push({ method: init.method ?? 'GET', path: url.pathname, ...(body ? { body } : {}) });
    if (init.method === 'POST') {
      const payout = { ...body, id: `disb-${this.#byId.size + 1}`, status: 'SUCCEEDED' };
      this.#byId.set(payout.id, payout);
      return json(200, payout);
    }
    const id = /^\/v2\/payouts\/([^/]+)$/.exec(url.pathname)?.[1];
    if (id) return this.#byId.has(id) ? json(200, this.#byId.get(id)) : json(404, { error_code: 'DATA_NOT_FOUND' });
    const ref = url.searchParams.get('reference_id');
    return json(200, { data: [...this.#byId.values()].filter((p) => p.reference_id === ref), has_more: false });
  };
}

describe.skipIf(!LIVE)('settle-spend payout routing by payee channel (Anvil + Postgres)', { timeout: LIVE_TIMEOUT_MS }, () => {
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

  const router = (xendit: XenditDouble) =>
    new PayoutRouter({ mock: new MockRail(live.db.$client), xendit: new XenditRail({ secretKey: `xnd_development_${randomBytes(36).toString('base64url')}`, fetch: xendit.fetch }) });

  async function world(o: { accounts?: Record<string, PayoutDestination>; currency?: string } = {}): Promise<World> {
    const w = await newWorld(live, o.accounts ? { accounts: o.accounts } : {});
    // harness/rina.ts stays MY: a Singapore facility differs only in its currency row (the chain holds no currency).
    if (o.currency) await live.db.$client.query('update facilities set currency = $2 where facility_id = $1', [w.facilityId, o.currency]);
    return w;
  }

  async function finalizedSpend(w: World): Promise<string> {
    const tick = await runTick(w.deps(), w.facilityId);
    await mined(live, tick);
    await runReconcile(w.deps(), [w.facilityId]);
    await finalizeAll(live);
    await runReconcile(w.deps(), [w.facilityId]);
    return tick.lines[0]?.paymentId as string;
  }

  async function mockPayouts(w: World): Promise<{ currency: string; destination: string }[]> {
    const r = await live.db.$client.query(
      `select m.currency, m.destination from hogee_worker.mock_payouts m where exists (select 1 from payments p where p.facility_id = $1 and m.reference_id like p.tx_hash || ':%')`,
      [w.facilityId],
    );
    return r.rows;
  }

  async function traces(w: World, paymentId: string, kind: string): Promise<{ summary: string; reason_code: string | null }[]> {
    const r = await live.db.$client.query(`select summary, reason_code from traces where facility_id = $1 and payment_id = $2 and kind = $3 order by seq`, [w.facilityId, paymentId, kind]);
    return r.rows;
  }

  const settleActions = async (w: World, paymentId: string): Promise<number> =>
    Number((await live.db.$client.query(`select count(*)::int as n from chain_actions where facility_id = $1 and ref_id = $2 and id like 'settle-%'`, [w.facilityId, paymentId])).rows[0].n);

  it('an SG payee (SG_PAYNOW, SGD) settles on MockRail as a simulated PayNow payout; Xendit is never called', async () => {
    const xendit = new XenditDouble();
    const w = await world({ accounts: { 'shopee-ads': SG_ADS }, currency: 'SGD' });
    const id = await finalizedSpend(w);
    const deps = w.deps({ rail: router(xendit) });
    expect((await runSettle(deps, [w.facilityId]))[0]?.payments).toEqual([expect.objectContaining({ paymentId: id, step: 'request_payout', detail: 'SUCCEEDED' })]);
    expect((await runSettle(deps, [w.facilityId]))[0]?.payments[0]).toMatchObject({ step: 'confirm' });
    await live.test.mine({ blocks: 1 });
    await finalizeAll(live);
    await runReconcile(deps, [w.facilityId]);
    expect((await runSettle(deps, [w.facilityId]))[0]?.payments[0]).toMatchObject({ step: 'close', detail: 'SETTLED' });
    expect(xendit.calls).toEqual([]);
    const paid = await mockPayouts(w);
    expect(paid).toHaveLength(1);
    expect(paid[0]?.currency).toBe('SGD');
    expect(JSON.parse(paid[0]?.destination ?? '{}')).toMatchObject({ channel: 'SG_PAYNOW' });
    expect((await traces(w, id, 'PAYOUT')).map((t) => t.summary)).toEqual([expect.stringMatching(/^payout attempt 1 via mock \(simulated PayNow payout\): SUCCEEDED$/)]);
  });

  it('an MY payee (MY_DUITNOW, MYR) still pays out through Xendit test mode, unlabelled', async () => {
    const xendit = new XenditDouble();
    const w = await world();
    const id = await finalizedSpend(w);
    const deps = w.deps({ rail: router(xendit) });
    expect((await runSettle(deps, [w.facilityId]))[0]?.payments[0]).toMatchObject({ paymentId: id, step: 'request_payout', detail: 'SUCCEEDED' });
    const posts = xendit.calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toMatchObject({ channel_code: 'MY_DUITNOW', currency: 'MYR', amount: 75 });
    expect(await mockPayouts(w)).toEqual([]);
    expect((await traces(w, id, 'PAYOUT')).map((t) => t.summary)).toEqual(['payout attempt 1 via xendit: SUCCEEDED']);
    expect((await runSettle(deps, [w.facilityId]))[0]?.payments[0]).toMatchObject({ step: 'confirm' });
  });

  it.each([
    ['an unknown channel', { accounts: { 'shopee-ads': { channel: 'TH_PROMPTPAY', accountNumber: '3000000001', holderName: 'Shopee Ads TH Test' } } }, 'UNKNOWN_CHANNEL'],
    ['a currency the channel does not carry (DuitNow on an SGD facility)', { currency: 'SGD' }, 'CURRENCY_MISMATCH'],
    ['a currency the channel does not carry (PayNow on a MYR facility)', { accounts: { 'shopee-ads': SG_ADS } }, 'CURRENCY_MISMATCH'],
  ] as const)('%s is refused before any rail call: no payout, no attestation, one ALERT, no halt', async (_what, o, code) => {
    const xendit = new XenditDouble();
    const w = await world(o);
    const id = await finalizedSpend(w);
    const deps = w.deps({ rail: router(xendit) });
    for (let pass = 0; pass < 2; pass += 1) {
      expect((await runSettle(deps, [w.facilityId]))[0]?.payments).toEqual([{ paymentId: id, step: 'error', detail: `PAYOUT_ROUTE_REFUSED ${code}` }]);
    }
    expect(xendit.calls).toEqual([]);
    expect(await mockPayouts(w)).toEqual([]);
    expect(await settleActions(w, id)).toBe(0);
    expect(await activeHalt(live.db.$client)).toBeNull();
    const alerts = await traces(w, id, 'ALERT');
    expect(alerts.map((a) => a.reason_code)).toEqual(['PAYOUT_ROUTE_REFUSED']);
    expect(alerts[0]?.summary).toContain(code);
    const row = await live.db.$client.query('select state, payout_status, payout_attempt from payments where facility_id = $1 and id = $2', [w.facilityId, id]);
    expect(row.rows[0]).toMatchObject({ state: 'FINALIZED', payout_status: 'NONE', payout_attempt: 0 });
  });
});
