/**
 * The relay queue's handler (fixr-cfo, re-check LOW 5). Every job shares one advisory lock (runtime/lock.ts), and a job
 * that finds it busy is skipped. That was fine for everything except a tighten-only row: the officer's (or founder's)
 * Treasury.pause, or the cancelLoosen of a vetoed loosening. Its relay wake, skipped while cfo-guard or another job
 * held the lock, waited for the next relay cron (up to a minute). Now, while such a row is pending for one of this
 * deployment's facilities, the wake waits for the lock (up to TIGHTEN_LOCK_WAIT_MS, retrying every pollMs) and relays as
 * soon as it frees; after the pass, a tighten-only row that arrived during it (its own wake was dropped by the
 * exclusive queue) gets another pass, at most MAX_RELAY_PASSES in all. Without one, the wake skips at once, as before.
 */
import type { JobDeps } from '../jobs/deps';
import { hasPendingTighten, runRelay, type RelayReport } from '../jobs/relay';
import { poolOf } from '../store/pg';
import { withJobLock } from './lock';

/**
 * Longer than a cfo-guard pass (10 s, sends included) and shorter than the relay cron. One holder's pass is all that
 * stands ahead: the settle-spend, reconcile and cfo-guard waiters give way while the row is pending (job-locks.ts, audit
 * run-10 v-4, re-check A-5).
 */
export const TIGHTEN_LOCK_WAIT_MS = 30_000;
export const TIGHTEN_LOCK_POLL_MS = 200;
const MAX_RELAY_PASSES = 3;

export interface RelayWakeOptions {
  readonly waitMs?: number;
  readonly pollMs?: number;
}

/** One relay wake over `facilities()` (read before the lock, to know whether to wait, and again under it). */
export async function relayWake(d: JobDeps, facilities: () => Promise<readonly string[]>, o: RelayWakeOptions = {}): Promise<{ ran: boolean; reports: RelayReport[] }> {
  const pool = poolOf(d.db);
  const urgent = await hasPendingTighten(pool, await facilities());
  const wait = urgent ? { waitMs: o.waitMs ?? TIGHTEN_LOCK_WAIT_MS, pollMs: o.pollMs ?? TIGHTEN_LOCK_POLL_MS } : undefined;
  const r = await withJobLock(
    pool,
    d.log,
    'relay',
    async () => {
      const ids = await facilities();
      const reports = [...(await runRelay(d, ids))];
      for (let pass = 1; pass < MAX_RELAY_PASSES && (await hasPendingTighten(pool, ids)); pass += 1) reports.push(...(await runRelay(d, ids)));
      return reports;
    },
    wait,
  );
  return r.ran ? { ran: true, reports: r.value } : { ran: false, reports: [] };
}
