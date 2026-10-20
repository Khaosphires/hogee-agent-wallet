/**
 * Plain node-postgres access for the worker's own queries. The worker does not import drizzle-orm at runtime:
 * pg-boss brings @opentelemetry/api into this package, which makes pnpm resolve a second drizzle-orm instance
 * whose types do not match @hogee/db's. Queries here are fully parameterised ($1, $2, …); `@hogee/chain` keeps
 * doing the signing-table writes through @hogee/db's own drizzle instance.
 */
import type { Db } from '@hogee/db';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { Logger } from '../runtime/log';

/** A pool or a client inside a transaction. */
export type Pg = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

export function poolOf(db: Db): Pool {
  return db.$client;
}

export async function rows<T extends QueryResultRow>(q: Pg, text: string, values: readonly unknown[] = []): Promise<T[]> {
  const result = await q.query<T>(text, values as unknown[]);
  return result.rows;
}

/** BEGIN … COMMIT on one pooled client; ROLLBACK and rethrow on any error. */
export async function inTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface SessionTimeouts {
  /** statement_timeout: a statement running longer is cancelled (SQLSTATE 57014). */
  readonly statementTimeoutMs: number;
  /** lock_timeout: a statement waiting longer for a lock (row, table or advisory) fails (SQLSTATE 55P03). */
  readonly lockTimeoutMs: number;
}

function checkTimeout(ms: number, name: string): string {
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new RangeError(`${name} must be a positive integer of milliseconds`);
  return String(ms);
}

/**
 * Sets session-level statement_timeout and lock_timeout on every new connection of `pool`, failing CLOSED (re-check
 * L6): it runs as pg-pool's `verify` step, which completes before a new connection is handed out, and a connection
 * whose set_config fails is destroyed (released with the error) while the query that asked for it fails. So no
 * statement ever runs on a connection without them. One stuck statement then fails instead of holding a row lock or
 * the job's session advisory lock (runtime/lock.ts) forever and starving reconcile. Session level (set_config(…,
 * false)), so a transaction cannot shorten-and-forget it. Call it before the pool's first query.
 */
export function applySessionTimeouts(pool: Pool, t: SessionTimeouts, log: Pick<Logger, 'error'>): void {
  const statement = checkTimeout(t.statementTimeoutMs, 'statementTimeoutMs');
  const lock = checkTimeout(t.lockTimeoutMs, 'lockTimeoutMs');
  const previous = pool.options.verify;
  pool.options.verify = (client: PoolClient, done: (err?: Error) => void) => {
    client
      .query(`select set_config('statement_timeout', $1, false), set_config('lock_timeout', $2, false)`, [statement, lock])
      .then(
        () => (previous ? previous(client, done) : done()),
        (error: unknown) => {
          log.error('pg_session_timeouts_failed', { error, action: 'connection destroyed; the query that needed it fails' });
          done(error instanceof Error ? error : new Error('could not set the session timeouts'));
        },
      );
  };
}

/** JSON with bigints as strings (chain values) for jsonb parameters. */
export function jsonParam(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}
