/** Hash-chained trace events (§26.5). Needs TEST_DATABASE_URL. */
import { hashObject, ZERO_HEX32 } from '@hogee/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendTrace } from '../../src/store/trace';
import { DB_SETUP_TIMEOUT_MS, DB_URL, openTestDb, type TestDb } from '../support/db';

describe.skipIf(!DB_URL)('appendTrace (Postgres)', () => {
  let t: TestDb;
  const facilityId = `fac-trace-${Date.now()}`;
  beforeAll(async () => {
    t = await openTestDb();
    await t.db.$client.query(
      `insert into facilities (facility_id, cap_minor, currency, reserve_floor_bps, lender_address, deployment_id, chain_id) values ($1, '1000', 'MYR', 300, $2, 'loop-1', 31337)`,
      [facilityId, `0x${'ab'.repeat(20)}`],
    );
  }, DB_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await t?.close();
  });

  it('chains each event to the previous hash, and the hash is keccak256(JCS(event without hash))', async () => {
    const first = await appendTrace(t.db.$client, { facilityId, traceId: 'trace:x', actor: 'policy', kind: 'PROPOSAL', verdict: 'AUTO', reasonCode: 'WITHIN_PLAN', summary: 'slot 1', refs: { paymentId: 'x', planVersion: 1 } });
    const second = await appendTrace(t.db.$client, { facilityId, traceId: 'trace:x', actor: 'executor', kind: 'TX', summary: 'sent', refs: { paymentId: 'x', txHash: `0x${'AB'.repeat(32)}` } });
    expect([first.seq, second.seq]).toEqual([0, 1]);
    const r = await t.db.$client.query(`select seq, ts, actor, kind, summary, policy_verdict, reason_code, plan_version, payment_id, tx_hash, prev_hash, hash from traces where facility_id = $1 and trace_id = 'trace:x' order by seq`, [facilityId]);
    expect(r.rows[0].prev_hash).toBe(ZERO_HEX32);
    expect(r.rows[1].prev_hash).toBe(r.rows[0].hash);
    expect(r.rows[1].tx_hash).toBe(`0x${'ab'.repeat(32)}`);
    const row = r.rows[1];
    const recomputed = hashObject({ traceId: 'trace:x', seq: 1, ts: new Date(row.ts).toISOString(), actor: 'executor', kind: 'TX', summary: 'sent', refs: { paymentId: 'x', txHash: row.tx_hash }, prevHash: row.prev_hash });
    expect(recomputed).toBe(row.hash);
  });
});
