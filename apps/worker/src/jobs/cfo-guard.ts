/**
 * cfo-guard (VISION-DECISIONS §7, §9 "CFO actions"): the AI CFO's bounded authority. For each facility it may only
 * TIGHTEN (core proposeTightenings: lower a line's per-payment or window cap on a line burning over 1.5× its pace,
 * raise the reserve rate up to 1000 bps), each proposal through the existing evaluateTighten path, with a trace and a
 * tx. Moving budget is never done here: it is a link to the officer's change-request flow.
 *
 * One pass per facility, at ONE block B:
 *   1. halted → nothing; fees above MAX_FEE_GWEI → nothing (no row is written);
 *   2. the chain snapshot at B and the committed plan → the REAL mirrored PolicyContext (buildPolicyContext: a DB/chain
 *      plan or role mismatch refuses; no plan → nothing);
 *   3. core CfoInputs from the snapshot and the DB rows landed at or below B (cfo-guard-inputs.ts) → proposeTightenings
 *      (which already checks each against core's own tightenContextOf);
 *   4. each proposal is re-checked on the REAL context (evaluateTighten must answer AUTO: agent live, not paused, line
 *      active) and against the snapshot itself (strictlyTightens: a cap strictly lower and at least 1 BU, a reserve rate
 *      strictly higher and at most 1000 bps). Anything else is never sent: a DENY trace records why;
 *   5. sent as Treasury.tighten signed by the AGENT key through the chain_actions outbox (crash-safe nonce, simulated
 *      before broadcast), with a POLICY_VERDICT trace before and a TX trace after.
 *
 * Idempotent per line per chain day: the action id is `cfo-guard:<chainDay>:<slot>` (slot = the line, or RESERVE), and
 * an existing row in ANY state uses the slot up for that day, so a re-run, a crash or a failed send never tightens the
 * same line twice in a day. Never loosens: proposals only lower caps or raise the reserve, the contract reverts a
 * raise (NotOwner), and step 4 refuses anything that is not strictly tighter. Fails closed: any read error ends the
 * facility's pass with nothing sent.
 *
 * Bounded (audit run-9 lead 3), because every job shares one advisory lock (reconcile, settle and the relay that sends
 * the officer's Treasury.pause wait while a pass holds it): the inputs are a 30-day window through a block-time cache
 * (cfo-guard-inputs.ts); a run has a deadline (CFO_GUARD_DEADLINE_MS), past which it starts no read and sends nothing,
 * and traces that once per facility per day; and with a pacer (the worker passes one) a facility runs at most one pass
 * per CFO_GUARD_MIN_INTERVAL_MS, however many sales wake the job. A refused proposal's DENY is traced once per line,
 * reason and chain day. Each send's RPC calls count against the same deadline (fixr-cfo, re-check LOW 5;
 * runtime/deadline.ts withinDeadline): a send stuck on the chain stops at it with an ALERT on its trace, and the
 * proposals after it are not sent. The relay still sends a pause queued meanwhile once the lock frees (runtime/relay-wake.ts).
 */
import {
  capFees,
  decisionIdToBytes32,
  FeeCapExceededError,
  buildTighten,
  HOGEE_KINDS,
  shortErrorReason,
  toBytes32Tag,
  toTxRequest,
  ZERO_BYTES32,
} from '@hogee/chain';
import { evaluateTighten, proposeTightenings, toTightenProposal, type CfoInputs, type CfoTightening, type CurrencyCode, type PolicyContext } from '@hogee/core';
import { BlockTimeCache } from '../chain/block-times';
import { sendAction } from '../chain/actions';
import { buildPolicyContext, ContextMismatchError } from '../chain/context';
import { readChainSnapshot } from '../chain/mirror';
import type { ChainSnapshot } from '../chain/snapshot';
import { Deadline, DeadlineError, isDeadlineError, withinDeadline } from '../runtime/deadline';
import { uuidv7 } from '../runtime/ids';
import { activeHalt } from '../store/halt';
import { poolOf, rows, type Pg } from '../store/pg';
import { appendTrace, hasTrace, traceExists } from '../store/trace';
import { CFO_GUARD_ACTION_PREFIX, readGuardInputs, taxPayeeOf, type CfoGuardRequest } from './cfo-guard-inputs';
import { chainDay } from './decide';
import type { JobDeps } from './deps';
import { loadCommittedPlan } from './facility';

