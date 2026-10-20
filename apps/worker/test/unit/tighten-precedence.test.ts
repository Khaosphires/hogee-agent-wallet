/**
 * Audit run-10 lead v-4: since fix-cfo-load, settle-spend and reconcile wait up to 20 s for the shared job lock, polling
 * every 200 ms like the relay wake does while a tighten-only row (Treasury.pause, cancelLoosen) is pending. Nothing
 * ordered the waiters, so behind one holder they could take the lock in turn and outlast the relay's 30 s bound: the
 * pause was not signed on that wake. Now a waiter gives way while such a row is pending (checked on its own pooled
 * connection each poll), so the relay takes the lock first. One in-memory advisory lock shared by every connection,
 * fake timers (the real 20 s and 30 s bounds, in no real time); only runRelay is replaced.
 */
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobDeps } from '../../src/jobs/deps';
import { runRelay } from '../../src/jobs/relay';
import { SAME_MINUTE_LOCK_WAIT_MS, lockedJob } from '../../src/runtime/job-locks';
import { withJobLock } from '../../src/runtime/lock';
import { createLogger } from '../../src/runtime/log';
import { relayWake } from '../../src/runtime/relay-wake';

vi.mock('../../src/jobs/relay', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../src/jobs/relay')>()), runRelay: vi.fn() }));

/**
 * pg_try_advisory_lock succeeds only while no other connection holds the lock; pg_advisory_unlock frees it. The real
 * hasPendingTighten query answers from `state.pending` (ids of unsigned tighten-only rows; a safety-pause attempt counts
 * only for a query that does not leave those out, as the SQL says); `checks` records who asked ('pool' or 'client-<n>',
 * n in connect order). `failChecks` makes a connection's check throw.
 */
function sharedLockPool() {
  const state = { holder: null as number | null, pending: ['act-pause-1'] as string[], failChecks: false };
  const checks: string[] = [];
  const released: unknown[] = [];
  let connections = 0;
  const tightenCheck = (who: string, text: string) => {
    checks.push(who);
    if (state.failChecks && who !== 'pool') throw new Error('connection terminated');
    const counted = state.pending.filter((id) => !(id.startsWith('safety-pause:') && text.includes("id not like 'safety-pause:%'")));
    return { rows: counted.length > 0 ? [{ x: 1 }] : [] };
  };
  const pool = {
    async query(text: string) {
      if (text.includes('from chain_actions')) return tightenCheck('pool', text);
      throw new Error(`unexpected pool query: ${text}`);
    },
    async connect() {
      const id = (connections += 1);
      return {
        async query(text: string) {
          if (text.includes('from chain_actions')) return tightenCheck(`client-${id}`, text);
          if (text.includes('pg_try_advisory_lock')) {
            state.holder ??= id;
            return { rows: [{ ok: state.holder === id }] };
          }
          if (text.includes('pg_advisory_unlock')) {
            const held = state.holder === id;
            if (held) state.holder = null;
            return { rows: [{ pg_advisory_unlock: held }] };
          }
          throw new Error(`unexpected client query: ${text}`);
        },
        release(err?: unknown) {
          released.push(err);
        },
      };
    },
  };
  return { pool: pool as unknown as Pool, state, checks, released };
}

function recorder() {
  const lines: Record<string, unknown>[] = [];
  return { lines, log: createLogger({ sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>) }) };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const facilities = async () => ['fac-a'] as const;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(runRelay).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('v-4: a pending tighten-only row wins the job lock over the settle-spend and reconcile waiters', () => {
  it('three waiters behind one holder (validation plan): the relay runs as soon as the lock frees, both waiters after it', async () => {
    const { pool, state, checks, released } = sharedLockPool();
    const { lines, log } = recorder();
    const t0 = Date.now();
    const ranAt: Record<string, number> = {};
    const body = (job: string, ms: number) => async () => {
      ranAt[job] = Date.now() - t0;
      await sleep(ms);
    };
    vi.mocked(runRelay).mockImplementation(async () => {
      ranAt.relay = Date.now() - t0;
      state.pending = []; // the pause is signed
      return [];
    });

    // t = 0: a job that does not relay (record-sale) holds the lock for 4.21 s; the urgent relay wake starts waiting.
    const holder = withJobLock(pool, log, 'record-sale', body('record-sale', 4_210));
    await vi.advanceTimersByTimeAsync(0);
    expect(state.holder).toBe(1);
    const wake = relayWake({ db: { $client: pool }, log } as unknown as JobDeps, facilities);
    await vi.advanceTimersByTimeAsync(50);
    const settle = lockedJob(pool, log, 'settle-spend', facilities, body('settle-spend', 12_000))();
    await vi.advanceTimersByTimeAsync(50);
    const reconcile = lockedJob(pool, log, 'reconcile', facilities, body('reconcile', 16_000))();

    await vi.advanceTimersByTimeAsync(31_000); // the relay's whole 30 s bound
    expect(await wake).toEqual({ ran: true, reports: [] });
    expect(vi.mocked(runRelay)).toHaveBeenCalledTimes(1);
    expect(ranAt.relay).toBeGreaterThanOrEqual(4_210);
    expect(ranAt.relay).toBeLessThan(4_210 + 400); // its next 200 ms poll, not after another job's pass
    expect(lines.find((l) => l.event === 'job_skipped_lock_busy' && l.job === 'relay')).toBeUndefined();

    await vi.advanceTimersByTimeAsync(20_000);
    await Promise.all([holder, settle, reconcile]);
    expect(ranAt['settle-spend']).toBeGreaterThan(ranAt.relay ?? Number.POSITIVE_INFINITY);
    expect(ranAt.reconcile).toBeGreaterThan(ranAt.relay ?? Number.POSITIVE_INFINITY);
    expect(lines.find((l) => l.event === 'job_lock_waited' && l.job === 'settle-spend')).toMatchObject({ yielded: true });
    expect(lines.find((l) => l.event === 'job_lock_waited' && l.job === 'reconcile')).toMatchObject({ yielded: true });
    // Each waiter asked on its own pooled connection (settle-spend's is the 3rd, reconcile's the 4th); the pool itself
    // was asked only by the relay wake (before the lock, and after its pass). Every connection went back healthy.
    expect(checks).toContain('client-3');
    expect(checks).toContain('client-4');
    expect(checks.filter((w) => w === 'pool')).toHaveLength(2);
    expect(released).toEqual([undefined, undefined, undefined, undefined]);
    expect(state.holder).toBeNull();
  });

  it('a waiter whose first try finds the lock free takes it at once, without asking (no extra query uncontested)', async () => {
    const { pool, checks } = sharedLockPool();
    let ran = false;
    await lockedJob(pool, recorder().log, 'settle-spend', facilities, async () => {
      ran = true;
    })();
    expect(ran).toBe(true);
    expect(checks).toEqual([]);
  });

  it('with no tighten-only row pending, a waiter takes the lock on its next poll after the release, as before', async () => {
    const { pool, state, checks } = sharedLockPool();
    state.pending = [];
    state.holder = 99; // another process
    const t0 = Date.now();
    let ranAt: number | null = null;
    const done = lockedJob(pool, recorder().log, 'reconcile', facilities, async () => {
      ranAt = Date.now() - t0;
    })();
    await vi.advanceTimersByTimeAsync(3_000);
    state.holder = null;
    await vi.advanceTimersByTimeAsync(400);
    await done;
    expect(ranAt).toBeGreaterThanOrEqual(3_000);
    expect(ranAt).toBeLessThan(3_400);
    expect(checks.length).toBeGreaterThan(0);
  });

  it('bounded: a waiter that gives way for its whole wait (the row stays unsigned) still skips at the bound', async () => {
    const { pool, state, released } = sharedLockPool();
    state.holder = 99; // freed after 1 s, but the tighten-only row stays pending (say its relay is deferred)
    const { lines, log } = recorder();
    let ran = false;
    const done = lockedJob(pool, log, 'settle-spend', facilities, async () => {
      ran = true;
    })();
    await vi.advanceTimersByTimeAsync(1_000);
    state.holder = null;
    await vi.advanceTimersByTimeAsync(SAME_MINUTE_LOCK_WAIT_MS + 300);
    await done;
    expect(ran).toBe(false);
    expect(state.holder).toBeNull(); // left free for the relay
    expect(released).toEqual([undefined]);
    const skipped = lines.find((l) => l.event === 'job_skipped_lock_busy');
    expect(skipped).toMatchObject({ job: 'settle-spend', yielded: true });
    expect(skipped?.waitedMs).toBeGreaterThanOrEqual(SAME_MINUTE_LOCK_WAIT_MS);
  });

  it('fails closed: when the precedence check errors the waiter fails without taking the lock', async () => {
    const { pool, state, released } = sharedLockPool();
    state.holder = 99;
    state.failChecks = true;
    let ran = false;
    const done = lockedJob(pool, recorder().log, 'reconcile', facilities, async () => {
      ran = true;
    })();
    const outcome = expect(done).rejects.toThrow('connection terminated');
    await vi.advanceTimersByTimeAsync(0); // its first try finds the lock busy
    state.holder = null;
    await vi.advanceTimersByTimeAsync(400);
    await outcome;
    expect(ran).toBe(false);
    expect(state.holder).toBeNull();
    expect(released).toHaveLength(1);
  });
});

/**
 * Re-check A-1 (a regression of v-4): the precedence check counted the safety pause's own unsigned attempt rows
 * (`safety-pause:<request>:<n>`, written by reconcile's driver) as a pending tighten, so reconcile, the only job that
 * signs them (lender key first, at MAX_SAFETY_FEE), gave way to the relay, which never should sign them. Only rows the
 * relay delivers (the officer's or founder's pause, a vetoed loosening's cancel) are given way to now, and the relay
 * wake no longer waits (or runs extra passes) for an attempt it does not sign.
 */
describe("A-1: a safety-pause attempt is reconcile's own row, never one to give way to", () => {
  it('a pending safety-pause:r1:1 row with the relay holding the lock: reconcile runs on its next poll after the release, no `yielded`', async () => {
    const { pool, state, released } = sharedLockPool();
    state.pending = ['safety-pause:r1:1'];
    const { lines, log } = recorder();
    const t0 = Date.now();
    let ranAt: number | null = null;
    const relay = withJobLock(pool, log, 'relay', () => sleep(4_210));
    await vi.advanceTimersByTimeAsync(0);
    expect(state.holder).toBe(1);
    const reconcile = lockedJob(pool, log, 'reconcile', facilities, async () => {
      ranAt = Date.now() - t0;
    })();
    await vi.advanceTimersByTimeAsync(SAME_MINUTE_LOCK_WAIT_MS + 1_000);
    await Promise.all([relay, reconcile]);
    expect(ranAt).toBeGreaterThanOrEqual(4_210);
    expect(ranAt).toBeLessThan(4_210 + 400);
    const waited = lines.find((l) => l.event === 'job_lock_waited' && l.job === 'reconcile');
    expect(waited).toBeDefined();
    expect(waited).not.toHaveProperty('yielded');
    expect(lines.find((l) => l.event === 'job_skipped_lock_busy')).toBeUndefined();
    expect(released).toEqual([undefined, undefined]);
    expect(state.holder).toBeNull();
  });

  it('next to an officer pause the waiter still gives way (the relay delivers that one)', async () => {
    const { pool, state } = sharedLockPool();
    state.pending = ['safety-pause:r1:1', 'act-pause-1'];
    state.holder = 99;
    const { lines, log } = recorder();
    const done = lockedJob(pool, log, 'reconcile', facilities, async () => undefined)();
    await vi.advanceTimersByTimeAsync(1_000);
    state.holder = null;
    await vi.advanceTimersByTimeAsync(SAME_MINUTE_LOCK_WAIT_MS + 300);
    await done;
    expect(lines.find((l) => l.event === 'job_skipped_lock_busy')).toMatchObject({ job: 'reconcile', yielded: true });
  });

  it('the relay wake does not wait for a safety-pause attempt it never signs: with the lock busy it skips at once', async () => {
    const { pool, state } = sharedLockPool();
    state.pending = ['safety-pause:r1:1'];
    state.holder = 99; // another process, for good
    const { lines, log } = recorder();
    const wake = relayWake({ db: { $client: pool }, log } as unknown as JobDeps, facilities);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await wake).toEqual({ ran: false, reports: [] });
    expect(vi.mocked(runRelay)).not.toHaveBeenCalled();
    const skipped = lines.find((l) => l.event === 'job_skipped_lock_busy' && l.job === 'relay');
    expect(skipped).toBeDefined();
    expect(skipped).not.toHaveProperty('waitedMs'); // no wait at all
  });
});

