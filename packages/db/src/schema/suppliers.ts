/**
 * Supplier step (§11), payees, escrow orders and invoices (§12.1, §26.5).
 *
 * Supplier and evidence rows use composite keys `(facility_id, natural_id)` because fixture IDs
 * (`data/suppliers/demo/A.json` …) are reused by every facility, including the T31 second tenant.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  chainUint,
  createdAt,
  hex32,
  hex32Checks,
  minor,
  minorChecks,
  taintCheck,
  tenantFk,
  tstz,
  updatedAt,
  type SigJson,
  type TaintJson,
} from './columns';
import {
  evidenceTierEnum,
  payeeKindEnum,
  payeeStatusEnum,
  shortlistSourceValues,
  shortlistStatusEnum,
  sourceTypeEnum,
  supplierTermsStatusValues,
} from './enums';
import { facilityRef } from './tenancy';

/** `'a', 'b'` for a CHECK `IN (...)` over a value array (fixed literals from enums.ts, never request data). */
const sqlList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/** Fixture + live check results (§12.1). `record_json` is the §26.5 Supplier object. */
export const suppliers = pgTable(
  'suppliers',
  {
    facilityId: facilityRef(),
    supplierId: text('supplier_id').notNull(),
    displayName: text('display_name').notNull(),
    /** ISO 3166-1 alpha-2 (suppliers are usually outside MY/ID, so not the `country_code` enum). */
    country: text('country').notNull(),
    recordJson: jsonb('record_json').notNull(),
    /** GLEIF / sanctions / USCC / SSM validator results. */
    checkResultsJson: jsonb('check_results_json'),
    evidenceTier: evidenceTierEnum('evidence_tier').notNull(),
    sourceType: sourceTypeEnum('source_type').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: 'suppliers_pk', columns: [t.facilityId, t.supplierId] }),
    check('suppliers_country_iso2', sql`${t.country} ~ '^[A-Z]{2}$'`),
  ],
);

/** §26.5 SupplierEvidence. */
export const supplierEvidence = pgTable(
  'supplier_evidence',
  {
    facilityId: facilityRef(),
    evidenceId: text('evidence_id').notNull(),
    supplierId: text('supplier_id').notNull(),
    /** One of the 7 §11 criteria. */
    criterion: text('criterion').notNull(),
    tier: evidenceTierEnum('tier').notNull(),
    sourceType: sourceTypeEnum('source_type').notNull(),
    sourceUrl: text('source_url'),
    /** `0x` + sha256 of the normalised sentence (§26.3). */
    snippetHash: hex32('snippet_hash'),
    value: jsonb('value'),
    taint: jsonb('taint').$type<TaintJson>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'supplier_evidence_pk', columns: [t.facilityId, t.evidenceId] }),
    foreignKey({
      name: 'supplier_evidence_supplier_fk',
      columns: [t.facilityId, t.supplierId],
      foreignColumns: [suppliers.facilityId, suppliers.supplierId],
    }),
    index('supplier_evidence_supplier_idx').on(t.facilityId, t.supplierId),
    ...hex32Checks('supplier_evidence', [t.snippetHash]),
    taintCheck('supplier_evidence', t.taint),
  ],
);

/**
 * G0-DECISION: not in §12.1. Backs `POST /api/suppliers/shortlist → {requestId}` and polling
 * `GET /api/suppliers/shortlist/:id` until READY (§26.6), plus the Planner tool `getShortlist`.
 * `result_json` is the §26.5 Shortlist (kept whole because `shortlistHash` commits to it).
 */
