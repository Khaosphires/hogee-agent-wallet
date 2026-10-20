/**
 * One signing job at a time, across processes: a session advisory lock held on a dedicated connection for the job.
 * The nonce allocator is already safe under concurrency; this keeps the jobs' own reads (in-flight projection, hole
 * detection, settlement steps) from interleaving, and makes an accidental second worker process harmless. A job that
 * finds the lock taken is skipped, not queued: its schedule runs it again shortly. With a `wait` (fixr-cfo, re-check
 * LOW 5: the relay while a tighten-only row such as the officer's pause is pending) it retries every `pollMs` for up to
 * `waitMs` instead, holding its pooled connection, and runs as soon as the lock frees. A wait with `yieldWhile` (audit
 * run-10 v-4: settle-spend, reconcile and cfo-guard, job-locks.ts) asks it on that same connection before each retry
 * and does not try the lock while it answers true, so a more urgent waiter takes the lock first.
 *
 * Session semantics: the lock belongs to the connection's session, not to a transaction, so it survives a failed
 * statement and only ends with `pg_advisory_unlock` or the session itself. When the unlock cannot be confirmed the
 * connection is destroyed (released with an error) instead of going back to the pool still holding the lock, where a
 * later job would re-enter it and every other process would be locked out. A stuck statement inside the job is ended
 * by the pool's statement_timeout (store/pg.ts applySessionTimeouts), so the job fails and the lock is freed.
 */
import type { Pool, PoolClient } from 'pg';
import type { Logger } from './log';

export const JOB_LOCK_KEY = 0x4e0_1e70;
const DEFAULT_POLL_MS = 200;

export interface LockWait {
  /** How long to keep retrying a busy lock before skipping. */
  readonly waitMs: number;
  /** Between tries (default 200 ms). */
  readonly pollMs?: number;
  /**
   * Asked on the waiter's own connection before each retry (not before the first try): while true the waiter gives way
   * and does not try the lock. An error ends the wait: the job fails without the lock (fail closed).
   */
  readonly yieldWhile?: (q: Pick<PoolClient, 'query'>) => Promise<boolean>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withJobLock<T>(pool: Pool, log: Logger, job: string, fn: () => Promise<T>, wait?: LockWait): Promise<{ ran: true; value: T } | { ran: false }> {
  const client = await pool.connect();
  let healthy = true;
  try {
    const tryLock = async (): Promise<boolean> => {
      try {
        const r = await client.query<{ ok: boolean }>('select pg_try_advisory_lock($1) as ok', [JOB_LOCK_KEY]);
        return r.rows[0]?.ok === true;
      } catch (error: unknown) {
        healthy = false; // the session's lock state is unknown: never reuse it
        throw error;
      }
    };
    const started = Date.now();
    let locked = await tryLock();
    let retried = false;
    let yielded = false;
    while (!locked && wait && Date.now() - started < wait.waitMs) {
      await sleep(wait.pollMs ?? DEFAULT_POLL_MS);
      retried = true;
      if (wait.yieldWhile && (await wait.yieldWhile(client))) {
        yielded = true;
        continue;
      }
      locked = await tryLock();
    }
    const gaveWay = yielded ? { yielded: true } : {};
    if (!locked) {
      log.info('job_skipped_lock_busy', { job, ...(wait ? { waitedMs: Date.now() - started } : {}), ...gaveWay });
      return { ran: false };
    }
    if (retried) log.info('job_lock_waited', { job, waitedMs: Date.now() - started, ...gaveWay });
    try {
      return { ran: true, value: await fn() };
    } finally {
      try {
        await client.query('select pg_advisory_unlock($1)', [JOB_LOCK_KEY]);
      } catch (error: unknown) {
        healthy = false;
        log.error('job_lock_unlock_failed', { job, error, action: 'connection destroyed so its session lock ends' });
      }
    }
  } finally {
    client.release(healthy ? undefined : new Error('job lock state unknown: connection discarded'));
  }
}
