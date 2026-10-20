/**
 * Stable ids and codes of the agent-actions job (task 1.12). Payment ids are deterministic, so a re-run after a crash
 * finds the row it inserted instead of inserting a second one:
 * - `fund:<orderId>:<idx>` (a retry after a REVERTED / CANCELLED attempt: `fund:<orderId>:<idx>:<attempt>`), kind
 *   FUND_MILESTONE, inserted by the worker;
 * - `escalation:<exceptionId>`, kind SPEND, inserted by the worker for an officer-APPROVED POLICY_ESCALATION
 *   (sync.ts marks the exception EXECUTED when this payment is mined);
 * - `release:<exceptionId | signatureRequestId>`, kind RELEASE_MILESTONE, and `owner:<signatureRequestId>`, kind
 *   OWNER_SPEND: inserted by the API with the founder's signed request; the worker only relays them.
 * - `adopt-owner:<spendId>` (OWNER_SPEND) and `adopt-release:<settlementId>` (RELEASE_MILESTONE): settle-adopt.ts
 *   records a founder-signed call another account executed first, so its settlement is paid once (audit run-4).
 * Every other unsigned POLICY_OK SPEND row (not `pacing:`, which the tick owns) is an API spend proposal.
 */
export const AGENT_ACTIONS_JOB = 'agent-actions';

export const FUND_ID_PREFIX = 'fund:';
export const ESCALATION_ID_PREFIX = 'escalation:';
export const RELEASE_ID_PREFIX = 'release:';
export const OWNER_ID_PREFIX = 'owner:';
/** autonomous-tick's pacing rows (jobs/decide.ts pacingPaymentId). */
export const PACING_ID_PREFIX = 'pacing:';
/** settle-adopt.ts: founder-signed calls a third party executed first (worker-owned, FINALIZED from the chain). */
export const ADOPT_OWNER_ID_PREFIX = 'adopt-owner:';
export const ADOPT_RELEASE_ID_PREFIX = 'adopt-release:';

/** Ids the worker or the founder flows own: never treated as an API spend proposal. */
export const RESERVED_PAYMENT_ID_PREFIXES: readonly string[] = Object.freeze([
  PACING_ID_PREFIX,
  FUND_ID_PREFIX,
  ESCALATION_ID_PREFIX,
  RELEASE_ID_PREFIX,
  OWNER_ID_PREFIX,
  ADOPT_OWNER_ID_PREFIX,
  ADOPT_RELEASE_ID_PREFIX,
]);

/** FUND_MILESTONE row of (order, idx); attempt 1 is the plain id, later attempts follow a released (failed) row. */
export function fundPaymentId(orderId: string, idx: number, attempt = 1): string {
  if (!Number.isSafeInteger(idx) || idx < 0 || idx > 255) throw new RangeError('idx must be a uint8');
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new RangeError('attempt must be a positive integer');
  const base = `${FUND_ID_PREFIX}${orderId}:${idx}`;
  return attempt === 1 ? base : `${base}:${attempt}`;
}

export const escalationPaymentId = (exceptionId: string): string => `${ESCALATION_ID_PREFIX}${exceptionId}`;
export const releasePaymentId = (ref: string): string => `${RELEASE_ID_PREFIX}${ref}`;
export const ownerPaymentId = (signatureRequestId: string): string => `${OWNER_ID_PREFIX}${signatureRequestId}`;

/** An unsigned SPEND row the API inserted for POST /api/proposals/spend (no reserved prefix). */
export function isApiSpendProposalId(id: string): boolean {
  return !RESERVED_PAYMENT_ID_PREFIXES.some((p) => id.startsWith(p));
}

/** Trace id of a worker-inserted payment (same form as pacing.ts). */
export const agentTraceIdOf = (paymentId: string): string => `trace:${paymentId}`;
/** Trace of an escalation whose exception row has no trace id. */
export const escalationTraceIdOf = (exceptionId: string): string => `trace:${escalationPaymentId(exceptionId)}`;

/** Reason codes the job writes to traces (an officer override is never WITHIN_PLAN). */
export const REASON = Object.freeze({
  WITHIN_PLAN: 'WITHIN_PLAN',
  OFFICER_OVERRIDE: 'OFFICER_OVERRIDE',
  OFFICER_OVERRIDE_REFUSED: 'OFFICER_OVERRIDE_REFUSED',
  SPEND_PROPOSAL_DENIED: 'SPEND_PROPOSAL_DENIED',
  FOUNDER_RELAY_REFUSED: 'FOUNDER_RELAY_REFUSED',
  /** A pacing line's slot of the chain day is taken (the tick's code, decide.ts; audit run-4). */
  ALREADY_PROPOSED_TODAY: 'ALREADY_PROPOSED_TODAY',
} as const);

/**
 * Denials that describe the treasury's or a line's state, not the proposal (core pacing.ts WORKER RULE): an approved
 * escalation hitting one of them waits for the next pass instead of being refused for good.
 */
export const TRANSIENT_DENIALS: ReadonlySet<string> = new Set(['Paused', 'CircuitOpen', 'PayeeCooling']);

export type AgentAction = 'FUND_MILESTONE' | 'ESCALATION' | 'API_SPEND' | 'RELEASE_MILESTONE' | 'OWNER_SPEND';

/**
 * sent: signed (or resumed) and broadcast · skipped: nothing to do yet (supplier cooling, funding in flight) ·
 * denied: the policy refused it now (nothing signed; an API row becomes POLICY_DENIED) · needs_officer: a flagged
 * milestone invoice (nothing signed) · refused: a hard refusal (override no longer allowed, a row that is not what was
 * signed, a reverting call); nothing is ever signed for it · deferred: fee cap, halt or a transient state · error.
 */
export type AgentActionResult = 'sent' | 'skipped' | 'denied' | 'needs_officer' | 'refused' | 'deferred' | 'error';

export interface AgentActionOutcome {
  readonly action: AgentAction;
  /** `<orderId>:<idx>`, the exception id or the payment id. */
  readonly ref: string;
  readonly result: AgentActionResult;
  readonly paymentId?: string;
  readonly reason?: string;
  readonly amountMinor?: string;
  readonly txHash?: `0x${string}`;
}

export type AgentActionsStatus = 'ok' | 'halted' | 'no_plan' | 'mismatch' | 'error';

export interface AgentActionsReport {
  readonly facilityId: string;
  readonly status: AgentActionsStatus;
  readonly blockNumber?: bigint;
  readonly actions: readonly AgentActionOutcome[];
  readonly detail?: string;
}