export const shortlists = pgTable(
  'shortlists',
  {
    /** `requestId` */
    id: text('id').notNull(),
    facilityId: facilityRef(),
    status: shortlistStatusEnum('status').notNull().default('PENDING'),
    specJson: jsonb('spec_json').notNull(),
    resultJson: jsonb('result_json'),
    shortlistHash: hex32('shortlist_hash'),
    weightsVersion: text('weights_version'),
    error: text('error'),
    /**
     * VISION-DECISIONS §6 (0004_chat_first): `catalog` (the demo catalog shortlist) or `web` (a web supplier search).
     * Reads, reuse and supersede are per source (api services/shortlist.ts).
     */
    source: text('source').notNull().default('catalog'),
    /** VISION-DECISIONS §6: the §3 SupplierSearch body of a `web` row (null for catalog rows). */
    searchJson: jsonb('search_json'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // G0-REVIEW (M9): tenant-scoped key.
    primaryKey({ name: 'shortlists_pk', columns: [t.facilityId, t.id] }),
    ...hex32Checks('shortlists', [t.shortlistHash]),
    check('shortlists_source', sql`${t.source} IN (${sqlList(shortlistSourceValues)})`),
  ],
);

/**
 * §12.1 payees. Payees never come from text and plans cannot add payees (§13.1); a row is created
 * only from a founder-signed SupplierApproval or the static platform registry.
 *
 * G0-REVIEW (M9): key `(facility_id, id)`. Payee ids are client-meaningful ShortIds (`supplier-a`,
 * `shopee-ads`, `spx-logistics`; bytes32 on-chain via stringToHex) and repeat across tenants.
 */
export const payees = pgTable(
  'payees',
  {
    id: text('id').notNull(),
    facilityId: facilityRef(),
    kind: payeeKindEnum('kind').notNull(),
    displayName: text('display_name').notNull(),
    /** Set when `kind = supplier`. */
    supplierId: text('supplier_id'),
    /** Xendit TEST account reference only (§9.1). */
    xenditAccountRef: text('xendit_account_ref'),
    /**
     * G0-REVIEW (3b): hash of the payout destination that the founder signs in SupplierApproval
     * (static registry value for platform payees). Settlement must pay only to the account whose
     * hash matches.
     */
    payoutAccountHash: hex32('payout_account_hash').notNull(),
    /** lineIds (Hex32) this payee is bound to. */
    boundLineIds: text('bound_line_ids')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    approvalSig: jsonb('approval_sig').$type<SigJson>(),
    /** Unix seconds (chain-mirrored cooling period end). */
    coolingUntil: chainUint('cooling_until'),
    status: payeeStatusEnum('status').notNull().default('PENDING'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: 'payees_pk', columns: [t.facilityId, t.id] }),
    foreignKey({
      name: 'payees_supplier_fk',
      columns: [t.facilityId, t.supplierId],
      foreignColumns: [suppliers.facilityId, suppliers.supplierId],
    }),
    check(
      'payees_supplier_kind',
      sql`${t.kind} <> 'supplier' OR ${t.supplierId} IS NOT NULL`,
    ),
    ...hex32Checks('payees', [t.payoutAccountHash]),
  ],
);

/**
 * G0-DECISION: not in §12.1. One row per founder-signed SupplierApproval (§8.7): the order header
 * whose `scheduleHash` commits to `escrow_milestones`. Needed to build `bindPayee(...)`, to derive
 * `settlementId = keccak256(abi.encode(orderId, idx))` and to serve `GET /api/escrow/:orderId`.
 *
 * G0-REVIEW (M9): key `(facility_id, order_id)`; order ids are ShortIds (`order-a-001`, bytes32
 * on-chain via stringToHex) and repeat across tenants.
 */
export const escrowOrders = pgTable(
  'escrow_orders',
  {
    orderId: text('order_id').notNull(),
    facilityId: facilityRef(),
    supplierId: text('supplier_id').notNull(),
    payeeId: text('payee_id').notNull(),
    scheduleHash: hex32('schedule_hash').notNull(),
    totalMinor: minor('total_minor').notNull(),
    quoteHash: hex32('quote_hash'),
    shortlistHash: hex32('shortlist_hash'),
    chosenIndex: integer('chosen_index'),
    inspectionRequired: boolean('inspection_required').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'escrow_orders_pk', columns: [t.facilityId, t.orderId] }),
    foreignKey({
      name: 'escrow_orders_supplier_fk',
      columns: [t.facilityId, t.supplierId],
      foreignColumns: [suppliers.facilityId, suppliers.supplierId],
    }),
    tenantFk('escrow_orders_payee_fk', [t.facilityId, t.payeeId], [payees.facilityId, payees.id]),
    ...hex32Checks('escrow_orders', [t.scheduleHash, t.quoteHash, t.shortlistHash]),
    ...minorChecks('escrow_orders', [t.totalMinor]),
  ],
);

/** G0-DECISION: not in §12.1. Signed milestone schedule + mirrored funded/released amounts. */
export const escrowMilestones = pgTable(
  'escrow_milestones',
  {
    orderId: text('order_id').notNull(),
    idx: integer('idx').notNull(),
    facilityId: facilityRef(),
    amountMinor: minor('amount_minor').notNull(),
    /** Cumulative funded (partial fundings allowed, T18). */
    fundedMinor: minor('funded_minor').notNull().default('0'),
    releasedMinor: minor('released_minor').notNull().default('0'),
    autoRelease: boolean('auto_release').notNull(),
    /** Inspection evidence hash (`POST /api/escrow/:orderId/inspection`). */
    evidenceHash: hex32('evidence_hash'),
    updatedAt: updatedAt(),
  },
  (t) => [
    // G0-REVIEW (M9): tenant-scoped key and FK.
    primaryKey({ name: 'escrow_milestones_pk', columns: [t.facilityId, t.orderId, t.idx] }),
    tenantFk(
      'escrow_milestones_order_fk',
      [t.facilityId, t.orderId],
      [escrowOrders.facilityId, escrowOrders.orderId],
    ),
    ...hex32Checks('escrow_milestones', [t.evidenceHash]),
    ...minorChecks('escrow_milestones', [t.amountMinor, t.fundedMinor, t.releasedMinor]),
  ],
);