export const CFO_GUARD_JOB = 'cfo-guard';
export { CFO_GUARD_ACTION_PREFIX } from './cfo-guard-inputs';

export type CfoGuardStatus = 'ok' | 'halted' | 'fee_skip' | 'no_plan' | 'mismatch' | 'error' | 'deadline' | 'paced';

/** Wall-clock budget of one run over the facilities (it holds the shared job lock throughout). */
export const CFO_GUARD_DEADLINE_MS = 10_000;
/** With a pacer: at most one pass per facility in this interval (every recorded sale wakes the job). */
export const CFO_GUARD_MIN_INTERVAL_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

/** Per facility, at most one pass per `intervalMs` (in-process; the job lock already keeps passes from overlapping). */
export class GuardPacer {
  private readonly last = new Map<string, number>();

  constructor(readonly intervalMs: number = CFO_GUARD_MIN_INTERVAL_MS) {}

  /** True, and the pass counts, when `facilityId` may run one at `nowMs`. A failed pass counts too (no retry storm). */
  take(facilityId: string, nowMs: number): boolean {
    const prev = this.last.get(facilityId);
    if (prev !== undefined && nowMs - prev < this.intervalMs) return false;
    this.last.set(facilityId, nowMs);
    return true;
  }
}

export interface CfoGuardOptions {
  /** Default CFO_GUARD_DEADLINE_MS. */
  readonly deadlineMs?: number;
  /** Absent: every facility runs (tests, the loop harness); the worker process passes one. */
  readonly pacer?: GuardPacer;
  /** Block timestamps (default: the process's shared cache). */
  readonly cache?: BlockTimeCache;
  /** Milliseconds (pacer and deadline clock). */
  readonly now?: () => number;
}

export interface CfoGuardReport {
  readonly facilityId: string;
  /** Tightenings sent this run (chain action ids). */
  readonly tightened: readonly string[];
  readonly error?: string;
  readonly status?: CfoGuardStatus;
  /** Proposals the re-check refused (never sent), as `<slot>: <reason>`. */
  readonly refused?: readonly string[];
}

/** The only actions the guard ever sends (core proposeTightenings proposes nothing else). */
const KIND_OF = {
  LOWER_PER_TX_CAP: HOGEE_KINDS.TIGHTEN_LOWER_PER_TX_CAP,
  LOWER_WINDOW_CAP: HOGEE_KINDS.TIGHTEN_LOWER_WINDOW_CAP,
  RAISE_RESERVE_BPS: HOGEE_KINDS.TIGHTEN_RAISE_RESERVE_BPS,
} as const;
type GuardAction = keyof typeof KIND_OF;
const isGuardAction = (a: string): a is GuardAction => Object.hasOwn(KIND_OF, a);

const ONE_BU = 100n;
const RESERVE_MAX_BPS = 1_000n;

/** The "line" a tightening uses up for the day: the reserve or the line. */
export const guardSlot = (t: Pick<CfoTightening, 'action' | 'lineKey'>): string => (t.action === 'RAISE_RESERVE_BPS' ? 'RESERVE' : (t.lineKey ?? 'AGENT'));

export const guardActionId = (day: number, slot: string): string => `${CFO_GUARD_ACTION_PREFIX}${day}:${slot}`;

/**
 * True only when `t` is strictly tighter than the chain state at the snapshot: a cap strictly below the line's current
 * one and at least 1 BU, or a reserve rate strictly above the live rate and at most 1000 bps. Every other action false.
 */
export function strictlyTightens(t: CfoTightening, s: Pick<ChainSnapshot, 'lines' | 'plan'>): boolean {
  if (t.action === 'RAISE_RESERVE_BPS') return t.lineKey === null && t.newValue > BigInt(s.plan.reserveBps) && t.newValue <= RESERVE_MAX_BPS;
  if (t.action !== 'LOWER_PER_TX_CAP' && t.action !== 'LOWER_WINDOW_CAP') return false;
  if (t.lineKey === null) return false;
  const lineId = toBytes32Tag(t.lineKey).toLowerCase();
  const line = s.lines.find((l) => l.lineId.toLowerCase() === lineId);
  if (!line) return false;
  const current = t.action === 'LOWER_PER_TX_CAP' ? line.pocket.perTxCapMinor : line.pocket.windowCapMinor;
  return t.newValue >= ONE_BU && t.newValue < current;
}

