/**
 * autonomous-tick (§12.4, G0-DECISIONS §1 #1 and §7). Per facility:
 * 1. halted → nothing; fees above MAX_FEE_GWEI → the tick is skipped (nothing inserted or signed);
 * 2. hot-key balances below LOW_BALANCE_ETH → alert (the tick still runs);
 * 3. one block B: chain snapshot at B, the committed plan, the in-flight projection at B → PolicyContext
 *    (a DB/chain plan or role mismatch fails closed and halts);
 * 4. each pacing line: core.planPacingSlot on the projection → decideLine → PROPOSE is inserted, signed and
 *    broadcast; SKIP is only logged. Nothing here ever calls recordDenied;
 * 5. heartbeat row.
 * Resumable and idempotent: unsigned rows are resumed, signed rows are left to recovery, and the payment id
 * `pacing:<LINE>:<day>` plus the intent_id unique index make a second slot for the same day or intent impossible.
 */
import { capFees, FeeCapExceededError, shortErrorReason, type HogeePublicClient } from '@hogee/chain';
import { planPacingSlot, type LineKey, type PolicyContext } from '@hogee/core';
import type { Hex } from 'viem';
import { buildPolicyContext, ContextMismatchError, type CommittedPlan } from '../chain/context';
import { readChainSnapshot } from '../chain/mirror';
import { activeHalt, raiseHalt, WorkerHaltedError } from '../store/halt';
import { PausePendingError } from '../store/pause-pending';
import { writeHeartbeat } from '../store/heartbeat';
import { poolOf } from '../store/pg';
import { PACING_ID_PREFIX } from './agent-actions-ids';
import { chainDay, decideLine, pacingPaymentId, type LineDecision } from './decide';
import type { JobDeps } from './deps';
import { loadCommittedPlan, loadPayments } from './facility';
import { inFlightAt, NO_LINE_IN_FLIGHT, otherSlotOnDay, pacingInFlightOf, type InFlightView, type PaymentRow, type ReceiptBlock } from './inflight';
import { insertProposal, refreshProposal, signAndSend, type Propose } from './pacing';

export type TickStatus = 'ok' | 'halted' | 'fee_skip' | 'no_plan' | 'mismatch' | 'error';

export interface LineOutcome {
  readonly lineKey: LineKey;
  readonly decision: LineDecision['kind'] | 'deferred' | 'error';
  readonly reason?: string;
  readonly paymentId?: string;
  readonly slot?: number;
  readonly amountMinor?: string;
  readonly txHash?: Hex;
  readonly headroomMinor?: string;
}

export interface TickReport {
  readonly facilityId: string;
  readonly status: TickStatus;
  readonly blockNumber?: bigint;
  readonly chainDay?: number;
  readonly lines: readonly LineOutcome[];
  readonly alerts: readonly string[];
  readonly detail?: string;
}

export const TICK_JOB = 'autonomous-tick';

/** Receipt block of a hash, null when the node has none (other RPC errors propagate and fail the tick). */
export function receiptBlockOf(client: Pick<HogeePublicClient, 'getTransactionReceipt'>) {
  return async (hash: Hex): Promise<bigint | null> => {
    try {
      return (await client.getTransactionReceipt({ hash })).blockNumber;
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'TransactionReceiptNotFoundError') return null;
      throw error;
    }
  };
}

/** LOW_BALANCE alerts for the hot keys the loop spends gas with (agent spends, oracle settles). */
async function balanceAlerts(d: JobDeps): Promise<string[]> {
  const alerts: string[] = [];
  for (const [role, account] of [['agent', d.signers.agent], ['oracle', d.signers.oracle]] as const) {
    const balance = await d.client.getBalance({ address: account.address });
    if (balance >= d.config.lowBalanceWei) continue;
    d.log.warn('low_balance', { role, address: account.address, balanceWei: balance, thresholdWei: d.config.lowBalanceWei });
    alerts.push(`LOW_BALANCE:${role}`);
  }
  return alerts;
}

