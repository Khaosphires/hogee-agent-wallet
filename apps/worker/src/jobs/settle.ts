/**
 * settle-spend (§9.1). For each mined value-moving payment (payments FINALIZED / SETTLEMENT_REQUESTED) whose on-chain
 * effect opened a settlement: SPEND (`Spent`), OWNER_SPEND (`OwnerSpent`), RELEASE_MILESTONE (`MilestoneReleased`), a
 * FUND_MILESTONE that auto-released its milestone in the same call (`MilestoneReleased`), and WITHDRAW_RESERVE
 * (`ReserveWithdrawn`, adopted from the chain by settle-adopt.ts, as is a founder-signed OWNER_SPEND or RELEASE_MILESTONE
 * another account executed first, audit run-4). Bind the row to the chain (settle-binding.ts), read the
 * rail's own history for the settlement's attempt keys, then pay out, poll, have the ORACLE
 * confirmSettlement(settlementId, payoutRefHash), or failSettlement(settlementId, code) once the RAIL says the failure is
 * final. The row closes from the chain's settlementState read at `finalized`.
 *
 * Security audit run-3: the DB row is an input, not an authority. The paid amount and destination are the verified
 * on-chain outflow and the account whose hash the chain binds; the settlement id and the attempt index (and so the
 * idempotency key) come from the chain and the rail's history for keys derived from that settlement id; the DB payout
 * columns are a mirror that must agree. Any mismatch blocks: a halt, an ALERT trace, and no payout or attestation.
 *
 * Idempotent per payment: the attempt is marked REQUESTED BEFORE the rail call and the rail dedupes on the key (same
 * key, same body), so a crash re-requests the same payout; the oracle calls use deterministic chain_actions ids.
 * While halted nothing is paid out or signed; only rows the chain already closed are closed.
 *
 * Audit run-4: a CONFIRMED settlement closes SETTLED only over a payout the rail reports SUCCEEDED (settle-decide.ts),
 * so the rail history is read for every closed settlement whose keys the chain verified, even when its payee binding
 * no longer reads OK (a re-bind after the payout), and the payoutRefHash comes from the SettlementConfirmed in the
 * worker's own settle-confirm tx (its canonical receipt: no log-range scan, which capped RPCs refuse). The settlement
 * state and that receipt are read against ONE finalized block. A paid row the worker's own confirm did not attest
 * closes with one ALERT; a SETTLEMENT_CONTRADICTION halts once per payment (the row then stays blocked, without
 * halting or alerting again after an operator resumes).
 *
 * Payout routing (SG-DECISIONS, rail/route.ts): every rail call for a settlement goes to the rail its payee's channel
 * routes to (SG_PAYNOW: MockRail, labelled "simulated PayNow payout"; MY_DUITNOW: Xendit test mode when configured).
 * An unknown channel or a currency the channel does not carry is refused before any rail call: nothing is paid or
 * attested, one ALERT is traced, and the row is reported as an error every pass.
 */
import { buildConfirmSettlement, buildFailSettlement, iTreasuryAbi, reasonCodeToBytes32, shortErrorReason, toTxRequest } from '@hogee/chain';
import { keccak256Utf8 } from '@hogee/core';
import { parseEventLogs, type Hex } from 'viem';
import { sendAction } from '../chain/actions';
import { PayoutConflictError, parsePayoutAccountRef, payoutIdempotencyKey, type PayoutRail, type PayoutResult } from '../rail/rail';
import { PayoutRouteError, payoutRouterOf, type PayoutRouter, type RoutedRail } from '../rail/route';
import { activeHalt, haltEverRecorded, raiseHalt } from '../store/halt';
import { writeHeartbeat } from '../store/heartbeat';
import { poolOf, rows, type Pg } from '../store/pg';
import { appendTrace, hasTrace } from '../store/trace';
import type { JobDeps } from './deps';
import { loadCommittedPlan } from './facility';
import { traceIdOf } from './pacing';
import { adoptReserveWithdrawals } from './settle-adopt';
import { adoptFounderExecutions } from './settle-adopt-founder';
import { rowSettlementId, verifySettlementBinding } from './settle-binding';
import { finalizedHead, finalizedLogsOf, same, type SettlementKeys, type SettlementRow, type VerifiedSettlement } from './settle-chain';
import { decideSettlement, readRailHistory, type ActionState, type BlockReason, type RailAttempt, type SettleFacts, type SettleStep } from './settle-decide';