/**
 * The re-check on the REAL mirrored context (step 4): null when `t` may be sent, else the reason code the DENY trace
 * carries (labelled for the timeline): the policy's own code (e.g. NotAgent, AgentExpired, LineExpired), or NotOwner
 * for anything that is not strictly tighter (on-chain a raise needs the owner, NotOwner).
 */
export function recheck(t: CfoTightening, ctx: PolicyContext, s: Pick<ChainSnapshot, 'lines' | 'plan'>): string | null {
  if (!isGuardAction(t.action)) return 'NotOwner';
  const d = evaluateTighten(toTightenProposal(t), ctx);
  if (d.verdict !== 'AUTO') return d.reasonCode;
  if (!strictlyTightens(t, s)) return 'NotOwner';
  return null;
}

async function slotUsed(q: Pg, facilityId: string, id: string): Promise<boolean> {
  const found = await rows<{ x: number }>(q, 'select 1 as x from chain_actions where facility_id = $1 and id = $2', [facilityId, id]);
  return found.length > 0;
}

async function facilityCurrency(q: Pg, facilityId: string): Promise<CurrencyCode> {
  const [f] = await rows<{ currency: string }>(q, 'select currency from facilities where facility_id = $1', [facilityId]);
  if (!f) throw new Error(`facility ${facilityId} is not in the database`);
  return f.currency as CurrencyCode;
}

export interface Pass {
  readonly facilityId: string;
  readonly snapshot: ChainSnapshot;
  readonly ctx: PolicyContext;
  readonly day: number;
  readonly planVersion: number;
}

/**
 * The DENY trace of a proposal the re-check refused (never sent), once per line, reason and chain day: the trace id is
 * already per slot and chain day, and a reason it already holds is not appended again on the next pass.
 */
export async function traceRefusal(d: Pick<JobDeps, 'db' | 'log'>, p: Pick<Pass, 'facilityId' | 'planVersion'>, t: CfoTightening, traceId: string, why: string): Promise<string> {
  const slot = guardSlot(t);
  const pool = poolOf(d.db);
  if (await hasTrace(pool, { facilityId: p.facilityId, traceId, reasonCode: why })) {
    d.log.info('cfo_guard_refused_again', { facilityId: p.facilityId, slot, why });
    return `${slot}: ${why}`;
  }
  d.log.warn('cfo_guard_refused', { facilityId: p.facilityId, slot, action: t.action, newValue: t.newValue.toString(), why });
  await appendTrace(pool, {
    facilityId: p.facilityId,
    traceId,
    actor: 'policy',
    kind: 'POLICY_VERDICT',
    verdict: 'DENY',
    reasonCode: why,
    summary: `CFO tightening of ${slot} not sent (${why}): ${t.reason}`,
    refs: { planVersion: p.planVersion },
  });
  return `${slot}: ${why}`;
}

/** Past the deadline: logged every time, traced once per facility per (wall-clock) day. Nothing was sent after it. */
async function traceDeadline(d: JobDeps, facilityId: string, deadline: Deadline, nowMs: number): Promise<void> {
  d.log.warn('cfo_guard_deadline', { facilityId, budgetMs: deadline.budgetMs });
  const traceId = `trace:cfo-guard:deadline:${new Date(Math.floor(nowMs / DAY_MS) * DAY_MS).toISOString().slice(0, 10)}`;
  const pool = poolOf(d.db);
  if (await traceExists(pool, { facilityId, traceId })) return;
  await appendTrace(pool, {
    facilityId,
    traceId,
    actor: 'worker',
    kind: 'ALERT',
    summary: `The CFO check stopped after ${deadline.budgetMs / 1000} s so other jobs could run; it sent nothing more and tries again on its next run`,
    refs: {},
  });
}

/** The ALERT of a send that failed: past the deadline it says whether anything was signed (recovery broadcasts it). */
function sendFailure(error: unknown, slot: string, unsigned: boolean, budgetMs: number): string {
  if (!isDeadlineError(error)) return `Treasury.tighten for ${slot} not sent: ${shortErrorReason(error)}`;
  const what = unsigned ? 'nothing was signed' : 'the signed transaction stays stored and recovery broadcasts it';
  return `Treasury.tighten for ${slot} stopped at the CFO check's ${budgetMs / 1000} s deadline so other jobs could run: ${what}`;
}

/**
 * Sends one re-checked tightening with the agent key; returns its action id. Its RPC calls count against `deadline`.
 * A failed send keeps the slot used.
 */
