/** Payout routing by payee channel (SG-DECISIONS "Payout rail"): SG on MockRail always, MY on Xendit when set, the rest refused. */
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { BANK_ACCOUNT_RE, isMockOnlyChannel, PAYNOW_PROXY_RE, PAYOUT_CHANNELS, payoutChannelOf, SIMULATED_PAYNOW_LABEL } from '../../src/rail/channels';
import { MockRail } from '../../src/rail/mock-rail';
import { parsePayoutAccountRef, payoutAccountRef, type PayoutDestination, type PayoutRail } from '../../src/rail/rail';
import { PayoutRouteError, PayoutRouter, payoutRouterOf } from '../../src/rail/route';
import { XenditRail } from '../../src/rail/xendit-rail';

const fakePool = {} as Pool; // never queried: routing calls no rail
const named = (name: string): PayoutRail => ({
  name,
  requestPayout: async () => {
    throw new Error('not called');
  },
  getPayout: async () => {
    throw new Error('not called');
  },
  findPayout: async () => null,
});
const mock = named('mock');
const xendit = named('xendit');
const xenditRail = () =>
  new XenditRail({
    secretKey: `xnd_development_${randomBytes(36).toString('base64url')}`,
    fetch: async () => {
      throw new Error('no network in this test');
    },
  });

function refusal(fn: () => unknown): PayoutRouteError {
  try {
    fn();
  } catch (error: unknown) {
    if (error instanceof PayoutRouteError) return error;
    throw error;
  }
  throw new Error('expected a PayoutRouteError');
}

describe('payout channel table', () => {
  it('routes exactly MY_DUITNOW (MYR, Xendit-eligible), SG_PAYNOW (SGD, mock, labelled) and MOCK_ONLY (mock)', () => {
    expect(Object.keys(PAYOUT_CHANNELS).sort()).toEqual(['MOCK_ONLY', 'MY_DUITNOW', 'SG_PAYNOW']);
    expect(PAYOUT_CHANNELS.MY_DUITNOW).toEqual({ currencies: ['MYR'], rail: 'xendit', accountNumber: BANK_ACCOUNT_RE });
    expect(PAYOUT_CHANNELS.SG_PAYNOW).toEqual({ currencies: ['SGD'], rail: 'mock', label: 'simulated PayNow payout', accountNumber: PAYNOW_PROXY_RE });
    expect(PAYOUT_CHANNELS.MOCK_ONLY).toEqual({ currencies: ['MYR', 'SGD'], rail: 'mock', accountNumber: BANK_ACCOUNT_RE });
    expect(Object.isFrozen(PAYOUT_CHANNELS) && Object.isFrozen(PAYOUT_CHANNELS.SG_PAYNOW)).toBe(true);
  });

  it('knows only its own keys and is case-sensitive', () => {
    for (const code of ['constructor', '__proto__', 'toString', 'sg_paynow', 'SG_PAYNOW ', '']) expect(payoutChannelOf(code), code).toBeUndefined();
    expect(isMockOnlyChannel('SG_PAYNOW')).toBe(true);
    expect(isMockOnlyChannel('MOCK_ONLY')).toBe(true);
    expect(isMockOnlyChannel('MY_DUITNOW')).toBe(false);
    expect(isMockOnlyChannel('TH_PROMPTPAY')).toBe(false);
  });
});

describe('payout account numbers follow their channel', () => {
  const ref = (channel: string, accountNumber: string) => payoutAccountRef({ channel, accountNumber, holderName: 'SPX SG Test' } as PayoutDestination);

  it('a PayNow account is a proxy: a UEN (the synthetic demo S99ZZ… ones included) or a +65 mobile', () => {
    for (const n of ['S99ZZ0003C', 'S99ZZ0099X', '53312345D', '201912345K', 'T08LL1234A', '+6581234567']) {
      expect(parsePayoutAccountRef(ref('SG_PAYNOW', n)), n).toEqual({ channel: 'SG_PAYNOW', accountNumber: n, holderName: 'SPX SG Test' });
    }
  });

  it('refuses a PayNow account that is not in canonical proxy form, and a proxy on a bank channel', () => {
    for (const n of ['s99zz0003c', 'S99ZZ 0003C', '2000000003', '+6571234567', '6581234567', 'S99ZZ0003']) expect(parsePayoutAccountRef(ref('SG_PAYNOW', n)), n).toBeNull();
    expect(parsePayoutAccountRef(ref('MY_DUITNOW', 'S99ZZ0003C'))).toBeNull();
    expect(parsePayoutAccountRef(ref('MOCK_ONLY', 'S99ZZ0003C'))).toBeNull();
    expect(parsePayoutAccountRef(ref('MY_DUITNOW', '1000000003'))).not.toBeNull();
  });

  it('keeps the bank-account form for a channel the router will refuse (so the refusal is the route, not the account)', () => {
    expect(parsePayoutAccountRef(ref('TH_PROMPTPAY', '3000000001'))).not.toBeNull();
    expect(parsePayoutAccountRef(ref('TH_PROMPTPAY', 'S99ZZ0003C'))).toBeNull();
  });
});