/** §12.1 / §26.5 Invoice. Extracted fields come from the quarantined Reader and are untrusted. */
export const invoices = pgTable(
  'invoices',
  {
    id: text('id').notNull(),
    facilityId: facilityRef(),
    payeeId: text('payee_id').notNull(),
    orderId: text('order_id'),
    milestoneIdx: integer('milestone_idx'),
    amountMinor: minor('amount_minor').notNull(),
    invoiceHash: hex32('invoice_hash').notNull(),
    extractedFieldsJson: jsonb('extracted_fields_json').notNull(),
    taint: jsonb('taint').$type<TaintJson>().notNull(),
    flags: text('flags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    receivedAt: tstz('received_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // G0-REVIEW (M9): tenant-scoped key and FKs.
    primaryKey({ name: 'invoices_pk', columns: [t.facilityId, t.id] }),
    tenantFk('invoices_payee_fk', [t.facilityId, t.payeeId], [payees.facilityId, payees.id]),
    tenantFk(
      'invoices_order_fk',
      [t.facilityId, t.orderId],
      [escrowOrders.facilityId, escrowOrders.orderId],
    ),
    uniqueIndex('invoices_facility_invoice_hash_unique').on(t.facilityId, t.invoiceHash),
    ...hex32Checks('invoices', [t.invoiceHash]),
    ...minorChecks('invoices', [t.amountMinor]),
    taintCheck('invoices', t.taint),
  ],
);

/**
 * VISION-DECISIONS §6 (0004_chat_first): the supplier terms a founder confirmed over POST /api/orders/terms, before they
 * sign the SupplierApproval. `payout_account_ref` is the canonical JSON {channel: "MOCK_ONLY", accountNumber,
 * holderName} (the channel is fixed server-side, "simulated payout") and `payout_account_hash` its keccak256, which the
 * founder signs. Rows are immutable apart from the status move (CONFIRMED → SUPERSEDED, or CONFIRMED → USED together
 * with `order_id`); the service enforces that (drizzle-kit manages no triggers). One live row (CONFIRMED or USED) per
 * supplier and facility: a correction supersedes, and a web supplier gets one order.
 */
export const supplierTerms = pgTable(
  'supplier_terms',
  {
    id: text('id').notNull(),
    facilityId: facilityRef(),
    shortlistId: text('shortlist_id').notNull(),
    supplierId: text('supplier_id').notNull(),
    /** The candidate's index in the shortlist / search (SupplierApproval.chosenIndex, uint8). */
    chosenIndex: integer('chosen_index').notNull(),
    currency: text('currency').notNull(),
    quoteTotalMinor: minor('quote_total_minor').notNull(),
    quantity: integer('quantity').notNull(),
    /** MilestoneInput[] as the founder confirmed them. */
    termsJson: jsonb('terms_json').notNull(),
    /** ScheduleRow[] computed by core termsToSchedule at confirm time. */
    scheduleJson: jsonb('schedule_json').notNull(),
    payoutAccountRef: text('payout_account_ref').notNull(),
    payoutAccountHash: hex32('payout_account_hash').notNull(),
    bankName: text('bank_name').notNull(),
    /** Personal payees are refused (TERMS_PAYEE_PERSONAL), so only a company is ever stored. */
    payeeType: text('payee_type').notNull(),
    quoteHash: hex32('quote_hash').notNull(),
    status: text('status').notNull().default('CONFIRMED'),
    orderId: text('order_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: 'supplier_terms_pk', columns: [t.facilityId, t.id] }),
    foreignKey({
      name: 'supplier_terms_supplier_fk',
      columns: [t.facilityId, t.supplierId],
      foreignColumns: [suppliers.facilityId, suppliers.supplierId],
    }),
    tenantFk('supplier_terms_shortlist_fk', [t.facilityId, t.shortlistId], [shortlists.facilityId, shortlists.id]),
    tenantFk('supplier_terms_order_fk', [t.facilityId, t.orderId], [escrowOrders.facilityId, escrowOrders.orderId]),
    uniqueIndex('supplier_terms_facility_supplier_live_unique')
      .on(t.facilityId, t.supplierId)
      .where(sql`${t.status} IN ('CONFIRMED', 'USED')`),
    check('supplier_terms_status', sql`${t.status} IN (${sqlList(supplierTermsStatusValues)})`),
    check('supplier_terms_used_iff_order', sql`(${t.status} = 'USED') = (${t.orderId} IS NOT NULL)`),
    check('supplier_terms_chosen_index_uint8', sql`${t.chosenIndex} >= 0 AND ${t.chosenIndex} <= 255`),
    check('supplier_terms_quantity_positive', sql`${t.quantity} >= 1`),
    check('supplier_terms_currency_iso4217', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('supplier_terms_payee_company', sql`${t.payeeType} = 'company'`),
    check('supplier_terms_terms_json_array', sql`jsonb_typeof(${t.termsJson}) = 'array'`),
    check('supplier_terms_schedule_json_array', sql`jsonb_typeof(${t.scheduleJson}) = 'array'`),
    ...hex32Checks('supplier_terms', [t.payoutAccountHash, t.quoteHash]),
    ...minorChecks('supplier_terms', [t.quoteTotalMinor]),
  ],
);
