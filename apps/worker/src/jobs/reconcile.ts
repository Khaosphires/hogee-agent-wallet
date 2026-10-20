/**
 * reconcile (§9.3, §12.3; every minute). For each facility, bound to that facility's deployment:
 * recoverOpenIntents (re-sends stored bytes, never signs) then advanceFinality (terminal states from `finalized`
 * reads). Then, per hot key, the nonce check (holes get a no-op cancel unless halted; agent-key use outside the
 * allocator halts and queues a safety pause, jobs/agent-key.ts, even while halted), the orphan-spend watch, and the
 * orphan safety pause (jobs/safety-pause.ts). Each step is guarded on its own: one that fails does not stop the
 * next, and the safety pause runs in every pass whatever happened before it.
 * Halt rules: jobs/halt-rules.ts. A halt stops new signing and payouts; this job keeps running (it signs nothing
 * but hole cancels, which stop while halted, and the safety pause, which is tighten-only).
 */
import {
  advanceFinality,
  DeploymentMismatchError,
  FeeCapExceededError,
  fillNonceHoles,
  inspectNonces,
  reconcileNonce,
  recoverOpenIntents,
  shortErrorReason,
  type FinalityOutcome,
  type NonceInspection,
  type RecoveryOutcome,
} from '@hogee/chain';
import { activeHalt, raiseHalt } from '../store/halt';
import { writeHeartbeat } from '../store/heartbeat';
import { trackNonCanonical, trackUnresolved } from '../store/noncanonical';
import { poolOf } from '../store/pg';
import { checkAgentKey } from './agent-key';
import type { JobDeps } from './deps';
import { judgeFacilityPass, judgeNoncePass, nonCanonicalRows, unresolvedSettlementRows, type Finding } from './halt-rules';
import { watchOrphans, type Orphan } from './orphans';
import { driveSafetyPause, type SafetyPauseReport } from './safety-pause';

export const RECONCILE_JOB = 'reconcile';

export interface FacilityReconcile {
  readonly facilityId: string;
  readonly recovery: readonly RecoveryOutcome[];
  readonly finality: readonly FinalityOutcome[];
  readonly error?: string;
}

export interface ReconcileReport {
  readonly status: 'ok' | 'error';
  readonly facilities: readonly FacilityReconcile[];
  readonly nonces: readonly { readonly role: string; readonly holes: number; readonly cancels: number; readonly externalUse: boolean }[];
  readonly orphans: readonly Orphan[];
  /** Set when the orphan watch failed this pass (retried next pass; its cursor did not move past the failure). */
  readonly orphanWatchError?: string;
  readonly safetyPause: SafetyPauseReport;
  readonly halts: readonly Finding[];
  readonly alerts: readonly Finding[];
  /** A halt is active after this pass. */
  readonly halted: boolean;
  readonly detail?: string;
}

async function reconcileFacility(d: JobDeps, facilityId: string, halts: Finding[], alerts: Finding[]): Promise<FacilityReconcile> {
  const opts = { chainId: d.deployment.chainId, deployment: d.deployment, facilityId };
  try {
    const recovery = await recoverOpenIntents(d.db, d.client, opts);
    const finality = await advanceFinality(d.db, d.client, { ...opts, nonceSearchFromBlock: BigInt(d.deployment.blockNumber) });
    const passes = await trackNonCanonical(poolOf(d.db), facilityId, nonCanonicalRows(finality));
    const unresolvedPasses = await trackUnresolved(poolOf(d.db), facilityId, unresolvedSettlementRows(recovery, finality));
    const verdict = judgeFacilityPass({ facilityId, recovery, finality, nonCanonicalPasses: passes, unresolvedPasses, stuckThreshold: d.config.stuckPendingPasses });
    await halt(d, halts, verdict.halts);
    alerts.push(...verdict.alerts);
    return { facilityId, recovery, finality };
  } catch (error: unknown) {
    // A pass that throws learned nothing about its rows: retried next minute. A wrong deployment is a config fault.
    if (error instanceof DeploymentMismatchError) await halt(d, halts, [{ reason: 'DEPLOYMENT_MISMATCH', detail: { facilityId, error: shortErrorReason(error) } }]);
    d.log.error('reconcile_facility_failed', { facilityId, error });
    return { facilityId, recovery: [], finality: [], error: shortErrorReason(error) };
  }
}

/** Records halts at once, so the rest of this same pass already sees them (no hole cancel after a halt). */
async function halt(d: JobDeps, into: Finding[], found: readonly Finding[]): Promise<void> {
  for (const h of found) {
    into.push(h);
    await raiseHalt(poolOf(d.db), d.log, h.reason, h.detail);
  }
}

const ROLES = ['agent', 'oracle', 'lender', 'relayer'] as const;
type NonceLine = { role: string; holes: number; cancels: number; externalUse: boolean };

/**
 * The agent key never goes through reconcileNonce's DB-only nonce advance: a use outside the allocator is recorded with
 * its halt and safety pause in one transaction (jobs/agent-key.ts), halted or not. Holes are then filled like any key's.
 */
async function reconcileAgentNonces(d: JobDeps, facilityIds: readonly string[], halts: Finding[], alerts: Finding[]): Promise<NonceLine> {
  const { inspection: n, finding } = await checkAgentKey(d, facilityIds);
  if (finding) halts.push(finding);
  if ((await activeHalt(poolOf(d.db))) !== null) {
    if (n.holes.length > 0) alerts.push({ reason: 'NONCE_HOLES_WHILE_HALTED', detail: { role: 'agent', holes: n.holes.map(String) } });
    return { role: 'agent', holes: n.holes.length, cancels: 0, externalUse: n.externalUse };
  }
  const cancels = await fillNonceHoles({ client: d.client, account: d.signers.agent, chainId: d.deployment.chainId, holes: n.holes, capWei: d.config.maxFeeWei });
  const verdict = judgeNoncePass('agent', { ...n, advancedTo: null, cancels });
  await halt(d, halts, verdict.halts);
  alerts.push(...verdict.alerts);
  return { role: 'agent', holes: n.holes.length, cancels: cancels.length, externalUse: n.externalUse };
}

