/**
 * Worker-owned tables (schema hogee_worker): halt flag, heartbeats, non-canonical watch. Needs a throwaway Postgres
 * (TEST_DATABASE_URL); skipped otherwise.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { activeHalt, clearHalt, haltReasons, raiseHalt } from '../../src/store/halt';
import { openSafetyPauses, queueSafetyPause } from '../../src/store/safety-pause';
import { readHeartbeats, writeHeartbeat } from '../../src/store/heartbeat';
import { trackNonCanonical, trackUnresolved } from '../../src/store/noncanonical';
import { publishRoles } from '../../src/store/roles';
import { migrateWorkerSchema } from '../../src/store/schema';
import { createLogger } from '../../src/runtime/log';
import { DB_SETUP_TIMEOUT_MS, DB_URL, openTestDb, type TestDb } from '../support/db';

/** Waits (bounded) until some session waits on a row lock, so the race above is staged before it is released. */
async function waitForLockWait(pool: { query: (text: string) => Promise<{ rows: { n: number }[] }> }): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    const r = await pool.query(`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`);
    if ((r.rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.skipIf(!DB_URL)('worker store (Postgres)', () => {
  let t: TestDb;
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({ sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>) });

  beforeAll(async () => {
    t = await openTestDb();
  }, DB_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    lines.length = 0;
    await t.db.$client.query('truncate hogee_worker.halts, hogee_worker.halt_events, hogee_worker.heartbeats, hogee_worker.noncanonical_watch, hogee_worker.unresolved_watch, hogee_worker.safety_pauses');
  });

  it('migrates idempotently', async () => {
    await migrateWorkerSchema(t.db.$client);
    await migrateWorkerSchema(t.db.$client);
    const r = await t.db.$client.query(`select table_name from information_schema.tables where table_schema = 'hogee_worker' order by 1`);
    expect(r.rows.map((x: { table_name: string }) => x.table_name)).toEqual(['flags', 'halt_events', 'halts', 'heartbeats', 'mock_payouts', 'noncanonical_watch', 'roles', 'safety_pauses', 'unresolved_watch']);
  });

  it('raises one active halt, logs it, and an operator clears it', async () => {
    expect(await activeHalt(t.db.$client)).toBeNull();
    const first = await raiseHalt(t.db.$client, log, 'RECOVERY_ERROR', { facilityId: 'fac-1' });
    expect(first.raised).toBe(true);
    const second = await raiseHalt(t.db.$client, log, 'NONCE_OCCUPIED', {});
    expect(second.raised).toBe(false);
    expect(second.halt.reason).toBe('RECOVERY_ERROR');
    expect(lines.filter((l) => l.event === 'halt_raised')).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'error', reason: 'RECOVERY_ERROR' });

    const cleared = await clearHalt(t.db.$client, log, { by: 'ops-cli', note: 'checked the row', ackThrough: 'all' });
    expect(cleared).toMatchObject({ status: 'cleared', halt: { reason: 'RECOVERY_ERROR' } });
    expect(await activeHalt(t.db.$client)).toBeNull();
    expect(await clearHalt(t.db.$client, log, { by: 'ops-cli', note: 'again', ackThrough: 'all' })).toEqual({ status: 'none' });
    expect((await raiseHalt(t.db.$client, log, 'ORPHAN_SPEND', {})).raised).toBe(true);
  });

  it('records every reason raised while a halt is active; clearing acknowledges them all', async () => {
    const first = await raiseHalt(t.db.$client, log, 'OPERATOR_HALT', { note: 'ops' });
    const second = await raiseHalt(t.db.$client, log, 'ORPHAN_SPEND', { txHash: '0xab' });
    expect(second).toMatchObject({ raised: false, recorded: true });
    expect(second.halt.id).toBe(first.halt.id);
    // The same reason with the same detail is not recorded twice (a persistent fault re-reported every pass).
    expect(await raiseHalt(t.db.$client, log, 'ORPHAN_SPEND', { txHash: '0xab' })).toMatchObject({ raised: false, recorded: false });
    expect(await raiseHalt(t.db.$client, log, 'ORPHAN_SPEND', { txHash: '0xcd' })).toMatchObject({ raised: false, recorded: true });
    const reasons = await haltReasons(t.db.$client, first.halt.id);
    expect(reasons.map((r) => [r.reason, r.detail])).toEqual([
      ['OPERATOR_HALT', { note: 'ops' }],
      ['ORPHAN_SPEND', { txHash: '0xab' }],
      ['ORPHAN_SPEND', { txHash: '0xcd' }],
    ]);
    expect(reasons.every((r) => r.acknowledgedAt === null)).toBe(true);
    // A reason added to an active halt is an error line too: a log watcher must see it.
    expect(lines.filter((l) => l.event === 'halt_reason_added' && l.level === 'error').map((l) => l.reason)).toEqual(['ORPHAN_SPEND', 'ORPHAN_SPEND']);

    await clearHalt(t.db.$client, log, { by: 'lead', note: 'checked all three', ackThrough: 'all' });
    const acked = await haltReasons(t.db.$client, first.halt.id);
    expect(acked.every((r) => r.acknowledgedAt !== null && r.acknowledgedBy === 'lead')).toBe(true);
    const next = await raiseHalt(t.db.$client, log, 'ORPHAN_SPEND', { txHash: '0xab' });
    expect(next).toMatchObject({ raised: true, recorded: true });
    expect((await haltReasons(t.db.$client, next.halt.id)).map((r) => r.reason)).toEqual(['ORPHAN_SPEND']);
  });

  it('acknowledges only the reasons up to --ack-through, and refuses while a newer one is unacknowledged', async () => {
    const first = await raiseHalt(t.db.$client, log, 'OPERATOR_HALT', { note: 'ops' });
    await raiseHalt(t.db.$client, log, 'ORPHAN_SPEND', { txHash: '0xab' });
    const [e1, e2] = await haltReasons(t.db.$client, first.halt.id);
    const refused = await clearHalt(t.db.$client, log, { by: 'lead', note: 'saw the first only', ackThrough: e1?.id as string });
    expect(refused).toMatchObject({ status: 'newer_events', newer: [expect.objectContaining({ id: e2?.id, reason: 'ORPHAN_SPEND' })] });
    expect((await activeHalt(t.db.$client))?.id).toBe(first.halt.id);
    expect((await haltReasons(t.db.$client, first.halt.id)).every((r) => r.acknowledgedAt === null)).toBe(true);
    const cleared = await clearHalt(t.db.$client, log, { by: 'lead', note: 'saw both', ackThrough: e2?.id as string });
    expect(cleared).toMatchObject({ status: 'cleared', acknowledged: [expect.objectContaining({ id: e1?.id }), expect.objectContaining({ id: e2?.id })] });
  });

  it('refuses to clear a halt whose safety pause is still open, unless the pause is abandoned', async () => {
    const { halt } = await raiseHalt(t.db.$client, log, 'ORPHAN_SPEND', { txHash: '0xab' });
    await queueSafetyPause(t.db.$client, { id: 'orphan:0xab:0', haltId: halt.id, reason: 'ORPHAN_SPEND', detail: {} });
    const refused = await clearHalt(t.db.$client, log, { by: 'lead', note: 'too early', ackThrough: 'all' });
    expect(refused).toMatchObject({ status: 'open_pauses', open: [expect.objectContaining({ id: 'orphan:0xab:0' })] });
    expect(await activeHalt(t.db.$client)).not.toBeNull();
    const cleared = await clearHalt(t.db.$client, log, { by: 'lead', note: 'treasury paused by hand', ackThrough: 'all', abandonPause: true });
    expect(cleared).toMatchObject({ status: 'cleared', abandoned: ['orphan:0xab:0'] });
    expect(await openSafetyPauses(t.db.$client)).toEqual([]);
    const r = await t.db.$client.query<{ closed_reason: string }>(`select closed_reason from hogee_worker.safety_pauses where id = 'orphan:0xab:0'`);
    expect(r.rows[0]?.closed_reason).toBe('ABANDONED');
  });

  it('a reason raised while a resume holds the halt joins a NEW halt, never the one being cleared (M1 race)', async () => {
    const { halt } = await raiseHalt(t.db.$client, log, 'OPERATOR_HALT', { note: 'ops' });
    const resume = await t.db.$client.connect();
    try {
      // A resume in progress: the halt row is locked, the clear and the acknowledgement are not committed yet.
      await resume.query('begin');
      await resume.query(`select id from hogee_worker.halts where id = $1 for update`, [halt.id]);
      const raising = raiseHalt(t.db.$client, log, 'ORPHAN_SPEND', { txHash: '0xef' });
      await waitForLockWait(t.db.$client);
      await resume.query(`update hogee_worker.halts set cleared_at = now(), cleared_by = 'lead', clear_note = 'race' where id = $1`, [halt.id]);
      await resume.query(`update hogee_worker.halt_events set acknowledged_at = now(), acknowledged_by = 'lead' where halt_id = $1 and acknowledged_at is null`, [halt.id]);
      await resume.query('commit');
      const raised = await raising;
      expect(raised).toMatchObject({ raised: true, recorded: true });
      expect(raised.halt.id).not.toBe(halt.id);
      expect((await activeHalt(t.db.$client))?.id).toBe(raised.halt.id);
      expect((await haltReasons(t.db.$client, halt.id)).map((r) => r.reason)).toEqual(['OPERATOR_HALT']);
    } finally {
      resume.release();
    }
  });

  it('backfills the first reason of a halt raised before halt_events existed', async () => {
    await t.db.$client.query(`insert into hogee_worker.halts (reason, detail) values ('LEGACY_HALT', '{"a":1}'::jsonb)`);
    await migrateWorkerSchema(t.db.$client);
    const halt = await activeHalt(t.db.$client);
    expect((await haltReasons(t.db.$client, halt?.id as string)).map((r) => [r.reason, r.detail])).toEqual([['LEGACY_HALT', { a: 1 }]]);
  });

  it('upserts one heartbeat row per job and scope', async () => {
    await writeHeartbeat(t.db.$client, { job: 'autonomous-tick', scope: 'fac-1', status: 'ok', detail: { block: '7' } });
    await writeHeartbeat(t.db.$client, { job: 'autonomous-tick', scope: 'fac-1', status: 'fee_skip', detail: { block: '9' } });
    await writeHeartbeat(t.db.$client, { job: 'reconcile', scope: 'fac-1', status: 'ok', detail: {} });
    const beats = await readHeartbeats(t.db.$client);
    expect(beats).toHaveLength(2);
    expect(beats.find((b) => b.job === 'autonomous-tick')).toMatchObject({ beats: 2, status: 'fee_skip', detail: { block: '9' } });
  });

  it('counts consecutive passes per non-canonical row and forgets rows that recover', async () => {
    const a = { table: 'payments', id: 'p-1' };
    const b = { table: 'chain_actions', id: 'a-1' };
    expect(await trackNonCanonical(t.db.$client, 'fac-1', [a, b])).toEqual(new Map([['payments/p-1', 1], ['chain_actions/a-1', 1]]));
    expect(await trackNonCanonical(t.db.$client, 'fac-1', [a])).toEqual(new Map([['payments/p-1', 2]]));
    expect(await trackNonCanonical(t.db.$client, 'fac-2', [b])).toEqual(new Map([['chain_actions/a-1', 1]]));
    expect(await trackNonCanonical(t.db.$client, 'fac-1', [a, b])).toEqual(new Map([['payments/p-1', 3], ['chain_actions/a-1', 1]]));
    expect(await trackNonCanonical(t.db.$client, 'fac-1', [])).toEqual(new Map());
  });

  it('publishes the public role addresses per deployment (lowercase, upserted)', async () => {
    const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts');
    const k = () => privateKeyToAccount(generatePrivateKey());
    const signers = { set: 'FINAL' as const, agent: k(), oracle: k(), lender: k(), relayer: k() };
    await publishRoles(t.db.$client, { deploymentId: 'final-roles', chainId: 31337 }, signers);
    await publishRoles(t.db.$client, { deploymentId: 'final-roles', chainId: 31337 }, signers);
    const r = await t.db.$client.query(`select role, address from hogee_worker.roles where deployment_id = 'final-roles' order by role`);
    expect(r.rows).toEqual([
      { role: 'agent', address: signers.agent.address.toLowerCase() },
      { role: 'lender', address: signers.lender.address.toLowerCase() },
      { role: 'oracle', address: signers.oracle.address.toLowerCase() },
      { role: 'relayer', address: signers.relayer.address.toLowerCase() },
    ]);
  });

  it('counts unresolved settlement attestations in their own watch (independent of the non-canonical one)', async () => {
    const c = { table: 'chain_actions', id: 'settle-confirm:p-9' };
    expect(await trackUnresolved(t.db.$client, 'fac-u', [c])).toEqual(new Map([['chain_actions/settle-confirm:p-9', 1]]));
    expect(await trackNonCanonical(t.db.$client, 'fac-u', [])).toEqual(new Map());
    expect(await trackUnresolved(t.db.$client, 'fac-u', [c])).toEqual(new Map([['chain_actions/settle-confirm:p-9', 2]]));
    expect(await trackUnresolved(t.db.$client, 'fac-u', [])).toEqual(new Map());
    expect(await trackUnresolved(t.db.$client, 'fac-u', [c])).toEqual(new Map([['chain_actions/settle-confirm:p-9', 1]]));
  });
});