export const SETTLE_JOB = 'settle-spend';
const CHAIN_STATE = ['NONE', 'CONFIRMED', 'FAILED'] as const;

interface SettleRow extends SettlementRow {
  id: string;
  state: 'FINALIZED' | 'SETTLEMENT_REQUESTED';
  payout_status: SettleFacts['payoutStatus'];
  payout_attempt: number;
  currency: string;
}

export interface SettleOutcome {
  readonly paymentId: string;
  readonly step: SettleStep['kind'] | 'halted' | 'error';
  readonly detail?: string;
}

export interface SettleReport {
  readonly facilityId: string;
  readonly payments: readonly SettleOutcome[];
}

const confirmId = (paymentId: string) => `settle-confirm:${paymentId}`;
const failId = (paymentId: string) => `settle-fail:${paymentId}`;

async function loadRows(q: Pg, facilityId: string): Promise<SettleRow[]> {
  return rows<SettleRow>(
    q,
    `select p.id, p.kind, p.intent_id, p.line_id, p.payee_id, p.order_id, p.milestone_idx, p.amount_minor::text as amount_minor, p.invoice_hash, p.plan_version,
            p.decision_id::text as decision_id, p.rationale_hash, p.tx_hash, p.state, p.payout_status, p.payout_attempt,
            pa.xendit_account_ref, pa.payout_account_hash, f.currency
       from payments p
       join payees pa on pa.facility_id = p.facility_id and pa.id = p.payee_id
       join facilities f on f.facility_id = p.facility_id
      where p.facility_id = $1 and p.kind in ('SPEND', 'OWNER_SPEND', 'RELEASE_MILESTONE', 'FUND_MILESTONE', 'WITHDRAW_RESERVE')
        and p.state in ('FINALIZED', 'SETTLEMENT_REQUESTED') and p.tx_hash is not null
      order by p.created_at, p.id`,
    [facilityId],
  );
}

async function actionState(q: Pg, facilityId: string, id: string): Promise<(ActionState & { txHash: Hex | null }) | null> {
  const [a] = await rows<{ state: string; signed: boolean; tx_hash: Hex | null }>(
    q,
    'select state, raw_signed_tx is not null as signed, tx_hash from chain_actions where facility_id = $1 and id = $2',
    [facilityId, id],
  );
  return a ? { state: a.state, signed: a.signed, txHash: a.tx_hash } : null;
}

const keyOf = (s: SettlementKeys, attempt: number) => payoutIdempotencyKey({ settlementId: s.settlementId, invoiceHash: s.invoiceHash, attempt });
const refOf = (r: SettleRow, attempt: number) => `${r.tx_hash}:${attempt}`;

const routerOf = (d: JobDeps): PayoutRouter => d.rail as PayoutRouter;

/**
 * The rail that pays this settlement: by the verified destination's channel when the binding holds, else (a closed
 * settlement's history) by the payee's stored account, which must still parse. Throws PayoutRouteError.
 */
function routeOf(d: JobDeps, r: SettleRow, spend: VerifiedSettlement | null): RoutedRail {
  const account = spend?.destination ?? parsePayoutAccountRef(r.xendit_account_ref);
  if (!account) throw new PayoutRouteError('the payee has no readable payout account to route: nothing is paid', 'NO_ACCOUNT');
  return routerOf(d).route({ channel: account.channel, currency: r.currency });
}

/** Attempts 1..n as the rail knows them, up to the first key it has never seen (settle-decide.ts readRailHistory). */
async function railHistory(rail: PayoutRail, r: SettleRow, s: SettlementKeys): Promise<RailAttempt[]> {
  return readRailHistory(async (attempt) => {
    const found = await rail.findPayout({ idempotencyKey: keyOf(s, attempt), referenceId: refOf(r, attempt) });
    return found ? { payoutId: found.payoutId, status: found.status, ...(found.failureCode ? { failureCode: found.failureCode } : {}) } : null;
  });
}

