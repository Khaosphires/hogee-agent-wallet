/**
 * Reads one facility's decision evidence from Postgres into the bundle's shapes (tools/verify-evidence bundle.ts):
 * payments (with the worker's raw signed bytes once mined), chain_actions, signature_requests, plans, traces,
 * llm_calls and the rationale preimages (rationales, then denials.proposal_json). A committed rationaleHash with no
 * stored preimage refuses the export (EvidenceIncompleteError): no deployment predates task 1.16 (run-6 v-4).
 * Eval traces (`[eval …`, no policy verdict) are measurements, not decisions: a trace with any eval event is left out
 * whole (its hash chain stays intact) and so are the LLM calls it names. Every query is scoped by facility_id.
 *
 * Traces past MAX_ROWS_PER_TABLE (audit run-7, after the eval filter) no longer refuse the export: every trace an
 * exported row or an exception names (payments, denials, exceptions) is kept whole, then the newest other traces whole
 * while they fit, and the older ones are left out (counted in `omittedTraces`, and logged by the export). Only when the
 * named traces alone exceed the cap is the export refused (EvidenceTooLargeError).
 *
 * Tables an anonymous caller can grow are never capped whole (run-7 re-check H1):
 *   signature_requests: only the requests the verifier reads are collected (SUBMITTED, a stored signature, or a chain
 *     action: signatures.ts and plans.ts); the unused rest (PENDING, EXPIRED, REJECTED) is counted in
 *     `omittedSignatures`.
 *   llm_calls: windowed like traces. Every call a kept trace holds or names is kept, then the newest others while they
 *     fit; the oldest are left out whole (`omittedLlmCalls`). A chat turn's trace is therefore not named by its calls.
 */
import { PlanManifest, TraceEvent, TypedData, SignatureSubmitBody } from "@hogee/core";
import type { ChainActionEntry, LlmCallEntry, PaymentEntry, PlanEntry, RationaleEntry, SignatureEntry } from "@hogee/verify-evidence";
import type { QueryResultRow } from "pg";
import type { z } from "zod";
import type { Scope } from "../context";
import { PAYMENT_COLUMNS, paymentFromRow, type PaymentRow } from "../services/payments-view";
import { rows, type Q } from "../services/sql";
import { EVAL_TRACE_PREFIX, TRACE_COLUMNS, traceFromRow } from "../services/traces";

/** A facility above these sizes is not exported (the bundle must stay loadable in a browser tab). */
export const MAX_ROWS_PER_TABLE = 50_000;

export interface Collected {
  readonly payments: PaymentEntry[];
  readonly chainActions: ChainActionEntry[];
  readonly signatures: SignatureEntry[];
  readonly plans: PlanEntry[];
  readonly traces: z.infer<typeof TraceEvent>[];
  readonly llmCalls: z.infer<typeof LlmCallEntry>[];
  readonly rationales: RationaleEntry[];
  readonly denials: { readonly id: string; readonly decisionId: string; readonly reasonCode: string; readonly traceId: string | null; readonly recordedTx: string | null }[];
  readonly excludedEvalTraces: number;
  /** Unnamed traces left out past MAX_ROWS_PER_TABLE: how many trace ids, and their events. */
  readonly omittedTraces: { readonly traces: number; readonly events: number };
  /** Signature requests the verifier does not read (never submitted, no chain action), left out. */
  readonly omittedSignatures: number;
  /** LLM calls no kept trace holds or names, left out oldest first past MAX_ROWS_PER_TABLE. */
  readonly omittedLlmCalls: number;
}

export class EvidenceTooLargeError extends Error {
  override readonly name = "EvidenceTooLargeError";
}

/** The facility's evidence is incomplete (e.g. a decision without its preimage): no bundle is written. */
export class EvidenceIncompleteError extends Error {
  override readonly name = "EvidenceIncompleteError";
}

async function capped<T extends QueryResultRow>(q: Q, table: string, sql: string, values: readonly unknown[]): Promise<T[]> {
  const out = await rows<T>(q, `${sql} limit ${MAX_ROWS_PER_TABLE + 1}`, values);
  if (out.length > MAX_ROWS_PER_TABLE) throw new EvidenceTooLargeError(`${table} has more than ${MAX_ROWS_PER_TABLE} rows for this facility`);
  return out;
}

