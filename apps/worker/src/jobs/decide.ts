/**
 * What the tick does with one pacing line (pure). core.planPacingSlot has already decided PROPOSE or SKIP on the
 * in-flight projection; this adds the worker's own rules:
 * - a SKIP is a skip: nothing is inserted, signed or recordDenied (G0-DECISIONS §1 #1, §7);
 * - one in-flight slot per line: while a slot is signed but not mined (or DROPPED) the line waits, so the next slot
 *   is never signed against a chain that cannot accept it yet (its simulation would revert). The founder's ownerSpend
 *   in flight on the line holds a slot too (core counts it in the projection; the chain does not until it is mined);
 * - at most one slot per line per chain day: the payment id `pacing:<LINE>:<day>` is the day's claim, and any other
 *   SPEND row on the line signed or mined in that day (an API proposal, an approved escalation) takes it too, so the
 *   rule holds across the tick and the API path (audit run-4 L1);
 * - resume before propose: an unsigned row of the tick's own (`pacing:`) of the same intent (a crash between insert
 *   and sign) is signed, never duplicated. An unsigned API proposal is never resumed: agent-actions re-checks and signs
 *   it; while one holds the intent the tick would propose, the tick waits (the unique index would refuse a twin).
 */
import type { LineKey, PacingSlotPlan } from '@hogee/core';
import type { Hex } from 'viem';

export interface LineFacts {
  readonly plan: PacingSlotPlan;
  /** pacingPaymentId(line, chain day of the snapshot). */
  readonly todayId: string;
  /** The row with `todayId`, if it exists. */
  readonly today: { readonly signed: boolean; readonly intentId: Hex } | null;
  /** This line's POLICY_OK rows of the tick's own (`pacing:` ids) without signed bytes (any day). */
  readonly unsigned: readonly { readonly id: string; readonly intentId: Hex }[];
  /** Intents of this line's unsigned POLICY_OK rows the tick does not own (API proposals): never resumed. */
  readonly foreignUnsigned: readonly Hex[];
  /** Another non-released SPEND row on the line (not todayId) is signed or mined in this chain day. */
  readonly otherToday: boolean;
  readonly inFlight: { readonly slots: number; readonly dropped: number; readonly owner: { readonly slots: number } };
}

export type LineDecision =
  | { readonly kind: 'skip'; readonly reason: string }
  | { readonly kind: 'wait'; readonly reason: 'SLOT_IN_FLIGHT' | 'DROPPED_IN_FLIGHT' | 'OWNER_SPEND_IN_FLIGHT' | 'PROPOSAL_PENDING' }
  | { readonly kind: 'resume'; readonly paymentId: string }
  | { readonly kind: 'done'; readonly reason: 'ALREADY_PROPOSED_TODAY' | 'STALE_PROPOSAL_TODAY' }
  | { readonly kind: 'propose'; readonly paymentId: string };

export const SECONDS_PER_DAY = 86_400n;

/** UTC chain day of a block timestamp. */
export function chainDay(timestamp: bigint): number {
  return Number(timestamp / SECONDS_PER_DAY);
}

export function pacingPaymentId(lineKey: LineKey, day: number): string {
  return `pacing:${lineKey}:${day}`;
}

export function decideLine(f: LineFacts): LineDecision {
  if (f.plan.action === 'SKIP') return { kind: 'skip', reason: f.plan.reason };
  if (f.inFlight.dropped > 0) return { kind: 'wait', reason: 'DROPPED_IN_FLIGHT' };
  if (f.inFlight.slots > 0) return { kind: 'wait', reason: 'SLOT_IN_FLIGHT' };
  if (f.inFlight.owner.slots > 0) return { kind: 'wait', reason: 'OWNER_SPEND_IN_FLIGHT' };
  if (f.otherToday) return { kind: 'done', reason: 'ALREADY_PROPOSED_TODAY' };
  const intent = f.plan.proposal.intentId.toLowerCase();
  const match = f.unsigned.find((u) => u.intentId.toLowerCase() === intent);
  if (match) return { kind: 'resume', paymentId: match.id };
  if (f.today) return { kind: 'done', reason: f.today.signed ? 'ALREADY_PROPOSED_TODAY' : 'STALE_PROPOSAL_TODAY' };
  if (f.foreignUnsigned.some((x) => x.toLowerCase() === intent)) return { kind: 'wait', reason: 'PROPOSAL_PENDING' };
  return { kind: 'propose', paymentId: f.todayId };
}