interface Pass {
  readonly facts: SettleFacts;
  readonly spend: VerifiedSettlement | null;
  /** The routed rail; null when there are no verified keys (nothing to look up or pay). */
  readonly routed: RoutedRail | null;
  readonly bindingDetail?: string;
}

/** A row nothing has been paid or attested for yet (the only kind of row that may turn out not to be a settlement). */
const fresh = (r: SettleRow): boolean => r.state === 'FINALIZED' && r.payout_status === 'NONE' && Number(r.payout_attempt) === 0;

/**
 * payoutRefHash of the SettlementConfirmed for `settlementId` in the worker's own settle-confirm tx (its canonical,
 * successful receipt at or below `finalized`), or null when that tx attested nothing (none sent, or it reverted behind
 * another confirm). A settlement is attested once ever (Treasury._openSettlement), so a CONFIRMED settlement this tx
 * did not confirm was attested by someone else. The row's tx hash is only a pointer: the receipt is what is trusted.
 */
async function confirmedPayoutRef(d: JobDeps, settlementId: Hex, confirmTx: Hex | null, finalized: bigint): Promise<Hex | null> {
  if (!confirmTx) return null;
  const treasury = d.deployment.contracts.Treasury.address;
  const logs = await finalizedLogsOf(d.client, confirmTx, finalized, treasury);
  const ev = logs ? parseEventLogs({ abi: iTreasuryAbi, logs, eventName: 'SettlementConfirmed' }).find((l) => same(l.args.settlementId, settlementId)) : undefined;
  return ev?.args.payoutRefHash ?? null;
}

/** The pass's facts, or null when the row is not a settlement (a fresh funding that released no milestone). */
async function gather(d: JobDeps, facilityId: string, planId: Hex | null, r: SettleRow): Promise<Pass | null> {
  const treasury = d.deployment.contracts.Treasury.address;
  const settlementId = rowSettlementId(r);
  // One finalized block for the settlement state and the confirm receipt (they must describe the same chain).
  const finalized = (await finalizedHead(d.client)).number;
  const [state, confirmAction, failAction, bound] = await Promise.all([
    settlementId === null ? 0 : d.client.readContract({ address: treasury, abi: iTreasuryAbi, functionName: 'settlementState', args: [settlementId], blockNumber: finalized }),
    actionState(poolOf(d.db), facilityId, confirmId(r.id)),
    actionState(poolOf(d.db), facilityId, failId(r.id)),
    verifySettlementBinding(d.client, d.deployment, planId, r),
  ]);
  if (bound.verdict === 'NONE' && fresh(r)) return null;
  // A row already in settlement that no longer reads as one was changed underneath: refuse it like any mismatch.
  const binding = bound.verdict === 'NONE' ? { verdict: 'SPEND_MISMATCH' as const, detail: bound.detail } : bound;
  const spend = binding.verdict === 'OK' ? binding.spend : null;
  const chainState = CHAIN_STATE[Number(state)] ?? 'NONE';
  // History keys need the on-chain settlement id and invoice; without a verified settlement there is nothing to look up.
  // A closed settlement keeps the keys its binding verified when only the destination fails (a re-bind since the payout):
  // its history decides whether the close is the worker's own (settle-decide.ts).
  const keys: SettlementKeys | null = spend ?? (chainState !== 'NONE' && 'keys' in binding ? (binding.keys ?? null) : null);
  const routed = keys ? routeOf(d, r, spend) : null;
  const [history, confirmedRef] = await Promise.all([
    keys && routed ? railHistory(routed.rail, r, keys) : [],
    chainState === 'CONFIRMED' && keys ? confirmedPayoutRef(d, keys.settlementId, confirmAction?.txHash ?? null, finalized) : null,
  ]);
  return {
    spend,
    routed,
    ...(binding.verdict === 'OK' ? {} : { bindingDetail: binding.detail }),
    facts: {
      state: r.state,
      payoutStatus: r.payout_status,
      payoutAttempt: Number(r.payout_attempt),
      chainState,
      confirmAction,
      failAction,
      binding: binding.verdict,
      history,
      confirmedPayoutRef: confirmedRef,
      maxAttempts: d.config.payoutMaxAttempts,
    },
  };
}

