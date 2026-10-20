/**
 * Session timeouts on the worker's pg connections (TEST_DATABASE_URL): a stuck statement or a long lock wait fails
 * instead of holding the shared job lock (a session advisory lock) and starving reconcile.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withJobLock } from '../../src/runtime/lock';
import { silentLogger } from '../../src/runtime/log';
import { applySessionTimeouts } from '../../src/store/pg';
import { migrateWorkerSchema, WORKER_MIGRATE_LOCK } from '../../src/store/schema';
import { DB_SETUP_TIMEOUT_MS, DB_URL, openTestDb, type TestDb } from '../support/db';

const LOCK_UNDER_TEST = 0x4e0_1e7f;

describe.skipIf(!DB_URL)('worker pg session timeouts (Postgres)', () => {
  let t: TestDb;
  let timed: pg.Pool;
  beforeAll(async () => {
    t = await openTestDb();
    timed = new pg.Pool({ connectionString: DB_URL, max: 3 });
    timed.on('error', () => undefined);
    applySessionTimeouts(timed, { statementTimeoutMs: 300, lockTimeoutMs: 150 }, silentLogger);
  }, DB_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await timed?.end();
    await t?.close();
  });

  it('sets statement_timeout and lock_timeout on every new connection', async () => {
    const r = await timed.query<{ s: string; l: string }>(`select current_setting('statement_timeout') as s, current_setting('lock_timeout') as l`);
    expect(r.rows[0]).toEqual({ s: '300ms', l: '150ms' });
  });

  it('cancels a statement that runs past statement_timeout', async () => {
    await expect(timed.query('select pg_sleep(5)')).rejects.toMatchObject({ code: '57014' });
  });

  it('fails a lock wait past lock_timeout', async () => {
    const holder = await t.db.$client.connect();
    try {
      await holder.query('select pg_advisory_lock($1)', [LOCK_UNDER_TEST]);
      await expect(timed.query('select pg_advisory_lock($1)', [LOCK_UNDER_TEST])).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await holder.query('select pg_advisory_unlock($1)', [LOCK_UNDER_TEST]);
      holder.release();
    }
  });

  it('fails closed: a connection whose timeouts cannot be set is destroyed, and nothing runs on it (re-check L6)', async () => {
    const broken = new pg.Pool({ connectionString: DB_URL, max: 2 });
    broken.on('error', () => undefined);
    // Registered first, so it runs before the timeouts are set: their set_config fails on every new connection.
    broken.on('connect', (client: pg.PoolClient) => {
      const query = client.query.bind(client) as (...args: unknown[]) => unknown;
      Object.assign(client, { query: (...args: unknown[]) => (String(args[0]).includes('set_config') ? Promise.reject(new Error('set_config refused')) : query(...args)) });
    });
    applySessionTimeouts(broken, { statementTimeoutMs: 300, lockTimeoutMs: 150 }, silentLogger);
    try {
      await expect(broken.query('select 1')).rejects.toThrow('set_config refused');
      expect(broken.totalCount).toBe(0);
    } finally {
      await broken.end();
    }
  });

  it('the startup migration waits for another worker holding the migration lock, past the short lock_timeout (re-check L6)', async () => {
    const holder = await t.db.$client.connect();
    try {
      await holder.query('begin');
      await holder.query('select pg_advisory_xact_lock($1)', [WORKER_MIGRATE_LOCK]);
      const migrating = migrateWorkerSchema(timed); // lock_timeout 150 ms, statement_timeout 300 ms on this pool
      await new Promise((resolve) => setTimeout(resolve, 600));
      await holder.query('commit');
      await expect(migrating).resolves.toBeUndefined();
    } finally {
      holder.release();
    }
  });

  it('a stuck statement inside a job ends the job and frees the job lock for the next one', async () => {
    const started = Date.now();
    await expect(withJobLock(timed, silentLogger, 'autonomous-tick', async () => timed.query('select pg_sleep(30)'))).rejects.toMatchObject({ code: '57014' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await withJobLock(timed, silentLogger, 'reconcile', async () => 'ran')).toEqual({ ran: true, value: 'ran' });
  });
});
