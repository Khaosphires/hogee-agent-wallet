import { createHash, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadWorkerConfig, WorkerConfigError } from '../../src/config/env';
import { PayoutConflictError, type PayoutDestination, type PayoutRequest } from '../../src/rail/rail';
import {
  minorFromXendit,
  XenditConfigError,
  xenditAmount,
  XenditRail,
  xenditRailFromEnv,
  XenditRailError,
  XenditTransientError,
} from '../../src/rail/xendit-rail';

// Keys are generated per run (gitleaks): a test-mode key and a live-mode key that must be refused.
const devKey = () => `xnd_development_${randomBytes(36).toString('base64url')}`;
const prodKey = () => `xnd_production_${randomBytes(36).toString('base64url')}`;
const KEY = devKey();
const AUTH_TOKEN = Buffer.from(`${KEY}:`).toString('base64');
const hex32 = (seed: string) => `0x${createHash('sha256').update(seed).digest('hex')}`;
const TX = hex32('spend-tx');
const DEST: PayoutDestination = { channel: 'MY_DUITNOW', accountNumber: '1000000001', holderName: 'Shopee Ads Test' };

const request = (over: Partial<PayoutRequest> = {}, attempt = 1): PayoutRequest => ({
  idempotencyKey: hex32(`attempt-${attempt}`),
  referenceId: `${TX}:${attempt}`,
  amountMinor: 123_456n,
  currency: 'MYR',
  destination: DEST,
  ...over,
});

interface Call {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly raw: string | undefined;
  readonly body: Record<string, unknown> | undefined;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const xErr = (status: number, error_code: string, message = 'nope') => json(status, { error_code, message });

/** A stateful Xendit Payouts v2 double: idempotent on the key (same body → same payout; other body → 409 DUPLICATE_ERROR). */
class FakeXendit {
  readonly calls: Call[] = [];
  readonly byKey = new Map<string, { raw: string; payout: Record<string, unknown> }>();
  readonly byId = new Map<string, Record<string, unknown>>();
  status = 'ACCEPTED';
  failureCode: string | undefined;
  /** Rewrites the payout Xendit returns (to simulate a tampered or foreign payout). */
  tamper: ((p: Record<string, unknown>) => Record<string, unknown>) | undefined;
  /** Answers instead of the double when it returns a Response. */
  override: ((call: Call) => Response | Promise<Response | undefined> | undefined) | undefined;

  readonly fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const raw = typeof init.body === 'string' ? init.body : undefined;
    const call: Call = { url: new URL(input), method: init.method ?? 'GET', headers: new Headers(init.headers), raw, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined };
    this.calls.push(call);
    const forced = await this.override?.(call);
    if (forced) return forced;
    const out = (p: Record<string, unknown>) => json(200, this.tamper ? this.tamper(p) : p);
    const path = call.url.pathname;
    if (call.method === 'POST' && path === '/v2/payouts') {
      const key = call.headers.get('idempotency-key');
      if (!key || !raw || !call.body) return xErr(400, 'API_VALIDATION_ERROR');
      const seen = this.byKey.get(key);
      if (seen) return seen.raw === raw ? out(seen.payout) : xErr(409, 'DUPLICATE_ERROR', 'A payout with this idempotency key already exists');
      const payout = { ...call.body, id: `disb-${this.byId.size + 1}`, status: this.status, business_id: 'biz-test', created: '2026-10-17T00:00:00Z', updated: '2026-10-17T00:00:00Z', ...(this.failureCode ? { failure_code: this.failureCode } : {}) };
      this.byKey.set(key, { raw, payout });
      this.byId.set(payout.id, payout);
      return out(payout);
    }
    if (call.method === 'GET' && path === '/v2/payouts') {
      const ref = call.url.searchParams.get('reference_id');
      return json(200, { data: [...this.byId.values()].filter((p) => p.reference_id === ref).map((p) => (this.tamper ? this.tamper(p) : p)), has_more: false, links: [] });
    }
    const m = /^\/v2\/payouts\/([^/]+)$/.exec(path);
    if (call.method === 'GET' && m) {
      const p = this.byId.get(decodeURIComponent(m[1] ?? ''));
      return p ? out(p) : xErr(404, 'DATA_NOT_FOUND');
    }
    return xErr(404, 'NOT_FOUND');
  };