const via = (routed: RoutedRail): string => `${routed.rail.name}${routed.label ? ` (${routed.label})` : ''}`;

async function recordPayout(d: JobDeps, facilityId: string, r: SettleRow, routed: RoutedRail, attempt: number, p: PayoutResult, extra = ''): Promise<void> {
  const status = p.status === 'PENDING' ? 'REQUESTED' : p.status;
  await poolOf(d.db).query(
    `update payments set payout_id = $3, payout_status = $4, payout_failure_code = $5, payout_attempt = $6
      where facility_id = $1 and id = $2 and state = 'SETTLEMENT_REQUESTED'`,
    [facilityId, r.id, p.payoutId, status, p.failureCode ?? null, attempt],
  );
  await appendTrace(poolOf(d.db), {
    facilityId,
    traceId: traceIdOf(r.id),
    actor: 'oracle',
    kind: 'PAYOUT',
    // The raw rail code goes in the summary; reason codes must fit bytes32.
    reasonCode: p.failureCode && /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(p.failureCode) ? p.failureCode : undefined,
    summary: `payout attempt ${attempt} via ${via(routed)}: ${p.status}${p.failureCode ? ` (${p.failureCode})` : ''}${extra}`,
    refs: { paymentId: r.id, payoutId: p.payoutId, txHash: r.tx_hash },
  }).catch((error: unknown) => d.log.warn('trace_append_failed', { paymentId: r.id, error }));
}

async function requestPayout(d: JobDeps, facilityId: string, r: SettleRow, s: VerifiedSettlement, routed: RoutedRail, attempt: number): Promise<string> {
  // Durable intent first: a crash after the rail call re-requests this same attempt (same key, same body → same payout).
  const moved = await poolOf(d.db).query(
    `update payments set state = 'SETTLEMENT_REQUESTED', settlement_id = $4, payout_status = 'REQUESTED', payout_attempt = $3,
            payout_id = null, payout_failure_code = null
      where facility_id = $1 and id = $2 and state in ('FINALIZED', 'SETTLEMENT_REQUESTED') and payout_attempt in ($3, $3 - 1)`,
    [facilityId, r.id, attempt, s.settlementId.toLowerCase()],
  );
  if (moved.rowCount !== 1) return 'row moved on concurrently';
  const result = await routed.rail.requestPayout({
    idempotencyKey: keyOf(s, attempt),
    referenceId: refOf(r, attempt),
    amountMinor: s.amountMinor,
    currency: r.currency,
    destination: s.destination,
  });
  await recordPayout(d, facilityId, r, routed, attempt, result);
  return `${result.status}${result.failureCode ? ` ${result.failureCode}` : ''}`;
}

async function block(d: JobDeps, facilityId: string, r: SettleRow, reason: BlockReason | 'PAYOUT_CONFLICT', detail: string): Promise<string> {
  // A contradiction is a fact about the chain that no retry changes: halt (and alert) once per payment, so after an
  // operator resumes the row stays blocked without halting the worker again every pass.
  if (reason === 'SETTLEMENT_CONTRADICTION' && (await haltEverRecorded(poolOf(d.db), reason, { facilityId, paymentId: r.id }))) return reason;
  await raiseHalt(poolOf(d.db), d.log, reason, { facilityId, paymentId: r.id, payeeId: r.payee_id, detail });
  await appendTrace(poolOf(d.db), {
    facilityId,
    traceId: traceIdOf(r.id),
    actor: 'oracle',
    kind: 'ALERT',
    reasonCode: reason,
    summary: `settlement blocked (${reason}): ${detail}; nothing paid or attested`,
    refs: { paymentId: r.id },
  }).catch((error: unknown) => d.log.warn('trace_append_failed', { paymentId: r.id, error }));
  return reason;
}

/** What the chain and the rail disagree on (the halt's detail), with the binding problem if there is one. */
function contradiction(pass: Pass): string {
  const what =
    pass.facts.chainState === 'FAILED'
      ? 'the chain failed the settlement, but its payout succeeded'
      : 'the chain confirms the settlement, but the rail reports no SUCCEEDED payout for it: an oracle attestation the worker did not make';
  return pass.bindingDetail ? `${what}; binding: ${pass.bindingDetail}` : what;
}

