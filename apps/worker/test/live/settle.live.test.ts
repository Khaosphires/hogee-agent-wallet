/**
 * settle-spend on Anvil + Postgres with MockRail (§9.1): a finalized spend is paid out once and the ORACLE confirms
 * it; re-running changes nothing; a final payout failure calls failSettlement; a retryable one is retried first; a
 * rail code that does not fit bytes32 is failed as PAYOUT_FAILED; nothing is paid while halted.
 *
 * Security audit run-3: every payout and attestation is bound to the chain first. Each tamper case below (a DB writer
 * with no keys) must end with NO payout, NO oracle attestation for the tampered row, and an active halt.
 *
 * Audit run-4: an oracle confirm the worker did not send (the hot oracle key used outside it) must never close the row
 * SETTLED unpaid; the worker seeds the oracle's nonces row, so the same outside use also alerts EXTERNAL_KEY_USE.
 */
import { buildConfirmSettlement, iTreasuryAbi, seedNonce, toBytes32Tag } from '@hogee/chain';
import { createWalletClient, getAbiItem, hexToString, http, keccak256, toHex, type Hex } from 'viem';
import { anvil } from 'viem/chains';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runReconcile } from '../../src/jobs/reconcile';
import { runSettle } from '../../src/jobs/settle';
import { runTick } from '../../src/jobs/tick';
import { payoutAccountRef } from '../../src/rail/rail';
import { activeHalt, clearHalt, raiseHalt } from '../../src/store/halt';
import { silentLogger } from '../../src/runtime/log';
import { finalizeAll, LIVE, LIVE_TIMEOUT_MS, mined, newWorld, openLive, RPC_URL, spentLogs, type Live, type World } from '../support/live';

const CONFIRMED = getAbiItem({ abi: iTreasuryAbi, name: 'SettlementConfirmed' });
const FAILED = getAbiItem({ abi: iTreasuryAbi, name: 'SettlementFailed' });
const ads = (accountNumber: string) => ({ 'shopee-ads': { channel: 'MY_DUITNOW', accountNumber, holderName: 'Shopee Ads Test' } });

