/**
 * Agent-key spends the worker did not decide alone (Treasury.spend):
 *
 * APPROVED ESCALATIONS. The loan officer approved a flagged payment (exception POLICY_ESCALATION, status APPROVED).
 * The worker pays exactly the server-derived payload.proposal {lineKey, payeeId, amountMinor, invoiceId | pacingSlot}
 * as payment `escalation:<exceptionId>`, after RE-CHECKING it on the current chain-backed context with every in-flight
 * payment counted: the payee listed on the line and bound (and cooled), the invoice the payload names (same payee,
 * same amount, not paid), every cap. The officer can override only the flagged-invoice escalation; any DENY is a refusal
 * (traced, never paid; terminal) except a treasury/line state that passes (Paused, CircuitOpen, PayeeCooling: wait).
 * The trace says OFFICER OVERRIDE, never "within plan".
 *
 * API SPEND PROPOSALS. Rows the API inserted for POST /api/proposals/spend (kind SPEND, POLICY_OK, unsigned, with the
 * API's decision and rationale). The world may have moved since the API evaluated them, so each is re-evaluated at
 * signing time (row rebuilt into a core SPEND proposal: intent recomputed from the committed planId, invoice re-read,
 * in-flight counted) and signed only on AUTO; anything else becomes POLICY_DENIED (its intent released) with a trace.
 * A pacing row is also refused ALREADY_PROPOSED_TODAY, for good, when its line already has another slot signed or mined
 * in the chain day (the plan pays a pacing line once per day, as the tick does; audit run-4).
 * Neither path ever calls recordDenied (the tick's rule: never for a state the agent did not cause).
 */
import { buildSpend, decisionIdToBytes32, intentId as spendIntentId, sequenceInvoiceHash, shortIdToBytes32, toBytes32Tag } from '@hogee/chain';
import { DerivedSpendProposal, evaluateProposal, type LineKey, type PolicyContext } from '@hogee/core';
import type { Hex } from 'viem';
import { poolOf, rows } from '../store/pg';
import type { JobDeps } from './deps';
import { escalationPaymentId, escalationTraceIdOf, isApiSpendProposalId, REASON, TRANSIENT_DENIALS, type AgentActionOutcome } from './agent-actions-ids';
import { isOverridable, spendProposal, type SpendBasis } from './agent-actions-pure';
import { decide, denyPayment, failureOf, hasTraceFor, insertDecided, invoiceByHash, invoiceById, sendPayment, traceBestEffort, traceOnChange, type Decision } from './agent-actions-sign';
import { contextOf, lineSlotToday, type ActionPaymentRow, type ActionWorld } from './agent-actions-world';

/** Spend fields shared by both paths, as the row (and the calldata) will carry them. */
interface SpendTerms {
  readonly lineKey: LineKey;
  readonly payeeId: string;
  readonly amountMinor: string;
  readonly invoiceHash: Hex;
  readonly basis: SpendBasis;
}

class Refusal extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const intentOf = (w: ActionWorld, t: SpendTerms): Hex =>
  spendIntentId({ planId: w.committed.planId, lineId: toBytes32Tag(t.lineKey), payeeId: shortIdToBytes32(t.payeeId, 'payeeId'), invoiceHash: t.invoiceHash, amountMinor: BigInt(t.amountMinor) });

function spendCall(row: { lineKey: LineKey; payeeId: string; amountMinor: string; invoiceHash: Hex; planVersion: number; decisionId: string; rationaleHash: Hex }) {
  return buildSpend({
    lineId: toBytes32Tag(row.lineKey),
    payeeId: shortIdToBytes32(row.payeeId, 'payeeId'),
    amountMinor: BigInt(row.amountMinor),
    invoiceHash: row.invoiceHash,
    planVersion: row.planVersion,
    decisionId: decisionIdToBytes32(row.decisionId),
    rationaleHash: row.rationaleHash,
  });
}

// ---- approved escalations ------------------------------------------------------------------------------------------

interface ExceptionRow {
  id: string;
  payload: { proposal?: unknown } | null;
  trace_id: string | null;
}

