/**
 * Founder-signed payments (relayer key, no authority of its own): rows the API inserted, kind RELEASE_MILESTONE
 * (`release:<exceptionId | signatureRequestId>`) or OWNER_SPEND (`owner:<signatureRequestId>`), POLICY_OK, unsigned,
 * whose `trace_id` is the id of the SUBMITTED signature_requests row (kind MilestoneRelease / OwnerSpend) holding the
 * typed message and the founder's signature. The call is rebuilt from that signed message and the signature only after
 * the message is checked against the payment row (and the chain's order, the stored inspection evidence, the
 * deployment, the intent); any mismatch is refused with an ALERT and the row becomes POLICY_DENIED: never sent. Then
 * the relayer simulates it (a decoded revert is a refusal: e.g. SignatureExpired, InvalidSignature, MilestoneLocked),
 * core re-checks it on the context with every in-flight payment counted (a DENY waits for the next pass), and it is
 * signed and broadcast through the same durable path as every payment.
 */
import {
  buildOwnerSpend,
  buildReleaseMilestone,
  decodeRevertData,
  intentId as spendIntentId,
  releaseMilestoneIntentId,
  revertDataFromError,
  shortIdToBytes32,
  toBytes32Tag,
  toTxRequest,
  type HogeeCall,
  type MilestoneReleaseMessage,
  type OwnerSpendMessage,
} from '@hogee/chain';
import { evaluateOwnerSpend, evaluateProposal, TRUSTED_PUBLIC, ZERO_HEX32, type PolicyContext, type PolicyDecision } from '@hogee/core';
import type { Hex } from 'viem';
import { poolOf, rows } from '../store/pg';
import type { JobDeps } from './deps';
import { ownerPaymentId, REASON, releasePaymentId, type AgentAction, type AgentActionOutcome } from './agent-actions-ids';
import { founderSigOf, FounderRelayRefusal, milestoneReleaseMismatch, ownerSpendMismatch } from './agent-actions-founder-sig';
import { denyPayment, failureOf, sendPayment, traceBestEffort } from './agent-actions-sign';
import { contextOf, type ActionPaymentRow, type ActionWorld } from './agent-actions-world';
import { RelayRefusal, toMessage } from './relay-calls';

const refuse = (reason: string): never => {
  throw new FounderRelayRefusal(reason);
};

interface SignatureRow {
  id: string;
  kind: string;
  ref_id: string;
  status: string;
  typed_data_json: { message?: Record<string, string | boolean> } | null;
  signature_json: unknown;
}

interface FounderCall {
  readonly call: HogeeCall;
  /** Core's view of the same payment on the projected context (NEEDS_FOUNDER = executable). */
  readonly check: (ctx: PolicyContext) => PolicyDecision;
}

async function signatureFor(d: JobDeps, w: ActionWorld, r: ActionPaymentRow): Promise<SignatureRow> {
  const want = r.kind === 'OWNER_SPEND' ? 'OwnerSpend' : 'MilestoneRelease';
  const [s] = await rows<SignatureRow>(
    poolOf(d.db),
    'select id, kind, ref_id, status, typed_data_json, signature_json from signature_requests where facility_id = $1 and id = $2',
    [w.facilityId, r.traceId],
  );
  if (!s) return refuse('no signature request is linked to the payment (trace_id)');
  if (s.kind !== want) refuse(`the linked signature request is a ${s.kind}, not a ${want}`);
  if (s.status !== 'SUBMITTED') refuse(`the linked signature request is ${s.status}`);
  const bound = r.kind === 'OWNER_SPEND' ? r.id === ownerPaymentId(s.id) : r.id === releasePaymentId(s.id) || r.id === releasePaymentId(s.ref_id);
  if (!bound) refuse('the payment id does not name its signature request');
  return s;
}

function signedMessage(kind: 'OwnerSpend' | 'MilestoneRelease', s: SignatureRow): Record<string, unknown> {
  try {
    return toMessage(kind, s.typed_data_json?.message ?? {});
  } catch (error: unknown) {
    if (error instanceof RelayRefusal) return refuse(error.reason);
    throw error;
  }
}

function ownerSpendCall(d: JobDeps, w: ActionWorld, r: ActionPaymentRow, s: SignatureRow): FounderCall {
  if (r.lineKey === null || (r.lineId ?? '').toLowerCase() !== toBytes32Tag(r.lineKey).toLowerCase()) refuse('the row line is malformed');
  const msg = signedMessage('OwnerSpend', s);
  const field = ownerSpendMismatch(msg, { lineId: r.lineId as Hex, payeeId: r.payeeId, amountMinor: r.amountMinor, invoiceHash: r.invoiceHash, deploymentId: d.deployment.deploymentId });
  if (field) refuse(`the signed OwnerSpend ${field} is not the payment row's`);
  const intent = spendIntentId({ planId: w.committed.planId, lineId: r.lineId as Hex, payeeId: shortIdToBytes32(r.payeeId, 'payeeId'), invoiceHash: r.invoiceHash, amountMinor: BigInt(r.amountMinor) });
  if (intent.toLowerCase() !== r.intentId.toLowerCase()) refuse('the row intent_id is not the signed spend');
  const req = msg as unknown as OwnerSpendMessage;
  return {
    call: buildOwnerSpend({ req, founder: founderSigOf(s.signature_json) }),
    check: (ctx) => evaluateOwnerSpend({ lineKey: r.lineKey as NonNullable<typeof r.lineKey>, payeeId: r.payeeId, amountMinor: r.amountMinor, invoiceHash: r.invoiceHash, intentId: intent }, ctx),
  };
}

