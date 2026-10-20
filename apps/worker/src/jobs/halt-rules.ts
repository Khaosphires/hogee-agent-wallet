/**
 * Alert-and-halt rules of the reconcile job (task 1.6; G0-DECISIONS §7 "open for task 1.6"). Pure.
 *
 * HALT (new signing and payouts stop until an operator resumes):
 * - any recovery or finality outcome `error` (a row could not be read or written: state is unknown);
 * - a nonce hole-fill reported `occupied` (another tx already holds that nonce: who sent it?);
 * - a finality `pending` from a non-canonical receipt that persists for N consecutive passes;
 * - a settlement attestation (settle-confirm / settle-fail chain action) left `unresolved` for N consecutive passes:
 *   the payout already happened, so it must not wait silently for ever (audit run-3).
 * - AGENT key use outside the allocator (EXTERNAL_AGENT_KEY_USE, security re-check M4): the agent key is the one
 *   presumed leaked, so its first nonce the worker never handed out halts at once and queues a safety pause
 *   (jobs/agent-key.ts), without waiting for the orphan watch at `finalized`. The pause only tightens: a false positive
 *   costs one founder + lender unpause.
 * ALERT only: `unresolved` rows (they keep holding their intent and wait for a human), a hole filled with a cancel,
 * and key use outside the allocator by the oracle, lender or relayer key (EXTERNAL_KEY_USE). Key-use findings need
 * the key to have a `nonces` row (the worker seeds one per key at start-up, runtime/app.ts). A use that moved money is
 * also caught at `finalized` by the orphan watch
 * (jobs/orphans.ts: Treasury `Spent`, and on final-1 MilestoneEscrow `MilestoneFunded`, against the payment rows the
 * worker signed), which halts and drives Treasury.pause() until it lands (jobs/safety-pause.ts). An outside ORACLE
 * attestation moves no money but would close a payment unpaid: settle-spend halts on a CONFIRMED settlement the worker's
 * own payout does not back (SETTLEMENT_CONTRADICTION, jobs/settle-decide.ts, audit run-4).
 */
import type { FinalityOutcome, NonceInspection, NonceReconcileResult, RecoveryOutcome } from '@hogee/chain';
import { watchKey, type WatchedRow } from '../store/noncanonical';

export interface Finding {
  readonly reason: string;
  readonly detail: Record<string, unknown>;
}

export interface Verdict {
  readonly halts: readonly Finding[];
  readonly alerts: readonly Finding[];
}

export interface FacilityPass {
  readonly facilityId: string;
  readonly recovery: readonly RecoveryOutcome[];
  readonly finality: readonly FinalityOutcome[];
  /** `<table>/<id>` → consecutive non-canonical passes (store/noncanonical.ts), counting this one. */
  readonly nonCanonicalPasses: ReadonlyMap<string, number>;
  /** `<table>/<id>` → consecutive passes a settlement attestation stayed unresolved, counting this one. */
  readonly unresolvedPasses?: ReadonlyMap<string, number>;
  readonly stuckThreshold: number;
}

const NOT_CANONICAL = 'not the canonical block';

/** Rows of this finality pass whose `pending` comes from a receipt in a non-canonical block. */
export function nonCanonicalRows(finality: readonly FinalityOutcome[]): WatchedRow[] {
  return finality.filter((o) => o.action === 'pending' && (o.detail ?? '').includes(NOT_CANONICAL)).map((o) => ({ table: o.target.table, id: o.target.id }));
}

const rowOf = (o: { target: { table: string; id: string } }): string => `${o.target.table}/${o.target.id}`;

const SETTLEMENT_ACTION = /^settle-(confirm|fail):/;

/** settle-confirm / settle-fail chain actions that this pass's recovery or finality left `unresolved`. */
export function unresolvedSettlementRows(recovery: readonly RecoveryOutcome[], finality: readonly FinalityOutcome[]): WatchedRow[] {
  const seen = new Map<string, WatchedRow>();
  for (const o of [...recovery, ...finality]) {
    if (o.action !== 'unresolved' || o.target.table !== 'chain_actions' || !SETTLEMENT_ACTION.test(o.target.id)) continue;
    seen.set(rowOf(o), { table: o.target.table, id: o.target.id });
  }
  return [...seen.values()];
}

export function judgeFacilityPass(p: FacilityPass): Verdict {
  const halts: Finding[] = [];
  const alerts: Finding[] = [];
  const detail = (o: RecoveryOutcome | FinalityOutcome) => ({ facilityId: p.facilityId, row: rowOf(o), nonce: o.nonce.toString(), detail: o.detail ?? '' });
  for (const o of p.recovery) {
    if (o.action === 'error') halts.push({ reason: 'RECOVERY_ERROR', detail: detail(o) });
    else if (o.action === 'unresolved') alerts.push({ reason: 'UNRESOLVED_ROW', detail: detail(o) });
  }
  for (const o of p.finality) {
    if (o.action === 'error') halts.push({ reason: 'FINALITY_ERROR', detail: detail(o) });
    else if (o.action === 'unresolved') alerts.push({ reason: 'UNRESOLVED_ROW', detail: detail(o) });
  }
  for (const row of nonCanonicalRows(p.finality)) {
    const passes = p.nonCanonicalPasses.get(watchKey(row)) ?? 0;
    if (passes >= p.stuckThreshold) halts.push({ reason: 'NON_CANONICAL_STUCK', detail: { facilityId: p.facilityId, row: watchKey(row), passes } });
  }
  for (const row of unresolvedSettlementRows(p.recovery, p.finality)) {
    const passes = p.unresolvedPasses?.get(watchKey(row)) ?? 0;
    if (passes >= p.stuckThreshold) halts.push({ reason: 'SETTLEMENT_UNRESOLVED_STUCK', detail: { facilityId: p.facilityId, row: watchKey(row), passes } });
  }
  return { halts, alerts };
}

export const AGENT_KEY_USE = 'EXTERNAL_AGENT_KEY_USE';

/** M4: the agent key's pending nonce count is above what the allocator handed out (null when it is not, or no row yet). */
export function judgeAgentKeyUse(n: Pick<NonceInspection, 'signer' | 'dbNext' | 'chainPending' | 'externalUse'>): Finding | null {
  if (!n.externalUse || n.dbNext === null) return null;
  return { reason: AGENT_KEY_USE, detail: { role: 'agent', signer: n.signer, dbNext: n.dbNext.toString(), chainPending: n.chainPending.toString() } };
}

/** The safety-pause request of an agent-key finding: one per first unallocated nonce, so a re-detection queues nothing twice. */
export const agentKeyPauseId = (signer: string, dbNext: bigint): string => `agent-key:${signer.toLowerCase()}:${dbNext}`;

export function judgeNoncePass(role: string, n: NonceReconcileResult): Verdict {
  const halts: Finding[] = [];
  const alerts: Finding[] = [];
  for (const c of n.cancels) {
    const detail = { role, signer: n.signer, nonce: c.nonce.toString(), txHash: c.txHash };
    if (c.status === 'occupied') halts.push({ reason: 'NONCE_HOLE_OCCUPIED', detail });
    else alerts.push({ reason: 'NONCE_HOLE_FILLED', detail: { ...detail, status: c.status } });
  }
  const agentUse = role === 'agent' ? judgeAgentKeyUse(n) : null;
  if (agentUse) halts.push(agentUse);
  else if (n.externalUse) alerts.push({ reason: 'EXTERNAL_KEY_USE', detail: { role, signer: n.signer, advancedTo: n.advancedTo?.toString() ?? null } });
  return { halts, alerts };
}
