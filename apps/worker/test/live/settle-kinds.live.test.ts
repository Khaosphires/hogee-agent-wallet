/**
 * settle-spend for every value-moving kind beyond SPEND, on final-1 worlds (Anvil + Postgres, MockRail): a founder
 * milestone release (RELEASE_MILESTONE), an autoRelease milestone released inside fundMilestone (FUND_MILESTONE), the
 * founder's ownerSpend (OWNER_SPEND) and a reserve withdrawal (WITHDRAW_RESERVE, adopted from the finalized
 * ReserveWithdrawn). Each is paid once, for the on-chain amount, to the account whose hash the chain binds, and closed
 * by the ORACLE's confirmSettlement on its on-chain settlement id.
 *
 * The same tamper regressions as SPEND run for every kind (a DB writer with no keys): each must end with NO payout, NO
 * attestation for the tampered row, and an active halt.
 *
 * Every world reuses order id `order-a-001`, so every milestone world has the SAME milestone settlementId: these tests
 * also prove the rail key is scoped per deployment (otherwise the rail would return an earlier world's payout).
 */
import { iTreasuryAbi, milestoneSettlementId, toBytes32Tag } from '@hogee/chain';
import { payoutAccountHash } from '@hogee/core';
import { getAbiItem, keccak256, toHex, type Hex } from 'viem';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runSettle } from '../../src/jobs/settle';
import { payoutAccountRef } from '../../src/rail/rail';
import { silentLogger } from '../../src/runtime/log';
import { activeHalt, clearHalt } from '../../src/store/halt';
import { LIVE, LIVE_TIMEOUT_MS, newWorld, openLive, type Live, type World } from '../support/live';
import { finalize, ORDER, prepareAutoRelease, prepareOwnerSpend, prepareRelease, prepareReserve, rebindSupplier, SUPPLIER_PAYEE, TAX_PAYEE, withdrawReserve, type SettleCase } from '../support/settle-kinds';

const CONFIRMED = getAbiItem({ abi: iTreasuryAbi, name: 'SettlementConfirmed' });
const FAILED = getAbiItem({ abi: iTreasuryAbi, name: 'SettlementFailed' });
const madeUp = (label: string): Hex => keccak256(toHex(label));

interface KindCase {
  readonly kind: string;
  readonly prepare: (live: Live) => Promise<SettleCase>;
  /** The verdict for the row's amount multiplied by 10 in the DB. */
  readonly amountVerdict: string;
  /** Changes to a copy of the real row so that no on-chain event backs it, and the verdict that copy must get. */
  readonly fabricated: { readonly intent: (c: SettleCase) => Hex; readonly idx?: number; readonly verdict: string };
  /**
   * After a SUCCEEDED payout, invoice_hash changed and the payout columns reset to NONE: the key must not move (no
   * second payout). Null where a DB CHECK pins the invoice (a reserve withdrawal's is always zero).
   */
  readonly invoiceVerdict: string | null;
}

const KINDS: readonly KindCase[] = [
  {
    kind: 'RELEASE_MILESTONE',
    prepare: (live) => prepareRelease(live),
    amountVerdict: 'SPEND_MISMATCH',
    // Milestone 1's own settlement id (consistent row), but nothing released it on-chain.
    fabricated: { intent: () => milestoneSettlementId(toBytes32Tag(ORDER), 1), idx: 1, verdict: 'SPEND_MISMATCH' },
    // The milestone invoice is not on-chain: the key ignores it, so the rail still reports the first payout.
    invoiceVerdict: 'PAYOUT_STATUS_MISMATCH',
  },
  {
    kind: 'FUND_MILESTONE (autoRelease)',
    prepare: (live) => prepareAutoRelease(live),
    amountVerdict: 'SPEND_MISMATCH',
    fabricated: { intent: () => madeUp('made-up funding'), verdict: 'INTENT_MISMATCH' },
    invoiceVerdict: 'PAYOUT_STATUS_MISMATCH',
  },
  {
    kind: 'OWNER_SPEND',
    prepare: (live) => prepareOwnerSpend(live),
    amountVerdict: 'INTENT_MISMATCH',
    fabricated: { intent: () => madeUp('made-up owner spend'), verdict: 'INTENT_MISMATCH' },
    invoiceVerdict: 'INTENT_MISMATCH',
  },
  {
    kind: 'WITHDRAW_RESERVE',
    prepare: (live) => prepareReserve(live),
    amountVerdict: 'SPEND_MISMATCH',
    fabricated: { intent: () => madeUp('made-up loosen'), verdict: 'SPEND_MISMATCH' },
    invoiceVerdict: null,
  },
];

