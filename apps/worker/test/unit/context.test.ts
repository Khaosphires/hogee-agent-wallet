import { planPacingSlot } from '@hogee/core';
import { describe, expect, it } from 'vitest';
import { buildPolicyContext, ContextMismatchError } from '../../src/chain/context';
import { AGENT, committed, LENDER, OBSERVER, ORACLE, OWNER, rinaSnapshot, roles } from '../support/fixtures';

const NONE = { slots: 0, lineMinor: '0', totalMinor: '0' };
const mined = { usedIntents: new Set<string>(), paidInvoices: new Set<string>() };

describe('buildPolicyContext', () => {
  it("mirrors Treasury.observer() so the constitution's agent != observer rule (audit run-3) sees the real key", () => {
    const ctx = buildPolicyContext({ snapshot: rinaSnapshot({ observer: OBSERVER }), committed, roles, mined });
    expect(ctx.facility.observer).toBe(OBSERVER.toLowerCase());
  });

  it('mirrors the chain snapshot into the core PolicyContext', () => {
    const ctx = buildPolicyContext({ snapshot: rinaSnapshot(), committed, roles, mined });
    expect(ctx.planVersion).toBe(1);
    expect(ctx.now).toBe(rinaSnapshot().timestamp);
    expect(ctx.releasedMinor).toBe('400000');
    expect(ctx.fundedMinor).toBe('1000000');
    expect(ctx.lines.ADS).toMatchObject({ windowCapMinor: '60000', nextSequence: 1, payeeIds: ['shopee-ads'], paused: false });
    expect(ctx.payees).toContainEqual(expect.objectContaining({ payeeId: 'shopee-ads', lineKeys: ['ADS'], source: 'platform', paidMinor: '0' }));
    // The real role addresses, not the zero address of the Rina demo context.
    expect(ctx.facility).toMatchObject({ ownerEOA: OWNER.toLowerCase(), lender: LENDER.toLowerCase(), oracle: ORACLE.toLowerCase(), capMinor: '1000000', reserveFloorBps: 300 });
    expect(ctx.facility.observer).toBe('0x0000000000000000000000000000000000000000');
    expect(ctx.stages).toEqual([
      { stageId: 'stage-1', released: true },
      { stageId: 'stage-2', released: false },
    ]);
  });

  it('feeds planPacingSlot: the next ADS slot is proposed at 7,500', () => {
    const plan = planPacingSlot(buildPolicyContext({ snapshot: rinaSnapshot(), committed, roles, mined }), 'ADS', NONE);
    expect(plan).toMatchObject({ action: 'PROPOSE', pacingSlot: 1, amountMinor: '7500', payeeId: 'shopee-ads' });
  });

  it('a full window skips the slot (no proposal, nothing to deny)', () => {
    const ctx = buildPolicyContext({ snapshot: rinaSnapshot({ ads: { windowSpentMinor: 60_000n, spentMinor: 60_000n }, adsSequence: 9n }), committed, roles, mined });
    expect(planPacingSlot(ctx, 'ADS', NONE)).toMatchObject({ action: 'SKIP', reason: 'NO_WINDOW_HEADROOM', headroomMinor: '0' });
  });

  it('counts in-flight spends against the window (projection)', () => {
    const ctx = buildPolicyContext({ snapshot: rinaSnapshot({ ads: { windowSpentMinor: 52_500n, spentMinor: 52_500n }, adsSequence: 8n }), committed, roles, mined });
    expect(planPacingSlot(ctx, 'ADS', NONE)).toMatchObject({ action: 'PROPOSE', pacingSlot: 8 });
    expect(planPacingSlot(ctx, 'ADS', { slots: 1, lineMinor: '7500', totalMinor: '7500' })).toMatchObject({ action: 'SKIP', reason: 'NO_WINDOW_HEADROOM' });
  });

  it('a paused treasury or an open circuit is a skip, not a denial', () => {
    expect(planPacingSlot(buildPolicyContext({ snapshot: rinaSnapshot({ paused: true }), committed, roles, mined }), 'ADS', NONE)).toMatchObject({ action: 'SKIP', reason: 'Paused' });
    expect(planPacingSlot(buildPolicyContext({ snapshot: rinaSnapshot({ ads: { circuitOpen: true } }), committed, roles, mined }), 'ADS', NONE)).toMatchObject({ action: 'SKIP', reason: 'CircuitOpen' });
  });

  it('fails closed when the DB plan is not the chain plan', () => {
    const s = rinaSnapshot();
    expect(() => buildPolicyContext({ snapshot: { ...s, planVersion: 2, plan: { ...s.plan, version: 2 } }, committed, roles, mined })).toThrow(ContextMismatchError);
    expect(() => buildPolicyContext({ snapshot: { ...s, plan: { ...s.plan, planHash: `0x${'1'.repeat(64)}` } }, committed, roles, mined })).toThrow(/PLAN_HASH_MISMATCH/);
    expect(() => buildPolicyContext({ snapshot: { ...s, plan: { ...s.plan, planId: `0x${'2'.repeat(64)}` } }, committed, roles, mined })).toThrow(/PLAN_ID_MISMATCH/);
  });

  it('fails closed when the stored manifest is not the one whose hash the chain holds', () => {
    const tampered = { ...committed.manifest, lines: committed.manifest.lines.map((l) => (l.lineKey === 'ADS' && l.pacing ? { ...l, pacing: { ...l.pacing, amountMinor: '30000' } } : l)) };
    expect(() => buildPolicyContext({ snapshot: rinaSnapshot(), committed: { ...committed, manifest: tampered }, roles, mined })).toThrow(/MANIFEST_MISMATCH/);
  });

  it('fails closed when the configured keys are not the deployment roles', () => {
    expect(() => buildPolicyContext({ snapshot: rinaSnapshot(), committed, roles: { ...roles, oracle: LENDER }, mined })).toThrow(/ROLE_MISMATCH/);
    expect(() => buildPolicyContext({ snapshot: rinaSnapshot(), committed, roles: { ...roles, agent: ORACLE }, mined })).toThrow(/AGENT_MISMATCH/);
    expect(AGENT).not.toBe(ORACLE);
  });

  it('reports a chain without a committed plan', () => {
    const s = rinaSnapshot();
    expect(() => buildPolicyContext({ snapshot: { ...s, planVersion: 0 }, committed: null, roles, mined })).toThrow(/NO_COMMITTED_PLAN/);
  });
});