async function send(d: JobDeps, p: Pass, t: CfoTightening & { action: GuardAction }, traceId: string, deadline: Deadline): Promise<string> {
  const pool = poolOf(d.db);
  const slot = guardSlot(t);
  const id = guardActionId(p.day, slot);
  const decisionId = (d.newDecisionId ?? (() => uuidv7()))();
  await appendTrace(pool, {
    facilityId: p.facilityId,
    traceId,
    actor: 'policy',
    kind: 'POLICY_VERDICT',
    verdict: 'AUTO',
    reasonCode: 'TIGHTEN_OK',
    // The prefilled change request that raises the cap back (re-check LOW 3): founder, officer and timelock decide.
    summary: `CFO: ${t.reason}${t.raiseHref ? ` Raise it back: ${t.raiseHref}` : ''}`,
    refs: { planVersion: p.planVersion, decisionId },
  });
  const request: CfoGuardRequest = {
    source: 'cfo-guard',
    action: t.action,
    lineKey: t.lineKey,
    newValue: t.newValue.toString(),
    reason: t.reason,
    decisionId,
    chainTime: p.snapshot.timestamp.toString(),
    traceId,
  };
  const call = buildTighten({ kind: KIND_OF[t.action], target: t.lineKey === null ? ZERO_BYTES32 : toBytes32Tag(t.lineKey), newValue: t.newValue, decisionId: decisionIdToBytes32(decisionId) });
  const ctx = { db: d.db, client: withinDeadline(d.client, deadline), deployment: d.deployment, chainId: d.deployment.chainId, capWei: d.config.maxFeeWei };
  try {
    const { stored, sent } = await sendAction(ctx, { facilityId: p.facilityId, id, kind: 'Treasury.tighten', request: toTxRequest(call, d.deployment.contracts), requestJson: request }, d.signers.agent);
    await appendTrace(pool, {
      facilityId: p.facilityId,
      traceId,
      actor: 'executor',
      kind: 'TX',
      summary: `Treasury.tighten (${t.action}${t.lineKey ? ` ${t.lineKey}` : ''} to ${t.newValue}) signed by the agent key at nonce ${stored.nonce} and broadcast (${sent.status})`,
      refs: { decisionId, txHash: stored.txHash },
    });
    return id;
  } catch (error: unknown) {
    // Never signed: mark the row so the relay never picks it up (it has no relay builder), and keep the slot used today.
    const reason = isDeadlineError(error) ? `the ${deadline.budgetMs} ms CFO check deadline passed` : shortErrorReason(error);
    const marked = await pool.query(`update chain_actions set revert_reason = $3 where facility_id = $1 and id = $2 and raw_signed_tx is null and revert_reason is null`, [p.facilityId, id, `REFUSED: ${reason}`.slice(0, 200)]);
    await appendTrace(pool, { facilityId: p.facilityId, traceId, actor: 'executor', kind: 'ALERT', summary: sendFailure(error, slot, (marked.rowCount ?? 0) > 0, deadline.budgetMs), refs: { decisionId } });
    throw error;
  }
}

interface Run {
  readonly deadline: Deadline;
  readonly cache?: BlockTimeCache;
}

type Prepared = { readonly report: CfoGuardReport } | { readonly pass: Pass; readonly inputs: CfoInputs };

/** Steps 1–3 (reads only): the snapshot, the real context and the inputs; or the report that ends the pass early. */
async function prepare(d: JobDeps, facilityId: string, run: Run): Promise<Prepared> {
  const pool = poolOf(d.db);
  if (await activeHalt(pool)) return { report: { facilityId, tightened: [], status: 'halted' } };
  try {
    capFees(await d.client.estimateFeesPerGas(), d.config.maxFeeWei);
  } catch (error: unknown) {
    if (error instanceof FeeCapExceededError) return { report: { facilityId, tightened: [], status: 'fee_skip' } };
    throw error;
  }
  run.deadline.check();
  const block = await d.client.getBlockNumber({ cacheTime: 0 });
  const [snapshot, committed, currency] = await Promise.all([readChainSnapshot(d.client, d.deployment, block), loadCommittedPlan(pool, facilityId), facilityCurrency(pool, facilityId)]);
  const roles = { agent: d.signers.agent.address, lender: d.signers.lender.address, oracle: d.signers.oracle.address };
  let ctx: PolicyContext;
  try {
    // evaluateTighten reads the agent, pause, line and reserve state only: no intents or invoices are needed.
    ctx = buildPolicyContext({ snapshot, committed, roles, mined: { usedIntents: new Set(), paidInvoices: new Set() } });
  } catch (error: unknown) {
    if (!(error instanceof ContextMismatchError)) throw error;
    const report: CfoGuardReport = { facilityId, tightened: [], status: error.code === 'NO_COMMITTED_PLAN' ? 'no_plan' : 'mismatch', ...(error.code === 'NO_COMMITTED_PLAN' ? {} : { error: error.code }) };
    return { report };
  }
  const plan = committed as NonNullable<typeof committed>;
  const inputs = await readGuardInputs(d, pool, { facilityId, currency, taxPayeeId: taxPayeeOf(currency), snapshot, committed: plan }, { ...(run.cache ? { cache: run.cache } : {}), check: () => run.deadline.check() });
  return { pass: { facilityId, snapshot, ctx, day: chainDay(snapshot.timestamp), planVersion: plan.version }, inputs };
}

