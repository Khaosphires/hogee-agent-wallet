/**
 * Plan drafts, signed plan versions and their lines (§12.1, §26.5 PlanDraft / PlanManifest).
 *
 * jsonb columns hold the §26.5 objects verbatim. They are typed `unknown` here because this package
 * must not import `@hogee/core`; callers narrow them with the zod schemas.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
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
} from './columns';
import { chatSessions } from './chat';
import { countryCodeEnum, lineKeyEnum, planStatusEnum } from './enums';
import { facilityRef } from './tenancy';

/**
 * G0-DECISION: not in §12.1. Persists `POST /api/plans/draft` results so that
 * `/api/plans/preview-country {draftId}`, `REPLAN {draftId}` exceptions and the PlanApproval signature
 * request can refer to a draft before any plan version exists.
 */
export const planDrafts = pgTable(
  'plan_drafts',
  {
    /** `draftId` */
    id: text('id').notNull(),
    facilityId: facilityRef(),
    sessionId: uuid('session_id'),
    /** Set for drafts produced by `/api/plans/preview-country` from another draft. */
    sourceDraftId: text('source_draft_id'),
    countryCode: countryCodeEnum('country_code').notNull(),
    intentJson: jsonb('intent_json').notNull(),
    manifestJson: jsonb('manifest_json').notNull(),
    baselineJson: jsonb('baseline_json').notNull(),
    diffJson: jsonb('diff_json').notNull(),
    blastRadiusMinor: minor('blast_radius_minor').notNull(),
    constitutionReportJson: jsonb('constitution_report_json').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // G0-REVIEW (M9): tenant-scoped keys and FKs.
    primaryKey({ name: 'plan_drafts_pk', columns: [t.facilityId, t.id] }),
    tenantFk(
      'plan_drafts_session_fk',
      [t.facilityId, t.sessionId],
      [chatSessions.facilityId, chatSessions.id],
    ),
    ...minorChecks('plan_drafts', [t.blastRadiusMinor]),
  ],
);

export const plans = pgTable(
  'plans',
  {
    id: text('id').notNull(),
    facilityId: facilityRef(),
    draftId: text('draft_id'),
    /** `PlanManifest.planId`; stable across versions of the same plan. */
    planId: text('plan_id').notNull(),
    version: integer('version').notNull(),
    /** `0x00…00` for version 1. */
    prevPlanHash: hex32('prev_plan_hash').notNull(),
    planHash: hex32('plan_hash').notNull(),
    manifestJson: jsonb('manifest_json').notNull(),
    countryPackHash: hex32('country_pack_hash').notNull(),
    status: planStatusEnum('status').notNull().default('PENDING_SIGNATURE'),
    signedAt: tstz('signed_at'),
    /** `commitPlan` tx. */
    txHash: hex32('tx_hash'),
    revertReason: text('revert_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // G0-REVIEW (M9): tenant-scoped keys and FKs.
    primaryKey({ name: 'plans_pk', columns: [t.facilityId, t.id] }),
    tenantFk('plans_draft_fk', [t.facilityId, t.draftId], [planDrafts.facilityId, planDrafts.id]),
    index('plans_facility_version_idx').on(t.facilityId, t.version),
    // Only one committed lineage per version. Rejected attempts (e.g. PlanInvariantViolated in the
    // "poison the planner" demo) may reuse the version number of the compliant retry.
    uniqueIndex('plans_facility_committed_version_unique')
      .on(t.facilityId, t.version)
      .where(sql`${t.status} IN ('COMMITTED', 'SUPERSEDED')`),
    ...hex32Checks('plans', [t.prevPlanHash, t.planHash, t.countryPackHash, t.txHash]),
  ],
);

/** One row per line of a plan version (§26.5 PlanManifest.lines). */
export const planLines = pgTable(
  'plan_lines',
  {
    /** FK to `plans(facility_id, id)` (the plan version row). */
    planId: text('plan_id').notNull(),
    facilityId: facilityRef(),
    lineKey: lineKeyEnum('line_key').notNull(),
    /** `stringToHex(lineKey, {size: 32})` (§26.3). */
    lineId: hex32('line_id').notNull(),
    purpose: text('purpose').notNull(),
    amountMinor: minor('amount_minor').notNull(),
    perTxCapMinor: minor('per_tx_cap_minor').notNull(),
    windowCapMinor: minor('window_cap_minor').notNull(),
    windowSeconds: integer('window_seconds').notNull(),
    /** Unix seconds (chain-mirrored). */
    validUntil: chainUint('valid_until').notNull(),
    escrowOnly: boolean('escrow_only').notNull().default(false),
    /** `pacing{period: day, amountMinor}`; NULL when the line has no pacing. */
    pacingAmountMinor: minor('pacing_amount_minor'),
    payeeIds: text('payee_ids')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
  },
  (t) => [
    // G0-REVIEW (M9): tenant-scoped keys and FKs.
    primaryKey({ name: 'plan_lines_pk', columns: [t.facilityId, t.planId, t.lineKey] }),
    tenantFk('plan_lines_plan_fk', [t.facilityId, t.planId], [plans.facilityId, plans.id]),
    ...hex32Checks('plan_lines', [t.lineId]),
    ...minorChecks('plan_lines', [
      t.amountMinor,
      t.perTxCapMinor,
      t.windowCapMinor,
      t.pacingAmountMinor,
    ]),
  ],
);
