/**
 * Executes a pacing PROPOSE (§12.3: PROPOSED → POLICY_OK → SIGNED → BROADCAST): insert the payment row with its
 * decision and rationale (one DB transaction, with the PROPOSAL trace), then @hogee/chain signAndStore (nonce + raw tx
 * in one DB transaction, BEFORE broadcast), then broadcast the stored bytes. Each step is durable before the next,
 * so a crash anywhere leaves a row the next tick resumes (unsigned) or recovery re-sends (signed): never a second
 * payment. Exactly the proposal planPacingSlot evaluated is sent: amount, payee, slot and intentId come from it.
 */
import {
  buildSpend,
  decisionIdToBytes32,
  sendStored,
  shortIdToBytes32,
  signAndStore,
  toBytes32Tag,
  toTxRequest,
  type BroadcastResult,
} from '@hogee/chain';
import { hashObject, type LineKey, type PacingSlotPlan } from '@hogee/core';
import { insertRationale } from '@hogee/db';
import type { Hex } from 'viem';
import type { CommittedPlan } from '../chain/context';
import { assertNotHalted } from '../store/halt';
import { assertNoPendingPause } from '../store/pause-pending';
import { inTransaction, poolOf } from '../store/pg';
import { appendTrace } from '../store/trace';
import { uuidv7 } from '../runtime/ids';
import type { JobDeps } from './deps';
import type { PaymentRow } from './inflight';

export type Propose = Extract<PacingSlotPlan, { action: 'PROPOSE' }>;

export const traceIdOf = (paymentId: string): string => `trace:${paymentId}`;

interface ProposalArgs {
  readonly facilityId: string;
  readonly paymentId: string;
  readonly lineKey: LineKey;
  readonly plan: Propose;
  readonly day: number;
}

/** A fresh decision for `plan`: decisionId (UUIDv7) and the rationale commitment Treasury.spend records. */
function decision(d: JobDeps, a: ProposalArgs): { decisionId: string; rationaleHash: Hex; rationale: Record<string, unknown>; summary: string } {
  const p = a.plan.proposal;
  const rationale = {
    kind: 'PACING_SLOT',
    lineKey: a.lineKey,
    pacingSlot: a.plan.pacingSlot,
    amountMinor: a.plan.amountMinor,
    payeeId: a.plan.payeeId,
    planVersion: p.planVersion,
    chainDay: a.day,
    verdict: 'AUTO',
    reasonCode: 'WITHIN_PLAN',
  };
  return {
    decisionId: (d.newDecisionId ?? uuidv7)(),
    rationaleHash: hashObject(rationale) as Hex,
    rationale,
    summary: `${a.lineKey} pacing slot ${a.plan.pacingSlot}: ${a.plan.amountMinor} minor to ${a.plan.payeeId} (plan v${p.planVersion}, chain day ${a.day})`,
  };
}

function proposalTrace(a: ProposalArgs, x: { decisionId: string; summary: string }) {
  const p = a.plan.proposal;
  return {
    facilityId: a.facilityId,
    traceId: traceIdOf(a.paymentId),
    actor: 'policy' as const,
    kind: 'PROPOSAL' as const,
    verdict: 'AUTO' as const,
    reasonCode: 'WITHIN_PLAN',
    summary: x.summary,
    refs: { planVersion: p.planVersion, paymentId: a.paymentId, invoiceHash: p.invoiceHash, decisionId: x.decisionId },
  };
}

/** Inserts the POLICY_OK SPEND row for `plan` (and its PROPOSAL trace) in one DB transaction. */
export async function insertProposal(d: JobDeps, a: ProposalArgs): Promise<PaymentRow> {
  const p = a.plan.proposal;
  const x = decision(d, a);
  await inTransaction(poolOf(d.db), async (c) => {
    await c.query(
      `insert into payments (id, facility_id, kind, intent_id, line_key, line_id, payee_id, amount_minor, invoice_hash, plan_version, state,
         decision_id, rationale_hash, trace_id)
       values ($1, $2, 'SPEND', $3, $4, $5, $6, $7, $8, $9, 'POLICY_OK', $10, $11, $12)`,
      [a.paymentId, a.facilityId, p.intentId.toLowerCase(), a.lineKey, toBytes32Tag(a.lineKey), a.plan.payeeId, a.plan.amountMinor, p.invoiceHash.toLowerCase(), p.planVersion, x.decisionId, x.rationaleHash, traceIdOf(a.paymentId)],
    );
    await insertRationale(c, { facilityId: a.facilityId, rationaleHash: x.rationaleHash, decisionId: x.decisionId, rationale: x.rationale });
    await appendTrace(c, proposalTrace(a, x));
  });
  return {
    id: a.paymentId,
    kind: 'SPEND',
    state: 'POLICY_OK',
    lineKey: a.lineKey,
    payeeId: a.plan.payeeId,
    amountMinor: a.plan.amountMinor,
    intentId: p.intentId as Hex,
    invoiceHash: p.invoiceHash as Hex,
    planVersion: p.planVersion,
    decisionId: x.decisionId,
    rationaleHash: x.rationaleHash,
    signed: false,
    txHash: null,
    supersededTxHashes: [],
    block: null,
  };
}