const iso = (d: Date | string): string => new Date(d).toISOString();
const num = (v: string | number | null): number | null => (v === null ? null : Number(v));

type SignedCols = { signer_address: string | null; nonce: string | null; raw_signed_tx: string | null };
/** The raw signed bytes only once a tx exists (an unbroadcast row's bytes stay private). */
const signed = (r: SignedCols, txHash: string | null) => ({
  signerAddress: r.signer_address,
  nonce: r.nonce,
  rawSignedTx: txHash ? r.raw_signed_tx : null,
});

async function payments(q: Q, scope: Scope): Promise<PaymentEntry[]> {
  const list = await capped<PaymentRow & SignedCols & { order_id: string | null; milestone_idx: number | null; nonce_consumed_by_tx_hash: string | null }>(
    q,
    "payments",
    `select ${PAYMENT_COLUMNS}, p.order_id, p.milestone_idx, p.signer_address, p.nonce::text as nonce, p.raw_signed_tx, p.nonce_consumed_by_tx_hash
       from payments p where p.facility_id = $1 order by p.created_at, p.id collate "C"`,
    [scope.facilityId],
  );
  // A CANCELLED row names the tx that consumed its nonce; fetch.ts adds that tx's receipt and signed bytes from the node.
  const consumer = (r: { state: string; nonce_consumed_by_tx_hash: string | null }) =>
    r.state === "CANCELLED" && r.nonce_consumed_by_tx_hash ? { txHash: r.nonce_consumed_by_tx_hash.toLowerCase(), rawSignedTx: null } : null;
  return list.map((r) => ({ payment: paymentFromRow(r), orderId: r.order_id, milestoneIdx: num(r.milestone_idx), nonceConsumedBy: consumer(r), ...signed(r, r.tx_hash) }) as PaymentEntry);
}

async function chainActions(q: Q, scope: Scope): Promise<ChainActionEntry[]> {
  const list = await capped<SignedCols & { id: string; kind: string; ref_id: string | null; state: string; tx_hash: string | null; block: string | null; revert_reason: string | null; created_at: Date }>(
    q,
    "chain_actions",
    `select id, kind, ref_id, state, tx_hash, block::text as block, revert_reason, signer_address, nonce::text as nonce, raw_signed_tx, created_at
       from chain_actions where facility_id = $1 order by created_at, id collate "C"`,
    [scope.facilityId],
  );
  return list.map(
    (r) =>
      ({
        actionId: r.id,
        kind: r.kind,
        refId: r.ref_id,
        state: r.state,
        txHash: r.tx_hash,
        block: num(r.block),
        revertReason: r.revert_reason ? r.revert_reason.slice(0, 200) : null,
        createdAt: iso(r.created_at),
        ...signed(r, r.tx_hash),
      }) as ChainActionEntry,
  );
}

/**
 * The requests a bundle uses: the verifier checks a signature only on a SUBMITTED request or one with a stored
 * submission (signatures.ts), and finds a PlanApproval by its chain action (plans.ts). An unused request (PENDING,
 * EXPIRED or REJECTED with neither) proves nothing, and anyone can create them (re-check H1), so it is only counted.
 */
type SignatureRow = { id: string; kind: string; ref_id: string; method: string; typed_data_json: unknown; digest: string; status: string; signature_json: unknown; chain_action_id: string | null };

const USED_REQUEST = "(status = 'SUBMITTED' or signature_json is not null or chain_action_id is not null)";

async function signatures(q: Q, scope: Scope): Promise<{ list: SignatureEntry[]; omitted: number }> {
  const list = await capped<SignatureRow>(
    q,
    "signature_requests",
    `select id, kind, ref_id, method, typed_data_json, digest, status, signature_json, chain_action_id
       from signature_requests where facility_id = $1 and ${USED_REQUEST} order by created_at, id collate "C"`,
    [scope.facilityId],
  );
  const [unused] = await rows<{ n: number }>(q, `select count(*)::int as n from signature_requests where facility_id = $1 and not ${USED_REQUEST}`, [scope.facilityId]);
  return { list: list.map(signatureEntry), omitted: Number(unused?.n ?? 0) };
}

