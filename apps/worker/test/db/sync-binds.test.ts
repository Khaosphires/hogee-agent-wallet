/**
 * A supplier order whose bindPayee never lands (audit run-9, critic gap 1): its payee is cancelled, so the order stops
 * holding SUPPLIER budget (the API counts only PENDING / COOLING / BOUND payees' unfunded milestones) and the chat
 * leaves ORDER_PENDING. Re-check 9 item 2: whatever happened to the bind (REVERTED, refused before signing, or never
 * landed), it is cancelled only once the signed SupplierApproval has expired (+2 min of chain time), since until then
 * its public calldata can still be replayed and bind the payee; never while the chain shows the payee bound (read at
 * the same block as `now`). A CANCELLED payee the chain shows bound after all is re-opened with an ALERT, and the
 * worker never funds an order whose payee the database holds CANCELLED. Postgres with a stub chain.
 * Needs TEST_DATABASE_URL.
 */
import { randomBytes } from 'node:crypto';
import { toBytes32Tag } from '@hogee/chain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readEscrowOrders } from '../../src/jobs/agent-actions-world';
import { BIND_EXPIRY_MARGIN_S, bindFailure, syncFailedBinds } from '../../src/jobs/sync-binds';
import { syncPayees } from '../../src/jobs/sync';
import { DB_SETUP_TIMEOUT_MS, DB_URL, openTestDb, type TestDb } from '../support/db';

