import { keccak256Utf8 } from '@hogee/core';
import { describe, expect, it } from 'vitest';
import { decideSettlement, RAIL_HISTORY_CAP, readRailHistory, settlementFailureCode, type RailAttempt, type SettleFacts } from '../../src/jobs/settle-decide';

function facts(over: Partial<SettleFacts> = {}): SettleFacts {
  return {
    state: 'FINALIZED',
    payoutStatus: 'NONE',
    payoutAttempt: 0,
    chainState: 'NONE',
    confirmAction: null,
    failAction: null,
    binding: 'OK',
    history: [],
    confirmedPayoutRef: null,
    maxAttempts: 3,
    ...over,
  };
}

const ok = (n: number): RailAttempt => ({ payoutId: `mock-${n}`, status: 'SUCCEEDED' });
/** The payoutRefHash the worker's own confirmSettlement carries for attempt n's payout. */
const refOf = (n: number) => keccak256Utf8(`mock-${n}`);
const bad = (n: number, code: string): RailAttempt => ({ payoutId: `mock-${n}`, status: 'FAILED', failureCode: code });
const paid = (over: Partial<SettleFacts> = {}) => facts({ state: 'SETTLEMENT_REQUESTED', payoutStatus: 'SUCCEEDED', payoutAttempt: 1, history: [ok(1)], ...over });
const failed = (code: string, over: Partial<SettleFacts> = {}) =>
  facts({ state: 'SETTLEMENT_REQUESTED', payoutStatus: 'FAILED', payoutAttempt: 1, history: [bad(1, code)], ...over });

