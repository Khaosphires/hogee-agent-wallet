/**
 * The durable path every agent-actions payment takes (§12.3, the same as pacing.ts): the POLICY_OK row (with its
 * decision, rationale and PROPOSAL trace, one DB transaction) exists BEFORE any key touches it, then @hogee/chain
 * signAndStore (nonce + raw tx in one DB transaction; binds the calldata to the row, recomputes the intent from the
 * committed planId, and its gas estimate simulates the call), then the stored bytes are broadcast. A crash leaves an
 * unsigned row the next pass resumes, or a signed one recovery re-sends: never a second payment, never key use
 * without a row (reconcile.ts halts on any).
 */
import { decodeRevertData, FeeCapExceededError, revertDataFromError, sendStored, shortErrorReason, signAndStore, toBytes32Tag, toTxRequest, type HogeeCall, type TxSigner } from '@hogee/chain';
import { hashObject, type LineKey } from '@hogee/core';
import { insertRationale } from '@hogee/db';
import type { Hex } from 'viem';
import { uuidv7 } from '../runtime/ids';
import { assertNotHalted, WorkerHaltedError } from '../store/halt';
import { assertNoPendingPause, PausePendingError } from '../store/pause-pending';
import { inTransaction, poolOf, rows, type Pg } from '../store/pg';
import { appendTrace, type TraceInput } from '../store/trace';
import type { JobDeps } from './deps';
import type { AgentActionResult } from './agent-actions-ids';

export interface Decision {
  readonly decisionId: string;
  readonly rationaleHash: Hex;
  /** The preimage of rationaleHash (task 1.16: stored with the row); absent when resuming a stored decision. */
  readonly rationale?: Readonly<Record<string, unknown>>;
}

/** A fresh decision: UUIDv7 decisionId and the rationale commitment the contract records. */
export function decide(d: JobDeps, rationale: Readonly<Record<string, unknown>>): Decision {
  return { decisionId: (d.newDecisionId ?? uuidv7)(), rationaleHash: hashObject(rationale) as Hex, rationale };
}

export interface DecidedRow extends Decision {
  readonly facilityId: string;
  readonly id: string;
  readonly kind: 'SPEND' | 'FUND_MILESTONE';
  readonly intentId: Hex;
  readonly lineKey: LineKey;
  readonly payeeId: string;
  readonly amountMinor: string;
  readonly invoiceHash: Hex;
  readonly planVersion: number;
  readonly orderId?: string;
  readonly milestoneIdx?: number;
  readonly traceId: string;
}

/** Inserts the POLICY_OK row and its PROPOSAL trace in one DB transaction (fails on a duplicate id or live intent). */
export async function insertDecided(d: JobDeps, r: DecidedRow, trace: Omit<TraceInput, 'facilityId' | 'traceId'>): Promise<void> {
  await inTransaction(poolOf(d.db), async (c) => {
    await c.query(
      `insert into payments (id, facility_id, kind, intent_id, line_key, line_id, payee_id, order_id, milestone_idx, amount_minor, invoice_hash, plan_version,
         state, decision_id, rationale_hash, trace_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'POLICY_OK', $13, $14, $15)`,
      [
        r.id,
        r.facilityId,
        r.kind,
        r.intentId.toLowerCase(),
        r.lineKey,
        toBytes32Tag(r.lineKey),
        r.payeeId,
        r.orderId ?? null,
        r.milestoneIdx ?? null,
        r.amountMinor,
        r.invoiceHash.toLowerCase(),
        r.planVersion,
        r.decisionId,
        r.rationaleHash,
        r.traceId,
      ],
    );
    if (r.rationale) await insertRationale(c, { facilityId: r.facilityId, rationaleHash: r.rationaleHash, decisionId: r.decisionId, rationale: r.rationale });
    await appendTrace(c, { ...trace, facilityId: r.facilityId, traceId: r.traceId });
  });
}

export interface SendSpec {
  readonly facilityId: string;
  readonly paymentId: string;
  readonly call: HogeeCall;
  readonly signer: TxSigner;
  readonly role: 'agent' | 'relayer';
  /** The committed plan's planId (never from the row or a request): SPEND / OWNER_SPEND intents are recomputed from it. */
  readonly planId: Hex;
  readonly traceId: string;
}

/**
 * signAndStore + broadcast of an existing unsigned POLICY_OK row. Throws WorkerHaltedError while halted and, for the
 * agent key, PausePendingError while a Treasury.pause is on its way (store/pause-pending.ts, re-check A-2).
 */
export async function sendPayment(d: JobDeps, s: SendSpec): Promise<{ txHash: Hex; status: string }> {
  await assertNotHalted(poolOf(d.db));
  if (s.role === 'agent') await assertNoPendingPause(poolOf(d.db), d.deployment);
  const stored = await signAndStore(d.db, {
    target: { table: 'payments', facilityId: s.facilityId, id: s.paymentId },
    request: toTxRequest(s.call, d.deployment.contracts),
    account: s.signer,
    client: d.client,
    chainId: d.deployment.chainId,
    capWei: d.config.maxFeeWei,
    deployment: d.deployment,
    planId: s.planId,
  });
  await d.onStep?.('signed', s.paymentId);
  const sent = await sendStored(d.db, d.client, stored);
  await d.onStep?.('broadcast', s.paymentId);
  await traceBestEffort(d, {
    facilityId: s.facilityId,
    traceId: s.traceId,
    actor: 'executor',
    kind: 'TX',
    summary: `${s.call.kind} signed by the ${s.role} key at nonce ${stored.nonce} and broadcast (${sent.status})`,
    refs: { paymentId: s.paymentId, txHash: stored.txHash },
  });
  return { txHash: stored.txHash, status: sent.status };
}

