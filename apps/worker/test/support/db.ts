/**
 * Throwaway Postgres for the db and live tests: TEST_DATABASE_URL (skipped when unset). Applies the packages/db
 * migrations and the worker schema once per process; a session advisory lock keeps test files that share the
 * database from running at the same time.
 */
import { fileURLToPath } from 'node:url';
import { createDb, type Db } from '@hogee/db';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { migrateWorkerSchema } from '../../src/store/schema';

export const DB_URL = process.env.TEST_DATABASE_URL;
/** beforeAll may wait for a live test file to release the shared lock. */
export const DB_SETUP_TIMEOUT_MS = 300_000;
const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/drizzle/', import.meta.url));
// Same key as the live tests (and packages/chain's): db and live files share the worker tables, so one at a time.
const TEST_LOCK_KEY = 0x4e0_1e05;

export interface TestDb {
  readonly db: Db;
  close(): Promise<void>;
}

export async function openTestDb(): Promise<TestDb> {
  if (!DB_URL) throw new Error('TEST_DATABASE_URL is required');
  const db = createDb(DB_URL, { maxConnections: 12 });
  db.$client.on('error', () => undefined);
  const lock = await db.$client.connect();
  await lock.query('select pg_advisory_lock($1)', [TEST_LOCK_KEY]);
  // Cast: the migrator resolves to this package's drizzle-orm instance (see src/store/pg.ts); same runtime.
  await migrate(db as unknown as Parameters<typeof migrate>[0], { migrationsFolder });
  await migrateWorkerSchema(db.$client);
  return {
    db,
    async close() {
      await lock.query('select pg_advisory_unlock($1)', [TEST_LOCK_KEY]);
      lock.release();
      await db.$client.end();
    },
  };
}
