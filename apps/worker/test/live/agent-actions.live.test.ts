/**
 * agent-actions on Anvil against the final-1 contracts (MilestoneEscrow, TreasuryGovernance) and a throwaway Postgres.
 * Only the worker signs: the rows below are what the API would write. Covers escrow funding (sample + deposit once each
 * after cooling, never the balance under stage 1, idempotent, crash-safe), approved escalations (exactly the payload,
 * traced as an OFFICER OVERRIDE; refused when the payee was never bound or the payload is not its invoice), API spend
 * proposals re-checked at signing (over-cap → POLICY_DENIED), founder-signed OwnerSpend / MilestoneRelease relayed by
 * the relayer, a row tampered after the founder signed refused, and the halt.
 */
import { iMilestoneEscrowAbi, iTreasuryAbi, sequenceInvoiceHash, shortIdToBytes32, toBytes32Tag } from '@hogee/chain';
import { keccak256Utf8 } from '@hogee/core';
import { getAbiItem, type Hex } from 'viem';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runAgentActions, type AgentActionsReport } from '../../src/jobs/agent-actions';
import { runReconcile } from '../../src/jobs/reconcile';
import { runTick } from '../../src/jobs/tick';
import { silentLogger } from '../../src/runtime/log';
import { activeHalt, clearHalt, raiseHalt } from '../../src/store/halt';
import {
  bindSupplierOrder,
  insertApiSpend,
  insertApprovedEscalation,
  insertInvoice,
  insertUnboundPayee,
  milestoneReleaseRequest,
  ownerSpendRequest,
  RINA_ORDER,
} from '../support/agent-actions';
import { DAY, denialRows, finalizeAll, lineSequence, LIVE, LIVE_TIMEOUT_MS, newWorld, openLive, spentLogs, warp, type Live, type World } from '../support/live';

const MILESTONE_FUNDED = getAbiItem({ abi: iMilestoneEscrowAbi, name: 'MilestoneFunded' });
const MILESTONE_RELEASED = getAbiItem({ abi: iMilestoneEscrowAbi, name: 'MilestoneReleased' });
const OWNER_SPENT = getAbiItem({ abi: iTreasuryAbi, name: 'OwnerSpent' });
const COOLING = 121n;

const run = async (w: World, over: Parameters<World['deps']>[0] = {}): Promise<AgentActionsReport> => {
  const [report] = await runAgentActions(w.deps(over), [w.facilityId]);
  if (!report) throw new Error('no report');
  return report;
};
const brief = (r: AgentActionsReport) => r.actions.map((a) => [a.ref, a.result, a.reason ?? null]);
async function landed(w: World, r: AgentActionsReport): Promise<void> {
  for (const a of r.actions) {
    if (!a.txHash) continue;
    const receipt = await w.live.client.waitForTransactionReceipt({ hash: a.txHash });
    expect(receipt.status).toBe('success');
  }
}
const escrowRange = (w: World) => ({ address: w.deployment.contracts.MilestoneEscrow?.address as Hex, fromBlock: BigInt(w.deployment.blockNumber), toBlock: 'latest' as const });
const fundedLogs = async (w: World) => w.live.client.getLogs({ ...escrowRange(w), event: MILESTONE_FUNDED });
const releasedLogs = async (w: World) => w.live.client.getLogs({ ...escrowRange(w), event: MILESTONE_RELEASED });
const milestones = async (w: World, orderId: string) =>
  w.live.client.readContract({ address: w.deployment.contracts.MilestoneEscrow?.address as Hex, abi: iMilestoneEscrowAbi, functionName: 'milestones', args: [shortIdToBytes32(orderId)] });
const payments = async (w: World, kind: string) =>
  (await w.live.db.$client.query(`select id, state, amount_minor::text as amount, payee_id, trace_id, signer_address from payments where facility_id = $1 and kind = $2 order by created_at, id`, [w.facilityId, kind])).rows;
const traces = async (w: World, traceId: string) =>
  (await w.live.db.$client.query(`select kind, policy_verdict, reason_code, summary from traces where facility_id = $1 and trace_id = $2 order by seq`, [w.facilityId, traceId])).rows;