describe.skipIf(!LIVE)('settle-spend with MockRail (Anvil + Postgres)', { timeout: LIVE_TIMEOUT_MS }, () => {
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

  /** reconcile, make everything final, reconcile again: receipts → INCLUDED → FINALIZED. */
  async function finalize(w: World): Promise<void> {
    await runReconcile(w.deps(), [w.facilityId]);
    await finalizeAll(live);
    await runReconcile(w.deps(), [w.facilityId]);
  }

  async function spendOnce(w: World): Promise<string> {
    const tick = await runTick(w.deps(), w.facilityId);
    await mined(live, tick);
    await finalize(w);
    return tick.lines[0]?.paymentId as string;
  }

  async function payment(w: World, id: string) {
    const r = await live.db.$client.query(
      'select state, payout_status, payout_attempt, payout_id, payout_failure_code, settlement_id from payments where facility_id = $1 and id = $2',
      [w.facilityId, id],
    );
    return r.rows[0];
  }

  async function mockPayouts(w: World): Promise<number> {
    const r = await live.db.$client.query(
      `select count(*)::int as n from hogee_worker.mock_payouts m where exists (select 1 from payments p where p.facility_id = $1 and m.reference_id like p.tx_hash || ':%')`,
      [w.facilityId],
    );
    return Number(r.rows[0].n);
  }

  async function settleActions(w: World, paymentId: string): Promise<number> {
    const r = await live.db.$client.query(`select count(*)::int as n from chain_actions where facility_id = $1 and ref_id = $2 and id like 'settle-%'`, [w.facilityId, paymentId]);
    return Number(r.rows[0].n);
  }

  async function settlementLogs(w: World, event: typeof CONFIRMED | typeof FAILED) {
    return live.client.getLogs({ address: w.deployment.contracts.Treasury.address, event, fromBlock: BigInt(w.deployment.blockNumber), toBlock: 'latest' });
  }

  async function settledFully(w: World, id: string) {
    await runSettle(w.deps(), [w.facilityId]); // payout
    await runSettle(w.deps(), [w.facilityId]); // confirm
    await live.test.mine({ blocks: 1 });
    await finalize(w);
    await runSettle(w.deps(), [w.facilityId]); // close
    return payment(w, id);
  }

  async function expectTamperRefused(w: World, id: string, reason: string, payoutsBefore: number): Promise<void> {
    const out = await runSettle(w.deps(), [w.facilityId]);
    expect(out[0]?.payments.find((p) => p.paymentId === id)).toMatchObject({ step: 'blocked', detail: reason });
    expect((await activeHalt(live.db.$client))?.reason).toBe(reason);
    expect(await mockPayouts(w)).toBe(payoutsBefore);
    // A second pass while halted pays and attests nothing either.
    await runSettle(w.deps(), [w.facilityId]);
    expect(await mockPayouts(w)).toBe(payoutsBefore);
  }

  it('pays out once, the oracle confirms, the row settles; every re-run is a no-op', async () => {
    const w = await newWorld(live);
    const id = await spendOnce(w);
    expect((await payment(w, id)).state).toBe('FINALIZED');
    const first = await runSettle(w.deps(), [w.facilityId]);
    expect(first[0]?.payments).toEqual([expect.objectContaining({ paymentId: id, step: 'request_payout', detail: 'SUCCEEDED' })]);
    const second = await runSettle(w.deps(), [w.facilityId]);
    expect(second[0]?.payments[0]).toMatchObject({ step: 'confirm' });
    const third = await runSettle(w.deps(), [w.facilityId]);
    expect(third[0]?.payments[0]).toMatchObject({ step: 'wait', detail: 'CONFIRM_IN_FLIGHT' });
    expect(await mockPayouts(w)).toBe(1);
    await live.test.mine({ blocks: 1 });
    await finalize(w);
    const closed = await runSettle(w.deps(), [w.facilityId]);
    expect(closed[0]?.payments[0]).toMatchObject({ step: 'close', detail: 'SETTLED' });
    expect(await payment(w, id)).toMatchObject({ state: 'SETTLED', payout_status: 'SUCCEEDED', payout_attempt: 1 });
    expect((await runSettle(w.deps(), [w.facilityId]))[0]?.payments).toEqual([]);
    expect(await settlementLogs(w, CONFIRMED)).toHaveLength(1);
    expect(await mockPayouts(w)).toBe(1);
  });

  it('a final payout failure calls failSettlement and returns the amount to the line', async () => {
    const w = await newWorld(live, { accounts: ads('9000121212') });
    const id = await spendOnce(w);
    expect((await runSettle(w.deps(), [w.facilityId]))[0]?.payments[0]).toMatchObject({ step: 'request_payout', detail: 'FAILED INVALID_DESTINATION' });
    expect((await runSettle(w.deps(), [w.facilityId]))[0]?.payments[0]).toMatchObject({ step: 'fail' });
    await live.test.mine({ blocks: 1 });
    await finalize(w);
    expect((await runSettle(w.deps(), [w.facilityId]))[0]?.payments[0]).toMatchObject({ step: 'close', detail: 'SETTLEMENT_FAILED' });
    expect(await payment(w, id)).toMatchObject({ state: 'SETTLEMENT_FAILED', payout_failure_code: 'INVALID_DESTINATION' });
    expect(await settlementLogs(w, FAILED)).toHaveLength(1);
    const pocket = await live.client.readContract({ address: w.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: 'pocket', args: [toBytes32Tag('ADS')] });
    expect(pocket.spentMinor).toBe(0n);
  });

  it('retries a retryable failure with the next rail-backed attempt up to PAYOUT_MAX_ATTEMPTS, then fails the settlement', async () => {
    const w = await newWorld(live, { accounts: ads('9000123456') });
    const id = await spendOnce(w);
    for (const attempt of [1, 2, 3]) {
      expect((await runSettle(w.deps(), [w.facilityId]))[0]?.payments[0]).toMatchObject({ step: 'request_payout', detail: 'FAILED TEMPORARY_TRANSFER_ERROR' });
      expect((await payment(w, id)).payout_attempt).toBe(attempt);
    }
    expect((await runSettle(w.deps(), [w.facilityId]))[0]?.payments[0]).toMatchObject({ step: 'fail' });
    expect(await mockPayouts(w)).toBe(3);
  });

  it('fails a rail code that does not fit bytes32 as PAYOUT_FAILED and keeps the raw code in the trace', async () => {
    const w = await newWorld(live, { accounts: ads('9000999999') });
    const id = await spendOnce(w);
    await runSettle(w.deps(), [w.facilityId]);
    expect((await runSettle(w.deps(), [w.facilityId]))[0]?.payments[0]).toMatchObject({ step: 'fail', detail: expect.stringMatching(/^0x/) });
    await live.test.mine({ blocks: 1 });
    const [log] = await settlementLogs(w, FAILED);
    expect(hexToString((log?.args as { code?: `0x${string}` }).code as `0x${string}`, { size: 32 })).toBe('PAYOUT_FAILED');
    const trace = await live.db.$client.query(`select summary from traces where facility_id = $1 and payment_id = $2 and kind = 'PAYOUT' order by seq`, [w.facilityId, id]);
    expect(trace.rows.map((r) => r.summary).join(' ')).toContain('rejected-by-bank: recipient KYC');
  });

  it('halts on a destination whose account fields do not hash to the on-chain binding (only xendit_account_ref changed)', async () => {
    const w = await newWorld(live);
    const id = await spendOnce(w);
    const evil = payoutAccountRef({ channel: 'MY_DUITNOW', accountNumber: '6660000666', holderName: 'Shopee Ads Test' });
    await live.db.$client.query(`update payees set xendit_account_ref = $2 where facility_id = $1 and id = 'shopee-ads'`, [w.facilityId, evil]);
    await expectTamperRefused(w, id, 'DESTINATION_MISMATCH', 0);
    expect(await settleActions(w, id)).toBe(0);
    expect((await payment(w, id)).state).toBe('FINALIZED');
  });

  it('halts on a payee without a canonical payout account (no fallback destination)', async () => {
    const w = await newWorld(live);
    const id = await spendOnce(w);
    await live.db.$client.query(`update payees set xendit_account_ref = 'test-1000000001' where facility_id = $1 and id = 'shopee-ads'`, [w.facilityId]);
    await expectTamperRefused(w, id, 'DESTINATION_MISMATCH', 0);
  });

  it('(a) halts on a real row whose amount was multiplied by 10', async () => {
    const w = await newWorld(live);
    const id = await spendOnce(w);
    await live.db.$client.query(`update payments set amount_minor = amount_minor * 10 where facility_id = $1 and id = $2`, [w.facilityId, id]);
    await expectTamperRefused(w, id, 'INTENT_MISMATCH', 0);
    expect(await settleActions(w, id)).toBe(0);
  });

  it('halts on a row whose plan_version changed (the finalized Spent log disagrees)', async () => {
    const w = await newWorld(live);
    const id = await spendOnce(w);
    await live.db.$client.query(`update payments set plan_version = plan_version + 1 where facility_id = $1 and id = $2`, [w.facilityId, id]);
    await expectTamperRefused(w, id, 'SPEND_MISMATCH', 0);
    expect(await settleActions(w, id)).toBe(0);
  });

  it('(b) halts on a fabricated FINALIZED row with a random intent_id', async () => {
    const w = await newWorld(live);
    const real = await spendOnce(w);
    await live.db.$client.query(`update payments set state = 'SETTLED' where facility_id = $1 and id = $2`, [w.facilityId, real]);
    const fake = 'fabricated-1';
    await live.db.$client.query(
      `insert into payments (id, facility_id, kind, intent_id, line_key, line_id, payee_id, amount_minor, invoice_hash, plan_version, state, signer_address,
         chain_id, raw_signed_tx, nonce, tx_hash, block, decision_id, rationale_hash, trace_id)
       select $3, facility_id, kind, $4, line_key, line_id, payee_id, amount_minor, invoice_hash, plan_version, 'FINALIZED', signer_address, chain_id,
              raw_signed_tx, 999999, tx_hash, block, decision_id, rationale_hash, trace_id
         from payments where facility_id = $1 and id = $2`,
      [w.facilityId, real, fake, keccak256(toHex('made-up intent'))],
    );
    await expectTamperRefused(w, fake, 'INTENT_MISMATCH', 0);
    expect(await settleActions(w, fake)).toBe(0);
  });

  it('(c) halts on payout_status FAILED/INVALID_DESTINATION written over a SUCCEEDED payout (no failSettlement)', async () => {
    const w = await newWorld(live);
    const id = await spendOnce(w);
    await runSettle(w.deps(), [w.facilityId]);
    expect(await mockPayouts(w)).toBe(1);
    await live.db.$client.query(`update payments set payout_status = 'FAILED', payout_failure_code = 'INVALID_DESTINATION' where facility_id = $1 and id = $2`, [w.facilityId, id]);
    await expectTamperRefused(w, id, 'PAYOUT_STATUS_MISMATCH', 1);
    expect(await settleActions(w, id)).toBe(0);
    expect(await settlementLogs(w, FAILED)).toHaveLength(0);
  });

  it('(d) halts on payout_status FAILED/TEMPORARY_TRANSFER_ERROR written over a SUCCEEDED payout (no second payout)', async () => {
    const w = await newWorld(live);
    const id = await spendOnce(w);
    await runSettle(w.deps(), [w.facilityId]);
    await live.db.$client.query(`update payments set payout_status = 'FAILED', payout_failure_code = 'TEMPORARY_TRANSFER_ERROR' where facility_id = $1 and id = $2`, [w.facilityId, id]);
    await expectTamperRefused(w, id, 'PAYOUT_STATUS_MISMATCH', 1);
    await live.db.$client.query(`update payments set payout_attempt = 2, payout_status = 'REQUESTED' where facility_id = $1 and id = $2`, [w.facilityId, id]);
    await clearHalt(live.db.$client, silentLogger, { by: 'test', note: 'try again with a forged attempt', ackThrough: 'all', abandonPause: true });
    await expectTamperRefused(w, id, 'PAYOUT_STATUS_MISMATCH', 1);
    expect(await settleActions(w, id)).toBe(0);
  });

  it('halts instead of closing a FAILED settlement whose payout the DB says succeeded (a contradiction)', async () => {
    const w = await newWorld(live, { accounts: ads('9000121212') });
    const id = await spendOnce(w);
    await runSettle(w.deps(), [w.facilityId]);
    await runSettle(w.deps(), [w.facilityId]); // fail
    await live.test.mine({ blocks: 1 });
    await finalize(w);
    await live.db.$client.query(`update payments set payout_status = 'SUCCEEDED' where facility_id = $1 and id = $2`, [w.facilityId, id]);
    const out = await runSettle(w.deps(), [w.facilityId]);
    expect(out[0]?.payments[0]).toMatchObject({ step: 'blocked', detail: 'SETTLEMENT_CONTRADICTION' });
    expect((await activeHalt(live.db.$client))?.reason).toBe('SETTLEMENT_CONTRADICTION');
    expect((await payment(w, id)).state).toBe('SETTLEMENT_REQUESTED');
  });

  it('pays nothing while halted', async () => {
    const w = await newWorld(live);
    const id = await spendOnce(w);
    await raiseHalt(live.db.$client, silentLogger, 'TEST_HALT', {});
    expect((await runSettle(w.deps(), [w.facilityId]))[0]?.payments[0]).toMatchObject({ paymentId: id, step: 'halted' });
    expect(await mockPayouts(w)).toBe(0);
  });

  /** The worker's hot ORACLE key used outside the backend: confirmSettlement(spendId, junk) straight to the Treasury. */
  async function outsideConfirm(w: World, spendId: Hex): Promise<void> {
    const wallet = createWalletClient({ account: w.signers.oracle, chain: anvil, transport: http(RPC_URL) });
    const call = buildConfirmSettlement({ settlementId: spendId, payoutRefHash: `0x${'01'.repeat(32)}` });
    const hash = await wallet.sendTransaction({ to: w.deployment.contracts.Treasury.address, data: call.data });
    expect((await live.client.waitForTransactionReceipt({ hash })).status).toBe('success');
  }

  async function spendIdOf(w: World): Promise<Hex> {
    const [log] = await spentLogs(w);
    return log?.args.spendId as Hex;
  }

  it('halts instead of closing SETTLED a spend an outside oracle confirm attested with no payout (audit run-4)', async () => {
    const w = await newWorld(live);
    const oracleKey = { signer: w.signers.oracle.address, chainId: w.deployment.chainId, client: live.client };
    await seedNonce(live.db, oracleKey); // what the worker does at start-up
    const tick = await runTick(w.deps(), w.facilityId);
    await mined(live, tick);
    const id = tick.lines[0]?.paymentId as string;
    await outsideConfirm(w, await spendIdOf(w));
    const pass = await runReconcile(w.deps(), [w.facilityId]);
    expect(pass.alerts).toContainEqual(expect.objectContaining({ reason: 'EXTERNAL_KEY_USE', detail: expect.objectContaining({ role: 'oracle' }) }));
    await finalizeAll(live);
    await runReconcile(w.deps(), [w.facilityId]);
    const out = await runSettle(w.deps(), [w.facilityId]);
    expect(out[0]?.payments.find((p) => p.paymentId === id)).toMatchObject({ step: 'blocked', detail: 'SETTLEMENT_CONTRADICTION' });
    expect((await activeHalt(live.db.$client))?.reason).toBe('SETTLEMENT_CONTRADICTION');
    expect(await payment(w, id)).toMatchObject({ state: 'FINALIZED', payout_status: 'NONE', payout_attempt: 0 });
    expect(await mockPayouts(w)).toBe(0);
    expect(await settleActions(w, id)).toBe(0);
    const alerts = async () => (await live.db.$client.query(`select summary from traces where facility_id = $1 and payment_id = $2 and kind = 'ALERT'`, [w.facilityId, id])).rows;
    expect((await alerts()).map((r) => r.summary).join(' ')).toContain('an oracle attestation the worker did not make');
    // Halted once per payment: after the operator resumes, the row stays blocked, but neither halts nor alerts again.
    await clearHalt(live.db.$client, silentLogger, { by: 'operator', note: 'reviewed the outside confirm', ackThrough: 'all', abandonPause: true });
    for (let i = 0; i < 2; i += 1) {
      const again = await runSettle(w.deps(), [w.facilityId]);
      expect(again[0]?.payments.find((p) => p.paymentId === id)).toMatchObject({ step: 'blocked', detail: 'SETTLEMENT_CONTRADICTION' });
    }
    expect(await activeHalt(live.db.$client)).toBeNull();
    expect(await alerts()).toHaveLength(1);
    const events = await live.db.$client.query(
      `select count(*)::int as n from hogee_worker.halt_events where reason = 'SETTLEMENT_CONTRADICTION' and detail->>'facilityId' = $1 and detail->>'paymentId' = $2`,
      [w.facilityId, id],
    );
    expect(events.rows[0].n).toBe(1);
    expect(await payment(w, id)).toMatchObject({ state: 'FINALIZED', payout_status: 'NONE' });
  });

  it('the contradiction halt names the binding problem too (audit run-4 L4)', async () => {
    const w = await newWorld(live);
    const tick = await runTick(w.deps(), w.facilityId);
    await mined(live, tick);
    const id = tick.lines[0]?.paymentId as string;
    await outsideConfirm(w, await spendIdOf(w));
    await finalize(w);
    const other = payoutAccountRef({ channel: 'MY_DUITNOW', accountNumber: '6660000666', holderName: 'Shopee Ads Test' });
    await live.db.$client.query(`update payees set xendit_account_ref = $2 where facility_id = $1 and id = 'shopee-ads'`, [w.facilityId, other]);
    expect((await runSettle(w.deps(), [w.facilityId]))[0]?.payments.find((p) => p.paymentId === id)).toMatchObject({ step: 'blocked', detail: 'SETTLEMENT_CONTRADICTION' });
    const halt = await activeHalt(live.db.$client);
    expect(halt?.reason).toBe('SETTLEMENT_CONTRADICTION');
    expect(String(halt?.detail.detail)).toContain('binding: the payout account does not hash to the on-chain binding');
  });

  it('closes SETTLED with one ALERT, never a halt, when an outside confirm lands after the payout (audit run-4)', async () => {
    const w = await newWorld(live);
    const id = await spendOnce(w);
    expect((await runSettle(w.deps(), [w.facilityId]))[0]?.payments[0]).toMatchObject({ step: 'request_payout', detail: 'SUCCEEDED' });
    await outsideConfirm(w, await spendIdOf(w));
    await finalize(w);
    // The payee was paid; the attestation is not the worker's own: close with an alert, never wedge the worker.
    expect((await runSettle(w.deps(), [w.facilityId]))[0]?.payments[0]).toMatchObject({ step: 'close', detail: 'SETTLED' });
    expect(await payment(w, id)).toMatchObject({ state: 'SETTLED', payout_status: 'SUCCEEDED' });
    expect(await activeHalt(live.db.$client)).toBeNull();
    expect(await settleActions(w, id)).toBe(0);
    expect(await mockPayouts(w)).toBe(1);
    const alerts = await live.db.$client.query(`select count(*)::int as n from traces where facility_id = $1 and payment_id = $2 and reason_code = 'SETTLEMENT_CONFIRMED_ELSEWHERE'`, [w.facilityId, id]);
    expect(alerts.rows[0].n).toBe(1);
    expect((await runSettle(w.deps(), [w.facilityId]))[0]?.payments).toEqual([]);
  });

  it('finds the payout when payoutMaxAttempts is lowered below its attempt index (audit run-4 L4)', async () => {
    const w = await newWorld(live);
    const id = await spendOnce(w);
    await runSettle(w.deps(), [w.facilityId]); // payout (attempt 1)
    await runSettle(w.deps(), [w.facilityId]); // confirm
    await live.test.mine({ blocks: 1 });
    await finalize(w);
    const lowered = w.deps({ config: { ...w.deps().config, payoutMaxAttempts: 0 } });
    expect((await runSettle(lowered, [w.facilityId]))[0]?.payments[0]).toMatchObject({ step: 'close', detail: 'SETTLED' });
    expect(await activeHalt(live.db.$client)).toBeNull();
    expect(await payment(w, id)).toMatchObject({ state: 'SETTLED' });
  });

  it("closes a row the worker paid and confirmed even when the payee's destination no longer matches (audit run-4)", async () => {
    const w = await newWorld(live);
    const id = await spendOnce(w);
    await runSettle(w.deps(), [w.facilityId]); // payout
    await runSettle(w.deps(), [w.facilityId]); // confirm
    await live.test.mine({ blocks: 1 });
    // The payee's account changed after the worker's own confirm: the binding reads DESTINATION_MISMATCH.
    const other = payoutAccountRef({ channel: 'MY_DUITNOW', accountNumber: '6660000666', holderName: 'Shopee Ads Test' });
    await live.db.$client.query(`update payees set xendit_account_ref = $2 where facility_id = $1 and id = 'shopee-ads'`, [w.facilityId, other]);
    await finalize(w);
    expect((await runSettle(w.deps(), [w.facilityId]))[0]?.payments[0]).toMatchObject({ step: 'close', detail: 'SETTLED' });
    expect(await activeHalt(live.db.$client)).toBeNull();
    expect(await mockPayouts(w)).toBe(1);
  });

  it('settles end to end after the fixes (regression)', async () => {
    const w = await newWorld(live);
    const id = await spendOnce(w);
    expect(await settledFully(w, id)).toMatchObject({ state: 'SETTLED' });
  });
});
