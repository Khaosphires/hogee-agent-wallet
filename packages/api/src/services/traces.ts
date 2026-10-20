/**
 * Glass-box timeline (§12.1 traces, §26.5 TraceEvent): append-only, hash-chained per trace id. Same hashing as the
 * worker (apps/worker store/trace.ts): hash = keccak256(utf8(JCS(event without hash))), prevHash = the previous event
 * of the trace (ZERO for the first). Appends to one trace are serialised with a transaction-scoped advisory lock.
 */
import { hashObject, ZERO_HEX32, type PolicyVerdict, type TraceActor, type TraceEvent, type TraceKind, type TraceRefs } from "@hogee/core";
import type { Db } from "@hogee/db";
import type { PoolClient } from "pg";
import { inTx, rows, type Q } from "./sql";

export interface TraceInput {
  readonly facilityId: string;
  readonly traceId: string;
  readonly actor: TraceActor;
  readonly kind: TraceKind;
  readonly summary: string;
  readonly verdict?: PolicyVerdict;
  readonly reasonCode?: string;
  readonly refs?: TraceRefs;
}

const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

async function appendIn(q: Q, e: TraceInput): Promise<TraceEvent> {
  await q.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`trace:${e.facilityId}:${e.traceId}`]);
  const [last] = await rows<{ seq: number; hash: string }>(
    q,
    "select seq, hash from traces where facility_id = $1 and trace_id = $2 order by seq desc limit 1",
    [e.facilityId, e.traceId],
  );
  const seq = last ? Number(last.seq) + 1 : 0;
  const prevHash = (last?.hash ?? ZERO_HEX32) as TraceEvent["prevHash"];
  const ts = new Date().toISOString();
  const refs = defined({ ...e.refs, txHash: e.refs?.txHash?.toLowerCase(), invoiceHash: e.refs?.invoiceHash?.toLowerCase() }) as TraceRefs;
  const body = defined({
    traceId: e.traceId,
    seq,
    ts,
    actor: e.actor,
    kind: e.kind,
    summary: e.summary.slice(0, 500),
    verdict: e.verdict,
    reasonCode: e.reasonCode,
    refs,
    prevHash,
  });
  const hash = hashObject(body);
  await q.query(
    `insert into traces (trace_id, seq, facility_id, ts, actor, kind, summary, policy_verdict, reason_code, plan_version, payment_id,
       invoice_hash, decision_id, tx_hash, payout_id, exception_id, llm_call_id, prev_hash, hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [
      e.traceId,
      seq,
      e.facilityId,
      ts,
      e.actor,
      e.kind,
      body.summary,
      e.verdict ?? null,
      e.reasonCode ?? null,
      refs.planVersion ?? null,
      refs.paymentId ?? null,
      refs.invoiceHash ?? null,
      refs.decisionId ?? null,
      refs.txHash ?? null,
      refs.payoutId ?? null,
      refs.exceptionId ?? null,
      refs.llmCallId ?? null,
      prevHash,
      hash,
    ],
  );
  return { ...body, hash } as TraceEvent;
}

/** Appends inside the caller's transaction (a PoolClient), or in its own one (a Db). */
export async function appendTrace(target: Db | PoolClient, e: TraceInput): Promise<TraceEvent> {
  if ("$client" in target) return inTx(target, (q) => appendIn(q, e));
  return appendIn(target, e);
}

/** Every trace of an /api/eval/* run starts with this: a measurement of the pipeline, never a decision of the facility. */
export const EVAL_TRACE_PREFIX = "[eval ";
/** SQL predicate on `traces` keeping the facility's own events (readers of decisions and the timeline add it). */
export const NOT_EVAL_TRACE = "summary not like '[eval %'";

/**
 * An eval run's trace: the eval prefix, and never a policy verdict (the autonomy stats and the evidence export count
 * verdicts as the agent's decisions). The verdict an eval observed stays in the summary.
 */
export async function appendEvalTrace(target: Db | PoolClient, e: Omit<TraceInput, "verdict">): Promise<TraceEvent> {
  if (!e.summary.startsWith(EVAL_TRACE_PREFIX)) throw new Error(`an eval trace summary must start with "${EVAL_TRACE_PREFIX}"`);
  const { verdict: _ignored, ...event } = e as TraceInput;
  return appendTrace(target, event);
}

interface TraceRow {
  trace_id: string;
  seq: number;
  ts: Date;
  actor: TraceEvent["actor"];
  kind: TraceEvent["kind"];
  summary: string;
  policy_verdict: TraceEvent["verdict"] | null;
  reason_code: string | null;
  plan_version: number | null;
  payment_id: string | null;
  invoice_hash: string | null;
  decision_id: string | null;
  tx_hash: string | null;
  payout_id: string | null;
  exception_id: string | null;
  llm_call_id: string | null;
  prev_hash: string;
  hash: string;
}

export const TRACE_COLUMNS =
  "trace_id, seq, ts, actor, kind, summary, policy_verdict, reason_code, plan_version, payment_id, invoice_hash, decision_id, tx_hash, payout_id, exception_id, llm_call_id, prev_hash, hash";

export function traceFromRow(r: TraceRow): TraceEvent {
  const refs = defined({
    planVersion: r.plan_version ?? undefined,
    paymentId: r.payment_id ?? undefined,
    invoiceHash: r.invoice_hash ?? undefined,
    decisionId: r.decision_id ?? undefined,
    txHash: r.tx_hash ?? undefined,
    payoutId: r.payout_id ?? undefined,
    exceptionId: r.exception_id ?? undefined,
    llmCallId: r.llm_call_id ?? undefined,
  });
  return defined({
    traceId: r.trace_id,
    seq: Number(r.seq),
    ts: new Date(r.ts).toISOString(),
    actor: r.actor,
    kind: r.kind,
    summary: r.summary,
    verdict: r.policy_verdict ?? undefined,
    reasonCode: r.reason_code ?? undefined,
    refs,
    prevHash: r.prev_hash,
    hash: r.hash,
  }) as TraceEvent;
}

export async function readTraces(q: Q, sql: string, values: readonly unknown[]): Promise<TraceEvent[]> {
  return (await rows<TraceRow>(q, sql, values)).map(traceFromRow);
}
