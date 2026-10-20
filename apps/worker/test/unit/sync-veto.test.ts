/**
 * Reconciling a vetoed (CANCELLED) loosening with the chain (audit run-4 v-4 and its re-check M2, M3, L2). Pure: the
 * chain's queuedLoosen status at `finalized` decides anything final; the status at `latest` only re-queues a cancel.
 */
import { HOGEE_KINDS } from '@hogee/chain';
import { describe, expect, it } from 'vitest';
import { decideVeto, MAX_CANCEL_REQUEUES, type VetoFacts } from '../../src/jobs/sync-veto';

const { LOOSEN_STATUS_NONE: NONE, LOOSEN_STATUS_QUEUED: QUEUED, LOOSEN_STATUS_EXECUTED: EXECUTED, LOOSEN_STATUS_CANCELLED: CANCELLED, LOOSEN_STATUS_EXPIRED: EXPIRED } = HOGEE_KINDS;
const facts = (over: Partial<VetoFacts> = {}): VetoFacts => ({ finalizedStatus: NONE, latestStatus: NONE, requestExpired: false, liveCancel: true, cancels: 1, ...over });

describe('decideVeto', () => {
  it('an execution counts only once it is final, and is an alert, never a halt (M2)', () => {
    expect(decideVeto(facts({ finalizedStatus: EXECUTED, latestStatus: EXECUTED }))).toEqual({ kind: 'executed' });
    // Executed at latest only: not final yet, so nothing is concluded (and no cancel can help any more).
    expect(decideVeto(facts({ finalizedStatus: QUEUED, latestStatus: EXECUTED, liveCancel: false }))).toEqual({ kind: 'wait' });
  });

  it('a final cancel, expiry, or a request that can no longer be queued drops the veto from later scans (M3)', () => {
    expect(decideVeto(facts({ finalizedStatus: CANCELLED, latestStatus: CANCELLED }))).toEqual({ kind: 'reconciled', reason: 'CANCELLED' });
    expect(decideVeto(facts({ finalizedStatus: EXPIRED, latestStatus: EXPIRED }))).toEqual({ kind: 'reconciled', reason: 'EXPIRED' });
    expect(decideVeto(facts({ finalizedStatus: NONE, requestExpired: true }))).toEqual({ kind: 'reconciled', reason: 'NEVER_QUEUED' });
    // Not queued yet, but its request may still land: keep watching.
    expect(decideVeto(facts({ finalizedStatus: NONE, requestExpired: false }))).toEqual({ kind: 'wait' });
  });

  it('re-queues a cancel for a loosening queued at latest with no live cancel, at most MAX_CANCEL_REQUEUES times (L2)', () => {
    expect(decideVeto(facts({ latestStatus: QUEUED, liveCancel: true }))).toEqual({ kind: 'wait' });
    expect(decideVeto(facts({ finalizedStatus: QUEUED, latestStatus: QUEUED, liveCancel: false, cancels: 1 }))).toEqual({ kind: 'requeue' });
    expect(decideVeto(facts({ latestStatus: QUEUED, liveCancel: false, cancels: MAX_CANCEL_REQUEUES }))).toEqual({ kind: 'requeue' });
    expect(decideVeto(facts({ latestStatus: QUEUED, liveCancel: false, cancels: MAX_CANCEL_REQUEUES + 1 }))).toEqual({ kind: 'exhausted' });
    // The API's own cancel is not a re-queue.
    expect(MAX_CANCEL_REQUEUES).toBe(3);
  });
});
