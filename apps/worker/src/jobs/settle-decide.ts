/**
 * settle-spend's next step for one mined spend (§9.1; §12.3 FINALIZED → SETTLEMENT_REQUESTED → SETTLED |
 * SETTLEMENT_FAILED). Pure.
 *
 * Nothing in the DB row is trusted on its own (security audit run-3): a DB writer without keys must not be able to get
 * money paid or an oracle attestation sent.
 * - `binding` is the on-chain check (jobs/settle-verify.ts): the row's intent recomputes from the committed planId and
 *   its own fields, a FINALIZED `Spent` log of the row's tx carries exactly that spend, and the payout account the rail
 *   would pay hashes to the payee binding's payoutAccountHash at finalized. Anything else blocks (halt) BEFORE any
 *   payout or attestation.
 * - payout outcomes come from the RAIL: `history` is what the rail returns for the idempotency keys of attempts
 *   1, 2, … (keys derive from the on-chain spendId and invoice, never from DB columns). The DB payout columns are a
 *   mirror that must agree with it; a DB status or attempt the rail does not back blocks, so a FAILED written into the
 *   DB can never trigger failSettlement (which returns the amount to the pocket) or a second payout, and a SUCCEEDED
 *   can never trigger a false confirm.
 * - the chain's settlementState read at `finalized` closes the row, except a FAILED settlement whose payout succeeded,
 *   which is a contradiction and halts.
 * - CONFIRMED closes SETTLED only when the RAIL reports an attempt SUCCEEDED (audit run-4): a row never becomes SETTLED
 *   without a payout. Without one the confirm is an oracle attestation the worker did not make (the hot oracle key used
 *   outside it): a contradiction that halts (settle.ts raises it once per payment, so it cannot wedge the worker). With
 *   one, the payee was paid: if the worker's own confirm did not make the attestation (none sent, reverted behind
 *   another confirm, or another payoutRefHash than keccak256Utf8(payoutId)) the row still closes, with one ALERT. This
 *   runs before the binding rules, so a row the worker paid still closes after its payee re-bound.
 */
import { keccak256Utf8 } from '@hogee/core';
import { RETRYABLE_FAILURES } from '../rail/rail';

export interface ActionState {
  readonly state: string;
  readonly signed: boolean;
}

/** On-chain binding of the row (settle-verify.ts); anything but OK blocks. */
/**
 * PAYEE_COOLING (audit run-3): the payee's line binding is inside its cooling window (a re-bind restarts it and
 * replaces the account). The payout is HELD, never failed and never halted: the oracle's failSettlement is the only
 * veto in that window, and once it ends the destination is checked against the binding as it stands then.
 */
export type BindingVerdict = 'OK' | 'INTENT_MISMATCH' | 'SPEND_MISMATCH' | 'DESTINATION_MISMATCH' | 'PAYEE_COOLING';

/** The rail's answer for one attempt's idempotency key. */
export interface RailAttempt {
  readonly payoutId: string;
  readonly status: 'SUCCEEDED' | 'PENDING' | 'FAILED';
  readonly failureCode?: string;
}

export interface SettleFacts {
  readonly state: 'FINALIZED' | 'SETTLEMENT_REQUESTED';
  /** DB mirror of the payout (never acted on alone). */
  readonly payoutStatus: 'NONE' | 'REQUESTED' | 'SUCCEEDED' | 'FAILED';
  readonly payoutAttempt: number;
  /** Treasury.settlementState(settlementId) at the finalized block. */
  readonly chainState: 'NONE' | 'CONFIRMED' | 'FAILED';
  /** chain_actions `settle-confirm:<paymentId>` / `settle-fail:<paymentId>`, when created. */
  readonly confirmAction: ActionState | null;
  readonly failAction: ActionState | null;
  readonly binding: BindingVerdict;
  /** Attempts 1..n as the rail knows them (stops at the first key the rail has never seen). */
  readonly history: readonly RailAttempt[];
  /** payoutRefHash of the finalized SettlementConfirmed for this settlement; null when none was read. */
  readonly confirmedPayoutRef: string | null;
  readonly maxAttempts: number;
}

export type BlockReason = Exclude<BindingVerdict, 'OK' | 'PAYEE_COOLING'> | 'SETTLEMENT_CALL_REVERTED' | 'PAYOUT_STATUS_MISMATCH' | 'SETTLEMENT_CONTRADICTION';

export type SettleStep =
  /** `alert`: the payout was made, but the worker's own confirm is not the attestation (one ALERT, no halt). */
  | { readonly kind: 'close'; readonly to: 'SETTLED' | 'SETTLEMENT_FAILED'; readonly alert?: 'SETTLEMENT_CONFIRMED_ELSEWHERE' }
  | { readonly kind: 'request_payout'; readonly attempt: number }
  /** Record the rail's answer for the latest attempt in the DB mirror (and poll a pending one). */
  | { readonly kind: 'poll_payout' }
  | { readonly kind: 'confirm' }
  /** `code` fits bytes32 (failSettlement); `rawCode` is the rail's own code, kept for the trace. */
  | { readonly kind: 'fail'; readonly code: string; readonly rawCode: string }
  | { readonly kind: 'wait'; readonly reason: 'CONFIRM_IN_FLIGHT' | 'FAIL_IN_FLIGHT' | 'PAYEE_COOLING' }
  | { readonly kind: 'blocked'; readonly reason: BlockReason };

