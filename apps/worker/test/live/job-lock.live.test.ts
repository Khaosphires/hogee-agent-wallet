/**
 * fix-cfo-load: settle-spend and reconcile no longer starve behind the shared job lock (seen live on Sepolia final-2:
 * every every-minute job fires in the same second, settle-spend's handler started ~0.4 s late, found the lock taken and
 * was skipped, run after run). On a real Postgres session advisory lock: a waiting job runs as soon as the holder
 * releases, still skips once its bound is over, and a job without a wait skips at once. Postgres + Anvil
 * (TEST_DATABASE_URL, TEST_RPC_URL; only the database is used).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lockedJob } from '../../src/runtime/job-locks';
import { withJobLock } from '../../src/runtime/lock';
import { silentLogger } from '../../src/runtime/log';
import { LIVE, LIVE_TIMEOUT_MS, openLive, type Live } from '../support/live';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!LIVE)('cron jobs vs the job lock (live)', { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  /** Holds the shared job lock as another every-minute job's pass would, until `release()`. */
  function holdLock() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const held = withJobLock(live.db.$client, silentLogger, 'timelock-executor', () => gate);
    return { held, release };
  }
  /** Starts `job`'s handler as runtime/app.ts builds it; `ran` turns true if its body ran. */
  function fire(job: 'settle-spend' | 'reconcile' | 'cfo-guard' | 'stage-gate', waits?: Parameters<typeof lockedJob>[5]) {
    const s = { ran: false, done: false };
    const handler = lockedJob(live.db.$client, silentLogger, job, async () => [], async () => void (s.ran = true), waits);
    const finished = handler().finally(() => (s.done = true));
    return { s, finished };
  }

  beforeAll(async () => {
    live = await openLive();
  }, LIVE_TIMEOUT_MS);
  afterAll(async () => {
    await live?.close();
  });

  it('settle-spend fired while another job holds the lock waits, then runs as soon as the lock frees', async () => {
    const lock = holdLock();
    await sleep(50);
    await sleep(400); // settle-spend's handler starts ~0.4 s after the others
    const settle = fire('settle-spend');
    await sleep(1_500);
    expect(settle.s).toEqual({ ran: false, done: false }); // waiting, not skipped
    const released = Date.now();
    lock.release();
    await settle.finished;
    expect(settle.s.ran).toBe(true);
    expect(Date.now() - released).toBeLessThan(1_000);
    expect(await lock.held).toMatchObject({ ran: true });
  });

  it('reconcile waits too; with the bound over it still skips (here a 600 ms bound)', async () => {
    const lock = holdLock();
    await sleep(50);
    const started = Date.now();
    const reconcile = fire('reconcile', { reconcile: { waitMs: 600, pollMs: 50 } });
    await reconcile.finished;
    expect(reconcile.s.ran).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
    expect(Date.now() - started).toBeLessThan(2_000);
    lock.release();
    await lock.held;
  });

  // cfo-guard waits too since re-check A-5 (job-locks.ts JOB_LOCK_WAITS); stage-gate is one that still does not.
  it('a cron job without a wait (stage-gate) still skips at once', async () => {
    const lock = holdLock();
    await sleep(50);
    const started = Date.now();
    const gate = fire('stage-gate');
    await gate.finished;
    expect(gate.s.ran).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
    lock.release();
    await lock.held;
  });
});
