/**
 * cfo-guard (VISION-DECISIONS §7, §9 "CFO actions"): the queue and its cron, and the pure half of the job: the
 * re-check on the REAL mirrored context, the strictly-tighter rule (never loosens) and the per-day slot ids. The
 * DB + chain path (send, idempotency, the API report) is packages/api test/live/cfo.live.test.ts.
 */
import { proposeTightenings, type CfoInputs, type CfoTightening, type LineKey } from '@hogee/core';
import { describe, expect, it } from 'vitest';
import { buildPolicyContext } from '../../src/chain/context';
import { loadWorkerConfig } from '../../src/config/env';
import { linesOf, taxPayeeOf } from '../../src/jobs/cfo-guard-inputs';
import { BlockTimeCache, blockTimesFor } from '../../src/chain/block-times';
import { CFO_GUARD_ACTION_PREFIX, CFO_GUARD_MIN_INTERVAL_MS, GuardPacer, guardActionId, guardSlot, recheck, runCfoGuard, strictlyTightens } from '../../src/jobs/cfo-guard';
import { Deadline, DeadlineError, isDeadlineError, withinDeadline } from '../../src/runtime/deadline';
import { WORKER_QUEUES } from '../../src/runtime/boss';
import { committed, NOW, rinaSnapshot, roles } from '../support/fixtures';

const mined = { usedIntents: new Set<string>(), paidInvoices: new Set<string>() };
const DAY_MS = 86_400_000;
const ctxOf = (s = rinaSnapshot()) => buildPolicyContext({ snapshot: s, committed, roles, mined });
const lower = (lineKey: LineKey, action: 'LOWER_PER_TX_CAP' | 'LOWER_WINDOW_CAP', newValue: bigint): CfoTightening => ({ action, lineKey, newValue, reason: 'test' });
const reserve = (newValue: bigint): CfoTightening => ({ action: 'RAISE_RESERVE_BPS', lineKey: null, newValue, reason: 'test' });

/** CfoInputs from the fixture snapshot, with ADS spends of `perDay` on each of the last `days` chain days. */
function inputs(perDay: bigint, days: number, over: Partial<CfoInputs> = {}): CfoInputs {
  const s = rinaSnapshot();
  const now = new Date(Number(s.timestamp) * 1000);
  return {
    currency: 'MYR',
    now,
    facilityId: 'fac-rina',
    lines: linesOf(s, committed.manifest),
    payments: Array.from({ length: days }, (_, k) => ({ kind: 'SPEND' as const, lineKey: 'ADS' as const, amountMinor: perDay, state: 'FINALIZED' as const, at: new Date(now.getTime() - k * DAY_MS), txHash: null })),
    sales: [],
    reserve: { rateBps: s.plan.reserveBps, skimmedMinor: 0n, withdrawnMinor: 0n, taxPayeeId: taxPayeeOf('MYR') },
    stage: null,
    reserveBps: s.plan.reserveBps,
    agentActions: [],
    releasedMinor: s.balances.releasedMinor,
    fundedMinor: s.balances.fundedMinor,
    ...over,
  };
}

describe('cfo-guard wiring', () => {
  it('is a worker queue (the API can wake it)', () => {
    expect(WORKER_QUEUES).toContain('cfo-guard');
  });

  it('runs every 10 minutes by default; CFO_GUARD_CRON overrides it and a bad value fails the start-up', () => {
    const base = { DATABASE_URL: 'postgres://worker@127.0.0.1:5432/hogee', DEPLOYMENT_ID: 'loop-1', MAX_FEE_GWEI: '30' };
    expect(loadWorkerConfig(base).schedules.cfoGuard).toBe('*/10 * * * *');
    expect(loadWorkerConfig({ ...base, CFO_GUARD_CRON: '*/5 * * * *' }).schedules.cfoGuard).toBe('*/5 * * * *');
    expect(() => loadWorkerConfig({ ...base, CFO_GUARD_CRON: 'often' })).toThrow(/CFO_GUARD_CRON/);
  });
});

describe('slots: one tightening per line (or the reserve) per chain day', () => {
  it('names the slot and the deterministic action id', () => {
    expect(guardSlot(lower('ADS', 'LOWER_WINDOW_CAP', 1n))).toBe('ADS');
    expect(guardSlot(lower('ADS', 'LOWER_PER_TX_CAP', 1n))).toBe('ADS');
    expect(guardSlot(reserve(600n))).toBe('RESERVE');
    expect(guardActionId(20_387, 'ADS')).toBe(`${CFO_GUARD_ACTION_PREFIX}20387:ADS`);
  });
});