const REASON_CODE_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

/** A rail failure code as failSettlement's bytes32 code: the code itself when it fits, else PAYOUT_FAILED. */
export function settlementFailureCode(raw: string): string {
  return REASON_CODE_RE.test(raw) ? raw : 'PAYOUT_FAILED';
}

const inFlight = (a: ActionState | null): boolean => a !== null && a.signed;
const blocked = (reason: BlockReason): SettleStep => ({ kind: 'blocked', reason });

/** The rail history allows a NEW attempt: none yet, or the latest failed retryably with attempts left. */
function mayRetry(f: SettleFacts): boolean {
  const n = f.history.length;
  const latest = f.history[n - 1];
  if (!latest) return true;
  return latest.status === 'FAILED' && RETRYABLE_FAILURES.has(latest.failureCode ?? '') && n < f.maxAttempts;
}

/** The DB mirror agrees with the rail history (allowing the one crash window: REQUESTED before the rail saw it). */
function mirrorAgrees(f: SettleFacts): boolean {
  const n = f.history.length;
  const latest = f.history[n - 1];
  switch (f.payoutStatus) {
    case 'NONE':
      return n === 0 && f.payoutAttempt === 0;
    case 'REQUESTED':
      return f.payoutAttempt === n || (f.payoutAttempt === n + 1 && mayRetry(f));
    case 'SUCCEEDED':
    case 'FAILED':
      return latest !== undefined && latest.status === f.payoutStatus && f.payoutAttempt === n;
  }
}

/** Upper bound on the attempts readRailHistory asks the rail about (far above any PAYOUT_MAX_ATTEMPTS). */
export const RAIL_HISTORY_CAP = 32;

/**
 * Attempts 1..n as the rail knows them, stopping at the first key it has never seen. Not bounded by payoutMaxAttempts
 * (audit run-4): lowering it must never hide a payout already made from the close rule. RAIL_HISTORY_CAP bounds it.
 */
export async function readRailHistory(find: (attempt: number) => Promise<RailAttempt | null>): Promise<RailAttempt[]> {
  const out: RailAttempt[] = [];
  for (let attempt = 1; attempt <= RAIL_HISTORY_CAP; attempt += 1) {
    const found = await find(attempt);
    if (!found) break;
    out.push(found);
  }
  return out;
}

/** CONFIRMED (module doc): SETTLED only over a rail SUCCEEDED; an alert unless the worker's own confirm attests it. */
function closeConfirmed(f: SettleFacts): SettleStep {
  const paid = f.history.filter((a) => a.status === 'SUCCEEDED');
  if (paid.length === 0) return blocked('SETTLEMENT_CONTRADICTION');
  const ref = f.confirmedPayoutRef?.toLowerCase();
  const ours = ref !== undefined && paid.some((a) => keccak256Utf8(a.payoutId).toLowerCase() === ref);
  return ours ? { kind: 'close', to: 'SETTLED' } : { kind: 'close', to: 'SETTLED', alert: 'SETTLEMENT_CONFIRMED_ELSEWHERE' };
}

export function decideSettlement(f: SettleFacts): SettleStep {
  const succeeded = f.payoutStatus === 'SUCCEEDED' || f.history.some((a) => a.status === 'SUCCEEDED');
  if (f.chainState === 'CONFIRMED') return closeConfirmed(f);
  if (f.chainState === 'FAILED') return succeeded ? blocked('SETTLEMENT_CONTRADICTION') : { kind: 'close', to: 'SETTLEMENT_FAILED' };
  if (f.confirmAction?.state === 'REVERTED' || f.failAction?.state === 'REVERTED') return blocked('SETTLEMENT_CALL_REVERTED');
  if (inFlight(f.confirmAction)) return { kind: 'wait', reason: 'CONFIRM_IN_FLIGHT' };
  if (inFlight(f.failAction)) return { kind: 'wait', reason: 'FAIL_IN_FLIGHT' };
  if (f.binding === 'PAYEE_COOLING') return { kind: 'wait', reason: 'PAYEE_COOLING' };
  if (f.binding !== 'OK') return blocked(f.binding);
  if (!mirrorAgrees(f)) return blocked('PAYOUT_STATUS_MISMATCH');
  const n = f.history.length;
  const latest = f.history[n - 1];
  if (f.payoutStatus === 'REQUESTED') return f.payoutAttempt === n + 1 ? { kind: 'request_payout', attempt: n + 1 } : { kind: 'poll_payout' };
  if (!latest) return { kind: 'request_payout', attempt: 1 };
  if (latest.status === 'SUCCEEDED') return { kind: 'confirm' };
  if (latest.status === 'PENDING') return { kind: 'poll_payout' };
  const raw = latest.failureCode ?? 'PAYOUT_FAILED';
  if (RETRYABLE_FAILURES.has(raw) && n < f.maxAttempts) return { kind: 'request_payout', attempt: n + 1 };
  return { kind: 'fail', code: settlementFailureCode(raw), rawCode: raw };
}
