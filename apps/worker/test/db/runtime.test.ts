/**
 * Runtime wiring on Postgres (TEST_DATABASE_URL): the job lock serialises every signing job across processes, and
 * pg-boss creates the three queues (idempotently), schedules them and runs a job through its handler.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBoss, WORKER_QUEUES } from '../../src/runtime/boss';
import { withJobLock } from '../../src/runtime/lock';
import { silentLogger } from '../../src/runtime/log';
import { DB_SETUP_TIMEOUT_MS, DB_URL, openTestDb, type TestDb } from '../support/db';

describe.skipIf(!DB_URL)('runtime (Postgres)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await openTestDb();
  }, DB_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await t?.close();
  });

  it('runs one locked job at a time; a second one is skipped, not queued behind it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = withJobLock(t.db.$client, silentLogger, 'autonomous-tick', async () => {
      await gate;
      return 'first';
    });
    await new Promise((r) => setTimeout(r, 50));
    const second = await withJobLock(t.db.$client, silentLogger, 'reconcile', async () => 'second');
    expect(second).toEqual({ ran: false });
    release();
    expect(await first).toEqual({ ran: true, value: 'first' });
    expect(await withJobLock(t.db.$client, silentLogger, 'reconcile', async () => 'third')).toEqual({ ran: true, value: 'third' });
  });

  it('pg-boss: creates the queues twice without error, schedules them and runs a sent job', async () => {
    const ran: string[] = [];
    const handlers = Object.fromEntries(WORKER_QUEUES.map((q) => [q, async () => void ran.push(q)])) as Record<(typeof WORKER_QUEUES)[number], () => Promise<void>>;
    const schedules = {
      'autonomous-tick': '*/20 * * * *',
      reconcile: '* * * * *',
      'settle-spend': '* * * * *',
      relay: '* * * * *',
      'record-sale': '* * * * *',
      'timelock-executor': '* * * * *',
      'stage-gate': '*/10 * * * *',
      'agent-actions': '* * * * *',
      'cfo-guard': '*/10 * * * *',
    } as const;
    const opts = { connectionString: DB_URL as string, schema: 'pgboss_test', schedules, handlers, log: silentLogger, pollingIntervalSeconds: 0.5 };
    const again = await startBoss(opts);
    await again.stop({ graceful: true, timeout: 5_000 });
    const boss = await startBoss(opts);
    try {
      expect((await boss.getQueues()).map((q) => q.name).filter((n) => !n.startsWith('__pgboss')).sort()).toEqual([...WORKER_QUEUES].sort());
      expect((await boss.getSchedules()).map((s) => `${s.name} ${s.cron}`).sort()).toEqual(Object.entries(schedules).map(([n, c]) => `${n} ${c}`).sort());
      // Options converge on restart even for queues an older worker created (createQueue alone keeps the old ones).
      expect(await boss.getQueue('reconcile')).toMatchObject({ policy: 'exclusive', retryLimit: 0, expireInSeconds: 300 });
      await boss.send('reconcile', {});
      const deadline = Date.now() + 15_000;
      while (!ran.includes('reconcile') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      expect(ran).toContain('reconcile');
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  }, 30_000);
});
