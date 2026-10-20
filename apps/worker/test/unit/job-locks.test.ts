/**
 * fix-cfo-load: job-lock starvation, seen live on Sepolia final-2 (19 Oct). Every every-minute job fires in the same
 * second and shares one advisory lock; a job that found it busy was skipped. settle-spend's handler started ~0.4 s after
 * the others, so it almost always lost: it ran once in 30 minutes and the deposit's confirmSettlement starved; reconcile
 * was skipped for minutes at a time too. Now settle-spend and reconcile wait up to 20 s for the lock (then skip, as
 * before), and so does cfo-guard (re-check A-5: the two waiters held the lock longer and starved it); the other cron
 * jobs still skip at once. Fake pool + fake timers: the real 20 s bound, in no real time.
 */
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKER_QUEUES } from '../../src/runtime/boss';
import { JOB_LOCK_WAITS, MIN_FREE_CONNECTIONS, SAME_MINUTE_LOCK_WAIT_MS, WORKER_POOL_MAX, lockedJob } from '../../src/runtime/job-locks';
import { createLogger } from '../../src/runtime/log';
import { TIGHTEN_LOCK_WAIT_MS } from '../../src/runtime/relay-wake';

/**
 * A pool whose advisory lock another job holds until `freeAt` (ms since the test's start; Infinity = never). No
 * tighten-only row is pending (the waiters' precedence check, tighten-precedence.test.ts, finds none).
 */
function heldPool(freeAt: number) {
  const t0 = Date.now();
  const released: unknown[] = [];
  let tries = 0;
  const client = {
    async query(text: string) {
      if (text.includes('pg_try_advisory_lock')) {
        tries += 1;
        return { rows: [{ ok: Date.now() - t0 >= freeAt }] };
      }
      if (text.includes('from chain_actions')) return { rows: [] };
      return { rows: [{ pg_advisory_unlock: true }] };
    },
    release(err?: unknown) {
      released.push(err);
    },
  };
  return { pool: { connect: async () => client } as unknown as Pool, released, tries: () => tries };
}

function recorder() {
  const lines: Record<string, unknown>[] = [];
  return { lines, log: createLogger({ sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>) }) };
}

/** Starts `job`'s handler; resolves `ranAt` (ms since start) if its body ran. */
function start(pool: Pool, job: (typeof WORKER_QUEUES)[number], log = recorder().log) {
  const t0 = Date.now();
  const s: { ranAt: number | null; done: boolean; facilities: readonly string[] | null } = { ranAt: null, done: false, facilities: null };
  const handler = lockedJob(pool, log, job, async () => ['fac-a'], async (ids) => {
    s.ranAt = Date.now() - t0;
    s.facilities = ids;
  });
  const finished = handler().then(() => {
    s.done = true;
  });
  return { s, finished };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('which cron jobs wait for the job lock', () => {
  it('settle-spend, reconcile and cfo-guard wait 20 s; every other cron job skips at once (the relay wake keeps its own wait)', () => {
    expect(SAME_MINUTE_LOCK_WAIT_MS).toBe(20_000);
    expect(JOB_LOCK_WAITS).toEqual({ 'settle-spend': { waitMs: 20_000 }, reconcile: { waitMs: 20_000 }, 'cfo-guard': { waitMs: 20_000 } });
    const waiting: readonly string[] = ['settle-spend', 'reconcile', 'cfo-guard'];
    for (const q of WORKER_QUEUES) if (!waiting.includes(q)) expect(JOB_LOCK_WAITS[q]).toBeUndefined();
  });

  it('the bound ends well inside the next minute’s run (the queues are exclusive: one queued or active)', () => {
    for (const w of Object.values(JOB_LOCK_WAITS)) expect(w.waitMs).toBeLessThan(60_000 / 2);
  });

  it('pool budget: every waiter holds a connection; the waiters plus the holder leave room for the running job', () => {
    const waiters = Object.keys(JOB_LOCK_WAITS).length + 1; // + the relay wake while a pause or cancelLoosen is pending
    expect(waiters).toBe(4);
    expect(TIGHTEN_LOCK_WAIT_MS).toBeGreaterThan(0);
    expect(waiters + 1 + MIN_FREE_CONNECTIONS).toBeLessThanOrEqual(WORKER_POOL_MAX);
  });
});

describe('settle-spend fired 0.4 s after another job took the lock', () => {
  it('waits, and runs as soon as the lock frees (here after 3 s)', async () => {
    const { pool, released } = heldPool(3_000);
    const { lines, log } = recorder();
    const { s, finished } = start(pool, 'settle-spend', log);
    await vi.advanceTimersByTimeAsync(2_900);
    expect(s.ranAt).toBeNull();
    expect(s.done).toBe(false);
    await vi.advanceTimersByTimeAsync(400);
    await finished;
    expect(s.ranAt).toBeGreaterThanOrEqual(3_000);
    expect(s.ranAt).toBeLessThan(3_400);
    expect(s.facilities).toEqual(['fac-a']);
    expect(released).toEqual([undefined]);
    expect(lines.map((l) => l.event)).toContain('job_lock_waited');
  });

  it('reconcile does the same', async () => {
    const { pool } = heldPool(8_000);
    const { s, finished } = start(pool, 'reconcile');
    await vi.advanceTimersByTimeAsync(8_400);
    await finished;
    expect(s.ranAt).toBeGreaterThanOrEqual(8_000);
  });

  it('cfo-guard does the same (re-check A-5)', async () => {
    const { pool } = heldPool(8_000);
    const { s, finished } = start(pool, 'cfo-guard');
    await vi.advanceTimersByTimeAsync(8_400);
    await finished;
    expect(s.ranAt).toBeGreaterThanOrEqual(8_000);
    expect(s.ranAt).toBeLessThan(8_400);
  });

  it('still skips after the 20 s bound (bounded: it never holds its connection longer)', async () => {
    const { pool, released, tries } = heldPool(Number.POSITIVE_INFINITY);
    const { lines, log } = recorder();
    const { s, finished } = start(pool, 'settle-spend', log);
    await vi.advanceTimersByTimeAsync(SAME_MINUTE_LOCK_WAIT_MS - 300);
    expect(s.done).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    await finished;
    expect(s.ranAt).toBeNull();
    expect(released).toEqual([undefined]);
    expect(tries()).toBeLessThanOrEqual(SAME_MINUTE_LOCK_WAIT_MS / 200 + 2);
    const skipped = lines.find((l) => l.event === 'job_skipped_lock_busy');
    expect(skipped).toMatchObject({ job: 'settle-spend' });
    expect(skipped?.waitedMs).toBeGreaterThanOrEqual(SAME_MINUTE_LOCK_WAIT_MS);
  });

  it('a job without a wait (stage-gate) still skips at once', async () => {
    const { pool, tries } = heldPool(1_000);
    const { s, finished } = start(pool, 'stage-gate');
    await vi.advanceTimersByTimeAsync(0);
    await finished;
    expect(s.ranAt).toBeNull();
    expect(tries()).toBe(1);
  });
});