const CONFIRMED_ELSEWHERE = 'SETTLEMENT_CONFIRMED_ELSEWHERE';

/** The payout was made but the worker's own confirm is not the attestation: one ALERT on the payment's trace. */
async function alertConfirmedElsewhere(d: JobDeps, facilityId: string, r: SettleRow): Promise<void> {
  const pool = poolOf(d.db);
  const traceId = traceIdOf(r.id);
  if (await hasTrace(pool, { facilityId, traceId, reasonCode: CONFIRMED_ELSEWHERE })) return;
  d.log.warn('settlement_confirmed_elsewhere', { facilityId, paymentId: r.id });
  await appendTrace(pool, {
    facilityId,
    traceId,
    actor: 'oracle',
    kind: 'ALERT',
    reasonCode: CONFIRMED_ELSEWHERE,
    summary: 'the payout succeeded, but the settlement was confirmed on-chain by a tx that is not the worker\'s own confirm (the oracle key was used outside the worker); closed SETTLED',
    refs: { paymentId: r.id },
  }).catch((error: unknown) => d.log.warn('trace_append_failed', { paymentId: r.id, error }));
}

const ROUTE_REFUSED = 'PAYOUT_ROUTE_REFUSED';

/** No rail serves this payee (rail/route.ts): one ALERT on the payment's trace; the row stays as it is. */
async function alertRouteRefused(d: JobDeps, facilityId: string, r: SettleRow, error: PayoutRouteError): Promise<void> {
  d.log.error('payout_route_refused', { facilityId, paymentId: r.id, code: error.code, error });
  const pool = poolOf(d.db);
  const traceId = traceIdOf(r.id);
  if (await hasTrace(pool, { facilityId, traceId, reasonCode: ROUTE_REFUSED })) return;
  await appendTrace(pool, {
    facilityId,
    traceId,
    actor: 'oracle',
    kind: 'ALERT',
    reasonCode: ROUTE_REFUSED,
    summary: `payout refused before any rail call (${error.code}): ${error.message}; nothing paid or attested`,
    refs: { paymentId: r.id },
  }).catch((e: unknown) => d.log.warn('trace_append_failed', { paymentId: r.id, error: e }));
}

async function execute(d: JobDeps, facilityId: string, r: SettleRow, step: SettleStep, pass: Pass): Promise<string | undefined> {
  const ctx = { db: d.db, client: d.client, deployment: d.deployment, chainId: d.deployment.chainId, capWei: d.config.maxFeeWei };
  const history = pass.facts.history;
  const latest = history[history.length - 1];
  switch (step.kind) {
    case 'close': {
      await poolOf(d.db).query(`update payments set state = $3 where facility_id = $1 and id = $2 and state in ('FINALIZED', 'SETTLEMENT_REQUESTED')`, [facilityId, r.id, step.to]);
      if (step.alert) await alertConfirmedElsewhere(d, facilityId, r);
      return step.to;
    }
    case 'request_payout':
      return requestPayout(d, facilityId, r, pass.spend as VerifiedSettlement, pass.routed as RoutedRail, step.attempt);
    case 'poll_payout': {
      if (!latest) return 'nothing to poll';
      const routed = pass.routed as RoutedRail;
      const result = await routed.rail.getPayout(latest.payoutId);
      await recordPayout(d, facilityId, r, routed, history.length, result);
      return result.status;
    }
    case 'confirm': {
      // decideSettlement only confirms or fails a row whose binding is OK: the settlement id is the chain's.
      const settlementId = (pass.spend as VerifiedSettlement).settlementId;
      const payoutId = (latest as RailAttempt).payoutId;
      const call = buildConfirmSettlement({ settlementId, payoutRefHash: keccak256Utf8(payoutId) as Hex });
      const { stored } = await sendAction(ctx, { facilityId, id: confirmId(r.id), kind: call.kind, refId: r.id, request: toTxRequest(call, d.deployment.contracts), requestJson: { settlementId, payoutId } }, d.signers.oracle);
      return stored.txHash;
    }
    case 'fail': {
      const settlementId = (pass.spend as VerifiedSettlement).settlementId;
      const call = buildFailSettlement({ settlementId, code: reasonCodeToBytes32(step.code, 'code') });
      const requestJson = { settlementId, code: step.code, rawCode: step.rawCode };
      const { stored } = await sendAction(ctx, { facilityId, id: failId(r.id), kind: call.kind, refId: r.id, request: toTxRequest(call, d.deployment.contracts), requestJson }, d.signers.oracle);
      await appendTrace(poolOf(d.db), {
        facilityId,
        traceId: traceIdOf(r.id),
        actor: 'oracle',
        kind: 'PAYOUT',
        reasonCode: step.code,
        summary: `failSettlement ${step.code} (rail code: ${step.rawCode})`,
        refs: { paymentId: r.id, txHash: stored.txHash },
      }).catch((error: unknown) => d.log.warn('trace_append_failed', { paymentId: r.id, error }));
      return stored.txHash;
    }
    case 'blocked':
      return block(d, facilityId, r, step.reason, step.reason === 'SETTLEMENT_CONTRADICTION' ? contradiction(pass) : (pass.bindingDetail ?? step.reason));
    case 'wait':
      return step.reason;
  }
}

