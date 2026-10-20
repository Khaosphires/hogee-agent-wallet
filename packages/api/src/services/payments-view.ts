/**
 * §26.6 read model of payments and traces (task 1.12). Every statement filters by the session's facility (server
 * config, never the request), so another facility's ids simply do not exist here (T31): by id → NOT_FOUND, as a
 * cursor → VALIDATION (the same answer as an id nobody ever used), in lists → absent.
 *
 * listPayments (G0-DECISION in api-contract schemas.ts): newest first by (created_at, id); `cursor` is the paymentId
 * of the previous page's last item and is exclusive; PAYMENTS_PAGE_SIZE rows per page; the body stays a bare array
 * (a page shorter than PAYMENTS_PAGE_SIZE is the last one). Ids compare with COLLATE "C", so the order and the cursor
 * never depend on the database locale.
 *
 * listTraces (G0-DECISION): events in time order (ts, traceId, seq). With `since` (exclusive): the first `limit`
 * events after it, so a client polls with since = the last ts it holds. Without: the latest `limit` events.
 */
import type { PaymentWithTraces } from "@hogee/api-contract";
import type { LineKey, Payment, PaymentKind, PaymentState, PayoutStatus, TraceEvent } from "@hogee/core";
import type { Scope } from "../context";
import { fail } from "../http/problem";
import { one, rows, type Q } from "./sql";
import { NOT_EVAL_TRACE, readTraces, TRACE_COLUMNS } from "./traces";

export const PAYMENTS_PAGE_SIZE = 50;
export const TRACES_DEFAULT_LIMIT = 100;
/** ListTracesQuery allows 1..500; enforced again here so no caller can lift the bound. */
export const TRACES_MAX_LIMIT = 500;
/** Events returned for one payment or one trace (a trace holds a handful; this only bounds a pathological one). */
export const TRACE_EVENTS_MAX = 1000;
/** Payment.revertReason is 1..200 characters; a longer chain reason is cut. */
const REVERT_REASON_MAX = 200;

export interface PaymentsQuery {
  readonly state?: PaymentState;
  readonly lineKey?: LineKey;
  readonly cursor?: string;
}

export interface TracesQuery {
  readonly since?: string;
  readonly limit?: string;
}

export interface PaymentRow {
  id: string;
  kind: PaymentKind;
  intent_id: string;
  line_key: LineKey | null;
  payee_id: string;
  amount_minor: string;
  invoice_hash: string;
  plan_version: number;
  state: PaymentState;
  tx_hash: string | null;
  block: string | null;
  revert_reason: string | null;
  payout_id: string | null;
  payout_attempt: number;
  payout_status: PayoutStatus;
  payout_failure_code: string | null;
  decision_id: string | null;
  rationale_hash: string | null;
  trace_id: string;
  updated_at: Date;
}

export const PAYMENT_COLUMNS = `p.id, p.kind, p.intent_id, p.line_key, p.payee_id, p.amount_minor::text as amount_minor, p.invoice_hash,
  p.plan_version, p.state, p.tx_hash, p.block::text as block, p.revert_reason, p.payout_id, p.payout_attempt, p.payout_status,
  p.payout_failure_code, p.decision_id::text as decision_id, p.rationale_hash, p.trace_id, p.updated_at`;

const NEWEST_FIRST = `p.created_at desc, p.id collate "C" desc`;
const TIME_ORDER = `ts, trace_id collate "C", seq`;

