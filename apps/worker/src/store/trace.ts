/**
 * Append-only, hash-chained trace events (§12.1 traces, §26.5 TraceEvent): every decision the worker acts on is
 * audit-logged, not only successful sends. hash = keccak256(utf8(JCS(event without hash))); prevHash = the previous
 * event's hash in the same trace (ZERO for the first).
 */
import { hashObject, ZERO_HEX32 } from '@hogee/core';
import { rows, type Pg } from './pg';

export interface TraceRefs {
  readonly planVersion?: number;
  readonly paymentId?: string;
  readonly invoiceHash?: string;
  readonly decisionId?: string;
  readonly txHash?: string;
  readonly payoutId?: string;
}

export interface TraceInput {
  readonly facilityId: string;
  readonly traceId: string;
  readonly actor: 'policy' | 'executor' | 'worker' | 'oracle' | 'reconciler';
  readonly kind: 'PROPOSAL' | 'POLICY_VERDICT' | 'TX' | 'PAYOUT' | 'ALERT' | 'EXCEPTION';
  readonly summary: string;
  readonly verdict?: 'AUTO' | 'NEEDS_FOUNDER' | 'NEEDS_OFFICER' | 'DENY';
  readonly reasonCode?: string;
  readonly refs: TraceRefs;
}

const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** Whether the trace already holds an event with `reasonCode` (the alert-once checks). */
export async function hasTrace(q: Pg, t: { readonly facilityId: string; readonly traceId: string; readonly reasonCode: string }): Promise<boolean> {
  const found = await rows<{ x: number }>(q, 'select 1 as x from traces where facility_id = $1 and trace_id = $2 and reason_code = $3 limit 1', [t.facilityId, t.traceId, t.reasonCode]);
  return found.length > 0;
}

/** Whether the trace holds any event yet (alert-once checks for events without a reason code). */
export async function traceExists(q: Pg, t: { readonly facilityId: string; readonly traceId: string }): Promise<boolean> {
  const found = await rows<{ x: number }>(q, 'select 1 as x from traces where facility_id = $1 and trace_id = $2 limit 1', [t.facilityId, t.traceId]);
  return found.length > 0;
}

export async function appendTrace(q: Pg, e: TraceInput): Promise<{ seq: number; hash: string }> {
  const [last] = await rows<{ seq: number; hash: string }>(
    q,
    'select seq, hash from traces where facility_id = $1 and trace_id = $2 order by seq desc limit 1 for update',
    [e.facilityId, e.traceId],
  );
  const seq = last ? Number(last.seq) + 1 : 0;
  const prevHash = last?.hash ?? ZERO_HEX32;
  const ts = new Date().toISOString();
  const refs = defined({ ...e.refs, txHash: e.refs.txHash?.toLowerCase(), invoiceHash: e.refs.invoiceHash?.toLowerCase() });
  const event = defined({ traceId: e.traceId, seq, ts, actor: e.actor, kind: e.kind, summary: e.summary.slice(0, 500), verdict: e.verdict, reasonCode: e.reasonCode, refs, prevHash });
  const hash = hashObject(event);
  await q.query(
    `insert into traces (trace_id, seq, facility_id, ts, actor, kind, summary, policy_verdict, reason_code, plan_version, payment_id,
       invoice_hash, decision_id, tx_hash, payout_id, prev_hash, hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      e.traceId,
      seq,
      e.facilityId,
      ts,
      e.actor,
      e.kind,
      event.summary,
      e.verdict ?? null,
      e.reasonCode ?? null,
      refs.planVersion ?? null,
      refs.paymentId ?? null,
      refs.invoiceHash ?? null,
      refs.decisionId ?? null,
      refs.txHash ?? null,
      refs.payoutId ?? null,
      prevHash,
      hash,
    ],
  );
  return { seq, hash };
}