async function releaseCall(d: JobDeps, w: ActionWorld, r: ActionPaymentRow, s: SignatureRow): Promise<FounderCall> {
  if (r.orderId === null || r.milestoneIdx === null) return refuse('the row names no milestone');
  const order = w.orders.find((o) => o.orderId === r.orderId);
  if (!order) return refuse('the order is not on-chain');
  if (r.payeeId !== order.payeeId || r.lineKey !== order.lineKey) refuse("the row payee or line is not the order's supplier");
  const [m] = await rows<{ evidence_hash: string | null }>(poolOf(d.db), 'select evidence_hash from escrow_milestones where facility_id = $1 and order_id = $2 and idx = $3', [
    w.facilityId,
    r.orderId,
    r.milestoneIdx,
  ]);
  if (!m) refuse('the milestone is not stored');
  const msg = signedMessage('MilestoneRelease', s);
  const evidenceHash = (m?.evidence_hash ?? ZERO_HEX32) as Hex;
  const field = milestoneReleaseMismatch(msg, { orderId: r.orderId, idx: r.milestoneIdx, amountMinor: r.amountMinor, evidenceHash, deploymentId: d.deployment.deploymentId });
  if (field) refuse(`the signed MilestoneRelease ${field} is not the payment row's`);
  if (releaseMilestoneIntentId({ orderId: order.orderIdHex, idx: r.milestoneIdx }).toLowerCase() !== r.intentId.toLowerCase()) refuse('the row intent_id is not the milestone settlement');
  const release = msg as unknown as MilestoneReleaseMessage;
  const orderId = r.orderId;
  const idx = r.milestoneIdx;
  return {
    call: buildReleaseMilestone({ release, founder: founderSigOf(s.signature_json) }),
    check: (ctx) => evaluateProposal({ kind: 'RELEASE_MILESTONE', origin: TRUSTED_PUBLIC, orderId, idx, evidenceHash, amountMinor: r.amountMinor }, ctx),
  };
}

/** The relayer's eth_call at latest: a decoded Hogee revert is a refusal; an RPC failure is retried next pass. */
async function simulate(d: JobDeps, call: HogeeCall): Promise<void> {
  const request = toTxRequest(call, d.deployment.contracts);
  try {
    await d.client.call({ account: d.signers.relayer.address, to: request.to, data: request.data, blockTag: 'latest' });
  } catch (error: unknown) {
    const data = revertDataFromError(error);
    const decoded = data ? decodeRevertData(data) : null;
    if (decoded) refuse(`simulation reverts ${decoded.name}`);
    throw error;
  }
}

async function relayOne(d: JobDeps, w: ActionWorld, r: ActionPaymentRow): Promise<AgentActionOutcome> {
  const action: AgentAction = r.kind === 'OWNER_SPEND' ? 'OWNER_SPEND' : 'RELEASE_MILESTONE';
  const base = { action, ref: r.id, paymentId: r.id, amountMinor: r.amountMinor };
  try {
    const s = await signatureFor(d, w, r);
    const f = r.kind === 'OWNER_SPEND' ? ownerSpendCall(d, w, r, s) : await releaseCall(d, w, r, s);
    await simulate(d, f.call);
    const { ctx } = await contextOf(d, w);
    const verdict = f.check(ctx);
    // NEEDS_FOUNDER = the founder's signature is all it needs; a DENY here comes from in-flight payments the chain
    // has not seen yet: wait for them (an expired signature is refused by the simulation on a later pass).
    if (verdict.verdict !== 'NEEDS_FOUNDER') return { ...base, result: 'deferred', reason: verdict.reasonCode };
    const sent = await sendPayment(d, { facilityId: w.facilityId, paymentId: r.id, call: f.call, signer: d.signers.relayer, role: 'relayer', planId: w.committed.planId, traceId: r.traceId });
    return { ...base, result: 'sent', txHash: sent.txHash };
  } catch (error: unknown) {
    if (!(error instanceof FounderRelayRefusal)) {
      const f = failureOf(error);
      if (f.result === 'error') d.log.error('founder_relay_failed', { facilityId: w.facilityId, paymentId: r.id, error });
      return { ...base, ...f };
    }
    await denyPayment(d, w.facilityId, r.id, `${REASON.FOUNDER_RELAY_REFUSED}: ${error.reason}`);
    await traceBestEffort(d, {
      facilityId: w.facilityId,
      traceId: r.traceId,
      actor: 'worker',
      kind: 'ALERT',
      verdict: 'DENY',
      reasonCode: REASON.FOUNDER_RELAY_REFUSED,
      summary: `${r.kind} ${r.id} not relayed: ${error.reason}`,
      refs: { paymentId: r.id },
    });
    d.log.warn('founder_relay_refused', { facilityId: w.facilityId, paymentId: r.id, reason: error.reason });
    return { ...base, result: 'refused', reason: error.reason };
  }
}

/** Relays every unsigned founder-signed payment of the facility, oldest first. */
export async function relayFounderPayments(d: JobDeps, w: ActionWorld): Promise<AgentActionOutcome[]> {
  const { rows: all } = await contextOf(d, w);
  const pending = all.filter((r) => (r.kind === 'OWNER_SPEND' || r.kind === 'RELEASE_MILESTONE') && r.state === 'POLICY_OK' && !r.signed);
  const out: AgentActionOutcome[] = [];
  for (const r of pending) out.push(await relayOne(d, w, r));
  return out;
}