export function paymentFromRow(r: PaymentRow): Payment {
  const revertReason = r.revert_reason ? r.revert_reason.slice(0, REVERT_REASON_MAX) : "";
  return {
    paymentId: r.id,
    kind: r.kind,
    intentId: r.intent_id,
    lineKey: r.line_key,
    payeeId: r.payee_id,
    amountMinor: r.amount_minor,
    invoiceHash: r.invoice_hash,
    planVersion: Number(r.plan_version),
    state: r.state,
    ...(r.tx_hash ? { txHash: r.tx_hash } : {}),
    ...(r.block !== null ? { block: Number(r.block) } : {}),
    ...(revertReason ? { revertReason } : {}),
    payout: {
      ...(r.payout_id ? { payoutId: r.payout_id } : {}),
      attempt: Number(r.payout_attempt),
      status: r.payout_status,
      ...(r.payout_failure_code ? { failureCode: r.payout_failure_code } : {}),
    },
    decisionId: r.decision_id,
    rationaleHash: r.rationale_hash,
    traceId: r.trace_id,
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

async function paymentExists(q: Q, scope: Scope, id: string): Promise<boolean> {
  return (await one(q, "select 1 as found from payments where facility_id = $1 and id = $2", [scope.facilityId, id])) !== undefined;
}

/** One page of this facility's payments, newest first, after `cursor` (exclusive) when given. */
export async function listPayments(q: Q, scope: Scope, query: PaymentsQuery): Promise<Payment[]> {
  const values: unknown[] = [scope.facilityId];
  const param = (v: unknown): string => `$${values.push(v)}`;
  const where = ["p.facility_id = $1"];
  if (query.state) where.push(`p.state = ${param(query.state)}`);
  if (query.lineKey) where.push(`p.line_key = ${param(query.lineKey)}`);
  let from = "payments p";
  if (query.cursor !== undefined) {
    if (!(await paymentExists(q, scope, query.cursor))) {
      throw fail("VALIDATION", "Unknown cursor: pass the paymentId of the last payment of the previous page");
    }
    from += ` join payments c on c.facility_id = p.facility_id and c.id = ${param(query.cursor)}`;
    where.push(`(p.created_at < c.created_at or (p.created_at = c.created_at and p.id collate "C" < c.id collate "C"))`);
  }
  const text = `select ${PAYMENT_COLUMNS} from ${from} where ${where.join(" and ")} order by ${NEWEST_FIRST} limit ${param(PAYMENTS_PAGE_SIZE)}`;
  return (await rows<PaymentRow>(q, text, values)).map(paymentFromRow);
}

/** A payment of this facility with its own trace and every event that references it, in time order. */
export async function paymentWithTraces(q: Q, scope: Scope, id: string): Promise<PaymentWithTraces> {
  const row = await one<PaymentRow>(q, `select ${PAYMENT_COLUMNS} from payments p where p.facility_id = $1 and p.id = $2`, [scope.facilityId, id]);
  if (!row) throw fail("NOT_FOUND", "No such payment");
  const traces = await readTraces(
    q,
    `select ${TRACE_COLUMNS} from traces where facility_id = $1 and (trace_id = $2 or payment_id = $3) order by ${TIME_ORDER} limit $4`,
    [scope.facilityId, row.trace_id, id, TRACE_EVENTS_MAX],
  );
  return { ...paymentFromRow(row), traces };
}

/**
 * A window of this facility's timeline in time order: after `since` (exclusive), else the latest events. Eval runs
 * (/api/eval/*) are not the founder's history and are left out; each stays readable by its trace id.
 */
export async function listTraces(q: Q, scope: Scope, query: TracesQuery): Promise<TraceEvent[]> {
  const asked = query.limit === undefined ? TRACES_DEFAULT_LIMIT : Number(query.limit);
  const limit = Math.min(Math.max(1, Number.isInteger(asked) ? asked : TRACES_DEFAULT_LIMIT), TRACES_MAX_LIMIT);
  if (query.since !== undefined) {
    return readTraces(q, `select ${TRACE_COLUMNS} from traces where facility_id = $1 and ${NOT_EVAL_TRACE} and ts > $2::timestamptz order by ${TIME_ORDER} limit $3`, [
      scope.facilityId,
      query.since,
      limit,
    ]);
  }
  return readTraces(
    q,
    `select ${TRACE_COLUMNS} from (
       select ${TRACE_COLUMNS} from traces where facility_id = $1 and ${NOT_EVAL_TRACE} order by ts desc, trace_id collate "C" desc, seq desc limit $2
     ) latest order by ${TIME_ORDER}`,
    [scope.facilityId, limit],
  );
}

/** Every event of one trace of this facility, in seq order. */
export async function traceEvents(q: Q, scope: Scope, traceId: string): Promise<TraceEvent[]> {
  const events = await readTraces(q, `select ${TRACE_COLUMNS} from traces where facility_id = $1 and trace_id = $2 order by seq limit $3`, [
    scope.facilityId,
    traceId,
    TRACE_EVENTS_MAX,
  ]);
  if (events.length === 0) throw fail("NOT_FOUND", "No such trace");
  return events;
}