describe('strictlyTightens: never loosens, never a no-op', () => {
  const s = rinaSnapshot();
  it('a cap strictly below the current one and at least 1 BU', () => {
    expect(strictlyTightens(lower('ADS', 'LOWER_WINDOW_CAP', 52_500n), s)).toBe(true);
    expect(strictlyTightens(lower('ADS', 'LOWER_WINDOW_CAP', 60_000n), s)).toBe(false); // equal: no-op
    expect(strictlyTightens(lower('ADS', 'LOWER_WINDOW_CAP', 60_001n), s)).toBe(false); // a raise
    expect(strictlyTightens(lower('ADS', 'LOWER_PER_TX_CAP', 29_900n), s)).toBe(true);
    expect(strictlyTightens(lower('ADS', 'LOWER_PER_TX_CAP', 99n), s)).toBe(false); // under 1 BU
    expect(strictlyTightens(lower('LICENSING', 'LOWER_PER_TX_CAP', 100n), s)).toBe(false); // not a line on chain
  });

  it('a reserve rate strictly above the LIVE rate and at most 1000 bps', () => {
    expect(strictlyTightens(reserve(600n), s)).toBe(true);
    expect(strictlyTightens(reserve(500n), s)).toBe(false);
    expect(strictlyTightens(reserve(400n), s)).toBe(false);
    expect(strictlyTightens(reserve(1_001n), s)).toBe(false);
    expect(strictlyTightens({ ...reserve(600n), lineKey: 'ADS' }, s)).toBe(false);
  });

  it('every other action is refused (the guard never revokes, pauses or does anything else)', () => {
    for (const action of ['REVOKE_AGENT', 'PAUSE_LINE', 'PAUSE'] as const) expect(strictlyTightens({ action, lineKey: 'ADS', newValue: 0n, reason: 'x' }, s)).toBe(false);
  });

  it('property: over a sweep of values, a cap at or above the current one is never sent', () => {
    for (let v = 0n; v <= 120_000n; v += 2_500n) {
      const sent = recheck(lower('ADS', 'LOWER_WINDOW_CAP', v), ctxOf(), s) === null;
      expect(sent).toBe(v >= 100n && v < 60_000n);
    }
    for (let bps = 0n; bps <= 2_000n; bps += 50n) {
      expect(recheck(reserve(bps), ctxOf(), s) === null).toBe(bps > 500n && bps <= 1_000n);
    }
  });
});

describe('recheck on the REAL mirrored context', () => {
  it('sends a proposal core makes for a line burning over 1.5x its pace', () => {
    const [t, ...rest] = proposeTightenings(inputs(20_000n, 3));
    expect(rest).toEqual([]);
    expect(t).toMatchObject({ action: 'LOWER_WINDOW_CAP', lineKey: 'ADS', newValue: 52_500n });
    expect(recheck(t as CfoTightening, ctxOf(), rinaSnapshot())).toBeNull();
  });

  it('proposes nothing at the planned pace or with under 3 days of data', () => {
    expect(proposeTightenings(inputs(7_500n, 7))).toEqual([]);
    expect(proposeTightenings(inputs(30_000n, 2))).toEqual([]);
  });

  it('skips a slot the agent already used today (agentActions from its own rows)', () => {
    const today = new Date(Number(NOW) * 1000).toISOString();
    const used = { at: today, action: 'LOWER_WINDOW_CAP' as const, lineKey: 'ADS' as const, newValue: '52500', reason: 'r', txHash: null };
    expect(proposeTightenings(inputs(20_000n, 3, { agentActions: [used] }))).toEqual([]);
  });

  it('refuses when the real context does (the agent revoked or expired); a paused treasury still takes a tightening', () => {
    const t = lower('ADS', 'LOWER_WINDOW_CAP', 52_500n);
    // Treasury.tighten works while paused (tighten-only, as on-chain), so a pause does not block the CFO.
    expect(recheck(t, ctxOf(rinaSnapshot({ paused: true })), rinaSnapshot())).toBeNull();
    const revoked = rinaSnapshot();
    const r = { ...revoked, plan: { ...revoked.plan, agentRevoked: true } };
    expect(recheck(t, ctxOf(r), r)).toBe('NotAgent');
    const late = rinaSnapshot({ now: rinaSnapshot().agentExpiry + 1n });
    expect(recheck(t, ctxOf(late), late)).toBe('AgentExpired');
  });

  it('refuses a proposal whose cap the chain has already lowered past it (the inputs were stale)', () => {
    const s = rinaSnapshot({ ads: { windowCapMinor: 50_000n } });
    expect(recheck(lower('ADS', 'LOWER_WINDOW_CAP', 52_500n), ctxOf(s), s)).toBe('NotOwner');
  });
});

describe('taxPayeeOf', () => {
  it('names the deployment tax payee by currency and fails closed on any other', () => {
    expect(taxPayeeOf('SGD')).toBe('iras-tax');
    expect(taxPayeeOf('MYR')).toBe('lhdn-tax');
    expect(() => taxPayeeOf('IDR')).toThrow();
  });
});