/** POLICY_OK → POLICY_DENIED for a row nothing was signed for (releases its intent). False when it moved meanwhile. */
export async function denyPayment(d: JobDeps, facilityId: string, paymentId: string, reason: string): Promise<boolean> {
  const r = await poolOf(d.db).query(
    `update payments set state = 'POLICY_DENIED', revert_reason = $3 where facility_id = $1 and id = $2 and state = 'POLICY_OK' and raw_signed_tx is null`,
    [facilityId, paymentId, `DENIED: ${reason}`.slice(0, 200)],
  );
  return r.rowCount === 1;
}

/** Audit trace that must not stop the job (the decision it records is already durable or nothing was done). */
export async function traceBestEffort(d: JobDeps, e: TraceInput): Promise<void> {
  await appendTrace(poolOf(d.db), e).catch((error: unknown) => d.log.warn('trace_append_failed', { traceId: e.traceId, error }));
}

/** Appends unless the trace's last event already has this reason code (a skip retried every pass is traced once). */
export async function traceOnChange(d: JobDeps, e: TraceInput): Promise<void> {
  const [last] = await rows<{ reason_code: string | null }>(poolOf(d.db), 'select reason_code from traces where facility_id = $1 and trace_id = $2 order by seq desc limit 1', [e.facilityId, e.traceId]);
  if (last && last.reason_code === (e.reasonCode ?? null)) return;
  await traceBestEffort(d, e);
}

/** A durable refusal marker: a trace with `reasonCode` that names `paymentId`. */
export async function hasTraceFor(q: Pg, facilityId: string, paymentId: string, reasonCode: string): Promise<boolean> {
  const found = await rows(q, 'select 1 as x from traces where facility_id = $1 and payment_id = $2 and reason_code = $3 limit 1', [facilityId, paymentId, reasonCode]);
  return found.length > 0;
}

/**
 * How a failed send is reported: fee cap, halt and a pending pause (PAUSE_PENDING) wait for the next pass; a reverting
 * estimate is named; else error.
 */
export function failureOf(error: unknown): { result: AgentActionResult; reason: string } {
  if (error instanceof FeeCapExceededError) return { result: 'deferred', reason: 'FEE_CAP' };
  if (error instanceof WorkerHaltedError) return { result: 'deferred', reason: 'HALTED' };
  if (error instanceof PausePendingError) return { result: 'deferred', reason: 'PAUSE_PENDING' };
  const data = revertDataFromError(error);
  const decoded = data ? decodeRevertData(data) : null;
  if (decoded) return { result: 'error', reason: `simulation reverts ${decoded.name}` };
  return { result: 'error', reason: shortErrorReason(error) };
}

export interface Invoice {
  readonly id: string;
  readonly payeeId: string;
  readonly amountMinor: string;
  readonly invoiceHash: Hex;
  readonly flags: readonly string[];
}

interface InvoiceDbRow {
  id: string;
  payee_id: string;
  amount_minor: string;
  invoice_hash: string;
  flags: string[] | null;
}

const toInvoice = (r: InvoiceDbRow): Invoice => ({ id: r.id, payeeId: r.payee_id, amountMinor: r.amount_minor, invoiceHash: r.invoice_hash as Hex, flags: r.flags ?? [] });
const INVOICE_COLS = 'id, payee_id, amount_minor::text as amount_minor, invoice_hash, flags';

export async function invoiceById(q: Pg, facilityId: string, id: string): Promise<Invoice | null> {
  const [r] = await rows<InvoiceDbRow>(q, `select ${INVOICE_COLS} from invoices where facility_id = $1 and id = $2`, [facilityId, id]);
  return r ? toInvoice(r) : null;
}

export async function invoiceByHash(q: Pg, facilityId: string, invoiceHash: Hex): Promise<Invoice | null> {
  const [r] = await rows<InvoiceDbRow>(q, `select ${INVOICE_COLS} from invoices where facility_id = $1 and invoice_hash = $2`, [facilityId, invoiceHash.toLowerCase()]);
  return r ? toInvoice(r) : null;
}

/** The newest invoice bound to a milestone (POST /api/escrow invoice intake), if any. */
export async function invoiceForMilestone(q: Pg, facilityId: string, orderId: string, idx: number): Promise<Invoice | null> {
  const [r] = await rows<InvoiceDbRow>(
    q,
    `select ${INVOICE_COLS} from invoices where facility_id = $1 and order_id = $2 and milestone_idx = $3 order by received_at desc, id desc limit 1`,
    [facilityId, orderId, idx],
  );
  return r ? toInvoice(r) : null;
}