async function settleFacility(d: JobDeps, facilityId: string): Promise<SettleReport> {
  const pool = poolOf(d.db);
  const out: SettleOutcome[] = [];
  const planId = ((await loadCommittedPlan(pool, facilityId))?.planId ?? null) as Hex | null;
  // Executed reserve withdrawals and founder-signed settlements someone else executed become rows first (DB only;
  // nothing is paid or signed here).
  out.push(...(await adoptReserveWithdrawals(d, facilityId)));
  out.push(...(await adoptFounderExecutions(d, facilityId)));
  for (const r of await loadRows(pool, facilityId)) {
    try {
      const pass = await gather(d, facilityId, planId, r);
      if (!pass) continue;
      const step = decideSettlement(pass.facts);
      if (step.kind !== 'close' && step.kind !== 'wait' && step.kind !== 'blocked' && (await activeHalt(pool))) {
        out.push({ paymentId: r.id, step: 'halted' });
        continue;
      }
      const detail = await execute(d, facilityId, r, step, pass);
      out.push({ paymentId: r.id, step: step.kind, ...(detail ? { detail } : {}) });
    } catch (error: unknown) {
      if (error instanceof PayoutConflictError) {
        out.push({ paymentId: r.id, step: 'blocked', detail: await block(d, facilityId, r, 'PAYOUT_CONFLICT', 'the rail refused a reused key with another body') });
        continue;
      }
      if (error instanceof PayoutRouteError) {
        await alertRouteRefused(d, facilityId, r, error);
        out.push({ paymentId: r.id, step: 'error', detail: `${ROUTE_REFUSED} ${error.code}` });
        continue;
      }
      d.log.error('settle_failed', { facilityId, paymentId: r.id, error });
      out.push({ paymentId: r.id, step: 'error', detail: shortErrorReason(error) });
    }
  }
  return { facilityId, payments: out };
}

/** One settle-spend sweep over this deployment's facilities. Never throws. */
export async function runSettle(d0: JobDeps, facilityIds: readonly string[]): Promise<SettleReport[]> {
  const d: JobDeps = { ...d0, log: d0.log.child({ job: SETTLE_JOB }), rail: payoutRouterOf(d0.rail, poolOf(d0.db)) };
  const reports: SettleReport[] = [];
  for (const facilityId of facilityIds) {
    const report = await settleFacility(d, facilityId).catch((error: unknown): SettleReport => {
      d.log.error('settle_facility_failed', { facilityId, error });
      return { facilityId, payments: [{ paymentId: '-', step: 'error', detail: shortErrorReason(error) }] };
    });
    reports.push(report);
    if (report.payments.length > 0) d.log.info('settle_done', { facilityId, payments: report.payments });
    await writeHeartbeat(poolOf(d.db), { job: SETTLE_JOB, scope: facilityId, status: report.payments.some((p) => p.step === 'error') ? 'error' : 'ok', detail: { payments: report.payments } }).catch(
      (error: unknown) => d.log.error('heartbeat_failed', { error }),
    );
  }
  return reports;
}