describe('PayoutRouter', () => {
  const both = new PayoutRouter({ mock, xendit });

  it('an SG (PayNow, SGD) payout goes to MockRail with the label, even when Xendit is configured', () => {
    const r = both.route({ channel: 'SG_PAYNOW', currency: 'SGD' });
    expect(r.rail).toBe(mock);
    expect(r.label).toBe(SIMULATED_PAYNOW_LABEL);
  });

  it('an MY (DuitNow, MYR) payout goes to Xendit test mode when configured, else MockRail; unlabelled', () => {
    expect(both.route({ channel: 'MY_DUITNOW', currency: 'MYR' })).toEqual({ rail: xendit });
    expect(new PayoutRouter({ mock }).route({ channel: 'MY_DUITNOW', currency: 'MYR' })).toEqual({ rail: mock });
  });

  it('a demo MOCK_ONLY supplier account never reaches Xendit', () => {
    expect(both.route({ channel: 'MOCK_ONLY', currency: 'MYR' }).rail).toBe(mock);
    expect(both.route({ channel: 'MOCK_ONLY', currency: 'SGD' }).rail).toBe(mock);
  });

  it('refuses an unknown channel (fail closed), naming only a code-shaped value', () => {
    for (const channel of ['TH_PROMPTPAY', 'PH_GCASH', 'sg_paynow', '__proto__']) {
      expect(refusal(() => both.route({ channel, currency: 'SGD' })).code, channel).toBe('UNKNOWN_CHANNEL');
    }
    const odd = refusal(() => both.route({ channel: 'SG PAYNOW; acct 9988776655', currency: 'SGD' }));
    expect(odd.message).not.toContain('9988776655');
  });

  it('refuses a currency the channel does not carry (an SGD DuitNow payout, a MYR PayNow payout)', () => {
    expect(refusal(() => both.route({ channel: 'MY_DUITNOW', currency: 'SGD' })).code).toBe('CURRENCY_MISMATCH');
    expect(refusal(() => both.route({ channel: 'SG_PAYNOW', currency: 'MYR' })).code).toBe('CURRENCY_MISMATCH');
    expect(refusal(() => both.route({ channel: 'MOCK_ONLY', currency: 'IDR' })).code).toBe('CURRENCY_MISMATCH');
  });

  it('names itself by its rails', () => {
    expect(both.name).toBe('xendit+mock');
    expect(new PayoutRouter({ mock }).name).toBe('mock');
  });
});

describe('payoutRouterOf (JobDeps.rail)', () => {
  it('keeps a router, wraps a bare XenditRail so SG stays on MockRail, and lets any other rail serve every route', () => {
    const router = new PayoutRouter({ mock });
    expect(payoutRouterOf(router, fakePool)).toBe(router);
    const x = xenditRail();
    const wrapped = payoutRouterOf(x, fakePool);
    expect(wrapped.route({ channel: 'MY_DUITNOW', currency: 'MYR' }).rail).toBe(x);
    expect(wrapped.route({ channel: 'SG_PAYNOW', currency: 'SGD' }).rail).toBeInstanceOf(MockRail);
    expect(payoutRouterOf(mock, fakePool).route({ channel: 'SG_PAYNOW', currency: 'SGD' }).rail).toBe(mock);
    expect(payoutRouterOf(undefined, fakePool).route({ channel: 'MY_DUITNOW', currency: 'MYR' }).rail).toBeInstanceOf(MockRail);
  });

  it('still refuses an unknown channel when it wraps a single rail', () => {
    expect(refusal(() => payoutRouterOf(mock, fakePool).route({ channel: 'TH_PROMPTPAY', currency: 'MYR' })).code).toBe('UNKNOWN_CHANNEL');
  });
});