function signatureEntry(r: SignatureRow): SignatureEntry {
  const submission = SignatureSubmitBody.safeParse(r.signature_json);
  return {
    requestId: r.id,
    kind: r.kind,
    refId: r.ref_id,
    method: r.method,
    typedData: TypedData.parse(r.typed_data_json),
    digest: r.digest,
    status: r.status,
    submission: submission.success ? submission.data : null,
    chainActionId: r.chain_action_id,
  } as SignatureEntry;
}

async function plans(q: Q, scope: Scope): Promise<PlanEntry[]> {
  const list = await capped<{ id: string; version: number; status: string; plan_hash: string; prev_plan_hash: string; country_pack_hash: string; tx_hash: string | null; manifest_json: unknown }>(
    q,
    "plans",
    `select id, version, status, plan_hash, prev_plan_hash, country_pack_hash, tx_hash, manifest_json
       from plans where facility_id = $1 order by version, created_at, id collate "C"`,
    [scope.facilityId],
  );
  return list.map(
    (r) =>
      ({
        planRowId: r.id,
        version: Number(r.version),
        status: r.status,
        planHash: r.plan_hash,
        prevPlanHash: r.prev_plan_hash,
        countryPackHash: r.country_pack_hash,
        txHash: r.tx_hash,
        manifest: PlanManifest.parse(r.manifest_json),
      }) as PlanEntry,
  );
}

/** One trace id of the facility: its event count, newest event, whether it is an eval run's, and whether a row names it. */
export interface TraceStat {
  readonly traceId: string;
  readonly events: number;
  readonly lastMs: number;
  readonly evalTrace: boolean;
  readonly named: boolean;
}

export interface TraceSelection {
  /** Trace ids to export whole. */
  readonly keep: readonly string[];
  readonly excludedEval: ReadonlySet<string>;
  readonly omitted: { readonly traces: number; readonly events: number };
}

const sum = (list: readonly TraceStat[]): number => list.reduce((n, s) => n + s.events, 0);

/**
 * Which traces the bundle carries, whole: never an eval trace; every named one; then the newest unnamed ones while the
 * events fit in `max`, so the oldest unnamed ones are left out. The cap counts events after the eval filter.
 */
export function selectTraces(stats: readonly TraceStat[], max = MAX_ROWS_PER_TABLE): TraceSelection {
  const excludedEval = new Set(stats.filter((s) => s.evalTrace).map((s) => s.traceId));
  const decisions = stats.filter((s) => !s.evalTrace);
  const named = decisions.filter((s) => s.named);
  let used = sum(named);
  if (used > max) throw new EvidenceTooLargeError(`traces: the ${used} events of the traces exported rows name exceed ${max}`);
  const keep = named.map((s) => s.traceId);
  const others = decisions.filter((s) => !s.named).sort((a, b) => b.lastMs - a.lastMs || (a.traceId < b.traceId ? -1 : a.traceId > b.traceId ? 1 : 0));
  let i = 0;
  for (; i < others.length && used + (others[i]?.events ?? 0) <= max; i += 1) {
    keep.push(others[i]?.traceId as string);
    used += others[i]?.events ?? 0;
  }
  const dropped = others.slice(i);
  return { keep, excludedEval, omitted: { traces: dropped.length, events: sum(dropped) } };
}

/**
 * Trace ids the exported rows (payments, denials) and the facility's exceptions name. LLM calls do not name their
 * trace (re-check H1): every chat turn writes one, so a chat trace is windowed like any unnamed trace, and the calls
 * follow the traces that are kept (`llmCalls`).
 */
const NAMED_TRACES = `select trace_id from payments where facility_id = $1
  union select trace_id from denials where facility_id = $1 and trace_id is not null
  union select trace_id from exceptions where facility_id = $1 and trace_id is not null`;

interface CollectedTraces {
  readonly events: z.infer<typeof TraceEvent>[];
  /** Kept trace ids (never an eval trace). */
  readonly kept: readonly string[];
  readonly excluded: ReadonlySet<string>;
  readonly omitted: TraceSelection["omitted"];
}

