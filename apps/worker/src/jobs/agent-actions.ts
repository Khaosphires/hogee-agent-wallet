/**
 * agent-actions (task 1.12; queue `agent-actions`). Only the worker signs (D19): the API writes rows, this job signs
 * them with the role keys after its own checks. Per facility, on ONE chain snapshot (agent-actions-world.ts), with the
 * context rebuilt from the payments table before every decision so whatever this pass signed counts as in flight:
 *   1. escrow funding (agent key)            agent-actions-escrow.ts
 *   2. officer-approved escalations (agent)  agent-actions-spend.ts
 *   3. API spend proposals (agent)           agent-actions-spend.ts
 *   4. founder-signed payments (relayer)     agent-actions-founder.ts
 * Halted → nothing is signed (checked first, and again before every signature); while a Treasury.pause is on its way
 * the agent key signs no payment either (re-check A-2: deferred `PAUSE_PENDING`, store/pause-pending.ts), so a spend
 * of this pass never lands ahead of the pause (the handler's relay step, runtime/app.ts, signs it after this pass).
 * Every payment row exists before its signature (agent-actions-sign.ts), so reconcile's orphan watch matches every
 * effect. recordDenied is never called.
 * After the pass the facility's DB mirrors are synced from the chain (sync.ts: escalation EXECUTED, escrow amounts).
 * Never throws: a failure becomes status `error` (or one action's `error`), retried next pass.
 */
import { shortErrorReason } from '@hogee/chain';
import { activeHalt } from '../store/halt';
import { writeHeartbeat } from '../store/heartbeat';
import { poolOf } from '../store/pg';
import type { JobDeps } from './deps';
import { fundEscrow } from './agent-actions-escrow';
import { relayFounderPayments } from './agent-actions-founder';
import { AGENT_ACTIONS_JOB, type AgentActionsReport } from './agent-actions-ids';
import { payEscalations, signApiProposals } from './agent-actions-spend';
import { loadActionWorld } from './agent-actions-world';
import { syncFacility } from './sync';

export * from './agent-actions-ids';
export * from './agent-actions-pure';
export * from './agent-actions-founder-sig';
export { contextOf as agentActionsContext, loadActionWorld, loadActionPayments, readEscrowOrders, RELEASED_PAYMENT_STATES, type AgentActionContext, type ActionPaymentRow, type ActionWorld } from './agent-actions-world';
export { fundEscrow } from './agent-actions-escrow';
export { payEscalations, signApiProposals } from './agent-actions-spend';
export { relayFounderPayments } from './agent-actions-founder';

async function runFacility(d: JobDeps, facilityId: string): Promise<AgentActionsReport> {
  const halt = await activeHalt(poolOf(d.db));
  if (halt) return { facilityId, status: 'halted', actions: [], detail: halt.reason };
  const loaded = await loadActionWorld(d, facilityId);
  if (!('world' in loaded)) return { facilityId, status: loaded.status, actions: [], detail: loaded.detail };
  const w = loaded.world;
  const actions = [...(await fundEscrow(d, w)), ...(await payEscalations(d, w)), ...(await signApiProposals(d, w)), ...(await relayFounderPayments(d, w))];
  return { facilityId, status: 'ok', blockNumber: w.block, actions };
}

/** One agent-actions pass over this deployment's facilities (see the module doc). */
export async function runAgentActions(d0: JobDeps, facilityIds: readonly string[]): Promise<AgentActionsReport[]> {
  const reports: AgentActionsReport[] = [];
  for (const facilityId of facilityIds) {
    const log = d0.log.child({ job: AGENT_ACTIONS_JOB, facilityId });
    const d: JobDeps = { ...d0, log };
    const report = await runFacility(d, facilityId).catch((error: unknown): AgentActionsReport => {
      log.error('agent_actions_failed', { error });
      return { facilityId, status: 'error', actions: [], detail: shortErrorReason(error) };
    });
    await syncFacility(d, facilityId).catch((error: unknown) => log.error('sync_failed', { error }));
    if (report.actions.length > 0 || report.status !== 'ok') log.info('agent_actions_done', { status: report.status, block: report.blockNumber, actions: report.actions, detail: report.detail });
    await writeHeartbeat(poolOf(d.db), { job: AGENT_ACTIONS_JOB, scope: facilityId, status: report.status, detail: { ...report } }).catch((error: unknown) => log.error('heartbeat_failed', { error }));
    reports.push(report);
  }
  return reports;
}