/** The payload's terms, with its invoice re-read: the payee and amount must be the invoice's (server-derived). */
async function escalationTerms(d: JobDeps, w: ActionWorld, e: ExceptionRow): Promise<SpendTerms> {
  const parsed = DerivedSpendProposal.safeParse(e.payload?.proposal);
  if (!parsed.success) throw new Refusal('MALFORMED_PAYLOAD');
  const p = parsed.data;
  if (p.pacingSlot !== undefined) return { lineKey: p.lineKey, payeeId: p.payeeId, amountMinor: p.amountMinor, invoiceHash: sequenceInvoiceHash(BigInt(p.pacingSlot)), basis: { pacingSlot: p.pacingSlot } };
  const invoice = await invoiceById(poolOf(d.db), w.facilityId, p.invoiceId as string);
  if (!invoice) throw new Refusal('INVOICE_NOT_FOUND');
  if (invoice.payeeId !== p.payeeId) throw new Refusal('INVOICE_PAYEE_MISMATCH');
  if (invoice.amountMinor !== p.amountMinor) throw new Refusal('INVOICE_AMOUNT_MISMATCH');
  return { lineKey: p.lineKey, payeeId: p.payeeId, amountMinor: p.amountMinor, invoiceHash: invoice.invoiceHash, basis: { invoiceId: invoice.id, flags: invoice.flags } };
}

const sameTerms = (r: ActionPaymentRow, t: SpendTerms, intent: Hex, planVersion: number): boolean =>
  r.lineKey === t.lineKey && r.payeeId === t.payeeId && r.amountMinor === t.amountMinor && r.invoiceHash.toLowerCase() === t.invoiceHash.toLowerCase() && r.intentId.toLowerCase() === intent.toLowerCase() && r.planVersion === planVersion;

async function refuseEscalation(d: JobDeps, w: ActionWorld, e: ExceptionRow, existing: ActionPaymentRow | undefined, reason: string): Promise<AgentActionOutcome> {
  const paymentId = escalationPaymentId(e.id);
  if (existing) await denyPayment(d, w.facilityId, paymentId, `${REASON.OFFICER_OVERRIDE_REFUSED}: ${reason}`);
  await traceBestEffort(d, {
    facilityId: w.facilityId,
    traceId: e.trace_id ?? escalationTraceIdOf(e.id),
    actor: 'policy',
    kind: 'ALERT',
    verdict: 'DENY',
    reasonCode: REASON.OFFICER_OVERRIDE_REFUSED,
    summary: `OFFICER OVERRIDE refused at execution (exception ${e.id}): ${reason}. The plan no longer allows this payment; nothing was paid`,
    refs: { paymentId },
  });
  d.log.warn('escalation_refused', { facilityId: w.facilityId, exceptionId: e.id, reason });
  return { action: 'ESCALATION', ref: e.id, result: 'refused', reason, paymentId };
}

