/**
 * Human oversight: exceptions (§26.5 Exception) and generic signature requests (§26.6 SignDialog).
 */
import { boolean, index, jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import {
  chainUint,
  createdAt,
  hex32,
  hex32Checks,
  minor,
  minorChecks,
  tenantFk,
  tstz,
  updatedAt,
  type SigJson,
} from './columns';
import {
  exceptionKindEnum,
  exceptionStatusEnum,
  signatureKindEnum,
  signatureMethodEnum,
  signatureRequestStatusEnum,
} from './enums';
import { chainActions } from './payments';
import { facilityRef } from './tenancy';

/**
 * §12.1 exceptions plus the §26.5 Exception fields (title, reason, requires, timelock, blast radius,
 * traceId). `payload` shape depends on `kind` (§26.5 table).
 */
export const exceptions = pgTable(
  'exceptions',
  {
    id: text('id').notNull(),
    facilityId: facilityRef(),
    kind: exceptionKindEnum('kind').notNull(),
    title: text('title').notNull(),
    payload: jsonb('payload').notNull(),
    reason: text('reason'),
    /** Persona or actor that opened it (founder / officer / planner / stage-gate). */
    requestedBy: text('requested_by').notNull(),
    requiresFounder: boolean('requires_founder').notNull(),
    requiresLender: boolean('requires_lender').notNull(),
    status: exceptionStatusEnum('status').notNull().default('OPEN'),
    founderSig: jsonb('founder_sig').$type<SigJson>(),
    lenderSig: jsonb('lender_sig').$type<SigJson>(),
    /** On-chain loosen id returned by `queueLoosen`, used by `executeLoosen(id)` / `cancelLoosen(id)`. */
    loosenId: text('loosen_id'),
    /** Off-chain time the queue tx was sent. */
    queuedAt: tstz('queued_at'),
    /** Unix seconds (chain-mirrored timelock end). */
    executableAt: chainUint('executable_at'),
    queuedTx: hex32('queued_tx'),
    executedTx: hex32('executed_tx'),
    blastRadiusMinor: minor('blast_radius_minor').notNull().default('0'),
    /** Reason given on deny / veto. */
    decisionReason: text('decision_reason'),
    traceId: text('trace_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // G0-REVIEW (M9): tenant-scoped key.
    primaryKey({ name: 'exceptions_pk', columns: [t.facilityId, t.id] }),
    index('exceptions_facility_status_idx').on(t.facilityId, t.status),
    ...hex32Checks('exceptions', [t.queuedTx, t.executedTx]),
    ...minorChecks('exceptions', [t.blastRadiusMinor]),
  ],
);

/**
 * G0-DECISION: not in §12.1. Backs `POST /api/signatures/request` → `{requestId, typedData, digest,
 * challengeB64url, displayModel, expiresAt}` and `POST /api/signatures/:id/submit` (§26.6).
 * The display model is rendered from the same canonical JSON as the digest (§13.1 principle 5).
 */
export const signatureRequests = pgTable(
  'signature_requests',
  {
    /** `requestId` */
    id: text('id').notNull(),
    facilityId: facilityRef(),
    kind: signatureKindEnum('kind').notNull(),
    /** draftId / orderId / exceptionId / stageId / paymentId (OwnerSpend), depending on `kind`. */
    refId: text('ref_id').notNull(),
    method: signatureMethodEnum('method').notNull(),
    typedDataJson: jsonb('typed_data_json').notNull(),
    digest: hex32('digest').notNull(),
    challengeB64url: text('challenge_b64url').notNull(),
    displayModelJson: jsonb('display_model_json').notNull(),
    /** EIP-712 struct `nonce` (chain-mirrored). */
    nonce: chainUint('nonce').notNull(),
    /** EIP-712 struct `expiry`, unix seconds (chain-mirrored). */
    expiresAt: chainUint('expires_at').notNull(),
    status: signatureRequestStatusEnum('status').notNull().default('PENDING'),
    /** Submitted passkey assertion or ECDSA signature (the §26.6 submit body). */
    signatureJson: jsonb('signature_json'),
    chainActionId: text('chain_action_id'),
    submittedAt: tstz('submitted_at'),
    createdAt: createdAt(),
  },
  (t) => [
    // G0-REVIEW (M9): tenant-scoped key and FK.
    primaryKey({ name: 'signature_requests_pk', columns: [t.facilityId, t.id] }),
    tenantFk(
      'signature_requests_chain_action_fk',
      [t.facilityId, t.chainActionId],
      [chainActions.facilityId, chainActions.id],
    ),
    index('signature_requests_ref_idx').on(t.facilityId, t.kind, t.refId),
    ...hex32Checks('signature_requests', [t.digest]),
  ],
);
