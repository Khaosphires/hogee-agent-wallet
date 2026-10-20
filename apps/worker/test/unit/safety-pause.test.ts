/** The orphan safety pause's pure rules: how the latest attempt is judged, and the fee cap it signs under. */
import { describe, expect, it } from 'vitest';
import { judgeAttempt, safetyFeeCapWei, type AttemptFacts } from '../../src/jobs/safety-pause';

const facts = (over: Partial<AttemptFacts>): AttemptFacts => ({ signed: true, nonce: 5n, receipt: null, minedCount: 5n, pendingCount: 6n, ...over });

describe('judgeAttempt (Treasury.paused() still false)', () => {
  it('an unsigned row is reused for the next try (no nonce was used)', () => {
    expect(judgeAttempt(facts({ signed: false, nonce: null }))).toBe('unsigned');
  });

  it('a pending attempt the node can execute is in flight (bumped and re-sent, not replaced)', () => {
    expect(judgeAttempt(facts({}))).toBe('in_flight');
  });

  it('nonce_consumed / replaced / front-run is a failure, never success', () => {
    expect(judgeAttempt(facts({ minedCount: 6n }))).toBe('failed');
  });

  it('a reverted attempt, or a mined one while the treasury is still unpaused, is a failure', () => {
    expect(judgeAttempt(facts({ receipt: 'reverted', minedCount: 6n }))).toBe('failed');
    expect(judgeAttempt(facts({ receipt: 'success', minedCount: 6n }))).toBe('failed');
  });

  it('an attempt the node does not hold as executable (dropped, or behind a nonce gap) is stalled', () => {
    expect(judgeAttempt(facts({ minedCount: 4n, pendingCount: 5n }))).toBe('stalled');
  });
});

describe('safetyFeeCapWei', () => {
  const base = { maxFeeWei: 30n, lowBalanceWei: 0n, stuckPendingPasses: 3, payoutMaxAttempts: 3 };
  it('is MAX_SAFETY_FEE_GWEI when set, else 10 × MAX_FEE_GWEI', () => {
    expect(safetyFeeCapWei({ ...base, maxSafetyFeeWei: 500n })).toBe(500n);
    expect(safetyFeeCapWei(base)).toBe(300n);
  });
});