describe.skipIf(!LIVE)('settle-spend for milestone, owner and reserve settlements (final-1, MockRail)', { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  beforeAll(async () => {
    live = await openLive();
  }, LIVE_TIMEOUT_MS);
  afterEach(async () => {
    await clearHalt(live.db.$client, silentLogger, { by: 'test-teardown', note: 'next test', ackThrough: 'all', abandonPause: true });
  });
  afterAll(async () => {
    await live?.close();
  });

  const q = () => live.db.$client;

  async function payment(w: World, id: string) {
    const r = await q().query(
      'select state, payout_status, payout_attempt, payout_id, payout_failure_code, settlement_id from payments where facility_id = $1 and id = $2',
      [w.facilityId, id],
    );
    return r.rows[0];
  }

  async function payouts(w: World): Promise<{ amount_minor: string; destination: string }[]> {
    const r = await q().query(
      `select m.amount_minor::text as amount_minor, m.destination from hogee_worker.mock_payouts m
        where exists (select 1 from payments p where p.facility_id = $1 and m.reference_id like p.tx_hash || ':%')`,
      [w.facilityId],
    );
    return r.rows;
  }

  async function settleActions(w: World, paymentId: string): Promise<number> {
    const r = await q().query(`select count(*)::int as n from chain_actions where facility_id = $1 and ref_id = $2 and id like 'settle-%'`, [w.facilityId, paymentId]);
    return Number(r.rows[0].n);
  }

  async function settlementLogs(w: World, event: typeof CONFIRMED | typeof FAILED) {
    return live.client.getLogs({ address: w.deployment.contracts.Treasury.address, event, fromBlock: BigInt(w.deployment.blockNumber), toBlock: 'latest' });
  }

  async function settlementState(w: World, id: Hex): Promise<number> {
    return Number(await live.client.readContract({ address: w.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: 'settlementState', args: [id] }));
  }

  async function expectTamperRefused(w: World, id: string, reason: string, payoutsBefore: number): Promise<void> {
    const out = await runSettle(w.deps(), [w.facilityId]);
    expect(out[0]?.payments.find((p) => p.paymentId === id)).toMatchObject({ step: 'blocked', detail: reason });
    expect((await activeHalt(q()))?.reason).toBe(reason);
    expect(await payouts(w)).toHaveLength(payoutsBefore);
    // A second pass while halted pays and attests nothing either.
    await runSettle(w.deps(), [w.facilityId]);
    expect(await payouts(w)).toHaveLength(payoutsBefore);
  }

  describe.each(KINDS)('$kind', (k) => {
    it('pays the on-chain amount once to the bound account, the oracle confirms the on-chain settlement id, the row settles', async () => {
      const c = await k.prepare(live);
      const { w, paymentId: id } = c;
      expect((await payment(w, id)).state).toBe('FINALIZED');
      const first = await runSettle(w.deps(), [w.facilityId]);
      // Only the settlement is paid: a funding that released nothing is not a settlement and is never reported.
      expect(first[0]?.payments).toEqual([expect.objectContaining({ paymentId: id, step: 'request_payout', detail: 'SUCCEEDED' })]);
      expect(await payouts(w)).toEqual([{ amount_minor: c.amountMinor.toString(), destination: payoutAccountRef(c.destination) }]);
      expect((await payment(w, id)).settlement_id).toBe(c.settlementId.toLowerCase());
      expect((await runSettle(w.deps(), [w.facilityId]))[0]?.payments[0]).toMatchObject({ paymentId: id, step: 'confirm' });
      await live.test.mine({ blocks: 1 });
      await finalize(w);
      expect((await runSettle(w.deps(), [w.facilityId]))[0]?.payments[0]).toMatchObject({ paymentId: id, step: 'close', detail: 'SETTLED' });
      expect(await payment(w, id)).toMatchObject({ state: 'SETTLED', payout_status: 'SUCCEEDED', payout_attempt: 1 });
      const confirmed = await settlementLogs(w, CONFIRMED);
      expect(confirmed.map((l) => l.args.settlementId?.toLowerCase())).toEqual([c.settlementId.toLowerCase()]);
      expect(await settlementState(w, c.settlementId)).toBe(1);
      expect((await runSettle(w.deps(), [w.facilityId]))[0]?.payments).toEqual([]);
      expect(await payouts(w)).toHaveLength(1);
    });

    it(`halts on a real row whose amount was multiplied by 10 (${k.amountVerdict})`, async () => {
      const { w, paymentId: id } = await k.prepare(live);
      await q().query(`update payments set amount_minor = amount_minor * 10 where facility_id = $1 and id = $2`, [w.facilityId, id]);
      await expectTamperRefused(w, id, k.amountVerdict, 0);
      expect(await settleActions(w, id)).toBe(0);
      expect((await payment(w, id)).state).toBe('FINALIZED');
    });

    it(`halts on a fabricated FINALIZED row that no on-chain event backs (${k.fabricated.verdict})`, async () => {
      const c = await k.prepare(live);
      const { w, paymentId: real } = c;
      await q().query(`update payments set state = 'SETTLED' where facility_id = $1 and id = $2`, [w.facilityId, real]);
      const fake = 'fabricated-1';
      const idx = k.fabricated.idx ?? null;
      const intent = k.fabricated.intent(c);
      await q().query(
        `insert into payments (id, facility_id, kind, intent_id, line_key, line_id, payee_id, order_id, milestone_idx, amount_minor, invoice_hash, plan_version, state,
           signer_address, chain_id, raw_signed_tx, nonce, tx_hash, block, decision_id, rationale_hash, trace_id)
         select $3, facility_id, kind, $4, line_key, line_id, payee_id, order_id, coalesce($5, milestone_idx), amount_minor, invoice_hash, plan_version, 'FINALIZED',
                signer_address, chain_id, raw_signed_tx, $6, tx_hash, block, decision_id, rationale_hash, trace_id
           from payments where facility_id = $1 and id = $2`,
        // A nonce no earlier run left behind for this signer (the reserve executor is a fixed Anvil account).
        [w.facilityId, real, fake, intent.toLowerCase(), idx, 1_000_000_000 + Math.floor(Math.random() * 1_000_000_000)],
      );
      await expectTamperRefused(w, fake, k.fabricated.verdict, 0);
      expect(await settleActions(w, fake)).toBe(0);
    });

    it('halts on a destination whose account fields do not hash to the on-chain binding (only xendit_account_ref changed)', async () => {
      const c = await k.prepare(live);
      const evil = payoutAccountRef({ ...c.destination, accountNumber: '6660000666' });
      await q().query(`update payees set xendit_account_ref = $3 where facility_id = $1 and id = $2`, [c.w.facilityId, c.payeeId, evil]);
      await expectTamperRefused(c.w, c.paymentId, 'DESTINATION_MISMATCH', 0);
      expect(await settleActions(c.w, c.paymentId)).toBe(0);
      expect((await payment(c.w, c.paymentId)).state).toBe('FINALIZED');
    });

    it('(c) halts on payout_status FAILED/INVALID_DESTINATION written over a SUCCEEDED payout (no failSettlement)', async () => {
      const { w, paymentId: id } = await k.prepare(live);
      await runSettle(w.deps(), [w.facilityId]);
      expect(await payouts(w)).toHaveLength(1);
      await q().query(`update payments set payout_status = 'FAILED', payout_failure_code = 'INVALID_DESTINATION' where facility_id = $1 and id = $2`, [w.facilityId, id]);
      await expectTamperRefused(w, id, 'PAYOUT_STATUS_MISMATCH', 1);
      expect(await settleActions(w, id)).toBe(0);
      expect(await settlementLogs(w, FAILED)).toHaveLength(0);
    });

    it('(d) no second payout on a retryable failure written over a SUCCEEDED payout, nor on a forged next attempt', async () => {
      const { w, paymentId: id } = await k.prepare(live);
      await runSettle(w.deps(), [w.facilityId]);
      await q().query(`update payments set payout_status = 'FAILED', payout_failure_code = 'TEMPORARY_TRANSFER_ERROR' where facility_id = $1 and id = $2`, [w.facilityId, id]);
      await expectTamperRefused(w, id, 'PAYOUT_STATUS_MISMATCH', 1);
      await q().query(`update payments set payout_attempt = 2, payout_status = 'REQUESTED' where facility_id = $1 and id = $2`, [w.facilityId, id]);
      await clearHalt(q(), silentLogger, { by: 'test', note: 'try again with a forged attempt', ackThrough: 'all', abandonPause: true });
      await expectTamperRefused(w, id, 'PAYOUT_STATUS_MISMATCH', 1);
      expect(await settleActions(w, id)).toBe(0);
    });

    it.skipIf(k.invoiceVerdict === null)('(e) an invoice_hash rewritten after a payout never mints a new idempotency key (no second payout)', async () => {
      const { w, paymentId: id } = await k.prepare(live);
      await runSettle(w.deps(), [w.facilityId]);
      expect(await payouts(w)).toHaveLength(1);
      await q().query(
        `update payments set invoice_hash = $3, state = 'FINALIZED', payout_status = 'NONE', payout_attempt = 0, payout_id = null where facility_id = $1 and id = $2`,
        [w.facilityId, id, madeUp('another invoice')],
      );
      await expectTamperRefused(w, id, k.invoiceVerdict as string, 1);
      expect(await settleActions(w, id)).toBe(0);
    });
  });

  it('milestone (T1): refuses when the ref AND payees.payout_account_hash both name another account; and when only the DB hash disagrees', async () => {
    const c = await prepareRelease(live);
    const evil = { ...c.destination, accountNumber: '6660000666' };
    await q().query(`update payees set xendit_account_ref = $3, payout_account_hash = $4 where facility_id = $1 and id = $2`, [c.w.facilityId, c.payeeId, payoutAccountRef(evil), payoutAccountHash(evil)]);
    await expectTamperRefused(c.w, c.paymentId, 'DESTINATION_MISMATCH', 0);
    await q().query(`update payees set xendit_account_ref = $3, payout_account_hash = $4 where facility_id = $1 and id = $2`, [
      c.w.facilityId,
      c.payeeId,
      payoutAccountRef(c.destination),
      payoutAccountHash(evil),
    ]);
    await clearHalt(q(), silentLogger, { by: 'test', note: 'only the DB hash is off now', ackThrough: 'all', abandonPause: true });
    await expectTamperRefused(c.w, c.paymentId, 'DESTINATION_MISMATCH', 0);
  });

  // Holds under either escrow rule: the M-1 re-check (BU back to the supplier line, milestone released for good) or the
  // earlier one (milestone un-released). Only the settlement and the payee binding are asserted, never `released`.
  it('milestone: a final payout failure calls failSettlement once; the settlement stays FAILED and is never paid again', async () => {
    const c = await prepareRelease(live, { account: { channel: 'MY_DUITNOW', accountNumber: '9000121212', holderName: 'Supplier A Test' } });
    const { w, paymentId: id } = c;
    expect((await runSettle(w.deps(), [w.facilityId]))[0]?.payments[0]).toMatchObject({ step: 'request_payout', detail: 'FAILED INVALID_DESTINATION' });
    expect((await runSettle(w.deps(), [w.facilityId]))[0]?.payments[0]).toMatchObject({ step: 'fail' });
    await live.test.mine({ blocks: 1 });
    await finalize(w);
    expect((await runSettle(w.deps(), [w.facilityId]))[0]?.payments[0]).toMatchObject({ step: 'close', detail: 'SETTLEMENT_FAILED' });
    expect(await payment(w, id)).toMatchObject({ state: 'SETTLEMENT_FAILED', payout_failure_code: 'INVALID_DESTINATION' });
    expect(await settlementState(w, c.settlementId)).toBe(2);
    const failed = await settlementLogs(w, FAILED);
    expect(failed.map((l) => l.args.settlementId?.toLowerCase())).toEqual([c.settlementId.toLowerCase()]);
    const binding = await live.client.readContract({
      address: w.deployment.contracts.Treasury.address,
      abi: iTreasuryAbi,
      functionName: 'payeeBinding',
      args: [toBytes32Tag('SUPPLIER'), toBytes32Tag(c.payeeId)],
    });
    expect(binding.paidMinor).toBe(0n);
    // Nothing is left to pay or attest: no new payout, no second settlement call, on any later pass.
    expect((await runSettle(w.deps(), [w.facilityId]))[0]?.payments).toEqual([]);
    expect(await payouts(w)).toHaveLength(1);
    expect(await settleActions(w, id)).toBe(1);
  });

  it('reserve: adopts the finalized ReserveWithdrawn (executed by a third party) as a worker-owned row and settles it', async () => {
    const w = await newWorld(live, { final: true });
    const loosenId = await withdrawReserve(w, 4_000n);
    const id = `reserve:${loosenId}`;
    expect((await q().query('select count(*)::int as n from payments where facility_id = $1', [w.facilityId])).rows[0].n).toBe(0);
    const first = await runSettle(w.deps(), [w.facilityId]);
    expect(first[0]?.payments).toEqual([expect.objectContaining({ paymentId: id, step: 'request_payout', detail: 'SUCCEEDED' })]);
    const [row] = (
      await q().query(
        `select kind, intent_id, settlement_id, line_id, payee_id, amount_minor::text as amount_minor, invoice_hash, decision_id, tx_hash, raw_signed_tx from payments where facility_id = $1 and id = $2`,
        [w.facilityId, id],
      )
    ).rows;
    expect(row).toMatchObject({ kind: 'WITHDRAW_RESERVE', intent_id: loosenId, settlement_id: loosenId, line_id: null, payee_id: TAX_PAYEE, amount_minor: '4000', decision_id: null });
    expect(row.invoice_hash).toMatch(/^0x0{64}$/);
    // The stored bytes are exactly the transaction that executed the loosening.
    expect(keccak256(row.raw_signed_tx as Hex)).toBe(row.tx_hash);
    await runSettle(w.deps(), [w.facilityId]); // confirm
    await live.test.mine({ blocks: 1 });
    await finalize(w);
    expect((await runSettle(w.deps(), [w.facilityId]))[0]?.payments[0]).toMatchObject({ paymentId: id, step: 'close', detail: 'SETTLED' });
    expect(await payouts(w)).toHaveLength(1);
  });

  it('reserve: an exception naming a loosen id that never executed on-chain adopts nothing and pays nothing', async () => {
    const c = await prepareReserve(live);
    await q().query(
      `insert into exceptions (id, facility_id, kind, title, payload, requested_by, requires_founder, requires_lender, status, loosen_id)
       values ('exc-fake', $1, 'WITHDRAW_RESERVE', 'fake', '{}'::jsonb, 'founder', true, true, 'EXECUTED', $2)`,
      [c.w.facilityId, madeUp('never queued')],
    );
    await q().query(`update payments set state = 'SETTLED' where facility_id = $1 and id = $2`, [c.w.facilityId, c.paymentId]);
    expect((await runSettle(c.w.deps(), [c.w.facilityId]))[0]?.payments).toEqual([]);
    expect((await q().query(`select count(*)::int as n from payments where facility_id = $1`, [c.w.facilityId])).rows[0].n).toBe(1);
    expect(await payouts(c.w)).toHaveLength(0);
  });

  it('reserve: a final payout failure calls failSettlement and returns the amount to the reserve', async () => {
    const c = await prepareReserve(live, { account: { channel: 'MY_DUITNOW', accountNumber: '9000121212', holderName: 'Shopee Fees Test' } });
    const { w } = c;
    const treasury = w.deployment.contracts.Treasury.address;
    const before = await live.client.readContract({ address: treasury, abi: iTreasuryAbi, functionName: 'reserve' });
    expect((await runSettle(w.deps(), [w.facilityId]))[0]?.payments[0]).toMatchObject({ step: 'request_payout', detail: 'FAILED INVALID_DESTINATION' });
    expect((await runSettle(w.deps(), [w.facilityId]))[0]?.payments[0]).toMatchObject({ step: 'fail' });
    await live.test.mine({ blocks: 1 });
    await finalize(w);
    expect((await runSettle(w.deps(), [w.facilityId]))[0]?.payments[0]).toMatchObject({ step: 'close', detail: 'SETTLEMENT_FAILED' });
    expect(await live.client.readContract({ address: treasury, abi: iTreasuryAbi, functionName: 'reserve' })).toBe(before + c.amountMinor);
    expect(await settlementLogs(w, FAILED)).toHaveLength(1);
  });

  it('milestone: a re-bind holds the payout while it cools (no payout, no fail, no halt), then pays the binding as it stands', async () => {
    const c = await prepareRelease(live);
    const { w, paymentId: id } = c;
    const fresh = { channel: 'MY_DUITNOW', accountNumber: '2000000099', holderName: 'Supplier A New Account' };
    await rebindSupplier(w, fresh);
    await finalize(w);
    const held = await runSettle(w.deps(), [w.facilityId]);
    expect(held[0]?.payments.find((p) => p.paymentId === id)).toMatchObject({ step: 'wait', detail: 'PAYEE_COOLING' });
    expect(await payouts(w)).toHaveLength(0);
    expect(await settleActions(w, id)).toBe(0);
    expect(await activeHalt(q())).toBeNull();
    // The payees mirror follows the re-bind (what the founder signed), then the cooling window passes.
    await q().query('update payees set xendit_account_ref = $3, payout_account_hash = $4 where facility_id = $1 and id = $2', [w.facilityId, SUPPLIER_PAYEE, payoutAccountRef(fresh), payoutAccountHash(fresh)]);
    await live.test.increaseTime({ seconds: 121 });
    await live.test.mine({ blocks: 1 });
    await finalize(w);
    expect((await runSettle(w.deps(), [w.facilityId]))[0]?.payments.find((p) => p.paymentId === id)).toMatchObject({ step: 'request_payout' });
    const paid = await payouts(w);
    expect(paid).toHaveLength(1);
    expect(paid[0]?.destination).toContain('2000000099');
    expect(paid[0]?.amount_minor).toBe(c.amountMinor.toString());
  });
});