  rail(opts: { timeoutMs?: number } = {}): XenditRail {
    return new XenditRail({ secretKey: KEY, fetch: this.fetch, ...opts });
  }
}

/** Every string a thrown error could put in a log. */
function errorText(error: unknown): string {
  const e = error as Error & { code?: unknown; status?: unknown };
  return [e.name, e.message, e.stack, String(e.code), String(e.status), JSON.stringify(e), inspect(e)].join('\n');
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('XenditRail request shape', () => {
  it('POSTs /v2/payouts with the idempotency key, Basic auth and the exact v2 body', async () => {
    const x = new FakeXendit();
    const res = await x.rail().requestPayout(request());
    expect(res).toEqual({ payoutId: 'disb-1', status: 'PENDING' });
    const [call] = x.calls;
    expect(call?.method).toBe('POST');
    expect(call?.url.href).toBe('https://api.xendit.co/v2/payouts');
    expect(call?.headers.get('idempotency-key')).toBe(hex32('attempt-1'));
    expect(call?.headers.get('authorization')).toBe(`Basic ${AUTH_TOKEN}`);
    expect(call?.headers.get('content-type')).toBe('application/json');
    expect(call?.body).toEqual({
      reference_id: `${TX}:1`,
      channel_code: 'MY_DUITNOW',
      channel_properties: { account_number: '1000000001', account_holder_name: 'Shopee Ads Test' },
      amount: 1234.56,
      currency: 'MYR',
      description: 'Hogee settlement',
      metadata: { hogee_idempotency_key: hex32('attempt-1') },
    });
    expect(call?.raw).toContain('"amount":1234.56');
  });

  it('reads a payout back by id and lists by reference_id, with auth on every call', async () => {
    const x = new FakeXendit();
    const rail = x.rail();
    await rail.requestPayout(request());
    x.status = 'SUCCEEDED';
    (x.byId.get('disb-1') as Record<string, unknown>).status = 'SUCCEEDED';
    expect(await rail.getPayout('disb-1')).toEqual({ payoutId: 'disb-1', status: 'SUCCEEDED' });
    expect(await rail.findPayout({ idempotencyKey: hex32('attempt-1'), referenceId: `${TX}:1` })).toEqual({ payoutId: 'disb-1', status: 'SUCCEEDED' });
    expect(await rail.findPayout({ idempotencyKey: hex32('attempt-2'), referenceId: `${TX}:2` })).toBeNull();
    const [, get, list] = x.calls;
    expect(get?.url.href).toBe('https://api.xendit.co/v2/payouts/disb-1');
    expect(list?.url.pathname).toBe('/v2/payouts');
    expect(list?.url.searchParams.get('reference_id')).toBe(`${TX}:1`);
    for (const c of x.calls) expect(c.headers.get('authorization')).toBe(`Basic ${AUTH_TOKEN}`);
    expect(x.calls.filter((c) => c.method === 'GET').every((c) => c.raw === undefined && !c.headers.has('idempotency-key'))).toBe(true);
  });
});

describe('XenditRail status mapping', () => {
  const cases: [string, string | undefined, object][] = [
    ['ACCEPTED', undefined, { status: 'PENDING' }],
    ['REQUESTED', undefined, { status: 'PENDING' }],
    ['LOCKED', undefined, { status: 'PENDING' }],
    ['SUCCEEDED', undefined, { status: 'SUCCEEDED' }],
    ['FAILED', 'INVALID_DESTINATION', { status: 'FAILED', failureCode: 'INVALID_DESTINATION' }],
    ['FAILED', 'TEMPORARY_TRANSFER_ERROR', { status: 'FAILED', failureCode: 'TEMPORARY_TRANSFER_ERROR' }],
    ['FAILED', 'SLS_RECIPIENT', { status: 'FAILED', failureCode: 'SLS_RECIPIENT' }],
    ['FAILED', 'rejected-by-bank: recipient KYC', { status: 'FAILED', failureCode: 'rejected-by-bank: recipient KYC' }],
    ['FAILED', undefined, { status: 'FAILED' }],
    ['CANCELLED', undefined, { status: 'FAILED', failureCode: 'CANCELLED' }],
    ['REVERSED', 'TEMPORARY_TRANSFER_ERROR', { status: 'FAILED', failureCode: 'REVERSED' }],
  ];
  it.each(cases)('%s (%s) → %o', async (status, failureCode, expected) => {
    const x = new FakeXendit();
    x.status = status;
    x.failureCode = failureCode;
    const res = await x.rail().requestPayout(request());
    expect(res).toEqual({ payoutId: 'disb-1', ...expected });
    expect(res.failureCode === undefined).toBe(!('failureCode' in expected));
  });

  it('never maps an unknown status: it throws instead', async () => {
    const x = new FakeXendit();
    x.status = 'PENDING_COMPLIANCE_ASSESSMENT';
    const error = await caught(x.rail().requestPayout(request()));
    expect(error).toBeInstanceOf(XenditRailError);
    expect(error).not.toBeInstanceOf(XenditTransientError);
  });

  it('keeps the raw failure code printable and bounded', async () => {
    const x = new FakeXendit();
    x.status = 'FAILED';
    x.failureCode = `BAD\nCODE${'X'.repeat(300)}`;
    const res = await x.rail().requestPayout(request());
    expect(res.failureCode).toMatch(/^BAD CODEX+$/);
    expect(res.failureCode?.length).toBeLessThanOrEqual(100);
  });
});

describe('XenditRail idempotency', () => {
  it('same key + same body returns the original payout', async () => {
    const x = new FakeXendit();
    const rail = x.rail();
    const first = await rail.requestPayout(request());
    const again = await rail.requestPayout(request());
    expect(again).toEqual(first);
    expect(x.byId.size).toBe(1);
  });

  it.each([
    ['amount', { amountMinor: 123_457n }],
    ['currency', { currency: 'PHP' }],
    ['destination account', { destination: { ...DEST, accountNumber: '6660000666' } }],
    ['destination channel', { destination: { ...DEST, channel: 'MY_MAYBANK' } }],
    ['holder name', { destination: { ...DEST, holderName: 'Someone Else' } }],
    ['reference', { referenceId: `${TX}:9` }],
  ] as [string, Partial<PayoutRequest>][])('same key + different %s → PayoutConflictError (DUPLICATE_ERROR)', async (_what, over) => {
    const x = new FakeXendit();
    const rail = x.rail();
    await rail.requestPayout(request());
    await expect(rail.requestPayout(request(over))).rejects.toBeInstanceOf(PayoutConflictError);
    expect(x.byId.size).toBe(1);
  });

  it('maps DUPLICATE_ERROR on any status, and any 409, to PayoutConflictError', async () => {
    const x = new FakeXendit();
    x.override = () => xErr(400, 'DUPLICATE_ERROR');
    await expect(x.rail().requestPayout(request())).rejects.toBeInstanceOf(PayoutConflictError);
    x.override = () => xErr(409, 'IDEMPOTENCY_ERROR');
    await expect(x.rail().requestPayout(request())).rejects.toBeInstanceOf(PayoutConflictError);
  });

  it('survives a lost response: the retry with the same key returns the payout created the first time', async () => {
    const x = new FakeXendit();
    const rail = x.rail();
    let drop = true;
    x.override = async (call) => {
      if (!drop || call.method !== 'POST') return undefined;
      drop = false;
      x.override = undefined;
      await x.fetch(call.url.href, { method: 'POST', headers: call.headers, ...(call.raw ? { body: call.raw } : {}) }); // Xendit created it...
      throw new TypeError('fetch failed'); // ...and the response never arrived
    };
    await expect(rail.requestPayout(request())).rejects.toBeInstanceOf(XenditTransientError);
    expect(await rail.findPayout({ idempotencyKey: hex32('attempt-1'), referenceId: `${TX}:1` })).toEqual({ payoutId: 'disb-1', status: 'PENDING' });
    expect(await rail.requestPayout(request())).toEqual({ payoutId: 'disb-1', status: 'PENDING' });
    expect(x.byId.size).toBe(1);
  });
});

describe('XenditRail never trusts a returned payout that differs from the request', () => {
  it.each([
    ['amount', (p: Record<string, unknown>) => ({ ...p, amount: 1234.57 })],
    ['amount as text', (p: Record<string, unknown>) => ({ ...p, amount: '9999.00' })],
    ['currency', (p: Record<string, unknown>) => ({ ...p, currency: 'IDR' })],
    ['account number', (p: Record<string, unknown>) => ({ ...p, channel_properties: { account_number: '6660000666', account_holder_name: 'Shopee Ads Test' } })],
    ['channel', (p: Record<string, unknown>) => ({ ...p, channel_code: 'MY_CIMB' })],
    ['holder name', (p: Record<string, unknown>) => ({ ...p, channel_properties: { account_number: '1000000001', account_holder_name: 'Mallory' } })],
    ['reference', (p: Record<string, unknown>) => ({ ...p, reference_id: `${TX}:7` })],
    ['idempotency tag', (p: Record<string, unknown>) => ({ ...p, metadata: { hogee_idempotency_key: hex32('other') } })],
  ])('%s mismatch → PayoutConflictError, even when SUCCEEDED', async (_what, tamper) => {
    const x = new FakeXendit();
    x.status = 'SUCCEEDED';
    x.tamper = tamper;
    const error = await caught(x.rail().requestPayout(request()));
    expect(error).toBeInstanceOf(PayoutConflictError);
    expect(errorText(error)).not.toContain('6660000666'); // names the field, never the value
  });

  it('accepts a holder name that differs only in case or spacing, and an omitted one', async () => {
    const x = new FakeXendit();
    x.tamper = (p) => ({ ...p, channel_properties: { account_number: '1000000001', account_holder_name: '  SHOPEE  ADS test ' } });
    expect((await x.rail().requestPayout(request())).status).toBe('PENDING');
    x.tamper = (p) => ({ ...p, channel_properties: { account_number: '1000000001' } });
    expect((await x.rail().requestPayout(request())).status).toBe('PENDING');
  });

  it('findPayout refuses a payout under this reference created with another key, or an ambiguous list', async () => {
    const x = new FakeXendit();
    const rail = x.rail();
    await rail.requestPayout(request());
    const key = { idempotencyKey: hex32('attempt-1'), referenceId: `${TX}:1` };
    x.tamper = (p) => ({ ...p, metadata: { hogee_idempotency_key: hex32('foreign') } });
    await expect(rail.findPayout(key)).rejects.toBeInstanceOf(PayoutConflictError);
    x.tamper = undefined;
    x.override = (c) => (c.method === 'GET' ? json(200, { data: [...x.byId.values(), { ...x.byId.get('disb-1'), id: 'disb-99' }], has_more: false }) : undefined);
    await expect(rail.findPayout(key)).rejects.toBeInstanceOf(PayoutConflictError);
    x.override = (c) => (c.method === 'GET' ? json(200, { data: [...x.byId.values()], has_more: true }) : undefined);
    await expect(rail.findPayout(key)).rejects.toBeInstanceOf(PayoutConflictError);
    // A payout without the tag (metadata not echoed) is still found by its unique reference.
    x.override = (c) => (c.method === 'GET' ? json(200, { data: [{ ...x.byId.get('disb-1'), metadata: null }], has_more: false }) : undefined);
    expect(await rail.findPayout(key)).toEqual({ payoutId: 'disb-1', status: 'PENDING' });
  });

  it('getPayout refuses an answer for another payout id', async () => {
    const x = new FakeXendit();
    const rail = x.rail();
    await rail.requestPayout(request());
    x.tamper = (p) => ({ ...p, id: 'disb-2' });
    await expect(rail.getPayout('disb-1')).rejects.toBeInstanceOf(XenditRailError);
    await expect(rail.getPayout('../balance')).rejects.toBeInstanceOf(XenditRailError);
  });
});

describe('XenditRail errors', () => {
  it.each([
    ['network failure', () => Promise.reject(new TypeError('fetch failed'))],
    ['HTTP 500', () => xErr(500, 'SERVER_ERROR')],
    ['HTTP 503', () => new Response('<html>unavailable</html>', { status: 503 })],
    ['HTTP 429', () => xErr(429, 'RATE_LIMIT_EXCEEDED')],
    ['a garbled 2xx', () => new Response('{"id":', { status: 200 })],
  ])('%s → XenditTransientError (the payout is not marked failed)', async (_what, answer) => {
    const x = new FakeXendit();
    x.override = answer;
    const rail = x.rail();
    for (const p of [rail.requestPayout(request()), rail.getPayout('disb-1'), rail.findPayout({ idempotencyKey: hex32('attempt-1'), referenceId: `${TX}:1` })]) {
      const error = await caught(p);
      expect(error).toBeInstanceOf(XenditTransientError);
      expect((error as XenditTransientError).transient).toBe(true);
    }
  });

  it('a timeout aborts the call and is transient', async () => {
    const hang = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error)));
    const rail = new XenditRail({ secretKey: KEY, fetch: hang, timeoutMs: 20 });
    const error = await caught(rail.requestPayout(request()));
    expect(error).toBeInstanceOf(XenditTransientError);
    expect((error as Error).message).toMatch(/TimeoutError/);
  });

  it.each([
    [400, 'API_VALIDATION_ERROR'],
    [400, 'INVALID_VALUE_ERROR'],
    [401, 'INVALID_API_KEY'],
    [403, 'REQUEST_FORBIDDEN_ERROR'],
  ])('HTTP %i %s → XenditRailError with the raw code, not transient and not a payout result', async (status, code) => {
    const x = new FakeXendit();
    x.override = () => xErr(status, code);
    const error = await caught(x.rail().requestPayout(request()));
    expect(error).toBeInstanceOf(XenditRailError);
    expect(error).not.toBeInstanceOf(XenditTransientError);
    expect(error).not.toBeInstanceOf(PayoutConflictError);
    expect(error).toMatchObject({ code, status });
  });

  it('findPayout treats 404 as never seen; getPayout treats it as an error', async () => {
    const x = new FakeXendit();
    x.override = () => xErr(404, 'DATA_NOT_FOUND');
    const rail = x.rail();
    expect(await rail.findPayout({ idempotencyKey: hex32('attempt-1'), referenceId: `${TX}:1` })).toBeNull();
    await expect(rail.getPayout('disb-404')).rejects.toMatchObject({ code: 'DATA_NOT_FOUND', status: 404 });
  });

  it('never puts the secret key (or its Basic token) in an error, even when Xendit echoes it', async () => {
    const x = new FakeXendit();
    const rail = x.rail();
    const answers: (() => Response | Promise<Response>)[] = [
      () => xErr(401, 'INVALID_API_KEY', `API key ${KEY} is invalid (Basic ${AUTH_TOKEN})`),
      () => xErr(500, `SERVER_ERROR`, `upstream said ${KEY}`),
      () => Promise.reject(new Error(`socket closed for ${KEY}`)),
      () => xErr(409, 'DUPLICATE_ERROR', `key ${KEY}`),
    ];
    for (const answer of answers) {
      x.override = answer;
      const text = errorText(await caught(rail.requestPayout(request())));
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(AUTH_TOKEN);
      expect(text).not.toMatch(/xnd_development_/);
    }
  });

  it('refuses invalid requests before calling Xendit', async () => {
    const x = new FakeXendit();
    const rail = x.rail();
    await expect(rail.requestPayout(request({ amountMinor: 0n }))).rejects.toThrow(RangeError);
    await expect(rail.requestPayout(request({ idempotencyKey: '' }))).rejects.toThrow(RangeError);
    await expect(rail.requestPayout(request({ idempotencyKey: 'k'.repeat(101) }))).rejects.toThrow(RangeError);
    await expect(rail.requestPayout(request({ currency: 'USD' }))).rejects.toThrow(/not supported/);
    await expect(rail.requestPayout(request({ currency: 'IDR', amountMinor: 150_050n }))).rejects.toThrow(/whole/);
    expect(x.calls).toHaveLength(0);
  });
});