const log = { child: () => log, info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never;
const NOW = 1_800_000_000n;
const BLOCK = 4_242n;
const LATER = NOW + 600n + BIND_EXPIRY_MARGIN_S + 1n; // past every approval's expiry + margin
const LINE = toBytes32Tag('SUPPLIER').toLowerCase();
/** A signer per run: (signer, chain, nonce) is unique across the whole table. */
const SIGNER = `0x${randomBytes(20).toString('hex')}`;

describe('bindFailure (re-check 9: a bind fails for good only once its approval has expired)', () => {
  const at = (expiry: bigint | null) => ({ expiry });
  it('waits while the signed approval could still bind the payee, whatever happened to this bind', () => {
    for (const a of [
      { state: 'REVERTED', signed: true, revertReason: 'SignatureExpired' },
      { state: 'PENDING', signed: false, revertReason: 'REFUSED: simulation reverts InvalidSignature' },
      { state: 'BROADCAST', signed: true, revertReason: null },
    ]) {
      expect(bindFailure({ ...a, ...at(NOW + 1n) }, NOW), a.state).toBeNull();
      expect(bindFailure({ ...a, ...at(NOW - BIND_EXPIRY_MARGIN_S) }, NOW), a.state).toBeNull(); // inside the margin
      expect(bindFailure({ ...a, ...at(null) }, NOW), a.state).toBeNull(); // no expiry to wait for: never cancelled
    }
  });

  it('names why once the approval expired more than the margin ago; a landed bind never fails', () => {
    const old = at(NOW - BIND_EXPIRY_MARGIN_S - 1n);
    expect(bindFailure({ state: 'REVERTED', signed: true, revertReason: 'SignatureExpired', ...old }, NOW)).toBe('it reverted: SignatureExpired');
    expect(bindFailure({ state: 'REVERTED', signed: true, revertReason: null, ...old }, NOW)).toBe('it reverted');
    expect(bindFailure({ state: 'PENDING', signed: false, revertReason: 'REFUSED: simulation reverts X', ...old }, NOW)).toBe('it was not sent: simulation reverts X');
    expect(bindFailure({ state: 'BROADCAST', signed: true, revertReason: null, ...old }, NOW)).toBe('the signed approval expired before it landed');
    expect(bindFailure({ state: 'FINALIZED', signed: true, revertReason: null, ...old }, NOW)).toBeNull();
    expect(bindFailure({ state: 'INCLUDED', signed: true, revertReason: null, ...old }, NOW)).toBeNull();
  });
});

type Case = 'reverted' | 'refused' | 'expired' | 'fresh' | 'bound' | 'landed' | 'replayed' | 'gone';
const EXPIRY: Record<Case, bigint> = {
  reverted: NOW + 600n, // the approval is still valid: a replay of its public calldata could still bind
  refused: NOW + 600n,
  expired: NOW - BIND_EXPIRY_MARGIN_S - 1n,
  fresh: NOW - BIND_EXPIRY_MARGIN_S + 1n, // expired, but inside the margin: it could still be mined
  bound: NOW - 3_600n,
  landed: NOW - 3_600n,
  replayed: NOW - 3_600n,
  gone: NOW - 3_600n,
};
/** Payees the stub chain shows bound. */
const BOUND = new Set(['sup-bound', 'sup-replayed'].map((id) => toBytes32Tag(id).toLowerCase()));

describe.skipIf(!DB_URL)('syncFailedBinds, syncPayees and readEscrowOrders (Postgres)', () => {
  let t: TestDb;
  const facilityId = `fac-binds-${Date.now()}`;
  const q = (sql: string, values: unknown[]) => t.db.$client.query(sql, values);
  const reads: { functionName: string; blockNumber: unknown }[] = [];
  const client = {
    readContract: async ({ functionName, args, blockNumber }: { functionName: string; args: readonly string[]; blockNumber?: bigint }) => {
      reads.push({ functionName, blockNumber });
      if (functionName === 'payeeBinding') return { bound: BOUND.has(String(args[1]).toLowerCase()), coolingUntil: NOW + 3_600n, lifetimeCapMinor: 100_000n, paidMinor: 0n };
      const orderId = String(args[0]).toLowerCase();
      const payee = ['open', 'gone'].find((c) => toBytes32Tag(`order-${c}-001`).toLowerCase() === orderId);
      if (functionName === 'order') return { exists: payee !== undefined, payeeId: toBytes32Tag(`sup-${payee ?? 'none'}`), lineId: LINE, inspectionRequired: true };
      if (functionName === 'milestones') return [{ amountMinor: 30_000n, fundedMinor: 0n, autoRelease: true, released: false, evidenceHash: `0x${'0'.repeat(64)}` }];
      if (functionName === 'isIntentUsed') return false;
      throw new Error(`unexpected read ${functionName}`);
    },
  } as never;
  const deployment = { contracts: { Treasury: { address: `0x${'cd'.repeat(20)}` }, MilestoneEscrow: { address: `0x${'ce'.repeat(20)}` } } };
  const d = () => ({ db: t.db, client, log, deployment }) as never;
  const status = async (c: Case | 'open') => (await q('select status from payees where facility_id = $1 and id = $2', [facilityId, `sup-${c}`])).rows[0]?.status;
  const alerts = async (c: Case) =>
    (await q(`select kind, reason_code, summary from traces where facility_id = $1 and trace_id = $2 and kind = 'ALERT' order by seq`, [facilityId, `trace:act:bind-${c}`])).rows as {
      kind: string;
      reason_code: string | null;
      summary: string;
    }[];
  const openMinor = async () =>
    (
      await q(
        `select coalesce(sum(m.amount_minor - m.funded_minor), 0)::text as n from escrow_milestones m
           join escrow_orders o on o.facility_id = m.facility_id and o.order_id = m.order_id
           join payees p on p.facility_id = o.facility_id and p.id = o.payee_id
          where m.facility_id = $1 and p.status in ('PENDING', 'COOLING', 'BOUND') and m.funded_minor < m.amount_minor`,
        [facilityId],
      )
    ).rows[0]?.n;

  async function order(c: Case | 'open', action: { state: string; signed: boolean; revertReason?: string }, payeeStatus = 'PENDING'): Promise<void> {
    const supplierId = `sup-${c}`;
    const orderId = `order-${c}-001`;
    await q(`insert into suppliers (facility_id, supplier_id, display_name, country, record_json, evidence_tier, source_type) values ($1, $2, $2, 'CN', '{}', 'tier2', 'mock')`, [facilityId, supplierId]);
    await q(`insert into payees (id, facility_id, kind, display_name, supplier_id, payout_account_hash, bound_line_ids, status) values ($1, $2, 'supplier', $1, $1, $3, $4, $5)`, [
      supplierId,
      facilityId,
      `0x${'0b'.repeat(32)}`,
      [LINE],
      payeeStatus,
    ]);
    await q(`insert into escrow_orders (order_id, facility_id, supplier_id, payee_id, schedule_hash, total_minor) values ($1, $2, $3, $3, $4, '100000')`, [orderId, facilityId, supplierId, `0x${'0c'.repeat(32)}`]);
    await q(`insert into escrow_milestones (order_id, idx, facility_id, amount_minor, auto_release) values ($1, 0, $2, '30000', true), ($1, 1, $2, '70000', false)`, [orderId, facilityId]);
    const nonce = String(['reverted', 'refused', 'expired', 'fresh', 'bound', 'landed', 'replayed', 'gone', 'open'].indexOf(c));
    const signed = action.signed
      ? { signer: SIGNER, chain: 31337, raw: '0x02aa', nonce, tx: `0x${(Number(nonce) + 1).toString(16).padStart(2, '0').repeat(32)}`, block: action.state === 'PENDING' || action.state === 'BROADCAST' ? null : '7' }
      : { signer: null, chain: null, raw: null, nonce: null, tx: null, block: null };
    await q(
      `insert into chain_actions (id, facility_id, kind, ref_id, state, signer_address, chain_id, raw_signed_tx, nonce, tx_hash, block, revert_reason, request_json)
       values ($1, $2, 'Treasury.bindPayee', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
      [
        `bind-${c}`,
        facilityId,
        orderId,
        action.state,
        signed.signer,
        signed.chain,
        signed.raw,
        signed.nonce,
        signed.tx,
        signed.block,
        action.revertReason ?? null,
        JSON.stringify({ approval: { orderId, expiry: (c === 'open' ? NOW - 3_600n : EXPIRY[c]).toString() }, schedule: ['30000', '70000'], autoRelease: [true, false], founder: {} }),
      ],
    );
  }

  beforeAll(async () => {
    t = await openTestDb();
    await q(`insert into facilities (facility_id, cap_minor, currency, reserve_floor_bps, lender_address, deployment_id, chain_id) values ($1, '1000000', 'MYR', 300, $2, 'loop-1', 31337)`, [facilityId, `0x${'ab'.repeat(20)}`]);
    await order('reverted', { state: 'REVERTED', signed: true, revertReason: 'SignatureExpired' });
    await order('refused', { state: 'PENDING', signed: false, revertReason: 'REFUSED: simulation reverts SignatureExpired' });
    await order('expired', { state: 'PENDING', signed: false });
    await order('fresh', { state: 'BROADCAST', signed: true });
    await order('bound', { state: 'BROADCAST', signed: true });
    await order('landed', { state: 'FINALIZED', signed: true });
    // Cancelled earlier (its bind reverted), then a replay of the signed approval bound it on-chain.
    await order('replayed', { state: 'REVERTED', signed: true, revertReason: 'SignatureExpired' }, 'CANCELLED');
    // Cancelled, and the chain shows its order: the worker must not fund it.
    await order('gone', { state: 'REVERTED', signed: true, revertReason: 'SignatureExpired' }, 'CANCELLED');
    await order('open', { state: 'FINALIZED', signed: true }, 'BOUND');
  }, DB_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await t?.close();
  });

  it('cancels only the bind whose approval expired unlanded; reverted and refused binds wait for their approval to expire', async () => {
    expect(await openMinor()).toBe(String(7 * 100_000));
    await syncFailedBinds(d(), t.db.$client, facilityId, { block: BLOCK, now: NOW });
    expect(await status('expired')).toBe('CANCELLED');
    const [alert, ...more] = await alerts('expired');
    expect(more).toEqual([]);
    expect(alert?.summary).toMatch(/^Supplier order order-expired-001 never landed on-chain \(the signed approval expired before it landed\), .*nothing was paid and its budget is free again/);
    // Still replayable: a REVERTED or relay-refused bind's approval is valid until NOW + 600, so they still hold budget.
    for (const c of ['reverted', 'refused', 'fresh', 'bound', 'landed'] as const) expect(await status(c), c).toBe('PENDING');
    expect(await openMinor()).toBe(String(6 * 100_000));
  });

  it('reads every binding at the block `now` was read from', () => {
    const bindings = reads.filter((r) => r.functionName === 'payeeBinding');
    expect(bindings.length).toBeGreaterThan(0);
    expect(bindings.every((r) => r.blockNumber === BLOCK)).toBe(true);
  });

  it('an expired bind that was never signed can no longer be signed by the relay', async () => {
    const r = await q(`select revert_reason, raw_signed_tx from chain_actions where facility_id = $1 and id = 'bind-expired'`, [facilityId]);
    expect(r.rows[0]).toMatchObject({ raw_signed_tx: null, revert_reason: expect.stringMatching(/^REFUSED: /) });
  });

  it('is idempotent: a second pass changes and traces nothing', async () => {
    await syncFailedBinds(d(), t.db.$client, facilityId, { block: BLOCK, now: NOW });
    expect(await alerts('expired')).toHaveLength(1);
    for (const c of ['reverted', 'refused'] as const) expect(await alerts(c), c).toEqual([]);
  });

  it('cancels the reverted, refused and fresh binds once their approvals expired; never one the chain shows bound', async () => {
    await syncFailedBinds(d(), t.db.$client, facilityId, { block: BLOCK + 1n, now: LATER });
    for (const c of ['reverted', 'refused', 'fresh'] as const) {
      expect(await status(c), c).toBe('CANCELLED');
      expect((await alerts(c)).map((a) => a.summary)).toEqual([expect.stringMatching(new RegExp(`^Supplier order order-${c}-001 never landed on-chain`))]);
    }
    expect((await alerts('reverted'))[0]?.summary).toContain('(it reverted: SignatureExpired)');
    expect(await status('bound')).toBe('PENDING'); // the chain shows it bound: syncPayees moves it, never this
    expect(await status('landed')).toBe('PENDING');
  });

  it('never funds an order whose payee is CANCELLED, even when the chain shows the order; alerts once', async () => {
    const first = await readEscrowOrders(d(), facilityId, BLOCK);
    expect(first.map((o) => o.orderId)).toEqual(['order-open-001']);
    await readEscrowOrders(d(), facilityId, BLOCK);
    const gone = await alerts('gone');
    expect(gone).toEqual([expect.objectContaining({ reason_code: 'PAYEE_CANCELLED', summary: expect.stringMatching(/^Supplier order order-gone-001 is on-chain but its payee binding is cancelled here/) })]);
  });

  it('syncPayees re-opens a CANCELLED payee the chain shows bound (a replayed approval), with an ALERT; once', async () => {
    reads.length = 0;
    await syncPayees(d(), t.db.$client, facilityId, { block: BLOCK + 2n, now: NOW });
    expect(await status('replayed')).toBe('COOLING');
    const cooling = await q('select cooling_until::text as c from payees where facility_id = $1 and id = $2', [facilityId, 'sup-replayed']);
    expect(cooling.rows[0]?.c).toBe(String(NOW + 3_600n));
    const reopened = await alerts('replayed');
    expect(reopened).toEqual([expect.objectContaining({ reason_code: 'PAYEE_REOPENED', summary: expect.stringMatching(/^Supplier order order-replayed-001 landed on-chain after its payee binding was cancelled/) })]);
    expect(await status('bound')).toBe('COOLING');
    for (const c of ['reverted', 'refused', 'expired', 'fresh'] as const) expect(await status(c), c).toBe('CANCELLED'); // the chain shows them unbound
    expect(reads.filter((r) => r.functionName === 'payeeBinding').every((r) => r.blockNumber === BLOCK + 2n)).toBe(true);
    await syncPayees(d(), t.db.$client, facilityId, { block: BLOCK + 2n, now: NOW });
    expect(await alerts('replayed')).toHaveLength(1);
  });
});