async function traces(q: Q, scope: Scope): Promise<CollectedTraces> {
  const stats = await rows<{ trace_id: string; n: number; last: Date; eval: boolean; named: boolean }>(
    q,
    `select t.trace_id, count(*)::int as n, max(t.ts) as last, bool_or(t.summary like $2) as eval, bool_or(r.trace_id is not null) as named
       from traces t left join (${NAMED_TRACES}) r on r.trace_id = t.trace_id
      where t.facility_id = $1 group by t.trace_id`,
    [scope.facilityId, `${EVAL_TRACE_PREFIX}%`],
  );
  const pick = selectTraces(stats.map((r) => ({ traceId: r.trace_id, events: Number(r.n), lastMs: new Date(r.last).getTime(), evalTrace: r.eval === true, named: r.named === true })));
  const events =
    pick.keep.length === 0
      ? []
      : (
          await rows<Parameters<typeof traceFromRow>[0]>(
            q,
            `select ${TRACE_COLUMNS} from traces where facility_id = $1 and trace_id = any($2::text[]) order by trace_id collate "C", seq`,
            [scope.facilityId, pick.keep],
          )
        ).map(traceFromRow);
  // Defence in depth: an id kept above can only gain events if a writer appended between the two reads.
  const kept = events.filter((t) => !pick.excludedEval.has(t.traceId) && !t.summary.startsWith(EVAL_TRACE_PREFIX));
  return { events: kept, kept: pick.keep, excluded: pick.excludedEval, omitted: pick.omitted };
}

type LlmCallRow = {
  id: string;
  trace_id: string | null;
  role: string;
  provider: string;
  model_id: string;
  params_json: unknown;
  prompt_hash: string;
  response_hash: string | null;
  redaction_report: unknown;
  latency_ms: number | null;
  tokens: { input: number; output: number } | null;
  created_at: Date;
  needed: boolean;
  total: number;
  needed_total: number;
};

/**
 * The LLM call log, windowed like traces (re-check H1): never a call of an eval trace; every call a kept trace holds
 * (its trace_id) or names (an event's refs.llmCallId, which the verifier requires); then the newest others while they
 * fit in MAX_ROWS_PER_TABLE. The oldest others are left out and counted. A kept trace has at most MAX_ROWS_PER_TABLE
 * events, so the named calls alone exceed the cap only if one trace holds calls it never names.
 */
async function llmCalls(q: Q, scope: Scope, tr: CollectedTraces): Promise<{ list: z.infer<typeof LlmCallEntry>[]; omitted: number }> {
  const named = [...new Set(tr.events.flatMap((t) => (t.refs.llmCallId ? [t.refs.llmCallId] : [])))];
  const list = await rows<LlmCallRow>(
    q,
    `with c as (
       select id, trace_id, role, provider, model_id, params_json, prompt_hash, response_hash, redaction_report, latency_ms, tokens, created_at,
              coalesce(id = any($2::text[]) or trace_id = any($3::text[]), false) as needed
         from llm_calls where facility_id = $1 and (trace_id is null or not (trace_id = any($4::text[]))))
     select *, count(*) over ()::int as total, (count(*) filter (where needed) over ())::int as needed_total
       from c order by needed desc, created_at desc, id collate "C" desc limit $5`,
    [scope.facilityId, named, tr.kept, [...tr.excluded], MAX_ROWS_PER_TABLE],
  );
  const neededTotal = Number(list[0]?.needed_total ?? 0);
  if (neededTotal > MAX_ROWS_PER_TABLE) throw new EvidenceTooLargeError(`llm_calls: the ${neededTotal} calls the kept traces hold or name exceed ${MAX_ROWS_PER_TABLE}`);
  const omitted = Number(list[0]?.total ?? 0) - list.length;
  const ordered = [...list].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { list: ordered.map(llmCallEntry), omitted };
}

function llmCallEntry(r: LlmCallRow): z.infer<typeof LlmCallEntry> {
  return {
    llmCallId: r.id,
    traceId: r.trace_id,
    role: r.role as z.infer<typeof LlmCallEntry>["role"],
    provider: r.provider,
    modelId: r.model_id,
    params: r.params_json as z.infer<typeof LlmCallEntry>["params"],
    promptHash: r.prompt_hash,
    responseHash: r.response_hash,
    redactionReport: r.redaction_report as z.infer<typeof LlmCallEntry>["redactionReport"],
    latencyMs: r.latency_ms,
    tokens: r.tokens ? { input: Number(r.tokens.input), output: Number(r.tokens.output) } : null,
    createdAt: iso(r.created_at),
  };
}