interface LineInput {
  readonly lineKey: LineKey;
  readonly rows: readonly PaymentRow[];
  readonly inflight: InFlightView;
  readonly day: number;
  readonly committed: CommittedPlan;
  readonly facilityId: string;
  /** The block B the tick reads, and how to tell which rows were mined at or below it (and on which chain day). */
  readonly block: bigint;
  readonly receiptBlock: ReceiptBlock;
  readonly dayOfBlock: (blockNumber: bigint) => Promise<number>;
}

async function execute(d: JobDeps, i: LineInput, decision: LineDecision, plan: Propose): Promise<LineOutcome> {
  const base = { lineKey: i.lineKey, slot: plan.pacingSlot, amountMinor: plan.amountMinor };
  if (decision.kind !== 'resume' && decision.kind !== 'propose') return { ...base, decision: decision.kind, reason: decision.reason };
  try {
    const args = { facilityId: i.facilityId, paymentId: decision.paymentId, lineKey: i.lineKey, plan, day: i.day };
    const found = decision.kind === 'resume' ? i.rows.find((r) => r.id === decision.paymentId) : await insertProposal(d, args);
    if (!found) throw new Error(`payment ${decision.paymentId} vanished`);
    const row = found.planVersion === plan.proposal.planVersion ? found : await refreshProposal(d, found, args);
    if (decision.kind === 'propose') await d.onStep?.('inserted', row.id);
    const { txHash } = await signAndSend(d, { facilityId: i.facilityId, committed: i.committed, row });
    return { ...base, decision: decision.kind, paymentId: row.id, txHash };
  } catch (error: unknown) {
    if (error instanceof FeeCapExceededError) return { ...base, decision: 'deferred', reason: 'FEE_CAP', paymentId: decision.paymentId };
    if (error instanceof WorkerHaltedError) return { ...base, decision: 'deferred', reason: 'HALTED', paymentId: decision.paymentId };
    if (error instanceof PausePendingError) return { ...base, decision: 'deferred', reason: 'PAUSE_PENDING', paymentId: decision.paymentId };
    d.log.error('pacing_send_failed', { facilityId: i.facilityId, lineKey: i.lineKey, paymentId: decision.paymentId, error });
    return { ...base, decision: 'error', reason: shortErrorReason(error), paymentId: decision.paymentId };
  }
}

async function tickLine(d: JobDeps, i: LineInput, ctx: PolicyContext, sentThisTick: bigint): Promise<LineOutcome> {
  const lf = i.inflight.perLine.get(i.lineKey) ?? NO_LINE_IN_FLIGHT;
  // Spends this tick already signed on other lines are in flight too: they count against releasedMinor / funded.
  // The line's in-flight ownerSpends take its next slots and balance (core PacingInFlight.owner).
  const plan = planPacingSlot(ctx, i.lineKey, pacingInFlightOf(lf, i.inflight.totalMinor + sentThisTick));
  const todayId = pacingPaymentId(i.lineKey, i.day);
  const today = i.rows.find((r) => r.id === todayId);
  const unsigned = i.rows.filter((r) => r.lineKey === i.lineKey && r.kind === 'SPEND' && r.state === 'POLICY_OK' && !r.signed);
  const own = (r: PaymentRow) => r.id.startsWith(PACING_ID_PREFIX);
  const otherToday = await otherSlotOnDay(i.rows, { lineKey: i.lineKey, except: todayId, block: i.block, receiptBlock: i.receiptBlock, day: i.day, dayOfBlock: i.dayOfBlock });
  const decision = decideLine({
    plan,
    todayId,
    today: today ? { signed: today.signed || !['PROPOSED', 'POLICY_OK'].includes(today.state), intentId: today.intentId } : null,
    unsigned: unsigned.filter(own).map((r) => ({ id: r.id, intentId: r.intentId })),
    foreignUnsigned: unsigned.filter((r) => !own(r)).map((r) => r.intentId),
    otherToday,
    inFlight: lf,
  });
  if (plan.action === 'SKIP') {
    const headroom = 'headroomMinor' in plan && plan.headroomMinor !== undefined ? { headroomMinor: plan.headroomMinor } : {};
    d.log.info('pacing_skip', { facilityId: i.facilityId, lineKey: i.lineKey, reason: plan.reason, ...headroom, note: 'not proposed, not recorded as a denial' });
    return { lineKey: i.lineKey, decision: 'skip', reason: plan.reason, ...headroom };
  }
  return execute(d, i, decision, plan);
}

