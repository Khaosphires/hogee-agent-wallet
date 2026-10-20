/**
 * G0-REVIEW (M9, M10), G0-AUDIT (v-4), G2 (founder enrolment): live checks on a real Postgres. Skipped unless TEST_DATABASE_URL
 * is set. Point it at a THROWAWAY database: it applies the migrations, then inserts inside a transaction
 * that is always rolled back. Keep every live check in this file: a second live file would run
 * `migrate` concurrently against the same fresh database.
 */
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import {
  consumeEnrolmentCode,
  createDb,
  escrowOrders,
  isFounderKeyRejected,
  issueEnrolmentCode,
  openEnrolmentCode,
  rejectPendingFounderKey,
  facilities,
  payees,
  payments,
  suppliers,
  type DbTx,
  type PaymentState,
} from '../src/index';

const url = process.env.TEST_DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL('../drizzle/', import.meta.url));
const h = (c: string) => `0x${c.repeat(64)}`;
const LENDER = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const FIXTURE_PAYEES = ['supplier-a', 'shopee-ads', 'spx-logistics', 'shopee-fees', 'printer-kl', 'lhdn-tax'];

class Rollback extends Error {}

describe.skipIf(!url)('tenancy on a live database', () => {
  const db = createDb(url ?? 'postgres://unused@127.0.0.1:1/unused');

  beforeAll(async () => {
    await migrate(db, { migrationsFolder });
  });
  afterAll(async () => {
    await db.$client.end();
  });

  /** Runs `fn` in a transaction that is always rolled back. */
  async function inRollback(fn: (tx: DbTx) => Promise<void>): Promise<void> {
    await expect(
      db.transaction(async (tx) => {
        await fn(tx);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  }

  type PgFailure = { code?: string; constraint?: string };

  /** Runs `fn` in a savepoint and returns the Postgres error (code + constraint) it failed with. */
  async function failure(tx: DbTx, fn: (sp: DbTx) => Promise<unknown>): Promise<PgFailure | undefined> {
    try {
      await tx.transaction(async (sp) => {
        await fn(sp);
      });
      return undefined;
    } catch (e) {
      const err = ((e as { cause?: PgFailure }).cause ?? e) as PgFailure;
      return { code: err.code, constraint: err.constraint };
    }
  }

  /** Runs `fn` in a savepoint and returns the Postgres error code it failed with. */
  async function failureCode(tx: DbTx, fn: (sp: DbTx) => Promise<unknown>): Promise<string | undefined> {
    return (await failure(tx, fn))?.code;
  }

  async function seedTenant(tx: DbTx, facilityId: string): Promise<void> {
    await tx.insert(facilities).values({
      facilityId, capMinor: '1000000', currency: 'MYR', reserveFloorBps: 300,
      lenderAddress: LENDER, deploymentId: 'final-1', chainId: 31337,
    });
    await tx.insert(suppliers).values({
      facilityId, supplierId: 'supplier-a', displayName: 'Supplier A', country: 'CN',
      recordJson: {}, evidenceTier: 'tier2', sourceType: 'mock',
    });
    await tx.insert(payees).values(
      FIXTURE_PAYEES.map((id) => ({
        id, facilityId, kind: id === 'supplier-a' ? ('supplier' as const) : ('platform' as const),
        displayName: id, supplierId: id === 'supplier-a' ? 'supplier-a' : null, payoutAccountHash: h('a'),
      })),
    );
    await tx.insert(escrowOrders).values({
      orderId: 'order-a-001', facilityId, supplierId: 'supplier-a', payeeId: 'supplier-a',
      scheduleHash: h('b'), totalMinor: '430000',
    });
  }

  it('two tenants reuse supplier-a, order-a-001 and every fixture payee id', async () => {
    await inRollback(async (tx) => {
      await seedTenant(tx, 'fac-rina');
      await seedTenant(tx, 'fac-second');
      const rows = await tx.execute(sql`select count(*)::int as n from payees where id = 'shopee-ads'`);
      expect(rows.rows[0]).toEqual({ n: 2 });
    });
  });

  it('rejects a cross-tenant reference and out-of-range money', async () => {
    await inRollback(async (tx) => {
      await seedTenant(tx, 'fac-rina');
      await tx.insert(facilities).values({
        facilityId: 'fac-other', capMinor: '1', currency: 'MYR', reserveFloorBps: 300,
        lenderAddress: LENDER, deploymentId: 'final-1', chainId: 31337,
      });
      // fac-other has no payee `spx-logistics`; fac-rina's must not satisfy the FK.
      const fk = await failureCode(tx, (sp) =>
        sp.insert(payments).values({
          id: 'p-1', facilityId: 'fac-other', kind: 'SPEND', intentId: h('c'), lineKey: 'LOGISTICS',
          lineId: h('d'), payeeId: 'spx-logistics', amountMinor: '100', invoiceHash: h('e'), planVersion: 1,
          decisionId: '0192f000-0000-7000-8000-000000000001', rationaleHash: h('f'), traceId: 't-1',
        }),
      );
      expect(fk).toBe('23503'); // foreign_key_violation
      // Raw SQL bypasses minor(); the uint128 CHECK still holds.
      const overflow = await failureCode(tx, (sp) =>
        sp.execute(sql`update facilities set cap_minor = 340282366920938463463374607431768211456 where facility_id = 'fac-rina'`),
      );
      expect(overflow).toBe('23514'); // check_violation
    });
  });

  // SG-DECISIONS (0003_sg_country): an SG facility in SGD and its SG founder store; a country outside the enum does not.
  it('stores an SG facility and founder, and refuses a country outside the enum', async () => {
    await inRollback(async (tx) => {
      await tx.insert(facilities).values({
        facilityId: 'fac-mei', capMinor: '1000000', currency: 'SGD', reserveFloorBps: 300,
        lenderAddress: LENDER, deploymentId: 'final-1', chainId: 31337,
      });
      await tx.execute(sql`insert into founders (id, facility_id, country, residency) values ('founder-mei', 'fac-mei', 'SG', 'citizen')`);
      const rows = await tx.execute(sql`select country::text as c from founders where facility_id = 'fac-mei'`);
      expect(rows.rows).toEqual([{ c: 'SG' }]);
      const bad = await failureCode(tx, (sp) =>
        sp.execute(sql`insert into founders (id, facility_id, country, residency) values ('founder-x', 'fac-mei', 'TH', 'citizen')`),
      );
      expect(bad).toBe('22P02'); // invalid_text_representation: not a country_code value
    });
  });

  // G0-AUDIT (v-4): a DROPPED row's signed bytes can still be mined at its nonce, so it keeps the intent.
  // For FUND_MILESTONE (no on-chain intent registry) this index is the only guard against a second
  // execution of one funding decision. Only exits with proof release it: CANCELLED names a foreign tx
  // that consumed the nonce (finding 8), REVERTED carries its receipt (finding 9).
  describe('payments intent uniqueness (G0-AUDIT v-4)', () => {
    type PaymentRow = typeof payments.$inferInsert;
    const FAC = 'fac-rina';
    const SIGNER = '0x1111111111111111111111111111111111111111';
    /** Signed at nonce 7; current tx hash h('2'). */
    const SIGNED = { signerAddress: SIGNER, chainId: 31337, rawSignedTx: '0x02f8', nonce: 7n, txHash: h('2') };
    const FOREIGN_TX = h('4');

    /** A FUND_MILESTONE row for intent h('1'). */
    const milestonePayment = (id: string, state: PaymentState, extra: Partial<PaymentRow> = {}): PaymentRow => ({
      id, facilityId: FAC, kind: 'FUND_MILESTONE', intentId: h('1'), lineKey: 'SUPPLIER',
      lineId: h('d'), payeeId: 'supplier-a', orderId: 'order-a-001', milestoneIdx: 0, amountMinor: '100000',
      invoiceHash: h('e'), planVersion: 1, state, decisionId: '0192f000-0000-7000-8000-000000000001',
      rationaleHash: h('f'), traceId: 't-1', ...extra,
    });
    const byId = (id: string) => and(eq(payments.facilityId, FAC), eq(payments.id, id));

    it('a DROPPED row still blocks a second live row for its intent', async () => {
      await inRollback(async (tx) => {
        await seedTenant(tx, FAC);
        await tx.insert(payments).values(milestonePayment('p-1', 'DROPPED', SIGNED));
        const dup = await failure(tx, (sp) => sp.insert(payments).values(milestonePayment('p-2', 'PROPOSED')));
        expect(dup).toEqual({ code: '23505', constraint: 'payments_facility_intent_id_unique' }); // unique_violation
      });
    });

    it.each([
      { exit: 'DROPPED -> CANCELLED', from: { state: 'DROPPED', ...SIGNED }, to: { state: 'CANCELLED', nonceConsumedByTxHash: FOREIGN_TX } },
      { exit: 'INCLUDED -> REVERTED', from: { state: 'INCLUDED', ...SIGNED, block: 100n }, to: { state: 'REVERTED' } },
    ] as const)('$exit releases the intent', async ({ from, to }) => {
      await inRollback(async (tx) => {
        await seedTenant(tx, FAC);
        await tx.insert(payments).values(milestonePayment('p-1', from.state, from));
        await tx.update(payments).set(to).where(byId('p-1'));
        const retry = await failure(tx, (sp) => sp.insert(payments).values(milestonePayment('p-2', 'PROPOSED')));
        expect(retry).toBeUndefined();
      });
    });

    // Finding 8: after an in-place fee bump, the ORIGINAL bytes may still be the tx that consumed the nonce.
    it('after a fee bump, the original tx cannot be recorded as the one that consumed the nonce', async () => {
      await inRollback(async (tx) => {
        await seedTenant(tx, FAC);
        await tx.insert(payments).values(milestonePayment('p-1', 'BROADCAST', SIGNED));
        // Fee bump in place (M11): the old hash moves into superseded_tx_hashes in the same UPDATE.
        await tx
          .update(payments)
          .set({
            rawSignedTx: '0x02f9', txHash: h('5'), state: 'DROPPED',
            supersededTxHashes: sql`array_append(${payments.supersededTxHashes}, ${payments.txHash})`,
          })
          .where(byId('p-1'));
        const ownOriginal = await failure(tx, (sp) =>
          sp.update(payments).set({ state: 'CANCELLED', nonceConsumedByTxHash: h('2') }).where(byId('p-1')),
        );
        expect(ownOriginal).toEqual({ code: '23514', constraint: 'payments_nonce_consumed_by_foreign_tx' });
        const dup = await failure(tx, (sp) => sp.insert(payments).values(milestonePayment('p-2', 'PROPOSED')));
        expect(dup?.code).toBe('23505'); // still DROPPED, still holds the intent
      });
    });

    type Rejection = { why: string; row: Partial<PaymentRow> & { state: PaymentState }; constraint: string };
    it.each<Rejection>([
      { why: 'CANCELLED without the consuming tx', row: { state: 'CANCELLED', ...SIGNED }, constraint: 'payments_cancelled_iff_nonce_consumed' },
      { why: 'a consuming tx on a non-CANCELLED row', row: { state: 'DROPPED', ...SIGNED, nonceConsumedByTxHash: FOREIGN_TX }, constraint: 'payments_cancelled_iff_nonce_consumed' },
      { why: 'CANCELLED by one of its own superseded txs', row: { state: 'CANCELLED', ...SIGNED, supersededTxHashes: [h('3')], nonceConsumedByTxHash: h('3') }, constraint: 'payments_nonce_consumed_by_foreign_tx' },
      { why: 'CANCELLED by its own current tx', row: { state: 'CANCELLED', ...SIGNED, nonceConsumedByTxHash: SIGNED.txHash }, constraint: 'payments_nonce_consumed_by_foreign_tx' },
      { why: 'CANCELLED without a current tx hash', row: { state: 'CANCELLED', ...SIGNED, txHash: null, nonceConsumedByTxHash: FOREIGN_TX }, constraint: 'payments_nonce_consumed_by_foreign_tx' },
      { why: 'REVERTED without a receipt block', row: { state: 'REVERTED', ...SIGNED }, constraint: 'payments_reverted_has_receipt' },
      { why: 'a malformed superseded tx hash', row: { state: 'DROPPED', ...SIGNED, supersededTxHashes: [h('A')] }, constraint: 'payments_superseded_tx_hashes_hex32' },
      { why: 'POLICY_DENIED with signed bytes', row: { state: 'POLICY_DENIED', ...SIGNED, txHash: null }, constraint: 'payments_policy_denied_unsigned' },
    ])('rejects $why', async ({ row, constraint }) => {
      await inRollback(async (tx) => {
        await seedTenant(tx, FAC);
        const err = await failure(tx, (sp) => sp.insert(payments).values(milestonePayment('p-1', row.state, row)));
        expect(err).toEqual({ code: '23514', constraint }); // check_violation
      });
    });

    it('rejects a NULL superseded tx hash (array_to_string would skip it)', async () => {
      await inRollback(async (tx) => {
        await seedTenant(tx, FAC);
        await tx.insert(payments).values(milestonePayment('p-1', 'DROPPED', SIGNED));
        const err = await failure(tx, (sp) =>
          sp.execute(sql`update payments set superseded_tx_hashes = ARRAY[NULL]::text[] where id = 'p-1'`),
        );
        expect(err).toEqual({ code: '23514', constraint: 'payments_superseded_tx_hashes_hex32' });
      });
    });
  });

  // G2 (run-4 lead 5): one-time enrolment codes and rejected pending keys, through the @hogee/db helper only.
  describe('founder enrolment (G2)', () => {
    const FAC = 'fac-enrol';
    const at = (min: number) => new Date(Date.UTC(2026, 9, 18, 9, min));

    /** BEGIN … ROLLBACK on one raw client (the helper takes node-postgres `query`). */
    async function inRawRollback(fn: (c: PoolClient) => Promise<void>): Promise<void> {
      const c = await db.$client.connect();
      try {
        await c.query('BEGIN');
        await c.query(
          `insert into facilities (facility_id, cap_minor, currency, reserve_floor_bps, lender_address, deployment_id, chain_id)
           values ($1, 1000000, 'MYR', 300, $2, 'final-1', 31337)`,
          [FAC, LENDER],
        );
        await c.query(`insert into founders (id, facility_id, country, residency) values ('rina', $1, 'MY', 'citizen')`, [FAC]);
        await fn(c);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    }
    const issue = (c: PoolClient, id: string, hash: string, now = at(0)) =>
      issueEnrolmentCode(c, { facilityId: FAC, founderId: 'rina', id, codeHash: hash, now, expiresAt: new Date(now.getTime() + 15 * 60_000) });
    const pgCode = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        return undefined;
      } catch (e) {
        return (e as { code?: string; constraint?: string }).constraint ?? (e as { code?: string }).code;
      }
    };

    it('stores only the hash; a code is open until it expires (wall clock), then never again', async () => {
      await inRawRollback(async (c) => {
        expect(await issue(c, 'enr-1', h('1'))).toBe(0);
        const open = await openEnrolmentCode(c, FAC, at(14));
        expect(open).toMatchObject({ id: 'enr-1', founderId: 'rina', codeHash: h('1') });
        expect(open?.expiresAt.toISOString()).toBe(at(15).toISOString());
        expect(await openEnrolmentCode(c, FAC, at(15))).toBeNull();
        expect(await consumeEnrolmentCode(c, { facilityId: FAC, id: 'enr-1', credentialId: 'cred-1', now: at(16) })).toBe(false);
        const cols = await c.query(`select column_name from information_schema.columns where table_name = 'founder_enrolment_codes'`);
        expect(cols.rows.map((r) => r.column_name)).not.toContain('code');
      });
    });

    it('a code is consumed once; a newer code revokes the open one', async () => {
      await inRawRollback(async (c) => {
        await issue(c, 'enr-1', h('1'));
        expect(await issue(c, 'enr-2', h('2'))).toBe(1);
        expect(await consumeEnrolmentCode(c, { facilityId: FAC, id: 'enr-1', credentialId: 'cred-1', now: at(1) })).toBe(false);
        expect(await consumeEnrolmentCode(c, { facilityId: FAC, id: 'enr-2', credentialId: 'cred-1', now: at(1) })).toBe(true);
        expect(await consumeEnrolmentCode(c, { facilityId: FAC, id: 'enr-2', credentialId: 'cred-2', now: at(2) })).toBe(false);
        expect(await openEnrolmentCode(c, FAC, at(2))).toBeNull();
        const r = await c.query(`select id, used_credential_id, revoked_at is not null as revoked from founder_enrolment_codes where facility_id = $1 order by id`, [FAC]);
        expect(r.rows).toEqual([
          { id: 'enr-1', used_credential_id: null, revoked: true },
          { id: 'enr-2', used_credential_id: 'cred-1', revoked: false },
        ]);
      });
    });

    it('the database allows one open code per facility and refuses a used code without its credential', async () => {
      await inRawRollback(async (c) => {
        await issue(c, 'enr-1', h('1'));
        await c.query('SAVEPOINT s');
        const insertOpen = () =>
          c.query(`insert into founder_enrolment_codes (id, facility_id, founder_id, code_hash, code_expires_at) values ('enr-x', $1, 'rina', $2, $3)`, [FAC, h('3'), at(15)]);
        expect(await pgCode(insertOpen)).toBe('founder_enrolment_codes_one_open');
        await c.query('ROLLBACK TO SAVEPOINT s');
        expect(await pgCode(() => c.query(`update founder_enrolment_codes set used_at = now() where id = 'enr-1'`))).toBe('founder_enrolment_codes_used_names_credential');
        await c.query('ROLLBACK TO SAVEPOINT s');
        expect(await pgCode(() => c.query(`update founder_enrolment_codes set code_hash = 'abc' where id = 'enr-1'`))).toBe('founder_enrolment_codes_code_hash_hex32');
      });
    });

    it('rejects only the pending key, frees the slot and remembers the credential; a registered key is never touched', async () => {
      await inRawRollback(async (c) => {
        await c.query(`update founders set passkey_credential_id = 'cred-1', qx = $2, qy = $3, passkey_registered_at = $4 where facility_id = $1`, [FAC, h('a'), h('b'), at(3)]);
        // Audit run-7: a code issued while the key was pending is revoked by the rejection.
        await issue(c, 'enr-pending', h('9'), at(4));
        const reject = (credentialId: string) => rejectPendingFounderKey(c, { facilityId: FAC, founderId: 'rina', credentialId, now: at(5) });
        expect(await reject('cred-other')).toBe(false);
        expect(await openEnrolmentCode(c, FAC, at(4))).toMatchObject({ id: 'enr-pending' });
        expect(await reject('cred-1')).toBe(true);
        expect(await openEnrolmentCode(c, FAC, at(5))).toBeNull();
        expect(await isFounderKeyRejected(c, FAC, { credentialId: 'cred-1' })).toBe(true);
        // Audit run-7: the same public key under a new credential id is rejected too; another key is not.
        expect(await isFounderKeyRejected(c, FAC, { credentialId: 'cred-new', qx: h('a').toUpperCase().replace('0X', '0x'), qy: h('b') })).toBe(true);
        expect(await isFounderKeyRejected(c, FAC, { credentialId: 'cred-new', qx: h('a'), qy: h('c') })).toBe(false);
        expect(await isFounderKeyRejected(c, FAC, { credentialId: 'cred-new' })).toBe(false);
        const f = await c.query('select passkey_credential_id, qx, qy, passkey_registered_at, key_status from founders where facility_id = $1', [FAC]);
        expect(f.rows[0]).toEqual({ passkey_credential_id: null, qx: null, qy: null, passkey_registered_at: null, key_status: 'PENDING_LENDER' });
        const rej = await c.query('select credential_id, qx, qy, registered_at, rejected_at from rejected_founder_keys where facility_id = $1', [FAC]);
        expect(rej.rows[0]).toEqual({ credential_id: 'cred-1', qx: h('a'), qy: h('b'), registered_at: at(3), rejected_at: at(5) });
        await c.query(`update founders set passkey_credential_id = 'cred-2', qx = $2, qy = $3, key_status = 'REGISTERED' where facility_id = $1`, [FAC, h('c'), h('d')]);
        expect(await reject('cred-2')).toBe(false);
        expect(await isFounderKeyRejected(c, FAC, { credentialId: 'cred-2', qx: h('c'), qy: h('d') })).toBe(false);
      });
    });
  });
});