describe.skipIf(!LIVE)('agent-actions (Anvil + Postgres, final-1)', { timeout: LIVE_TIMEOUT_MS }, () => {
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

  it('funds the sample and the deposit once each after cooling, never the balance under stage 1; a second pass funds nothing', async () => {
    const w = await newWorld(live, { final: true });
    const orderId = await bindSupplierOrder(w);
    expect(brief(await run(w))).toEqual([[orderId, 'skipped', 'PAYEE_COOLING']]);

    await warp(live, COOLING);
    const first = await run(w);
    expect(first.status).toBe('ok');
    expect(brief(first)).toEqual([
      [`${orderId}:0`, 'sent', null],
      [`${orderId}:1`, 'sent', null],
      [`${orderId}:2`, 'denied', 'CapExceeded'], // 150,000 escrowed + 280,000 > stage 1's 400,000: waits for stage 2
    ]);
    await landed(w, first);
    const ms = await milestones(w, orderId);
    expect(ms.map((m) => [m.fundedMinor, m.released])).toEqual([
      [30_000n, true],
      [120_000n, true],
      [0n, false],
    ]);

    const second = await run(w);
    expect(second.actions.filter((a) => a.result === 'sent')).toEqual([]);
    expect(brief(second)).toEqual([[`${orderId}:2`, 'denied', 'CapExceeded']]);
    expect((await fundedLogs(w)).map((l) => [l.args.idx, l.args.amountMinor])).toEqual([
      [0, 30_000n],
      [1, 120_000n],
    ]);
    expect((await payments(w, 'FUND_MILESTONE')).map((p) => [p.id, p.amount])).toEqual([
      [`fund:${orderId}:0`, '30000'],
      [`fund:${orderId}:1`, '120000'],
    ]);
    // The balance skip is traced once (not every pass) and never recordDenied.
    const skip = await traces(w, `trace:fund:${orderId}:2`);
    expect(skip).toEqual([expect.objectContaining({ kind: 'POLICY_VERDICT', policy_verdict: 'DENY', reason_code: 'CapExceeded' })]);
    expect(await denialRows(w)).toBe(0);

    // Every MilestoneFunded matches its row (intent, rationaleHash, tx): no orphan, no halt.
    await finalizeAll(live);
    const rec = await runReconcile(w.deps(), [w.facilityId]);
    expect(rec.orphans).toEqual([]);
    expect(await activeHalt(live.db.$client)).toBeNull();
  });

  it('a crash between insert and sign resumes the same row: no second funding', async () => {
    const w = await newWorld(live, { final: true });
    const orderId = await bindSupplierOrder(w);
    await warp(live, COOLING);
    let crashed = false;
    const crash = await run(w, {
      onStep: (step) => {
        if (step !== 'inserted' || crashed) return;
        crashed = true;
        throw new Error('simulated crash after insert');
      },
    });
    expect(brief(crash)).toEqual([[`${orderId}:0`, 'error', 'Error: simulated crash after insert']]);
    expect(await payments(w, 'FUND_MILESTONE')).toEqual([expect.objectContaining({ id: `fund:${orderId}:0`, state: 'POLICY_OK', signer_address: null })]);
    expect(await fundedLogs(w)).toEqual([]);

    const resumed = await run(w);
    expect(brief(resumed).slice(0, 2)).toEqual([
      [`${orderId}:0`, 'sent', null],
      [`${orderId}:1`, 'sent', null],
    ]);
    expect(resumed.actions[0]?.paymentId).toBe(`fund:${orderId}:0`);
    await landed(w, resumed);
    expect((await payments(w, 'FUND_MILESTONE')).map((p) => p.id)).toEqual([`fund:${orderId}:0`, `fund:${orderId}:1`]);
    expect((await fundedLogs(w)).map((l) => l.args.idx)).toEqual([0, 1]);
  });

  it('an approved escalation pays exactly the server-derived payload and is traced as an OFFICER OVERRIDE', async () => {
    const w = await newWorld(live, { final: true });
    const invoiceId = 'inv-esc-1';
    const invoiceHash = await insertInvoice(w, { id: invoiceId, payeeId: 'spx-logistics', amountMinor: '5000', flags: ['IMPERATIVE_TEXT'] });
    const traceId = await insertApprovedEscalation(w, 'exc-esc-1', { lineKey: 'LOGISTICS', payeeId: 'spx-logistics', amountMinor: '5000', invoiceId });
    const r = await run(w);
    expect(r.actions).toEqual([expect.objectContaining({ action: 'ESCALATION', ref: 'exc-esc-1', result: 'sent', paymentId: 'escalation:exc-esc-1', amountMinor: '5000' })]);
    await landed(w, r);
    const spent = await spentLogs(w);
    expect(spent.map((l) => [l.args.lineId, l.args.payeeId, l.args.amountMinor, l.args.invoiceHash])).toEqual([[toBytes32Tag('LOGISTICS'), toBytes32Tag('spx-logistics'), 5_000n, invoiceHash]]);
    expect(await payments(w, 'SPEND')).toEqual([expect.objectContaining({ id: 'escalation:exc-esc-1', amount: '5000', payee_id: 'spx-logistics', trace_id: traceId })]);
    const t = await traces(w, traceId);
    expect(t).toContainEqual(expect.objectContaining({ kind: 'PROPOSAL', policy_verdict: 'NEEDS_OFFICER', reason_code: 'OFFICER_OVERRIDE' }));
    expect(t.some((e) => e.reason_code === 'WITHIN_PLAN')).toBe(false);
    expect(t.map((e) => e.kind)).toContain('TX');

    expect((await run(w)).actions).toEqual([]); // nothing twice
    await finalizeAll(live);
    expect((await runReconcile(w.deps(), [w.facilityId])).orphans).toEqual([]);
    await run(w); // its sync marks the exception EXECUTED once the payment is final
    const e = await live.db.$client.query(`select status from exceptions where facility_id = $1 and id = 'exc-esc-1'`, [w.facilityId]);
    expect(e.rows[0]?.status).toBe('EXECUTED');
  });

  it('refuses an approved escalation to a payee never bound, or one that is not its invoice: no tx, an ALERT, terminal', async () => {
    const w = await newWorld(live, { final: true });
    await insertUnboundPayee(w, 'evil-payee');
    const evil = await insertInvoice(w, { id: 'inv-evil', payeeId: 'evil-payee', amountMinor: '5000', flags: ['IMPERATIVE_TEXT'] });
    expect(evil).toMatch(/^0x/);
    const evilTrace = await insertApprovedEscalation(w, 'exc-evil', { lineKey: 'LOGISTICS', payeeId: 'evil-payee', amountMinor: '5000', invoiceId: 'inv-evil' });
    await insertInvoice(w, { id: 'inv-real', payeeId: 'spx-logistics', amountMinor: '5000' });
    await insertApprovedEscalation(w, 'exc-inflated', { lineKey: 'LOGISTICS', payeeId: 'spx-logistics', amountMinor: '19000', invoiceId: 'inv-real' });
    const r = await run(w);
    expect(brief(r)).toEqual([
      ['exc-evil', 'refused', 'PayeeNotBound'],
      ['exc-inflated', 'refused', 'INVOICE_AMOUNT_MISMATCH'],
    ]);
    expect(await spentLogs(w)).toEqual([]);
    expect(await payments(w, 'SPEND')).toEqual([]);
    expect(await traces(w, evilTrace)).toEqual([expect.objectContaining({ kind: 'ALERT', policy_verdict: 'DENY', reason_code: 'OFFICER_OVERRIDE_REFUSED' })]);
    expect((await run(w)).actions).toEqual([]); // terminal: not re-evaluated, not re-traced
    expect(await traces(w, evilTrace)).toHaveLength(1);
  });

  it('re-checks API spend proposals at signing: the one that became over-cap is POLICY_DENIED, never signed; nothing while halted', async () => {
    const w = await newWorld(live, { final: true });
    for (const id of ['a', 'b', 'c']) {
      const invoiceHash = await insertInvoice(w, { id: `inv-${id}`, payeeId: 'spx-logistics', amountMinor: '19000' });
      await insertApiSpend(w, { id: `proposal:${id}`, lineKey: 'LOGISTICS', payeeId: 'spx-logistics', amountMinor: '19000', invoiceHash });
    }
    await raiseHalt(live.db.$client, silentLogger, 'TEST_HALT', {});
    expect((await run(w)).status).toBe('halted');
    expect((await payments(w, 'SPEND')).every((p) => p.signer_address === null)).toBe(true);
    await clearHalt(live.db.$client, silentLogger, { by: 'test', note: 'resume', ackThrough: 'all', abandonPause: true });

    const r = await run(w);
    // LOGISTICS window cap 40,000: two 19,000 spends fit, the third (counted in flight) does not.
    expect(brief(r)).toEqual([
      ['proposal:a', 'sent', null],
      ['proposal:b', 'sent', null],
      ['proposal:c', 'denied', 'CapExceeded'],
    ]);
    await landed(w, r);
    expect((await payments(w, 'SPEND')).map((p) => [p.id, p.state])).toEqual([
      ['proposal:a', 'BROADCAST'],
      ['proposal:b', 'BROADCAST'],
      ['proposal:c', 'POLICY_DENIED'],
    ]);
    expect((await spentLogs(w)).map((l) => l.args.amountMinor)).toEqual([19_000n, 19_000n]);
    expect(await denialRows(w)).toBe(0); // not recordDenied
    expect(await traces(w, 'trace:proposal:c')).toEqual([expect.objectContaining({ kind: 'POLICY_VERDICT', policy_verdict: 'DENY', reason_code: 'CapExceeded' })]);
  });

  it('signs no agent payment while a Treasury.pause is pending (re-check A-2); a refused pause holds nothing back', async () => {
    const w = await newWorld(live, { final: true });
    const invoiceHash = await insertInvoice(w, { id: 'inv-p', payeeId: 'spx-logistics', amountMinor: '19000' });
    await insertApiSpend(w, { id: 'proposal:p', lineKey: 'LOGISTICS', payeeId: 'spx-logistics', amountMinor: '19000', invoiceHash });
    // What POST /api/control/pause writes; the handler's relay step signs it only after this pass.
    await live.db.$client.query(`insert into chain_actions (id, facility_id, kind, ref_id, state, request_json) values ('act-pause-a2', $1, 'Treasury.pause', $1, 'PENDING', '{}'::jsonb)`, [
      w.facilityId,
    ]);
    expect(brief(await run(w))).toEqual([['proposal:p', 'deferred', 'PAUSE_PENDING']]);
    expect((await payments(w, 'SPEND')).map((p) => [p.id, p.state, p.signer_address])).toEqual([['proposal:p', 'POLICY_OK', null]]);
    expect(await spentLogs(w)).toEqual([]);

    await live.db.$client.query(`update chain_actions set revert_reason = 'REFUSED: test' where facility_id = $1 and id = 'act-pause-a2'`, [w.facilityId]);
    const r = await run(w);
    expect(brief(r)).toEqual([['proposal:p', 'sent', null]]);
    await landed(w, r);
  });

  it('signs at most one API pacing slot per line per chain day; the next slot waits for the next day (audit run-4)', async () => {
    const w = await newWorld(live, { final: true });
    const slot = await lineSequence(w, 'ADS');
    const pace = (id: string, s: bigint) => insertApiSpend(w, { id, lineKey: 'ADS', payeeId: 'shopee-ads', amountMinor: '7500', invoiceHash: sequenceInvoiceHash(s) });
    await pace('pace:1', slot);
    await pace('pace:2', slot + 1n);
    const r = await run(w);
    // The core policy alone would sign both (slot 2 follows slot 1 in flight): the day rule refuses the second, for good.
    expect(brief(r)).toEqual([
      ['pace:1', 'sent', null],
      ['pace:2', 'denied', 'ALREADY_PROPOSED_TODAY'],
    ]);
    await landed(w, r);
    expect((await payments(w, 'SPEND')).map((p) => [p.id, p.state])).toEqual([
      ['pace:1', 'BROADCAST'],
      ['pace:2', 'POLICY_DENIED'],
    ]);
    expect(await denialRows(w)).toBe(0); // not recordDenied
    // Mined today: another proposal of the next slot is refused the same chain day too.
    await pace('pace:3', slot + 1n);
    expect(brief(await run(w))).toEqual([['pace:3', 'denied', 'ALREADY_PROPOSED_TODAY']]);
    // The tick counts the API slot as the line's slot of the day too (L1).
    const tick = await runTick(w.deps(), w.facilityId);
    expect(tick.lines.find((l) => l.lineKey === 'ADS')).toMatchObject({ decision: 'done', reason: 'ALREADY_PROPOSED_TODAY' });
    // The next chain day it is signed, by agent-actions: the tick never resumes an API row, it waits for it (L1).
    await warp(live, DAY);
    await pace('pace:4', slot + 1n);
    const waiting = await runTick(w.deps(), w.facilityId);
    expect(waiting.lines.find((l) => l.lineKey === 'ADS')).toMatchObject({ decision: 'wait', reason: 'PROPOSAL_PENDING' });
    const next = await run(w);
    expect(brief(next)).toEqual([['pace:4', 'sent', null]]);
    await landed(w, next);
    expect(await lineSequence(w, 'ADS')).toBe(slot + 2n);
    expect((await payments(w, 'SPEND')).filter((p) => String(p.id).startsWith('pacing:'))).toEqual([]);
  });

  it('relays a founder-signed OwnerSpend with the relayer key; refuses a row whose amount is not what the founder signed', async () => {
    const w = await newWorld(live, { final: true });
    const invoiceHash = await insertInvoice(w, { id: 'inv-owner', payeeId: 'spx-logistics', amountMinor: '4000' });
    const ok = await ownerSpendRequest(w, { sigId: 'sig-owner-1', lineKey: 'LOGISTICS', payeeId: 'spx-logistics', amountMinor: '4000', invoiceHash });
    const tamperedHash = await insertInvoice(w, { id: 'inv-tamper', payeeId: 'spx-logistics', amountMinor: '4000' });
    const bad = await ownerSpendRequest(w, { sigId: 'sig-owner-2', lineKey: 'LOGISTICS', payeeId: 'spx-logistics', amountMinor: '4000', invoiceHash: tamperedHash, rowAmountMinor: '9000' });

    const r = await run(w);
    expect(brief(r)).toEqual([
      [ok.paymentId, 'sent', null],
      [bad.paymentId, 'refused', "the signed OwnerSpend amountMinor is not the payment row's"],
    ]);
    await landed(w, r);
    const owner = await w.live.client.getLogs({ address: w.deployment.contracts.Treasury.address, event: OWNER_SPENT, fromBlock: BigInt(w.deployment.blockNumber), toBlock: 'latest' });
    expect(owner.map((l) => [l.args.spendId, l.args.amountMinor])).toEqual([[ok.intent, 4_000n]]);
    expect(await live.client.readContract({ address: w.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: 'isIntentUsed', args: [ok.intent] })).toBe(true);
    const rows = await payments(w, 'OWNER_SPEND');
    expect(rows).toEqual([
      expect.objectContaining({ id: ok.paymentId, state: 'BROADCAST', signer_address: w.signers.relayer.address.toLowerCase() }),
      expect.objectContaining({ id: bad.paymentId, state: 'POLICY_DENIED', signer_address: null }),
    ]);
    expect(await traces(w, 'sig-owner-2')).toContainEqual(expect.objectContaining({ kind: 'ALERT', reason_code: 'FOUNDER_RELAY_REFUSED' }));
    expect((await run(w)).actions).toEqual([]);
  });

  it('funds a non-autoRelease milestone into escrow, then relays the founder-signed MilestoneRelease', async () => {
    const w = await newWorld(live, { final: true });
    const order = { supplierId: 'supplier-b', orderId: 'order-b-001', schedule: [30_000n, 50_000n], autoRelease: [true, false] } as const;
    await bindSupplierOrder(w, order);
    await warp(live, COOLING);
    const funding = await run(w);
    expect(brief(funding)).toEqual([
      ['order-b-001:0', 'sent', null],
      ['order-b-001:1', 'sent', null],
    ]);
    await landed(w, funding);
    expect((await milestones(w, order.orderId)).map((m) => [m.fundedMinor, m.released])).toEqual([
      [30_000n, true],
      [50_000n, false], // funded into escrow: only the founder's signed release pays it
    ]);

    const evidenceHash = keccak256Utf8('inspection/order-b-001/1') as Hex;
    const paymentId = await milestoneReleaseRequest(w, { sigId: 'sig-release-1', order, idx: 1, evidenceHash });
    const r = await run(w);
    expect(brief(r)).toEqual([[paymentId, 'sent', null]]);
    await landed(w, r);
    expect((await milestones(w, order.orderId))[1]?.released).toBe(true);
    const released = await releasedLogs(w);
    expect(released.map((l) => [l.args.idx, l.args.amountMinor, l.args.evidenceHash])).toEqual([
      [0, 30_000n, `0x${'0'.repeat(64)}`],
      [1, 50_000n, evidenceHash],
    ]);
  });

  it('holds an automatic milestone back while the window is full or it pays out over the current per-payment cap (re-check 9)', async () => {
    const w = await newWorld(live, { final: true });
    // SUPPLIER: per-payment cap 125,000, window 250,000 a week. Three orders bound, all cooled.
    const b = { supplierId: 'supplier-b', orderId: 'order-b-001', schedule: [110_000n, 10_000n], autoRelease: [true, false] } as const;
    const c = { supplierId: 'supplier-c', orderId: 'order-c-001', schedule: [130_000n, 10_000n], autoRelease: [true, false] } as const;
    const a = await bindSupplierOrder(w);
    await bindSupplierOrder(w, b);
    await bindSupplierOrder(w, c);
    await warp(live, COOLING);

    const first = await run(w);
    expect(brief(first)).toEqual([
      [`${a}:0`, 'sent', null],
      [`${a}:1`, 'sent', null],
      [`${a}:2`, 'denied', 'CapExceeded'],
      ['order-b-001:0', 'deferred', 'AUTO_WINDOW_FULL'], // 30,000 + 120,000 in flight + 110,000 > 250,000
      ['order-c-001:0', 'deferred', 'AUTO_OVER_PER_TX'], // 130,000 > 125,000 (a cap tightened after signing looks the same)
    ]);
    await landed(w, first);
    // Held back, not refused: nothing signed or recorded, and each hold is traced once (not every pass).
    expect(brief(await run(w)).filter(([ref]) => ref !== `${a}:2`)).toEqual([
      ['order-b-001:0', 'deferred', 'AUTO_WINDOW_FULL'],
      ['order-c-001:0', 'deferred', 'AUTO_OVER_PER_TX'],
    ]);
    expect(await traces(w, 'trace:fund:order-b-001:0')).toEqual([expect.objectContaining({ kind: 'ALERT', reason_code: 'AUTO_WINDOW_FULL' })]);
    expect(await traces(w, 'trace:fund:order-c-001:0')).toEqual([expect.objectContaining({ kind: 'ALERT', reason_code: 'AUTO_OVER_PER_TX' })]);
    expect((await payments(w, 'FUND_MILESTONE')).map((p) => p.id)).toEqual([`fund:${a}:0`, `fund:${a}:1`]);
    expect(await denialRows(w)).toBe(0);

    // A week of chain time later the earlier automatic payments have left the window: the deposit is paid, and the
    // held balance after it is funded into escrow (held milestones are never bounded by the window).
    await warp(live, 604_800n);
    const later = await run(w);
    expect(brief(later)).toEqual([
      [`${a}:2`, 'denied', 'CapExceeded'],
      ['order-b-001:0', 'sent', null],
      ['order-b-001:1', 'sent', null],
      ['order-c-001:0', 'deferred', 'AUTO_OVER_PER_TX'],
    ]);
    await landed(w, later);
    expect((await milestones(w, b.orderId)).map((m) => [m.fundedMinor, m.released])).toEqual([
      [110_000n, true],
      [10_000n, false],
    ]);
  });
});