async function tickFacility(d: JobDeps, facilityId: string, alerts: string[]): Promise<TickReport> {
  const pool = poolOf(d.db);
  const block = await d.client.getBlockNumber({ cacheTime: 0 });
  const [snapshot, committed, rows] = await Promise.all([readChainSnapshot(d.client, d.deployment, block), loadCommittedPlan(pool, facilityId), loadPayments(pool, facilityId)]);
  const pacing = new Set((committed?.manifest.lines ?? []).filter((l) => l.pacing).map((l) => l.lineKey));
  const receiptBlock = receiptBlockOf(d.client);
  const inflight = await inFlightAt(rows, block, receiptBlock, pacing);
  const roles = { agent: d.signers.agent.address, lender: d.signers.lender.address, oracle: d.signers.oracle.address };
  let ctx: PolicyContext;
  try {
    ctx = buildPolicyContext({ snapshot, committed, roles, mined: inflight });
  } catch (error: unknown) {
    if (!(error instanceof ContextMismatchError)) throw error;
    if (error.code === 'NO_COMMITTED_PLAN') return { facilityId, status: 'no_plan', blockNumber: block, lines: [], alerts };
    await raiseHalt(pool, d.log, 'CONTEXT_MISMATCH', { facilityId, code: error.code, block });
    return { facilityId, status: 'mismatch', blockNumber: block, lines: [], alerts: [...alerts, error.code] };
  }
  const day = chainDay(snapshot.timestamp);
  const lines: LineOutcome[] = [];
  let sentThisTick = 0n;
  for (const line of (committed as CommittedPlan).manifest.lines) {
    if (!line.pacing) continue;
    const dayOfBlock = async (blockNumber: bigint) => chainDay((await d.client.getBlock({ blockNumber })).timestamp);
    const input = { lineKey: line.lineKey, rows, inflight, day, committed: committed as CommittedPlan, facilityId, block, receiptBlock, dayOfBlock };
    const outcome = await tickLine(d, input, ctx, sentThisTick);
    if (outcome.txHash && outcome.amountMinor) sentThisTick += BigInt(outcome.amountMinor);
    lines.push(outcome);
  }
  return { facilityId, status: 'ok', blockNumber: block, chainDay: day, lines, alerts };
}

/** One autonomous tick for one facility. Never throws: failures become status `error` (retried next tick). */
export async function runTick(d: JobDeps, facilityId: string): Promise<TickReport> {
  const log = d.log.child({ job: TICK_JOB, facilityId });
  const deps: JobDeps = { ...d, log };
  let report: TickReport;
  try {
    const halt = await activeHalt(poolOf(d.db));
    if (halt) {
      report = { facilityId, status: 'halted', lines: [], alerts: [], detail: halt.reason };
    } else {
      report = await feeGate(deps, facilityId);
    }
  } catch (error: unknown) {
    log.error('tick_failed', { error });
    report = { facilityId, status: 'error', lines: [], alerts: [], detail: shortErrorReason(error) };
  }
  log.info('tick_done', { status: report.status, block: report.blockNumber, chainDay: report.chainDay, lines: report.lines, alerts: report.alerts });
  await writeHeartbeat(poolOf(d.db), { job: TICK_JOB, scope: facilityId, status: report.status, detail: { ...report } }).catch((error: unknown) =>
    log.error('heartbeat_failed', { error }),
  );
  return report;
}

async function feeGate(d: JobDeps, facilityId: string): Promise<TickReport> {
  try {
    capFees(await d.client.estimateFeesPerGas(), d.config.maxFeeWei);
  } catch (error: unknown) {
    if (!(error instanceof FeeCapExceededError)) throw error;
    d.log.warn('tick_fee_skip', { neededWei: error.neededWei, capWei: error.capWei });
    return { facilityId, status: 'fee_skip', lines: [], alerts: [], detail: `maxFeePerGas ${error.neededWei} > cap ${error.capWei}` };
  }
  const alerts = await balanceAlerts(d);
  return tickFacility(d, facilityId, alerts);
}
