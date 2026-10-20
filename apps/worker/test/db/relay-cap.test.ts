/**
 * record-sale takes at most RECORD_SALE_PER_PASS oracle rows per pass (audit run-9 lead 4): every demo sale queues one
 * SalesOracle.recordSale, signed by the oracle key on the nonce sequence settlement shares, so a burst of sales is
 * drained a few per pass and the rest wait for the next one. Postgres with a stub chain (planVersion 0: each row is
 * deferred, nothing is signed). Needs TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RECORD_SALE_PER_PASS, runRelay } from '../../src/jobs/relay';
import { DB_SETUP_TIMEOUT_MS, DB_URL, openTestDb, type TestDb } from '../support/db';

const log = { child: () => log, info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never;
const PENDING = 25;

describe.skipIf(!DB_URL)('record-sale: a bounded pass (Postgres)', () => {
  let t: TestDb;
  const facilityId = `fac-relay-cap-${Date.now()}`;
  let reads = 0;
  const client = {
    readContract: async () => ((reads += 1), 0), // planVersion 0: no plan committed yet, so every row waits
    getBlock: async () => {
      throw new Error('no chain in this test');
    },
  } as never;
  const deps = () =>
    ({ db: t.db, client, log, config: { maxFeeWei: 1n }, signers: {}, deployment: { contracts: { PlanRegistry: { address: `0x${'11'.repeat(20)}` } } } }) as never;

  beforeAll(async () => {
    t = await openTestDb();
    // An open halt (another db file's) would end the pass before what this file checks.
    await t.db.$client.query('truncate hogee_worker.halts, hogee_worker.halt_events, hogee_worker.safety_pauses');
    await t.db.$client.query(
      `insert into facilities (facility_id, cap_minor, currency, reserve_floor_bps, lender_address, deployment_id, chain_id) values ($1, '1000', 'MYR', 300, $2, 'loop-1', 31337)`,
      [facilityId, `0x${'ab'.repeat(20)}`],
    );
    await t.db.$client.query(
      `insert into sales (id, facility_id, stripe_event_id, sale_id_hash, amount_bucket)
       select 'sale-' || i, $1, 'evt_' || i, '0x' || md5('s' || i) || md5('t' || i), 10000 from generate_series(1, $2::int) as i`,
      [facilityId, PENDING],
    );
    await t.db.$client.query(
      `insert into chain_actions (id, facility_id, kind, ref_id, request_json, created_at)
       select 'act-' || lpad(i::text, 3, '0'), $1, 'SalesOracle.recordSale', 'sale-' || i,
              jsonb_build_object('saleId', 'sale-' || i, 'saleIdHash', '0x' || md5('s' || i) || md5('t' || i), 'amountBucket', '10000'),
              now() - make_interval(secs => $2::int - i)
         from generate_series(1, $2::int) as i`,
      [facilityId, PENDING],
    );
  }, DB_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await t?.close();
  });

  it(`takes the ${10} oldest rows and leaves the rest PENDING for the next pass`, async () => {
    expect(RECORD_SALE_PER_PASS).toBe(10);
    const [r] = await runRelay(deps(), [facilityId], { oracle: true });
    expect(r?.actions).toHaveLength(RECORD_SALE_PER_PASS);
    expect(r?.actions.map((a) => a.actionId)).toEqual(Array.from({ length: 10 }, (_, k) => `act-${String(k + 1).padStart(3, '0')}`));
    expect(r?.actions.every((a) => a.result === 'deferred')).toBe(true);
    expect(reads).toBe(RECORD_SALE_PER_PASS); // one planVersion read per row taken, none for the rest
    const left = await t.db.$client.query(`select count(*)::int as n from chain_actions where facility_id = $1 and state = 'PENDING' and revert_reason is null`, [facilityId]);
    expect(left.rows[0].n).toBe(PENDING);
  });

  it('the relay queue (not oracle) never takes oracle rows', async () => {
    const [r] = await runRelay(deps(), [facilityId]);
    expect(r?.actions).toEqual([]);
  });
});

/**
 * Re-check review LOW 4: rows that keep failing (an RPC error, not a refusal) must not hold the batch's head. Each pass
 * takes the least recently tried rows, so a burst behind 10 failing rows is still reached on the next pass.
 */
describe.skipIf(!DB_URL)('record-sale: failing rows never block the rest (Postgres)', () => {
  let t: TestDb;
  const facilityId = `fac-relay-hol-${Date.now()}`;
  const client = {
    readContract: async () => {
      throw new Error('rpc unavailable');
    },
    getBlock: async () => {
      throw new Error('no chain in this test');
    },
  } as never;
  const deps = () =>
    ({ db: t.db, client, log, config: { maxFeeWei: 1n }, signers: {}, deployment: { contracts: { PlanRegistry: { address: `0x${'11'.repeat(20)}` } } } }) as never;
  const act = (i: number) => `hol-${String(i).padStart(3, '0')}`;

  beforeAll(async () => {
    t = await openTestDb();
    await t.db.$client.query('truncate hogee_worker.halts, hogee_worker.halt_events, hogee_worker.safety_pauses');
    await t.db.$client.query(
      `insert into facilities (facility_id, cap_minor, currency, reserve_floor_bps, lender_address, deployment_id, chain_id) values ($1, '1000', 'MYR', 300, $2, 'loop-1', 31337)`,
      [facilityId, `0x${'ab'.repeat(20)}`],
    );
    await t.db.$client.query(
      `insert into sales (id, facility_id, stripe_event_id, sale_id_hash, amount_bucket)
       select 'hsale-' || i, $1, 'hevt_' || i, '0x' || md5('hs' || i) || md5('ht' || i), 10000 from generate_series(1, $2::int) as i`,
      [facilityId, PENDING],
    );
    await t.db.$client.query(
      `insert into chain_actions (id, facility_id, kind, ref_id, request_json, created_at, updated_at)
       select 'hol-' || lpad(i::text, 3, '0'), $1, 'SalesOracle.recordSale', 'hsale-' || i,
              jsonb_build_object('saleId', 'hsale-' || i, 'saleIdHash', '0x' || md5('hs' || i) || md5('ht' || i), 'amountBucket', '10000'),
              now() - make_interval(secs => 600 + $2::int - i), now() - make_interval(secs => 600 + $2::int - i)
         from generate_series(1, $2::int) as i`,
      [facilityId, PENDING],
    );
  }, DB_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await t?.close();
  });

  it('takes the next rows after a failing batch, then comes back to the failed ones', async () => {
    const pass = async () => (await runRelay(deps(), [facilityId], { oracle: true }))[0]?.actions ?? [];
    const first = await pass();
    expect(first.map((a) => a.actionId)).toEqual(Array.from({ length: 10 }, (_, k) => act(k + 1)));
    expect(first.every((a) => a.result === 'error')).toBe(true);
    const second = await pass();
    expect(second.map((a) => a.actionId)).toEqual(Array.from({ length: 10 }, (_, k) => act(k + 11)));
    const third = await pass();
    expect(third.map((a) => a.actionId)).toEqual([...Array.from({ length: 5 }, (_, k) => act(k + 21)), ...Array.from({ length: 5 }, (_, k) => act(k + 1))]);
    // Still PENDING and never refused: a transient error is retried, not given up.
    const left = await t.db.$client.query(`select count(*)::int as n from chain_actions where facility_id = $1 and state = 'PENDING' and revert_reason is null`, [facilityId]);
    expect(left.rows[0].n).toBe(PENDING);
  });
});