async function reconcileNonces(d: JobDeps, facilityIds: readonly string[], halts: Finding[], alerts: Finding[]): Promise<ReconcileReport['nonces']> {
  const out: NonceLine[] = [];
  for (const role of ROLES) {
    const account = d.signers[role];
    const key = { signer: account.address, chainId: d.deployment.chainId, client: d.client };
    try {
      if (role === 'agent') {
        out.push(await reconcileAgentNonces(d, facilityIds, halts, alerts));
        continue;
      }
      // Checked per key: a halt raised earlier in this pass (or by the previous key's hole-fill) stops the cancels.
      if ((await activeHalt(poolOf(d.db))) !== null) {
        const n: NonceInspection = await inspectNonces(d.db, key);
        if (n.holes.length > 0) alerts.push({ reason: 'NONCE_HOLES_WHILE_HALTED', detail: { role, holes: n.holes.map(String) } });
        out.push({ role, holes: n.holes.length, cancels: 0, externalUse: n.externalUse });
        continue;
      }
      const n = await reconcileNonce(d.db, { ...key, account, capWei: d.config.maxFeeWei });
      const verdict = judgeNoncePass(role, n);
      await halt(d, halts, verdict.halts);
      alerts.push(...verdict.alerts);
      out.push({ role, holes: n.holes.length, cancels: n.cancels.length, externalUse: n.externalUse });
    } catch (error: unknown) {
      if (error instanceof FeeCapExceededError) alerts.push({ reason: 'NONCE_FILL_DEFERRED_FEE', detail: { role } });
      else d.log.error('nonce_reconcile_failed', { role, error });
    }
  }
  return out;
}

/**
 * The orphan watch (Treasury, and MilestoneEscrow on final-1), guarded: a failure is reported and retried next pass,
 * and never stops the safety pause.
 */
async function watchOrphansGuarded(d: JobDeps, facilityIds: readonly string[]): Promise<{ orphans: readonly Orphan[]; error?: string }> {
  try {
    const watch = await watchOrphans({
      pool: poolOf(d.db),
      client: d.client,
      contracts: d.deployment.contracts,
      chainId: d.deployment.chainId,
      startBlock: BigInt(d.deployment.blockNumber),
      facilityIds,
      agent: d.signers.agent.address,
      log: d.log,
    });
    return watch.errors.length > 0 ? { orphans: watch.orphans, error: watch.errors.join('; ') } : { orphans: watch.orphans };
  } catch (error: unknown) {
    d.log.error('orphan_watch_failed', { error });
    return { orphans: [], error: shortErrorReason(error) };
  }
}

/** One reconcile pass over this deployment's facilities. Never throws. */
export async function runReconcile(d0: JobDeps, facilityIds: readonly string[]): Promise<ReconcileReport> {
  const d: JobDeps = { ...d0, log: d0.log.child({ job: RECONCILE_JOB }) };
  const pool = poolOf(d.db);
  const halts: Finding[] = [];
  const alerts: Finding[] = [];
  const facilities: FacilityReconcile[] = [];
  let nonces: ReconcileReport['nonces'] = [];
  let detail: string | undefined;
  try {
    for (const id of facilityIds) facilities.push(await reconcileFacility(d, id, halts, alerts));
    nonces = await reconcileNonces(d, facilityIds, halts, alerts);
  } catch (error: unknown) {
    // Each step above catches its own failures; this is a last resort, and the watch and the pause still run.
    d.log.error('reconcile_failed', { error });
    detail = shortErrorReason(error);
  }
  const watch = await watchOrphansGuarded(d, facilityIds);
  // Independent of every step above: an orphan queued by this pass or an earlier one is paused now.
  const safetyPause = await driveSafetyPause(d, facilityIds);
  for (const a of alerts) d.log.warn('reconcile_alert', { reason: a.reason, detail: a.detail });
  const halted = (await activeHalt(pool).catch(() => null)) !== null;
  const failed = detail !== undefined || watch.error !== undefined || safetyPause.error !== undefined || facilities.some((f) => f.error);
  const report: ReconcileReport = {
    status: failed ? 'error' : 'ok',
    facilities,
    nonces,
    orphans: watch.orphans,
    ...(watch.error ? { orphanWatchError: watch.error } : {}),
    safetyPause,
    halts,
    alerts,
    halted,
    ...(detail ? { detail } : {}),
  };
  const summary = {
    halted: report.halted,
    halts: report.halts.map((h) => h.reason),
    alerts: report.alerts.map((a) => a.reason),
    orphans: report.orphans.length,
    safetyPause: { live: safetyPause.live, paused: safetyPause.paused, pausedSafe: safetyPause.pausedSafe ?? null, attempts: safetyPause.attempts.map((a) => `${a.role}:${a.action}`), error: safetyPause.error },
    rows: report.facilities.map((f) => ({ facilityId: f.facilityId, recovery: f.recovery.map((o) => o.action), finality: f.finality.map((o) => o.action), error: f.error })),
  };
  d.log.info('reconcile_done', { status: report.status, ...summary });
  await writeHeartbeat(pool, { job: RECONCILE_JOB, scope: 'global', status: report.halted ? 'halted' : report.status, detail: summary }).catch((error: unknown) =>
    d.log.error('heartbeat_failed', { error }),
  );
  return report;
}