describe('XenditRail never pays a Singapore (PayNow) or demo-only destination (SG-DECISIONS)', () => {
  it.each(['SG_PAYNOW', 'MOCK_ONLY'])('refuses a %s destination before any call, as a clean XenditRailError', async (channel) => {
    const x = new FakeXendit();
    const error = await caught(x.rail().requestPayout(request({ currency: 'SGD', destination: { ...DEST, channel } })));
    expect(error).toBeInstanceOf(XenditRailError);
    expect((error as XenditRailError).code).toBe('CHANNEL_NOT_ON_XENDIT');
    expect(x.calls).toHaveLength(0);
  });

  it('reads SGD amounts (2 decimals), so a misrouted SGD payout is refused cleanly instead of a RangeError', () => {
    expect(xenditAmount(123_456n, 'SGD')).toBe(1234.56);
    expect(minorFromXendit('1234.56', 'SGD')).toBe(123_456n);
  });
});

describe('XenditRail amounts (Hogee minor units, 1 BU = 100 minor)', () => {
  it.each([
    [123_456n, 'MYR', 1234.56],
    [1n, 'MYR', 0.01],
    [10n, 'MYR', 0.1],
    [100n, 'MYR', 1],
    [1_000_000_000_00n, 'MYR', 1_000_000_000],
    [999_999_999_999n, 'PHP', 9_999_999_999.99],
    [150_000n, 'IDR', 1500],
  ] as [bigint, string, number][])('%s minor %s → %s', (minor, currency, amount) => {
    expect(xenditAmount(minor, currency)).toBe(amount);
    expect(minorFromXendit(amount, currency)).toBe(minor);
    expect(minorFromXendit(JSON.parse(JSON.stringify(amount)), currency)).toBe(minor);
  });

  it('refuses amounts it cannot send exactly', () => {
    expect(() => xenditAmount(-1n, 'MYR')).toThrow(RangeError);
    expect(() => xenditAmount(150_001n, 'IDR')).toThrow(/whole/);
    expect(() => xenditAmount(9_007_199_254_740_993n, 'MYR')).toThrow(/exactly/);
    expect(() => xenditAmount(100n, 'EUR')).toThrow(/not supported/);
  });

  it('reads Xendit amounts strictly', () => {
    expect(minorFromXendit('1234.50', 'MYR')).toBe(123_450n);
    expect(minorFromXendit(1234.567, 'MYR')).toBeNull();
    expect(minorFromXendit(1500.5, 'IDR')).toBeNull();
    expect(minorFromXendit(-1, 'MYR')).toBeNull();
    expect(minorFromXendit(1e21, 'MYR')).toBeNull();
    expect(minorFromXendit(Number.NaN, 'MYR')).toBeNull();
    expect(minorFromXendit(null, 'MYR')).toBeNull();
    expect(minorFromXendit(1, 'EUR')).toBeNull();
  });
});

