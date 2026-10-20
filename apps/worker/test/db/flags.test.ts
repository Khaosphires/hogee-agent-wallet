/** Demo/operator flags (hogee_worker.flags): they can only stop the tick or the process, never grant anything. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AUTONOMY_FLAG, CRASH_FLAG, autonomyRunning, consumeCrashFlag, readFlag, writeFlag } from '../../src/store/flags';
import { migrateWorkerSchema } from '../../src/store/schema';
import { DB_SETUP_TIMEOUT_MS, DB_URL, openTestDb, type TestDb } from '../support/db';

describe.skipIf(!DB_URL)('worker flags (db)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await openTestDb();
    await migrateWorkerSchema(t.db.$client);
  }, DB_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.db.$client.query('delete from hogee_worker.flags');
  });

  it('autonomy runs unless explicitly stopped', async () => {
    expect(await autonomyRunning(t.db.$client)).toBe(true);
    await writeFlag(t.db.$client, AUTONOMY_FLAG, { running: false });
    expect(await autonomyRunning(t.db.$client)).toBe(false);
    await writeFlag(t.db.$client, AUTONOMY_FLAG, { running: true });
    expect(await autonomyRunning(t.db.$client)).toBe(true);
  });

  it('the crash flag fires once: consumed atomically by the first broadcast', async () => {
    expect(await consumeCrashFlag(t.db.$client)).toBe(false);
    await writeFlag(t.db.$client, CRASH_FLAG, { armed: true });
    const [a, b] = await Promise.all([consumeCrashFlag(t.db.$client), consumeCrashFlag(t.db.$client)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await readFlag(t.db.$client, CRASH_FLAG)).toBeUndefined();
  });
});