describe('GuardPacer: at most one pass per facility per interval (audit run-9 lead 3: every sale wakes the job)', () => {
  it('admits the first pass, refuses another inside the interval, admits one after it; facilities are independent', () => {
    const pacer = new GuardPacer(300_000);
    expect(pacer.take('fac-a', 1_000)).toBe(true);
    expect(pacer.take('fac-a', 1_000 + 299_999)).toBe(false);
    expect(pacer.take('fac-b', 1_000 + 299_999)).toBe(true);
    expect(pacer.take('fac-a', 1_000 + 300_000)).toBe(true);
    expect(pacer.take('fac-a', 1_000 + 300_001)).toBe(false);
  });

  it('defaults to five minutes', () => {
    expect(CFO_GUARD_MIN_INTERVAL_MS).toBe(300_000);
    expect(new GuardPacer().intervalMs).toBe(CFO_GUARD_MIN_INTERVAL_MS);
  });

  it('a paced facility reads nothing: no database, no chain call', async () => {
    const untouchable = new Proxy({}, { get: () => { throw new Error('touched'); } }) as never;
    const log = { child: () => log, info: () => undefined, warn: () => undefined, error: () => undefined } as never;
    const pacer = new GuardPacer(300_000);
    pacer.take('fac-a', Date.now());
    const [r] = await runCfoGuard({ db: untouchable, client: untouchable, log } as never, ['fac-a'], { pacer });
    expect(r).toEqual({ facilityId: 'fac-a', tightened: [], status: 'paced' });
  });
});

describe('Deadline', () => {
  it('expires at its budget; check throws DeadlineError; race rejects a read still in flight', async () => {
    let now = 0;
    const d = Deadline.after(10_000, () => now);
    expect(d.expired()).toBe(false);
    now = 9_999;
    expect(() => d.check()).not.toThrow();
    now = 10_000;
    expect(d.expired()).toBe(true);
    expect(() => d.check()).toThrow(DeadlineError);
    const short = Deadline.after(20);
    await expect(short.race(new Promise(() => undefined))).rejects.toBeInstanceOf(DeadlineError);
    await expect(Deadline.after(1_000).race(Promise.resolve(7))).resolves.toBe(7);
  });
});

describe('BlockTimeCache: bounded LRU scoped to one chain', () => {
  it('evicts the least recently used entry, never the whole map, and empties on another genesis', () => {
    const c = new BlockTimeCache(2);
    c.scope('0xaa');
    c.set(1n, 10n);
    c.set(2n, 20n);
    expect(c.get(1n)).toBe(10n); // 1 is now the most recent
    c.set(3n, 30n); // evicts 2
    expect([c.get(2n), c.get(1n), c.get(3n), c.size]).toEqual([undefined, 10n, 30n, 2]);
    c.scope('0xAA'); // same chain (case-insensitive)
    expect(c.size).toBe(2);
    c.scope('0xbb');
    expect(c.size).toBe(0);
  });

  it('a view reads through the cache and checks before every block read', async () => {
    let calls = 0;
    const client = { getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ((calls += 1), { hash: '0x01', timestamp: 1_000n + blockNumber }) } as never;
    const cache = new BlockTimeCache();
    const times = await blockTimesFor(client, cache);
    expect(Object.fromEntries(await times.all([5n, 6n, 5n]))).toEqual({ 5: 1_005n, 6: 1_006n });
    expect(await times.of(5n)).toBe(1_005n);
    expect(calls).toBe(3); // genesis + 5 + 6
    let checks = 0;
    const again = await blockTimesFor(client, cache, () => void (checks += 1));
    await again.all([5n, 6n]);
    expect([calls, checks]).toEqual([4, 1]); // genesis only; one check before it
    const stopped = await blockTimesFor(client, cache, () => {
      if (calls >= 5) throw new DeadlineError(1);
    });
    await expect(stopped.of(7n)).rejects.toBeInstanceOf(DeadlineError);
  });
});

describe('withinDeadline: a send counts its RPC calls against the pass deadline (re-check LOW 5)', () => {
  it('races a call in flight, refuses a call past the deadline before it reaches the client, passes values through', async () => {
    let calls = 0;
    const client = {
      chainId: 31337,
      hang: () => ((calls += 1), new Promise<never>(() => undefined)),
      quick: async (x: number) => ((calls += 1), x * 2),
    };
    const d = Deadline.after(40);
    const c = withinDeadline(client, d);
    expect(c.chainId).toBe(31337);
    expect(await c.quick(2)).toBe(4);
    await expect(c.hang()).rejects.toBeInstanceOf(DeadlineError);
    const before = calls;
    expect(() => c.quick(1)).toThrow(DeadlineError);
    expect(calls).toBe(before);
    expect(isDeadlineError(new Error('wrapped', { cause: new DeadlineError(40) }))).toBe(true);
    expect(isDeadlineError(new Error('other'))).toBe(false);
  });
});
