/**
 * autonomous-tick on Anvil against the real loop-1 contracts (DeployLoop.s.sol) and a throwaway Postgres.
 * Covers: one ADS slot per chain day at 7,500; the acceptance rule "a pacing slot without window headroom is
 * skipped, never proposed" (and never recordDenied); the MAX_FEE_GWEI skip; the halt flag stops signing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runTick } from '../../src/jobs/tick';
import { clearHalt, raiseHalt } from '../../src/store/halt';
import { silentLogger } from '../../src/runtime/log';
import { DAY, deniedLogs, denialRows, LIVE, LIVE_TIMEOUT_MS, lineSequence, mined, newWorld, openLive, paymentRows, spentLogs, warp, type Live } from '../support/live';

describe.skipIf(!LIVE)('autonomous-tick (Anvil + Postgres)', { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  beforeAll(async () => {
    live = await openLive();
  }, LIVE_TIMEOUT_MS);
  afterAll(async () => {
    await live?.close();
  });

  it('pays one ADS slot of 7,500 per chain day and never two on the same day', async () => {
    const w = await newWorld(live);
    await live.test.setAutomine(false);
    let first;
    try {
      first = await runTick(w.deps(), w.facilityId);
      expect(first.status).toBe('ok');
      expect(first.lines).toEqual([expect.objectContaining({ lineKey: 'ADS', decision: 'propose', slot: 1 })]);
      // Broadcast but not mined: the line waits instead of signing the next slot (its simulation would revert).
      expect((await runTick(w.deps(), w.facilityId)).lines[0]).toMatchObject({ decision: 'wait', reason: 'SLOT_IN_FLIGHT', slot: 2 });
      await live.test.mine({ blocks: 1 });
    } finally {
      await live.test.setAutomine(true);
    }
    await mined(live, first);
    const again = await runTick(w.deps(), w.facilityId);
    expect(again.lines[0]).toMatchObject({ lineKey: 'ADS', decision: 'done', reason: 'ALREADY_PROPOSED_TODAY' });

    await warp(live, DAY);
    const next = await runTick(w.deps(), w.facilityId);
    expect(next.lines[0]).toMatchObject({ decision: 'propose', slot: 2 });
    await mined(live, next);

    const spent = await spentLogs(w);
    expect(spent.map((l) => l.args.amountMinor)).toEqual([7_500n, 7_500n]);
    expect(await lineSequence(w, 'ADS')).toBe(3n);
    expect(await deniedLogs(w)).toEqual([]);
    expect(await denialRows(w)).toBe(0);
  });

  it('a slot without window headroom is skipped: no payment row, no recordDenied, no Denied event', async () => {
    const w = await newWorld(live, { windowCapMinor: { ADS: '15000' } }); // two 7,500 slots per 7-day window
    const t1 = await runTick(w.deps(), w.facilityId);
    expect(t1.lines[0]).toMatchObject({ decision: 'propose', slot: 1 });
    await mined(live, t1);
    await warp(live, DAY);
    const t2 = await runTick(w.deps(), w.facilityId);
    expect(t2.lines[0]).toMatchObject({ decision: 'propose', slot: 2 });
    await mined(live, t2);
    for (let day = 2; day < 7; day += 1) {
      await warp(live, DAY);
      const tick = await runTick(w.deps(), w.facilityId);
      expect(tick.lines[0]).toMatchObject({ lineKey: 'ADS', decision: 'skip', reason: 'NO_WINDOW_HEADROOM' });
    }
    expect((await paymentRows(w)).map((r) => r.id)).toHaveLength(2);
    expect(await lineSequence(w, 'ADS')).toBe(3n); // a skip consumes nothing
    expect(await deniedLogs(w)).toEqual([]);
    expect(await denialRows(w)).toBe(0);

    await warp(live, DAY + 60n); // the first slot leaves the 7-day window
    const t3 = await runTick(w.deps(), w.facilityId);
    expect(t3.lines[0]).toMatchObject({ decision: 'propose', slot: 3 });
    await mined(live, t3);
    expect(await spentLogs(w)).toHaveLength(3);
  });

  it('re-decides an unsigned row left from another plan version instead of signing it stale', async () => {
    const w = await newWorld(live);
    const { buildPolicyContext } = await import('../../src/chain/context');
    const { readChainSnapshot } = await import('../../src/chain/mirror');
    const { loadCommittedPlan } = await import('../../src/jobs/facility');
    const { insertProposal } = await import('../../src/jobs/pacing');
    const { chainDay, pacingPaymentId } = await import('../../src/jobs/decide');
    const { planPacingSlot } = await import('@hogee/core');
    const block = await live.client.getBlockNumber({ cacheTime: 0 });
    const snapshot = await readChainSnapshot(live.client, w.deployment, block);
    const committed = await loadCommittedPlan(live.db.$client, w.facilityId);
    const ctx = buildPolicyContext({ snapshot, committed, roles: { agent: w.signers.agent.address, lender: w.signers.lender.address, oracle: w.signers.oracle.address }, mined: { usedIntents: new Set(), paidInvoices: new Set() } });
    const plan = planPacingSlot(ctx, 'ADS', { slots: 0, lineMinor: '0', totalMinor: '0' });
    if (plan.action !== 'PROPOSE') throw new Error('expected a proposal');
    // The row a crashed tick left behind under another plan version (same intent: planVersion is not in it).
    const stale = { ...plan, proposal: { ...plan.proposal, planVersion: 7 } };
    const day = chainDay(snapshot.timestamp);
    await insertProposal(w.deps(), { facilityId: w.facilityId, paymentId: pacingPaymentId('ADS', day), lineKey: 'ADS', plan: stale, day });
    const tick = await runTick(w.deps(), w.facilityId);
    expect(tick.lines[0]).toMatchObject({ decision: 'resume', slot: 1 });
    await mined(live, tick);
    const row = await live.db.$client.query('select plan_version, state from payments where facility_id = $1', [w.facilityId]);
    expect(row.rows).toEqual([{ plan_version: 1, state: 'BROADCAST' }]);
    expect(await spentLogs(w)).toHaveLength(1);
  });

  it('skips the whole tick when fees are above MAX_FEE_GWEI (nothing inserted, nothing signed)', async () => {
    const w = await newWorld(live);
    const tick = await runTick(w.deps({ config: { maxFeeWei: 1n, lowBalanceWei: 0n, stuckPendingPasses: 3, payoutMaxAttempts: 3 } }), w.facilityId);
    expect(tick.status).toBe('fee_skip');
    expect(await paymentRows(w)).toEqual([]);
    expect(await spentLogs(w)).toEqual([]);
  });

  it('signs nothing while halted, and resumes after the operator clears the halt', async () => {
    const w = await newWorld(live);
    await raiseHalt(live.db.$client, silentLogger, 'TEST_HALT', {});
    try {
      expect((await runTick(w.deps(), w.facilityId)).status).toBe('halted');
      expect(await paymentRows(w)).toEqual([]);
    } finally {
      await clearHalt(live.db.$client, silentLogger, { by: 'test', note: 'resume', ackThrough: 'all' });
    }
    expect((await runTick(w.deps(), w.facilityId)).lines[0]).toMatchObject({ decision: 'propose', slot: 1 });
  });

  it('alerts on a low hot-key balance and still runs', async () => {
    const lines: Record<string, unknown>[] = [];
    const { createLogger } = await import('../../src/runtime/log');
    const w = await newWorld(live, { log: createLogger({ sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>) }) });
    const tick = await runTick(w.deps({ config: { maxFeeWei: 1_000n * 1_000_000_000n, lowBalanceWei: 10n ** 30n, stuckPendingPasses: 3, payoutMaxAttempts: 3 } }), w.facilityId);
    expect(tick.status).toBe('ok');
    expect(tick.alerts).toEqual(expect.arrayContaining(['LOW_BALANCE:agent', 'LOW_BALANCE:oracle']));
    expect(lines.some((l) => l.event === 'low_balance' && l.level === 'warn')).toBe(true);
  });
});