/**
 * An unsigned row of the same intent but another plan version (a crash, then a re-commit: planVersion is not part
 * of the intent) would be signed stale and revert StalePlan. Nothing was ever signed for it, so it is re-decided in
 * place for the version the policy just evaluated: new decision, new rationale, same row and intent.
 */
export async function refreshProposal(d: JobDeps, row: PaymentRow, a: ProposalArgs): Promise<PaymentRow> {
  const p = a.plan.proposal;
  const x = decision(d, a);
  await inTransaction(poolOf(d.db), async (c) => {
    const updated = await c.query(
      `update payments set plan_version = $3, decision_id = $4, rationale_hash = $5
        where facility_id = $1 and id = $2 and state = 'POLICY_OK' and raw_signed_tx is null and intent_id = $6`,
      [a.facilityId, row.id, p.planVersion, x.decisionId, x.rationaleHash, p.intentId.toLowerCase()],
    );
    if (updated.rowCount !== 1) throw new Error(`payment ${row.id} is no longer an unsigned proposal of this intent`);
    await insertRationale(c, { facilityId: a.facilityId, rationaleHash: x.rationaleHash, decisionId: x.decisionId, rationale: x.rationale });
    await appendTrace(c, { ...proposalTrace(a, x), summary: `${x.summary}; re-decided (the row was for plan v${row.planVersion})` });
  });
  return { ...row, planVersion: p.planVersion, decisionId: x.decisionId, rationaleHash: x.rationaleHash };
}

/**
 * signAndStore + broadcast for an unsigned POLICY_OK SPEND row, as the agent. signAndStore re-derives the intent
 * from the calldata and the committed plan's planId and refuses any mismatch; its gas estimate simulates the call
 * (a call that would revert is never signed). Nothing is signed while halted (WorkerHaltedError) or while a
 * Treasury.pause is on its way (PausePendingError, store/pause-pending.ts, re-check A-2).
 */
export async function signAndSend(d: JobDeps, a: { facilityId: string; committed: CommittedPlan; row: PaymentRow }): Promise<{ txHash: Hex; sent: BroadcastResult }> {
  const { row } = a;
  if (row.lineKey === null || row.decisionId === null || row.rationaleHash === null) throw new Error(`payment ${row.id} is not an agent spend`);
  await assertNotHalted(poolOf(d.db));
  await assertNoPendingPause(poolOf(d.db), d.deployment);
  const call = buildSpend({
    lineId: toBytes32Tag(row.lineKey),
    payeeId: shortIdToBytes32(row.payeeId, 'payeeId'),
    amountMinor: BigInt(row.amountMinor),
    invoiceHash: row.invoiceHash,
    planVersion: row.planVersion,
    decisionId: decisionIdToBytes32(row.decisionId),
    rationaleHash: row.rationaleHash,
  });
  const stored = await signAndStore(d.db, {
    target: { table: 'payments', facilityId: a.facilityId, id: row.id },
    request: toTxRequest(call, d.deployment.contracts),
    account: d.signers.agent,
    client: d.client,
    chainId: d.deployment.chainId,
    capWei: d.config.maxFeeWei,
    deployment: d.deployment,
    planId: a.committed.planId,
  });
  await d.onStep?.('signed', row.id);
  const sent = await sendStored(d.db, d.client, stored);
  await d.onStep?.('broadcast', row.id);
  try {
    await appendTrace(poolOf(d.db), {
      facilityId: a.facilityId,
      traceId: traceIdOf(row.id),
      actor: 'executor',
      kind: 'TX',
      summary: `Treasury.spend signed at nonce ${stored.nonce} and broadcast (${sent.status})`,
      refs: { paymentId: row.id, txHash: stored.txHash, planVersion: row.planVersion },
    });
  } catch (error: unknown) {
    d.log.warn('trace_append_failed', { paymentId: row.id, error }); // the tx is stored and sent; the audit row is best effort
  }
  return { txHash: stored.txHash, sent };
}
