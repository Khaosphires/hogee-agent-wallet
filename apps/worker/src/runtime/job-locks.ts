/**
 * Which cron jobs wait for the shared job lock (runtime/lock.ts), and how a cron job's handler takes it (fix-cfo-load).
 *
 * Seen live on Sepolia final-2 (19 Oct): every every-minute job fires in the same second and they share one advisory
 * lock; a job that found it busy was skipped until its next run, where the same race repeats. settle-spend's handler
 * starts ~0.4 s after the others, so it almost always lost: it ran once in 30 minutes and a deposit's confirmSettlement
 * starved; reconcile was skipped for minutes at a time too. Both now wait up to SAME_MINUTE_LOCK_WAIT_MS for the lock
 * (retrying every 200 ms), run as soon as it frees, and skip as before after the bound. 20 s is longer than another
 * job's usual pass and well inside the next minute (the queues are exclusive, so a waiting job never piles up runs).
 * cfo-guard (the CFO's tightening, woken by every sale) waits the same way (re-check A-5): it skipped at once, and the
 * two waiters above now hold the lock longer, so its wakes were lost; its pass keeps its own 10 s deadline, counted
 * from when it has the lock (cfo-guard.ts). The other cron jobs still skip at once; the relay wake keeps its own wait
 * (relay-wake.ts).
 *
 * Precedence (audit run-10 v-4): nothing orders the waiters, so behind one holder the waiters could take the lock in
 * turn and outlast the relay wake's 30 s bound, leaving a pending Treasury.pause or cancelLoosen unsigned on that wake.
 * So a waiter gives way: before each retry it asks hasPendingTighten on its own pooled connection (over the
 * facilities, read once per wait at the first retry) and does not try the lock while such a row is pending; the relay
 * takes it first. Its first try is unchanged (a free lock is taken at once, with no extra query), and it still skips at
 * its bound: while a tighten-only row stays unsigned (its relay deferred, say), a contested run of these jobs skips as
 * it did before fix-cfo-load, leaving the lock free for the relay. Only rows the relay delivers count (re-check A-1):
 * the safety pause's own attempts are reconcile's to sign, so reconcile never gives way to them.
 *
 * Pool budget: a waiting job holds one pooled connection. At most four wait at once (settle-spend, reconcile, cfo-guard
 * and the relay wake while a tighten-only row is pending); with the holder's lock connection that leaves
 * MIN_FREE_CONNECTIONS of the WORKER_POOL_MAX for the running job's own queries (job-locks.test.ts checks the sum).
 */
import type { Pool } from 'pg';
import { hasPendingTighten } from '../jobs/relay';
import type { WorkerQueue } from './boss';
import { withJobLock, type LockWait } from './lock';
import type { Logger } from './log';

/** The worker's DB pool (runtime/app.ts). */
export const WORKER_POOL_MAX = 8;
/** Connections that stay free for the running job while every waiter waits. */
export const MIN_FREE_CONNECTIONS = 3;
/** How long settle-spend, reconcile and cfo-guard wait for the lock before skipping. */
export const SAME_MINUTE_LOCK_WAIT_MS = 20_000;

/** The cron jobs that wait for the lock (the rest skip at once when it is busy). */
export const JOB_LOCK_WAITS: Readonly<Partial<Record<WorkerQueue, LockWait>>> = Object.freeze({
  'settle-spend': { waitMs: SAME_MINUTE_LOCK_WAIT_MS },
  reconcile: { waitMs: SAME_MINUTE_LOCK_WAIT_MS },
  'cfo-guard': { waitMs: SAME_MINUTE_LOCK_WAIT_MS },
});

/** `wait`, giving way while one of `facilities()` (read once, at the first retry) has a tighten-only row pending. */
function givingWayToTighten(wait: LockWait, facilities: () => Promise<readonly string[]>): LockWait {
  let ids: Promise<readonly string[]> | undefined;
  return { ...wait, yieldWhile: async (q) => hasPendingTighten(q, await (ids ??= facilities())) };
}

/**
 * A cron job's handler: `run` over the deployment's facilities under the shared job lock, waiting per `waits[job]` and
 * giving way to a pending tighten-only row while it waits (the relay wake, the only other waiter, is not built here).
 */
export function lockedJob(
  pool: Pool,
  log: Logger,
  job: WorkerQueue,
  facilities: () => Promise<readonly string[]>,
  run: (facilityIds: readonly string[]) => Promise<unknown>,
  waits: Readonly<Partial<Record<WorkerQueue, LockWait>>> = JOB_LOCK_WAITS,
): () => Promise<void> {
  return async () => {
    const wait = waits[job];
    await withJobLock(pool, log, job, async () => run(await facilities()), wait && givingWayToTighten(wait, facilities));
  };
}