describe('decideSettlement', () => {
  it('a finalized spend gets its first payout (attempt 1)', () => {
    expect(decideSettlement(facts())).toEqual({ kind: 'request_payout', attempt: 1 });
  });

  it.each(['DESTINATION_MISMATCH', 'INTENT_MISMATCH', 'SPEND_MISMATCH'] as const)('never pays or attests when the on-chain binding check says %s', (binding) => {
    expect(decideSettlement(facts({ binding }))).toEqual({ kind: 'blocked', reason: binding });
    expect(decideSettlement(paid({ binding }))).toEqual({ kind: 'blocked', reason: binding });
    expect(decideSettlement(failed('INVALID_DESTINATION', { binding }))).toEqual({ kind: 'blocked', reason: binding });
  });

  it('re-requests the same attempt when the rail never saw it (crash after REQUESTED)', () => {
    expect(decideSettlement(facts({ state: 'SETTLEMENT_REQUESTED', payoutStatus: 'REQUESTED', payoutAttempt: 1 }))).toEqual({ kind: 'request_payout', attempt: 1 });
  });

  it('records what the rail has for a requested attempt (pending or done)', () => {
    const requested = facts({ state: 'SETTLEMENT_REQUESTED', payoutStatus: 'REQUESTED', payoutAttempt: 1 });
    expect(decideSettlement({ ...requested, history: [{ payoutId: 'mock-1', status: 'PENDING' }] })).toEqual({ kind: 'poll_payout' });
    expect(decideSettlement({ ...requested, history: [ok(1)] })).toEqual({ kind: 'poll_payout' });
  });

  it('confirms only a payout the rail itself reports as succeeded, then waits for the confirm to land', () => {
    expect(decideSettlement(paid())).toEqual({ kind: 'confirm' });
    expect(decideSettlement(paid({ confirmAction: { state: 'BROADCAST', signed: true } }))).toEqual({ kind: 'wait', reason: 'CONFIRM_IN_FLIGHT' });
    expect(decideSettlement(paid({ confirmAction: { state: 'PENDING', signed: false } }))).toEqual({ kind: 'confirm' });
    expect(decideSettlement(paid({ history: [bad(1, 'INVALID_DESTINATION')] }))).toEqual({ kind: 'blocked', reason: 'PAYOUT_STATUS_MISMATCH' });
  });

  it('never fails a settlement on a DB FAILED status the rail contradicts (a tampered row)', () => {
    expect(decideSettlement(failed('INVALID_DESTINATION', { history: [ok(1)] }))).toEqual({ kind: 'blocked', reason: 'PAYOUT_STATUS_MISMATCH' });
    expect(decideSettlement(failed('TEMPORARY_TRANSFER_ERROR', { history: [ok(1)] }))).toEqual({ kind: 'blocked', reason: 'PAYOUT_STATUS_MISMATCH' });
    expect(decideSettlement(facts({ payoutStatus: 'FAILED', payoutAttempt: 1 }))).toEqual({ kind: 'blocked', reason: 'PAYOUT_STATUS_MISMATCH' });
    expect(decideSettlement(facts({ payoutStatus: 'SUCCEEDED', payoutAttempt: 1 }))).toEqual({ kind: 'blocked', reason: 'PAYOUT_STATUS_MISMATCH' });
  });

  it('refuses a DB attempt counter the rail history does not back (no extra payout)', () => {
    expect(decideSettlement(paid({ payoutAttempt: 2 }))).toEqual({ kind: 'blocked', reason: 'PAYOUT_STATUS_MISMATCH' });
    expect(decideSettlement(facts({ state: 'SETTLEMENT_REQUESTED', payoutStatus: 'REQUESTED', payoutAttempt: 3, history: [ok(1)] }))).toEqual({
      kind: 'blocked',
      reason: 'PAYOUT_STATUS_MISMATCH',
    });
    expect(decideSettlement(facts({ history: [ok(1)] }))).toEqual({ kind: 'blocked', reason: 'PAYOUT_STATUS_MISMATCH' });
    // A forged "next attempt" over a payout that succeeded (or failed for good) must never open a second payout.
    const requestedNext = (history: RailAttempt[]) => facts({ state: 'SETTLEMENT_REQUESTED', payoutStatus: 'REQUESTED', payoutAttempt: history.length + 1, history });
    expect(decideSettlement(requestedNext([ok(1)]))).toEqual({ kind: 'blocked', reason: 'PAYOUT_STATUS_MISMATCH' });
    expect(decideSettlement(requestedNext([bad(1, 'INVALID_DESTINATION')]))).toEqual({ kind: 'blocked', reason: 'PAYOUT_STATUS_MISMATCH' });
    expect(decideSettlement(requestedNext([{ payoutId: 'mock-1', status: 'PENDING' }]))).toEqual({ kind: 'blocked', reason: 'PAYOUT_STATUS_MISMATCH' });
    expect(decideSettlement(requestedNext([bad(1, 'TEMPORARY_TRANSFER_ERROR')]))).toEqual({ kind: 'request_payout', attempt: 2 });
  });

  it('retries a retryable failure with the next attempt, then fails the settlement on-chain', () => {
    expect(decideSettlement(failed('TEMPORARY_TRANSFER_ERROR'))).toEqual({ kind: 'request_payout', attempt: 2 });
    const three = [bad(1, 'TEMPORARY_TRANSFER_ERROR'), bad(2, 'TEMPORARY_TRANSFER_ERROR'), bad(3, 'TEMPORARY_TRANSFER_ERROR')];
    expect(decideSettlement(failed('TEMPORARY_TRANSFER_ERROR', { payoutAttempt: 3, history: three }))).toEqual({
      kind: 'fail',
      code: 'TEMPORARY_TRANSFER_ERROR',
      rawCode: 'TEMPORARY_TRANSFER_ERROR',
    });
    expect(decideSettlement(failed('INVALID_DESTINATION'))).toEqual({ kind: 'fail', code: 'INVALID_DESTINATION', rawCode: 'INVALID_DESTINATION' });
  });

  it('maps a rail failure code that does not fit bytes32 to PAYOUT_FAILED and keeps the raw code', () => {
    expect(decideSettlement(failed('rejected-by-bank: KYC'))).toEqual({ kind: 'fail', code: 'PAYOUT_FAILED', rawCode: 'rejected-by-bank: KYC' });
    expect(settlementFailureCode('INVALID_DESTINATION')).toBe('INVALID_DESTINATION');
    expect(settlementFailureCode('A'.repeat(33))).toBe('PAYOUT_FAILED');
    expect(settlementFailureCode('9LIVES')).toBe('PAYOUT_FAILED');
    expect(settlementFailureCode('')).toBe('PAYOUT_FAILED');
  });

  it('holds (never pays, never fails, never halts) while the payee binding is cooling after a re-bind (audit run-3)', () => {
    expect(decideSettlement(facts({ binding: 'PAYEE_COOLING' }))).toEqual({ kind: 'wait', reason: 'PAYEE_COOLING' });
    expect(decideSettlement(facts({ binding: 'PAYEE_COOLING', payoutStatus: 'REQUESTED', payoutAttempt: 1 }))).toEqual({ kind: 'wait', reason: 'PAYEE_COOLING' });
  });

  it('closes from the chain state read at finalized', () => {
    expect(decideSettlement(paid({ chainState: 'CONFIRMED', confirmedPayoutRef: refOf(1) }))).toEqual({ kind: 'close', to: 'SETTLED' });
    expect(decideSettlement(failed('INVALID_DESTINATION', { chainState: 'FAILED' }))).toEqual({ kind: 'close', to: 'SETTLEMENT_FAILED' });
  });

  it('closes a CONFIRMED settlement only over a payout the rail reports SUCCEEDED and the attestation names (audit run-4)', () => {
    // An oracle attestation the worker did not make (no payout at all): halt, never SETTLED.
    expect(decideSettlement(facts({ chainState: 'CONFIRMED' }))).toEqual({ kind: 'blocked', reason: 'SETTLEMENT_CONTRADICTION' });
    expect(decideSettlement(facts({ chainState: 'CONFIRMED', binding: 'PAYEE_COOLING' }))).toEqual({ kind: 'blocked', reason: 'SETTLEMENT_CONTRADICTION' });
    expect(decideSettlement(facts({ chainState: 'CONFIRMED', confirmedPayoutRef: refOf(1) }))).toEqual({ kind: 'blocked', reason: 'SETTLEMENT_CONTRADICTION' });
    // A payout still pending or failed at the rail is not paid: a confirm over it is a contradiction too.
    const requested = facts({ state: 'SETTLEMENT_REQUESTED', payoutStatus: 'REQUESTED', payoutAttempt: 1, chainState: 'CONFIRMED', confirmedPayoutRef: refOf(1) });
    expect(decideSettlement({ ...requested, history: [{ payoutId: 'mock-1', status: 'PENDING' }] })).toEqual({ kind: 'blocked', reason: 'SETTLEMENT_CONTRADICTION' });
    expect(decideSettlement(failed('INVALID_DESTINATION', { chainState: 'CONFIRMED', confirmedPayoutRef: refOf(1) }))).toEqual({ kind: 'blocked', reason: 'SETTLEMENT_CONTRADICTION' });
    // A DB mirror claiming SUCCEEDED is not the rail.
    expect(decideSettlement(facts({ chainState: 'CONFIRMED', payoutStatus: 'SUCCEEDED', payoutAttempt: 1, confirmedPayoutRef: refOf(1) }))).toEqual({
      kind: 'blocked',
      reason: 'SETTLEMENT_CONTRADICTION',
    });
    // A paid row whose attestation the worker's own confirm did not make (none, reverted behind another confirm, or
    // another ref): the payee WAS paid, so it closes SETTLED with one alert, never a halt that would wedge the worker.
    const elsewhere = { kind: 'close', to: 'SETTLED', alert: 'SETTLEMENT_CONFIRMED_ELSEWHERE' };
    expect(decideSettlement(paid({ chainState: 'CONFIRMED' }))).toEqual(elsewhere);
    expect(decideSettlement(paid({ chainState: 'CONFIRMED', confirmedPayoutRef: refOf(2) }))).toEqual(elsewhere);
    expect(decideSettlement(paid({ chainState: 'CONFIRMED', confirmAction: { state: 'REVERTED', signed: true } }))).toEqual(elsewhere);
    expect(decideSettlement(paid({ chainState: 'CONFIRMED', binding: 'DESTINATION_MISMATCH' }))).toEqual(elsewhere);
    // A rail SUCCEEDED the DB mirror has not recorded yet is still a payout.
    expect(decideSettlement({ ...requested, history: [ok(1)], confirmedPayoutRef: null })).toEqual(elsewhere);
    // A legitimately confirmed row closes even when the payee re-bound since (binding no longer OK).
    expect(decideSettlement(paid({ chainState: 'CONFIRMED', confirmedPayoutRef: refOf(1), binding: 'PAYEE_COOLING' }))).toEqual({ kind: 'close', to: 'SETTLED' });
    expect(decideSettlement(paid({ chainState: 'CONFIRMED', confirmedPayoutRef: refOf(1), binding: 'DESTINATION_MISMATCH' }))).toEqual({ kind: 'close', to: 'SETTLED' });
    // The paid attempt after a retryable failure.
    const retried = paid({ payoutAttempt: 2, history: [bad(1, 'TEMPORARY_TRANSFER_ERROR'), ok(2)], chainState: 'CONFIRMED', confirmedPayoutRef: refOf(2) });
    expect(decideSettlement(retried)).toEqual({ kind: 'close', to: 'SETTLED' });
    expect(decideSettlement({ ...retried, confirmedPayoutRef: refOf(1) })).toEqual(elsewhere);
  });

  it('reads the rail history up to the first key the rail never saw, not only up to payoutMaxAttempts (audit run-4 L4)', async () => {
    const rail: Record<number, RailAttempt> = { 1: bad(1, 'TEMPORARY_TRANSFER_ERROR'), 2: bad(2, 'TEMPORARY_TRANSFER_ERROR'), 3: ok(3) };
    const asked: number[] = [];
    const history = await readRailHistory(async (attempt) => {
      asked.push(attempt);
      return rail[attempt] ?? null;
    });
    expect(history).toEqual([rail[1], rail[2], rail[3]]);
    expect(asked).toEqual([1, 2, 3, 4]);
    // A lowered payoutMaxAttempts (2) cannot hide attempt 3's payout from the close rule.
    expect(decideSettlement(paid({ payoutAttempt: 3, history, maxAttempts: 2, chainState: 'CONFIRMED', confirmedPayoutRef: refOf(3) }))).toEqual({ kind: 'close', to: 'SETTLED' });
    // A runaway rail is bounded.
    expect(await readRailHistory(async (attempt) => ok(attempt))).toHaveLength(RAIL_HISTORY_CAP);
  });

  it('halts instead of closing a FAILED settlement whose payout succeeded (a contradiction)', () => {
    expect(decideSettlement(paid({ chainState: 'FAILED' }))).toEqual({ kind: 'blocked', reason: 'SETTLEMENT_CONTRADICTION' });
    expect(decideSettlement(failed('INVALID_DESTINATION', { chainState: 'FAILED', payoutStatus: 'SUCCEEDED' }))).toEqual({ kind: 'blocked', reason: 'SETTLEMENT_CONTRADICTION' });
  });

  it('a reverted settlement call needs a human', () => {
    expect(decideSettlement(paid({ confirmAction: { state: 'REVERTED', signed: true } }))).toEqual({ kind: 'blocked', reason: 'SETTLEMENT_CALL_REVERTED' });
  });
});