/**
 * Re-check A-5: cfo-guard (the CFO's tightening) skipped at once when the lock was busy, and settle-spend and
 * reconcile now hold it longer, so a sale's cfo-guard wake was lost behind them. It now waits like them (its pass has
 * its own 10 s deadline, counted from when it has the lock) and gives way to a pending tighten-only row like them.
 */
describe('A-5: cfo-guard waits for the job lock like settle-spend and reconcile', () => {
  it('with record-sale holding the lock, cfo-guard runs within 20 s (on its next poll after the release)', async () => {
    const { pool, state, released } = sharedLockPool();
    state.pending = [];
    const { lines, log } = recorder();
    const t0 = Date.now();
    let ranAt: number | null = null;
    const holder = withJobLock(pool, log, 'record-sale', () => sleep(6_000));
    await vi.advanceTimersByTimeAsync(0);
    const guard = lockedJob(pool, log, 'cfo-guard', facilities, async () => {
      ranAt = Date.now() - t0;
    })();
    await vi.advanceTimersByTimeAsync(SAME_MINUTE_LOCK_WAIT_MS);
    await Promise.all([holder, guard]);
    expect(ranAt).toBeGreaterThanOrEqual(6_000);
    expect(ranAt).toBeLessThan(6_400);
    expect(lines.find((l) => l.event === 'job_lock_waited' && l.job === 'cfo-guard')).toBeDefined();
    expect(released).toEqual([undefined, undefined]);
  });

  it('gives way to a pending pause: the relay wake behind the same holder runs first', async () => {
    const { pool, state } = sharedLockPool();
    const { lines, log } = recorder();
    const t0 = Date.now();
    const ranAt: Record<string, number> = {};
    vi.mocked(runRelay).mockImplementation(async () => {
      ranAt.relay = Date.now() - t0;
      state.pending = [];
      return [];
    });
    const holder = withJobLock(pool, log, 'record-sale', () => sleep(4_210));
    await vi.advanceTimersByTimeAsync(0);
    const guard = lockedJob(pool, log, 'cfo-guard', facilities, async () => {
      ranAt['cfo-guard'] = Date.now() - t0;
    })();
    await vi.advanceTimersByTimeAsync(50);
    const wake = relayWake({ db: { $client: pool }, log } as unknown as JobDeps, facilities);
    await vi.advanceTimersByTimeAsync(SAME_MINUTE_LOCK_WAIT_MS);
    await Promise.all([holder, guard, wake]);
    expect(ranAt.relay).toBeLessThan(4_210 + 400);
    expect(ranAt['cfo-guard']).toBeGreaterThan(ranAt.relay ?? Number.POSITIVE_INFINITY);
    expect(lines.find((l) => l.event === 'job_lock_waited' && l.job === 'cfo-guard')).toMatchObject({ yielded: true });
  });
});
