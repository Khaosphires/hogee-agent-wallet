/**
 * Against Postgres (TEST_DATABASE_URL; no chain): which Treasury.pause rows hold back the agent key's payments
 * (re-check A-2, store/pause-pending.ts), and that neither the relay's pending query nor the job-lock precedence check
 * (hasPendingTighten) counts a safety-pause attempt, which reconcile alone signs (re-check A-1). Every case gets its
 * own deployment id, so rows other files leave on `loop-1` never count here.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasPendingTighten, runRelay } from '../../src/jobs/relay';
import { silentLogger } from '../../src/runtime/log';
import { pendingPause } from '../../src/store/pause-pending';
import { closeSafetyPauses, queueSafetyPause } from '../../src/store/safety-pause';
import { DB_SETUP_TIMEOUT_MS, DB_URL, openTestDb, type TestDb } from '../support/db';

const CHAIN_ID = 31337;
type Dep = { readonly deploymentId: string; readonly chainId: number };

describe.skipIf(!DB_URL)('pending Treasury.pause rows and the safety pause’s own attempts (Postgres)', () => {
  let t: TestDb;
  const signer = `0x${randomBytes(20).toString('hex')}`;
  let nonce = 0;
  const q = (sql: string, values: unknown[] = []) => t.db.$client.query(sql, values);
  const newDep = (): Dep => ({ deploymentId: `pause-${randomUUID().slice(0, 8)}`, chainId: CHAIN_ID });

  async function facility(dep: Dep): Promise<string> {
    const id = `fac-${randomUUID().slice(0, 8)}`;
    await q(`insert into facilities (facility_id, cap_minor, currency, reserve_floor_bps, lender_address, deployment_id, chain_id) values ($1, 1000000, 'MYR', 300, $2, $3, $4)`, [
      id,
      `0x${'ab'.repeat(20)}`,
      dep.deploymentId,
      dep.chainId,
    ]);
    return id;
  }

  /** A Treasury.pause row; one past PENDING (or `signed`) carries signed bytes, as the schema requires. */
  async function pauseRow(facilityId: string, id: string, state: string, o: { signed?: boolean; revertReason?: string; refId?: string } = {}): Promise<void> {
    const signed = o.signed === true || state !== 'PENDING';
    await q(
      `insert into chain_actions (id, facility_id, kind, ref_id, state, signer_address, chain_id, raw_signed_tx, nonce, tx_hash, revert_reason, request_json)
       values ($1, $2, 'Treasury.pause', $3, $4, $5, $6, $7, $8, $9, $10, '{}'::jsonb)`,
      [
        id,
        facilityId,
        o.refId ?? facilityId,
        state,
        signed ? signer : null,
        signed ? CHAIN_ID : null,
        signed ? '0x02aa' : null,
        signed ? String((nonce += 1)) : null,
        signed ? `0x${randomBytes(32).toString('hex')}` : null,
        o.revertReason ?? null,
      ],
    );
  }

  beforeAll(async () => {
    t = await openTestDb();
    // An open halt (another db file's) would end the relay pass before what this file checks.
    await q('truncate hogee_worker.halts, hogee_worker.halt_events, hogee_worker.safety_pauses');
  }, DB_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await t?.close();
  });

  it('a pause not yet final holds agent spends back; a refused, reverted or finalized one does not', async () => {
    const dep = newDep();
    const fac = await facility(dep);
    expect(await pendingPause(t.db.$client, dep)).toBeNull();
    await pauseRow(fac, 'act-final', 'FINALIZED');
    await pauseRow(fac, 'act-reverted', 'REVERTED', { revertReason: 'NotAgent' });
    await pauseRow(fac, 'act-refused', 'PENDING', { revertReason: 'REFUSED: simulation reverts NotAgent' });
    expect(await pendingPause(t.db.$client, dep)).toBeNull();
    await pauseRow(fac, 'act-pending', 'PENDING');
    expect(await pendingPause(t.db.$client, dep)).toBe('act-pending');
    for (const [state, signed] of [
      ['PENDING', true],
      ['BROADCAST', true],
      ['INCLUDED', true],
    ] as const) {
      const d = newDep();
      await pauseRow(await facility(d), `act-${state.toLowerCase()}-signed`, state, { signed });
      expect(await pendingPause(t.db.$client, d)).toBe(`act-${state.toLowerCase()}-signed`);
    }
  });

  it('one Treasury per deployment: a pause on another facility of it counts, one of another deployment does not', async () => {
    const dep = newDep();
    const spender = await facility(dep);
    const sibling = await facility(dep);
    const elsewhere = newDep();
    await pauseRow(await facility(elsewhere), 'act-elsewhere', 'PENDING');
    expect(await pendingPause(t.db.$client, dep)).toBeNull();
    await pauseRow(sibling, 'act-sibling', 'BROADCAST');
    expect(await pendingPause(t.db.$client, dep)).toBe('act-sibling');
    expect(spender).not.toBe(sibling);
  });

  it('a safety-pause attempt holds agent spends back while its request is open, not once it is closed', async () => {
    const dep = newDep();
    const fac = await facility(dep);
    const req = `orphan:${fac}:0`;
    await queueSafetyPause(t.db.$client, { id: req, haltId: '1', reason: 'ORPHAN_SPEND', detail: {} });
    await pauseRow(fac, `safety-pause:${req}:1`, 'BROADCAST', { refId: req }); // say its nonce was taken by another tx
    expect(await pendingPause(t.db.$client, dep)).toBe(`safety-pause:${req}:1`);
    await closeSafetyPauses(t.db.$client, [req], 'ABANDONED');
    expect(await pendingPause(t.db.$client, dep)).toBeNull();
  });

  it('the relay never takes a safety-pause attempt, and the waiters do not give way to one; an officer pause counts', async () => {
    const dep = newDep();
    const fac = await facility(dep);
    const req = `orphan:${fac}:0`;
    await pauseRow(fac, `safety-pause:${req}:1`, 'PENDING', { refId: req });
    expect(await hasPendingTighten(t.db.$client, [fac])).toBe(false);
    const client = {
      readContract: async () => {
        throw new Error('no chain in this test');
      },
      getBlock: async () => {
        throw new Error('no chain in this test');
      },
    } as never;
    const deps = { db: t.db, client, log: silentLogger, config: { maxFeeWei: 1n }, signers: {}, deployment: { chainId: CHAIN_ID, contracts: { Treasury: { address: `0x${'cd'.repeat(20)}` } } } } as never;
    const [report] = await runRelay(deps, [fac]);
    expect(report?.actions).toEqual([]);
    const left = await q(`select state, raw_signed_tx, revert_reason from chain_actions where facility_id = $1 and id = $2`, [fac, `safety-pause:${req}:1`]);
    expect(left.rows).toEqual([{ state: 'PENDING', raw_signed_tx: null, revert_reason: null }]);
    await pauseRow(fac, 'act-officer-pause', 'PENDING');
    expect(await hasPendingTighten(t.db.$client, [fac])).toBe(true);
  });
});