/** Preimages for every commitment a payment or denial names; one that is not stored refuses the export. */
async function rationales(q: Q, scope: Scope, pay: readonly PaymentEntry[]): Promise<RationaleEntry[]> {
  const stored = await capped<{ rationale_hash: string; decision_id: string | null; rationale_json: unknown; salt: string | null }>(
    q,
    "rationales",
    "select rationale_hash, decision_id::text as decision_id, rationale_json, salt from rationales where facility_id = $1 order by rationale_hash",
    [scope.facilityId],
  );
  const legacy = await capped<{ proposal_hash: string; decision_id: string; proposal_json: unknown }>(
    q,
    "denials",
    "select proposal_hash, decision_id::text as decision_id, proposal_json from denials where facility_id = $1 order by created_at, id collate \"C\"",
    [scope.facilityId],
  );
  const decisions = new Map<string, Set<string>>();
  const named = (hash: string, decisionId: string | null) => {
    const set = decisions.get(hash) ?? new Set<string>();
    if (decisionId) set.add(decisionId);
    decisions.set(hash, set);
  };
  for (const { payment } of pay) if (payment.rationaleHash) named(payment.rationaleHash, payment.decisionId);
  for (const d of legacy) named(d.proposal_hash, d.decision_id);
  const decisionOf = (hash: string, fallback: string | null): string | null => {
    const set = decisions.get(hash);
    return set && set.size > 1 ? null : (set?.values().next().value ?? fallback);
  };
  const out = new Map<string, RationaleEntry>();
  for (const r of stored) out.set(r.rationale_hash, { status: "available", rationaleHash: r.rationale_hash, decisionId: decisionOf(r.rationale_hash, r.decision_id), rationale: r.rationale_json as never, salt: r.salt } as RationaleEntry);
  for (const d of legacy) {
    if (!out.has(d.proposal_hash)) out.set(d.proposal_hash, { status: "available", rationaleHash: d.proposal_hash, decisionId: decisionOf(d.proposal_hash, d.decision_id), rationale: d.proposal_json as never, salt: null } as RationaleEntry);
  }
  const missing = [...decisions.keys()].filter((hash) => !out.has(hash)).sort();
  if (missing.length > 0) {
    throw new EvidenceIncompleteError(
      `${missing.length} committed rationaleHash(es) have no stored preimage (first: ${missing[0]}); every decision since task 1.16 stores one, so the evidence was altered or lost and no bundle is written`,
    );
  }
  return [...out.values()].sort((a, b) => (a.rationaleHash < b.rationaleHash ? -1 : 1));
}

async function denialRows(q: Q, scope: Scope): Promise<Collected["denials"]> {
  const list = await capped<{ id: string; decision_id: string; reason_code: string; trace_id: string | null; recorded_tx: string | null }>(
    q,
    "denials",
    "select id, decision_id::text as decision_id, reason_code, trace_id, recorded_tx from denials where facility_id = $1 order by created_at, id collate \"C\"",
    [scope.facilityId],
  );
  return list.map((r) => ({ id: r.id, decisionId: r.decision_id, reasonCode: r.reason_code, traceId: r.trace_id, recordedTx: r.recorded_tx }));
}

export async function collect(q: Q, scope: Scope): Promise<Collected> {
  const pay = await payments(q, scope);
  const tr = await traces(q, scope);
  const denials = await denialRows(q, scope);
  const sigs = await signatures(q, scope);
  const calls = await llmCalls(q, scope, tr);
  return {
    payments: pay,
    chainActions: await chainActions(q, scope),
    signatures: sigs.list,
    plans: await plans(q, scope),
    traces: tr.events,
    llmCalls: calls.list,
    rationales: await rationales(q, scope, pay),
    denials,
    excludedEvalTraces: tr.excluded.size,
    omittedTraces: tr.omitted,
    omittedSignatures: sigs.omitted,
    omittedLlmCalls: calls.omitted,
  };
}
