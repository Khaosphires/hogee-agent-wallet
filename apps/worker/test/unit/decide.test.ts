import type { PacingSlotPlan, SpendProposalIn } from '@hogee/core';
import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { decideLine, pacingPaymentId, type LineFacts } from '../../src/jobs/decide';

const INTENT: Hex = `0x${'ab'.repeat(32)}`;
const OTHER: Hex = `0x${'cd'.repeat(32)}`;
const propose = { action: 'PROPOSE', pacingSlot: 3, amountMinor: '7500', payeeId: 'shopee-ads', proposal: { intentId: INTENT } as SpendProposalIn } as PacingSlotPlan;

function facts(over: Partial<LineFacts> = {}): LineFacts {
  return { plan: propose, todayId: pacingPaymentId('ADS', 20_378), today: null, unsigned: [], foreignUnsigned: [], otherToday: false, inFlight: { slots: 0, dropped: 0, owner: { slots: 0 } }, ...over };
}

describe('pacingPaymentId', () => {
  it('is one id per line per chain day (the at-most-one-slot-per-day claim)', () => {
    expect(pacingPaymentId('ADS', 20_378)).toBe('pacing:ADS:20378');
  });
});

describe('decideLine', () => {
  it('proposes today when nothing is in flight', () => {
    expect(decideLine(facts())).toEqual({ kind: 'propose', paymentId: 'pacing:ADS:20378' });
  });

  it('a SKIP is only a skip: never proposed, never a denial', () => {
    const skip = { action: 'SKIP', reason: 'NO_WINDOW_HEADROOM', headroomMinor: '0' } as PacingSlotPlan;
    expect(decideLine(facts({ plan: skip }))).toEqual({ kind: 'skip', reason: 'NO_WINDOW_HEADROOM' });
    // even with an unsigned row of the same day waiting: it is not signed while the state refuses the slot
    expect(decideLine(facts({ plan: skip, today: { signed: false, intentId: INTENT }, unsigned: [{ id: 'pacing:ADS:20378', intentId: INTENT }] }))).toEqual({
      kind: 'skip',
      reason: 'NO_WINDOW_HEADROOM',
    });
  });

  it('waits while a slot of the line is in flight or dropped', () => {
    expect(decideLine(facts({ inFlight: { slots: 1, dropped: 0, owner: { slots: 0 } } }))).toEqual({ kind: 'wait', reason: 'SLOT_IN_FLIGHT' });
    expect(decideLine(facts({ inFlight: { slots: 1, dropped: 1, owner: { slots: 0 } } }))).toEqual({ kind: 'wait', reason: 'DROPPED_IN_FLIGHT' });
  });

  it("waits while the founder's ownerSpend holds the line's next slot (the agent's slot would revert until it is mined)", () => {
    expect(decideLine(facts({ inFlight: { slots: 0, dropped: 0, owner: { slots: 1 } } }))).toEqual({ kind: 'wait', reason: 'OWNER_SPEND_IN_FLIGHT' });
  });

  it('resumes an unsigned row of the same intent (crash between insert and sign)', () => {
    expect(decideLine(facts({ today: { signed: false, intentId: INTENT }, unsigned: [{ id: 'pacing:ADS:20378', intentId: INTENT }] }))).toEqual({
      kind: 'resume',
      paymentId: 'pacing:ADS:20378',
    });
    expect(decideLine(facts({ unsigned: [{ id: 'pacing:ADS:20377', intentId: INTENT }] }))).toEqual({ kind: 'resume', paymentId: 'pacing:ADS:20377' });
  });

  it('does not propose when another SPEND row on the line is signed or mined this chain day (an API proposal, audit run-4 L1)', () => {
    expect(decideLine(facts({ otherToday: true }))).toEqual({ kind: 'done', reason: 'ALREADY_PROPOSED_TODAY' });
    // Not even by resuming its own unsigned row of an earlier day.
    expect(decideLine(facts({ otherToday: true, unsigned: [{ id: 'pacing:ADS:20377', intentId: INTENT }] }))).toEqual({ kind: 'done', reason: 'ALREADY_PROPOSED_TODAY' });
  });

  it('never resumes an API row: it waits while an API proposal holds the slot it would propose (audit run-4 L1)', () => {
    expect(decideLine(facts({ foreignUnsigned: [INTENT] }))).toEqual({ kind: 'wait', reason: 'PROPOSAL_PENDING' });
    expect(decideLine(facts({ foreignUnsigned: [OTHER] }))).toEqual({ kind: 'propose', paymentId: 'pacing:ADS:20378' });
  });

  it('does not propose twice on one chain day', () => {
    expect(decideLine(facts({ today: { signed: true, intentId: OTHER } }))).toEqual({ kind: 'done', reason: 'ALREADY_PROPOSED_TODAY' });
    expect(decideLine(facts({ today: { signed: false, intentId: OTHER }, unsigned: [{ id: 'pacing:ADS:20378', intentId: OTHER }] }))).toEqual({
      kind: 'done',
      reason: 'STALE_PROPOSAL_TODAY',
    });
  });
});
