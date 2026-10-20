/**
 * Audit trail: hash-chained traces, LLM call log and evidence export runs (§12.1, §16, NFRA 二十一).
 */
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, hex32, hex32Checks, tstz } from './columns';
import {
  evidenceRunStatusEnum,
  llmRoleEnum,
  policyVerdictEnum,
  traceActorEnum,
  traceKindEnum,
} from './enums';
import { facilityRef } from './tenancy';

/**
 * §26.5 TraceEvent, append-only.
 *
 * G0-DECISION: `refs` are flattened into typed, nullable columns named after the §26.5 `refs` keys
 * (not jsonb), so `GET /api/payments/:id` (payment + traces) and evidence export can use
 * indexes. No FKs on refs: a trace may be written before the row it points at, and the audit log
 * must never block or cascade.
 *
 * Hash chain per `trace_id`: `hash = keccak256(utf8(JCS(event without hash)))`, `prev_hash` = the
 * previous event's `hash` (`0x00…00` for the first event).
 */
export const traces = pgTable(
  'traces',
  {
    traceId: text('trace_id').notNull(),
    seq: integer('seq').notNull(),
    facilityId: facilityRef(),
    ts: tstz('ts').notNull().defaultNow(),
    actor: traceActorEnum('actor').notNull(),
    kind: traceKindEnum('kind').notNull(),
    summary: text('summary').notNull(),
    policyVerdict: policyVerdictEnum('policy_verdict'),
    reasonCode: text('reason_code'),
    planVersion: integer('plan_version'),
    paymentId: text('payment_id'),
    invoiceHash: hex32('invoice_hash'),
    decisionId: uuid('decision_id'),
    txHash: hex32('tx_hash'),
    payoutId: text('payout_id'),
    exceptionId: text('exception_id'),
    llmCallId: text('llm_call_id'),
    prevHash: hex32('prev_hash').notNull(),
    hash: hex32('hash').notNull(),
  },
  (t) => [
    // G0-REVIEW (M9): tenant-scoped key; fixture trace ids can repeat across tenants.
    primaryKey({ name: 'traces_pk', columns: [t.facilityId, t.traceId, t.seq] }),
    index('traces_facility_ts_idx').on(t.facilityId, t.ts),
    index('traces_payment_idx').on(t.paymentId),
    index('traces_decision_idx').on(t.decisionId),
    index('traces_tx_hash_idx').on(t.txHash),
    ...hex32Checks('traces', [t.invoiceHash, t.txHash, t.prevHash, t.hash]),
  ],
);

/**
 * §12.1 llm_calls. Only hashes of the (already redacted, §12.2) prompt and response are stored, never
 * raw prompts: no PII lands in this table. `redaction_report` is the `@hogee/privacy` report
 * (`{entities[{type, start, end}], count}`), which holds offsets and entity types, not values.
 */
export const llmCalls = pgTable(
  'llm_calls',
  {
    id: text('id').notNull(),
    facilityId: facilityRef(),
    traceId: text('trace_id'),
    role: llmRoleEnum('role').notNull(),
    provider: text('provider').notNull(),
    modelId: text('model_id').notNull(),
    paramsJson: jsonb('params_json').notNull(),
    promptHash: hex32('prompt_hash').notNull(),
    responseHash: hex32('response_hash'),
    redactionReport: jsonb('redaction_report').notNull(),
    /** G0-DECISION: §12.1 `latency`, unit made explicit. */
    latencyMs: integer('latency_ms'),
    /** §12.1 name, kept per the §14.4 allow-list: LLM usage counts `{input, output}`. */
    tokens: jsonb('tokens').$type<{ input: number; output: number }>(),
    createdAt: createdAt(),
  },
  (t) => [
    // G0-REVIEW (M9): tenant-scoped key.
    primaryKey({ name: 'llm_calls_pk', columns: [t.facilityId, t.id] }),
    index('llm_calls_trace_idx').on(t.facilityId, t.traceId),
    ...hex32Checks('llm_calls', [t.promptHash, t.responseHash]),
  ],
);

/**
 * Task 1.16 (approved 2026-10-18; G0-DECISIONS.md §10): the preimage of every rationale commitment a decision
 * writer records (payments.rationale_hash, Spent/MilestoneFunded rationaleHash, Denied proposalHash), so the
 * evidence bundle can carry it and the verifier recompute the commitment (§16). Written in the SAME transaction as
 * the payment or denial row, by `insertRationale` (src/rationales.ts) only.
 *
 * Today rationale_hash = keccak256(utf8(JCS(rationale_json))) and `salt` is NULL; the §7.2 salted form
 * keccak256(utf8(JCS(rationale)) ‖ salt) is reserved (deviation recorded in G0-DECISIONS.md). Keyed by hash:
 * identical rationales (e.g. a re-proposed pacing slot) share one row; `decision_id` is the first decision's.
 * Rows decided before task 1.16 have no preimage here.
 */
export const rationales = pgTable(
  'rationales',
  {
    facilityId: facilityRef(),
    rationaleHash: hex32('rationale_hash').notNull(),
    decisionId: uuid('decision_id'),
    rationaleJson: jsonb('rationale_json').notNull(),
    salt: hex32('salt'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'rationales_pk', columns: [t.facilityId, t.rationaleHash] }),
    index('rationales_decision_idx').on(t.facilityId, t.decisionId),
    ...hex32Checks('rationales', [t.rationaleHash, t.salt]),
  ],
);

/**
 * G0-DECISION: not in §12.1. Tracks the async `evidence-export` job behind `POST /api/evidence/export
 * → {runId}` and `GET /api/evidence/runs` (§26.6). The bundle itself lives in `evidence/<runId>/`.
 */
export const evidenceRuns = pgTable(
  'evidence_runs',
  {
    /** `runId` */
    id: text('id').notNull(),
    facilityId: facilityRef(),
    status: evidenceRunStatusEnum('status').notNull().default('PENDING'),
    gitCommit: text('git_commit'),
    /** Bundle `manifest.json` (§26.8). */
    manifestJson: jsonb('manifest_json'),
    rowCount: integer('row_count'),
    error: text('error'),
    createdAt: createdAt(),
    finishedAt: tstz('finished_at'),
  },
  // G0-REVIEW (M9): tenant-scoped key.
  (t) => [primaryKey({ name: 'evidence_runs_pk', columns: [t.facilityId, t.id] })],
);