async function payEscalation(d: JobDeps, w: ActionWorld, e: ExceptionRow): Promise<AgentActionOutcome | null> {
  const paymentId = escalationPaymentId(e.id);
  const traceId = e.trace_id ?? escalationTraceIdOf(e.id);
  const { ctx, rows: all } = await contextOf(d, w);
  const existing = all.find((r) => r.id === paymentId);
  if (existing && (existing.signed || existing.state !== 'POLICY_OK')) return null; // sent (sync marks it EXECUTED) or refused
  if (await hasTraceFor(poolOf(d.db), w.facilityId, paymentId, REASON.OFFICER_OVERRIDE_REFUSED)) return null;
  let terms: SpendTerms;
  try {
    terms = await escalationTerms(d, w, e);
  } catch (error: unknown) {
    if (error instanceof Refusal) return refuseEscalation(d, w, e, existing, error.reason);
    throw error;
  }
  const intent = intentOf(w, terms);
  const decision = evaluateProposal(spendProposal({ ...terms, intentId: intent, planVersion: ctx.planVersion }), ctx);
  if (!isOverridable(decision)) {
    if (decision.verdict === 'DENY' && TRANSIENT_DENIALS.has(decision.reasonCode)) {
      await traceOnChange(d, { facilityId: w.facilityId, traceId, actor: 'policy', kind: 'POLICY_VERDICT', verdict: 'DENY', reasonCode: decision.reasonCode, summary: `Approved override waits: ${decision.reasonCode}`, refs: { paymentId } });
      return { action: 'ESCALATION', ref: e.id, result: 'deferred', reason: decision.reasonCode, paymentId };
    }
    return refuseEscalation(d, w, e, existing, decision.reasonCode);
  }
  let x: Decision;
  if (existing) {
    if (!sameTerms(existing, terms, intent, ctx.planVersion) || !existing.decisionId || !existing.rationaleHash) return refuseEscalation(d, w, e, existing, 'STALE_ESCALATION_ROW');
    x = { decisionId: existing.decisionId, rationaleHash: existing.rationaleHash };
  } else {
    const basis = 'invoiceId' in terms.basis ? { invoiceId: terms.basis.invoiceId, invoiceFlags: terms.basis.flags } : { pacingSlot: terms.basis.pacingSlot };
    x = decide(d, { kind: 'OFFICER_OVERRIDE', exceptionId: e.id, lineKey: terms.lineKey, payeeId: terms.payeeId, amountMinor: terms.amountMinor, invoiceHash: terms.invoiceHash, ...basis, planVersion: ctx.planVersion, policyVerdict: decision.verdict, policyReasonCode: decision.reasonCode, reasonCode: REASON.OFFICER_OVERRIDE });
    await insertDecided(
      d,
      { ...x, facilityId: w.facilityId, id: paymentId, kind: 'SPEND', intentId: intent, lineKey: terms.lineKey, payeeId: terms.payeeId, amountMinor: terms.amountMinor, invoiceHash: terms.invoiceHash, planVersion: ctx.planVersion, traceId },
      {
        actor: 'policy',
        kind: 'PROPOSAL',
        verdict: 'NEEDS_OFFICER',
        reasonCode: REASON.OFFICER_OVERRIDE,
        summary: `OFFICER OVERRIDE (exception ${e.id}): pays exactly the approved ${terms.amountMinor} minor to ${terms.payeeId} from ${terms.lineKey}; re-checked payee listed and bound and every cap, in flight counted (policy ${decision.verdict} ${decision.reasonCode})`,
        refs: { paymentId, planVersion: ctx.planVersion, invoiceHash: terms.invoiceHash, decisionId: x.decisionId },
      },
    );
    await d.onStep?.('inserted', paymentId);
  }
  const call = spendCall({ ...terms, planVersion: ctx.planVersion, ...x });
  const sent = await sendPayment(d, { facilityId: w.facilityId, paymentId, call, signer: d.signers.agent, role: 'agent', planId: w.committed.planId, traceId });
  return { action: 'ESCALATION', ref: e.id, result: 'sent', paymentId, amountMinor: terms.amountMinor, txHash: sent.txHash };
}

/** Pays (or refuses) every officer-approved escalation of the facility. */
export async function payEscalations(d: JobDeps, w: ActionWorld): Promise<AgentActionOutcome[]> {
  const approved = await rows<ExceptionRow>(
    poolOf(d.db),
    `select id, payload, trace_id from exceptions where facility_id = $1 and kind = 'POLICY_ESCALATION' and status = 'APPROVED' order by created_at, id`,
    [w.facilityId],
  );
  const out: AgentActionOutcome[] = [];
  for (const e of approved) {
    try {
      const o = await payEscalation(d, w, e);
      if (o) out.push(o);
    } catch (error: unknown) {
      const f = failureOf(error);
      if (f.result === 'error') d.log.error('escalation_failed', { facilityId: w.facilityId, exceptionId: e.id, error });
      out.push({ action: 'ESCALATION', ref: e.id, ...f, paymentId: escalationPaymentId(e.id) });
    }
  }
  return out;
}

// ---- API spend proposals -------------------------------------------------------------------------------------------

/** The row's terms re-derived: a pacing line's slot from its hash; otherwise the stored invoice of that hash. */
async function rowTerms(d: JobDeps, w: ActionWorld, ctx: PolicyContext, r: ActionPaymentRow): Promise<SpendTerms> {
  if (r.lineKey === null) throw new Refusal('NO_LINE');
  if ((r.lineId ?? '').toLowerCase() !== toBytes32Tag(r.lineKey).toLowerCase()) throw new Refusal('LINE_ID_MISMATCH');
  const pacing = ctx.plan.lines.find((l) => l.lineKey === r.lineKey)?.pacing !== undefined;
  if (pacing) {
    const slot = BigInt(r.invoiceHash);
    if (slot > BigInt(Number.MAX_SAFE_INTEGER)) throw new Refusal('PACING_HASH_MISMATCH');
    return { lineKey: r.lineKey, payeeId: r.payeeId, amountMinor: r.amountMinor, invoiceHash: r.invoiceHash, basis: { pacingSlot: Number(slot) } };
  }
  const invoice = await invoiceByHash(poolOf(d.db), w.facilityId, r.invoiceHash);
  if (!invoice) throw new Refusal('INVOICE_NOT_FOUND');
  if (invoice.payeeId !== r.payeeId) throw new Refusal('INVOICE_PAYEE_MISMATCH');
  if (invoice.amountMinor !== r.amountMinor) throw new Refusal('INVOICE_AMOUNT_MISMATCH');
  return { lineKey: r.lineKey, payeeId: r.payeeId, amountMinor: r.amountMinor, invoiceHash: r.invoiceHash, basis: { invoiceId: invoice.id, flags: invoice.flags } };
}