/**
 * Step 4–5 for one facility's proposals: re-check each and send it, never past `deadline`. A send stopped by the
 * deadline ends the pass (status `deadline`): what was sent stays sent, nothing more goes out.
 */
export async function sendProposals(d: JobDeps, p: Pass, proposals: readonly CfoTightening[], deadline: Deadline): Promise<CfoGuardReport> {
  const pool = poolOf(d.db);
  const tightened: string[] = [];
  const refused: string[] = [];
  const report = (status: CfoGuardStatus): CfoGuardReport => ({ facilityId: p.facilityId, tightened, status, ...(refused.length > 0 ? { refused } : {}) });
  for (const t of proposals) {
    if (deadline.expired()) return report('deadline');
    const slot = guardSlot(t);
    if (await slotUsed(pool, p.facilityId, guardActionId(p.day, slot))) continue;
    const traceId = `trace:cfo-guard:${p.day}:${slot}`;
    const why = recheck(t, p.ctx, p.snapshot);
    if (why !== null || !isGuardAction(t.action)) {
      refused.push(await traceRefusal(d, p, t, traceId, why ?? 'NotOwner'));
      continue;
    }
    try {
      tightened.push(await send(d, p, { ...t, action: t.action }, traceId, deadline));
    } catch (error: unknown) {
      if (isDeadlineError(error)) return report('deadline');
      throw error;
    }
  }
  return report('ok');
}

async function guardFacility(d: JobDeps, facilityId: string, run: Run): Promise<CfoGuardReport> {
  run.deadline.check();
  // The reads race the deadline: a slow RPC is left behind (reads only) and the job lock is released.
  const prepared = await run.deadline.race(prepare(d, facilityId, run));
  if ('report' in prepared) return prepared.report;
  return sendProposals(d, prepared.pass, proposeTightenings(prepared.inputs), run.deadline);
}

/**
 * One cfo-guard run over this deployment's facilities, under one deadline (`opts`). Never throws: a facility's failure
 * is its report's `error`; a facility past the deadline reports `deadline`, one the pacer holds back `paced`.
 */
export async function runCfoGuard(d0: JobDeps, facilityIds: readonly string[], opts: CfoGuardOptions = {}): Promise<CfoGuardReport[]> {
  const d: JobDeps = { ...d0, log: d0.log.child({ job: CFO_GUARD_JOB }) };
  const now = opts.now ?? Date.now;
  const run: Run = { deadline: Deadline.after(opts.deadlineMs ?? CFO_GUARD_DEADLINE_MS, now), ...(opts.cache ? { cache: opts.cache } : {}) };
  const reports: CfoGuardReport[] = [];
  for (const facilityId of facilityIds) {
    if (opts.pacer && !opts.pacer.take(facilityId, now())) {
      reports.push({ facilityId, tightened: [], status: 'paced' });
      continue;
    }
    const report = await guardFacility(d, facilityId, run).catch(async (error: unknown): Promise<CfoGuardReport> => {
      if (error instanceof DeadlineError) return { facilityId, tightened: [], status: 'deadline' };
      d.log.error('cfo_guard_failed', { facilityId, error });
      return { facilityId, tightened: [], status: 'error', error: shortErrorReason(error) };
    });
    if (report.status === 'deadline') {
      await traceDeadline(d, facilityId, run.deadline, now()).catch((e: unknown) => d.log.error('cfo_guard_trace_failed', { facilityId, error: e }));
    }
    d.log.info('cfo_guard_done', { ...report });
    reports.push(report);
  }
  return reports;
}
