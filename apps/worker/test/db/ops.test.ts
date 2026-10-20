/** Operator commands against Postgres (TEST_DATABASE_URL): status, manual halt, resume. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runOps } from '../../src/ops/cli';
import { silentLogger } from '../../src/runtime/log';
import { activeHalt, haltReasons, raiseHalt } from '../../src/store/halt';
import { writeHeartbeat } from '../../src/store/heartbeat';
import { queueSafetyPause } from '../../src/store/safety-pause';
import { DB_SETUP_TIMEOUT_MS, DB_URL, openTestDb, type TestDb } from '../support/db';

describe.skipIf(!DB_URL)('ops CLI (Postgres)', () => {
  let t: TestDb;
  const out: string[] = [];
  const ops = (...argv: string[]) => runOps(argv, { db: t.db, log: silentLogger, print: (s) => out.push(s) });

  beforeAll(async () => {
    t = await openTestDb();
    await t.db.$client.query('truncate hogee_worker.halts, hogee_worker.halt_events, hogee_worker.heartbeats, hogee_worker.safety_pauses');
  }, DB_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await t?.close();
  });

  it('halt → status → resume', async () => {
    await writeHeartbeat(t.db.$client, { job: 'reconcile', scope: 'global', status: 'ok', detail: {} });
    expect(await ops('halt', '--reason', 'suspicious payout')).toBe(0);
    expect((await activeHalt(t.db.$client))?.reason).toBe('OPERATOR_HALT');
    out.length = 0;
    expect(await ops('status')).toBe(0);
    expect(out[0]).toMatch(/^HALTED since .*OPERATOR_HALT/);
    expect(out[1]).toMatch(/1 unacknowledged reason .*--ack-through/);
    const [event] = await haltReasons(t.db.$client, (await activeHalt(t.db.$client))?.id as string);
    expect(out[2]).toMatch(new RegExp(`#${event?.id} .*OPERATOR_HALT .*suspicious payout`));
    expect(out[3]).toMatch(/^reconcile \[global\] ok/);
    // Unacknowledged reasons exist: --ack-through (the last id `status` showed) is required.
    out.length = 0;
    expect(await ops('resume', '--note', 'checked', '--by', 'lead')).toBe(1);
    expect(out.join('\n')).toMatch(/refused.*--ack-through/s);
    expect(await activeHalt(t.db.$client)).not.toBeNull();
    expect(await ops('resume', '--note', 'checked', '--by', 'lead', '--ack-through', event?.id as string)).toBe(0);
    expect(await activeHalt(t.db.$client)).toBeNull();
    expect(await ops('resume', '--note', 'again')).toBe(0);
    expect(out.at(-1)).toBe('nothing to resume: no active halt');
  });

  it('status lists every unacknowledged reason of the halt; resume prints what it acknowledges', async () => {
    expect(await ops('halt', '--reason', 'ops drill')).toBe(0);
    await raiseHalt(t.db.$client, silentLogger, 'ORPHAN_SPEND', { txHash: '0xabc' });
    out.length = 0;
    expect(await ops('status')).toBe(0);
    expect(out[0]).toMatch(/^HALTED since .*OPERATOR_HALT/);
    expect(out[1]).toMatch(/2 unacknowledged reasons/);
    expect(out[2]).toMatch(/OPERATOR_HALT .*ops drill/);
    expect(out[3]).toMatch(/ORPHAN_SPEND .*0xabc/);
    const [first, second] = await haltReasons(t.db.$client, (await activeHalt(t.db.$client))?.id as string);
    // A resume that only saw the first reason refuses: the second was raised after it (or was never read).
    out.length = 0;
    expect(await ops('resume', '--note', 'checked one', '--ack-through', first?.id as string)).toBe(1);
    expect(out.join('\n')).toMatch(new RegExp(`#${second?.id} .*ORPHAN_SPEND`));
    expect(await activeHalt(t.db.$client)).not.toBeNull();
    out.length = 0;
    expect(await ops('resume', '--note', 'checked both', '--ack-through', second?.id as string)).toBe(0);
    expect(out.join('\n')).toMatch(/acknowledged 2 reasons: OPERATOR_HALT, ORPHAN_SPEND/);
  });

  it('status lists open safety pauses; resume refuses while one is open unless --abandon-pause', async () => {
    const { halt } = await raiseHalt(t.db.$client, silentLogger, 'ORPHAN_SPEND', { txHash: '0xfe' });
    await queueSafetyPause(t.db.$client, { id: 'orphan:0xfe:2', haltId: halt.id, reason: 'ORPHAN_SPEND', detail: {} });
    const [event] = await haltReasons(t.db.$client, halt.id);
    out.length = 0;
    expect(await ops('status')).toBe(0);
    expect(out.join('\n')).toMatch(/1 open safety pause.*\n\s+- orphan:0xfe:2 /);
    out.length = 0;
    expect(await ops('resume', '--note', 'checked', '--ack-through', event?.id as string)).toBe(1);
    expect(out.join('\n')).toMatch(/refused.*orphan:0xfe:2.*--abandon-pause/s);
    expect(await activeHalt(t.db.$client)).not.toBeNull();
    out.length = 0;
    expect(await ops('resume', '--note', 'paused by hand', '--ack-through', event?.id as string, '--abandon-pause')).toBe(0);
    expect(out.join('\n')).toMatch(/abandoned 1 safety pause: orphan:0xfe:2/);
    expect(await activeHalt(t.db.$client)).toBeNull();
  });

  it('refuses a resume without a note, a malformed --ack-through and unknown commands', async () => {
    expect(await ops('resume')).toBe(2);
    expect(await ops('resume', '--note', 'x', '--ack-through', '12abc')).toBe(2);
    expect(await ops('reboot')).toBe(2);
  });
});