describe('XenditRail key handling (test mode only)', () => {
  it('refuses a live-mode key without echoing it', () => {
    const live = prodKey();
    const error = (() => {
      try {
        return new XenditRail({ secretKey: live, fetch: new FakeXendit().fetch });
      } catch (e: unknown) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(XenditConfigError);
    expect((error as Error).message).toMatch(/XENDIT_SECRET_KEY/);
    expect((error as Error).message).toMatch(/xnd_production_/);
    expect(errorText(error)).not.toContain(live);
  });

  it.each([
    ['empty', ''],
    ['a public key', `xnd_public_development_${randomBytes(30).toString('base64url')}`],
    ['garbage', randomBytes(30).toString('hex')],
    ['a key with a newline (header injection)', `${KEY}\nX-Evil: 1`],
  ])('refuses %s', (_what, value) => {
    expect(() => new XenditRail({ secretKey: value })).toThrow(XenditConfigError);
    try {
      new XenditRail({ secretKey: value });
    } catch (e: unknown) {
      if (value) expect(errorText(e)).not.toContain(value);
    }
  });

  it('keeps the key out of JSON and inspect output', () => {
    const rail = new XenditRail({ secretKey: KEY, fetch: new FakeXendit().fetch });
    for (const text of [JSON.stringify(rail), inspect(rail, { showHidden: true, depth: 5 }), JSON.stringify({ deps: { rail } })]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(AUTH_TOKEN);
    }
    expect(rail.name).toBe('xendit');
  });

  it('only talks to https (or loopback http for local doubles)', () => {
    expect(() => new XenditRail({ secretKey: KEY, baseUrl: 'http://api.xendit.co' })).toThrow(XenditConfigError);
    expect(() => new XenditRail({ secretKey: KEY, baseUrl: 'https://user:pw@api.xendit.co' })).toThrow(XenditConfigError);
    expect(() => new XenditRail({ secretKey: KEY, baseUrl: 'http://127.0.0.1:4010' })).not.toThrow();
  });

  it('xenditRailFromEnv reads XENDIT_SECRET_KEY once and scrubs it from the env, even on failure', () => {
    const env: Record<string, string | undefined> = { XENDIT_SECRET_KEY: KEY };
    expect(xenditRailFromEnv(env, { scrub: true }).name).toBe('xendit');
    expect('XENDIT_SECRET_KEY' in env).toBe(false);
    const bad: Record<string, string | undefined> = { XENDIT_SECRET_KEY: prodKey() };
    expect(() => xenditRailFromEnv(bad, { scrub: true })).toThrow(XenditConfigError);
    expect('XENDIT_SECRET_KEY' in bad).toBe(false);
    expect(() => xenditRailFromEnv({})).toThrow(/XENDIT_SECRET_KEY is required/);
  });
});

describe('PAYOUT_RAIL selection (loadWorkerConfig)', () => {
  const BASE = { DATABASE_URL: 'postgres://worker@127.0.0.1:5432/hogee', DEPLOYMENT_ID: 'loop-1', MAX_FEE_GWEI: '30' };

  it('defaults to mock and accepts xendit with a test-mode key, which stays out of the config', () => {
    expect(loadWorkerConfig(BASE).payoutRail).toBe('mock');
    const c = loadWorkerConfig({ ...BASE, PAYOUT_RAIL: 'xendit', XENDIT_SECRET_KEY: KEY });
    expect(c.payoutRail).toBe('xendit');
    expect(JSON.stringify(c, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(KEY);
  });

  it('refuses xendit without a key, with a live key, and any other rail, naming only the variable', () => {
    const live = prodKey();
    const cases: [Record<string, string>, RegExp][] = [
      [{ PAYOUT_RAIL: 'xendit' }, /XENDIT_SECRET_KEY is required/],
      [{ PAYOUT_RAIL: 'xendit', XENDIT_SECRET_KEY: live }, /XENDIT_SECRET_KEY/],
      [{ PAYOUT_RAIL: 'stripe' }, /PAYOUT_RAIL must be mock or xendit/],
    ];
    for (const [extra, re] of cases) {
      let error: unknown;
      try {
        loadWorkerConfig({ ...BASE, ...extra });
      } catch (e: unknown) {
        error = e;
      }
      expect(error).toBeInstanceOf(WorkerConfigError);
      expect((error as Error).message).toMatch(re);
      expect(errorText(error)).not.toContain(live);
    }
  });
});