async function denyProposal(d: JobDeps, w: ActionWorld, r: ActionPaymentRow, verdict: 'DENY' | 'NEEDS_FOUNDER' | 'NEEDS_OFFICER', reason: string): Promise<AgentActionOutcome> {
  const moved = await denyPayment(d, w.facilityId, r.id, reason);
  if (moved) {
    await traceBestEffort(d, {
      facilityId: w.facilityId,
      traceId: r.traceId,
      actor: 'policy',
      kind: 'POLICY_VERDICT',
      verdict,
      reasonCode: reason,
      summary: `Spend proposal ${r.id} re-checked at signing: ${verdict} ${reason}; not signed, marked POLICY_DENIED (not recorded on-chain)`,
      refs: { paymentId: r.id, planVersion: r.planVersion, ...(r.decisionId ? { decisionId: r.decisionId } : {}) },
    });
  }
  return { action: 'API_SPEND', ref: r.id, result: 'denied', reason, paymentId: r.id, amountMinor: r.amountMinor };
}

async function signProposal(d: JobDeps, w: ActionWorld, id: string): Promise<AgentActionOutcome | null> {
  const { ctx, rows: all } = await contextOf(d, w);
  const r = all.find((x) => x.id === id);
  if (!r || r.signed || r.state !== 'POLICY_OK' || !r.decisionId || !r.rationaleHash) return null;
  let terms: SpendTerms;
  try {
    terms = await rowTerms(d, w, ctx, r);
  } catch (error: unknown) {
    if (error instanceof Refusal) return denyProposal(d, w, r, 'DENY', error.reason);
    throw error;
  }
  const intent = intentOf(w, terms);
  if (intent.toLowerCase() !== r.intentId.toLowerCase()) return denyProposal(d, w, r, 'DENY', 'INTENT_MISMATCH');
  const decision = evaluateProposal(spendProposal({ ...terms, intentId: intent, planVersion: r.planVersion }), ctx);
  if (decision.verdict !== 'AUTO') return denyProposal(d, w, r, decision.verdict, decision.reasonCode);
  if (w.pacingLines.has(terms.lineKey) && (await lineSlotToday(d, w, all, terms.lineKey, r.id))) return denyProposal(d, w, r, 'DENY', REASON.ALREADY_PROPOSED_TODAY);
  const call = spendCall({ ...terms, planVersion: r.planVersion, decisionId: r.decisionId, rationaleHash: r.rationaleHash });
  const sent = await sendPayment(d, { facilityId: w.facilityId, paymentId: r.id, call, signer: d.signers.agent, role: 'agent', planId: w.committed.planId, traceId: r.traceId });
  return { action: 'API_SPEND', ref: r.id, result: 'sent', paymentId: r.id, amountMinor: r.amountMinor, txHash: sent.txHash };
}

/** Re-evaluates and signs (or denies) each unsigned API spend proposal, oldest first. */
export async function signApiProposals(d: JobDeps, w: ActionWorld): Promise<AgentActionOutcome[]> {
  const { rows: all } = await contextOf(d, w);
  const ids = all.filter((r) => r.kind === 'SPEND' && r.state === 'POLICY_OK' && !r.signed && isApiSpendProposalId(r.id)).map((r) => r.id);
  const out: AgentActionOutcome[] = [];
  for (const id of ids) {
    try {
      const o = await signProposal(d, w, id);
      if (o) out.push(o);
    } catch (error: unknown) {
      const f = failureOf(error);
      if (f.result === 'error') d.log.error('spend_proposal_failed', { facilityId: w.facilityId, paymentId: id, error });
      out.push({ action: 'API_SPEND', ref: id, ...f, paymentId: id });
    }
  }
  return out;
}
