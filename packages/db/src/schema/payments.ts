/**
 * Payments state machine, worker signing tables, sales oracle and denials (§9, §12.1, §12.3).
 *
 * Crash safety (§12.3, T19), implemented in tasks 1.5/1.6 on top of these tables:
 * 1. In ONE DB transaction: `SELECT next_nonce FROM nonces WHERE signer_address=$1 AND chain_id=$2
 *    FOR UPDATE`, sign, write `raw_signed_tx` + `nonce` (+ signer/chain) on the payment or chain action,
 *    set state SIGNED, increment `nonces.next_nonce`, COMMIT.
 * 2. Only then broadcast. Recovery rebroadcasts the SAME bytes or fee-bumps the SAME nonce; it never
 *    signs a new tx for an open intent (checks `isIntentUsed(intentId)` and `Spent` logs first).
 * The `*_signed_tx_atomic` / `*_signed_state_has_tx` CHECKs make the half-written states unrepresentable.
 *
 * G0-REVIEW (M11): `(signer_address, chain_id, nonce)` is UNIQUE (where set) on `payments` and on
 * `chain_actions`, each separately. One row owns a nonce for good: a fee-bump, rebroadcast or
 * replacement of the same intent updates that row's `raw_signed_tx` instead of inserting a new row.
 * Both tables draw from the same `nonces` row under FOR UPDATE; a single cross-table UNIQUE would need
 * a shared ledger table or a trigger, which drizzle-kit does not manage.
 */
import { sql } from 'drizzle-orm';
import {
  check,
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
  address,
  addressChecks,
  chainId,
  chainUint,
  createdAt,
  hex32,
  hex32ArrayCheck,
  hex32Checks,
  minor,
  minorChecks,
  nonNegativeChecks,
  rawTx,
  rawTxCheck,
  signedTxChecks,
  tenantFk,
  updatedAt,
} from './columns';
import {
  chainActionStateEnum,
  lineKeyEnum,
  paymentKindEnum,
  paymentStateEnum,
  payoutStatusEnum,
} from './enums';
import { escrowOrders, payees } from './suppliers';
import { facilityRef } from './tenancy';

/** Payment states in which nothing has been signed yet. */
export const UNSIGNED_PAYMENT_STATES = ['PROPOSED', 'POLICY_DENIED', 'POLICY_OK'] as const;

/**
 * G0-REVIEW (H4): payment kinds without an agent decision (same list as @hogee/core
 * NON_AGENT_PAYMENT_KINDS). They carry no `decision_id` / `rationale_hash` (CHECK
 * `payments_decision_iff_agent_kind`). The reconciler matches owner spends through the
 * `signature_requests` row (kind `OwnerSpend`, `ref_id` = payment id) and the on-chain `OwnerSpent`
 * event, instead of the `Spent` + rationaleHash match used for agent spends.
 */
export const NON_AGENT_PAYMENT_KINDS = ['OWNER_SPEND', 'WITHDRAW_RESERVE'] as const;

/** All-zero Hex32: the `invoice_hash` of a WITHDRAW_RESERVE payment (no invoice). */
export const ZERO_HEX32 = `0x${'0'.repeat(64)}`;

/**
 * Payment states whose `intent_id` no longer blocks a new row for the same intent: rows whose tx can
 * never execute.
 * G0-AUDIT (v-4): not DROPPED. Its signed bytes can still be mined at its unused nonce (§12.3), so a
 * second row for the intent could execute one decision twice (FUND_MILESTONE has no on-chain intent
 * registry). See `payments.intent_id`.
 */
export const INTENT_RELEASED_STATES = ['POLICY_DENIED', 'REVERTED', 'CANCELLED'] as const;

const sqlList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * §12.1 / §26.5 Payment. Key `(facility_id, id)` (G0-REVIEW M9).
 *
 * `intent_id` (G0-REVIEW M11):
 * - SPEND: `keccak256(abi.encode(planId, lineId, payeeId, invoiceHash, amount))`, the on-chain intent
 *   (§8.4, `isIntentUsed`).
 * - FUND_MILESTONE: off-chain key `keccak256(abi.encode(orderId, idx, amountMinor, cumulativeAfterMinor))`.
 *   `fundMilestone` has no on-chain intent registry, so crash recovery reads the on-chain funded amount
 *   for (orderId, idx) before resending: if it already reaches `cumulativeAfterMinor`, the funding landed.
 * - OWNER_SPEND: its on-chain spendId. WITHDRAW_RESERVE: the loosen id (core `Payment.intentId`).
 * - RELEASE_MILESTONE: defined by the tx builder in `packages/chain`.
 * Unique per facility while the row is live; POLICY_DENIED / REVERTED / CANCELLED rows release it.
 * G0-AUDIT (v-4): a DROPPED row keeps its intent, because its signed bytes can still be mined at its
 * nonce. Rebroadcast and fee bump update that same row in place (M11). A DROPPED row leaves that state
 * only by DROPPED → INCLUDED (its bytes got mined after all; still holding the intent) → FINALIZED or
 * REVERTED, or by DROPPED → CANCELLED.
 *
 * G0-AUDIT (v-4): the two signed exits that release the intent need proof; only the worker sets them.
 * - REVERTED (finding 9): only from a revert receipt read at `finalized`. Until then the row stays
 *   INCLUDED and holds the intent, because a reorg can drop a non-final revert and the same bytes can
 *   then succeed. CHECK `payments_reverted_has_receipt`: the row records the receipt's block and tx hash.
 * - CANCELLED (finding 8): only from `finalized` reads, after checking that (a) the tx that consumed the
 *   row's nonce is none of the hashes ever signed for this row (`tx_hash`, `superseded_tx_hashes`), and
 *   (b) the on-chain effect shows the intent was NOT applied: SPEND / OWNER_SPEND `isIntentUsed` false;
 *   FUND_MILESTONE `fundedMinor` of (orderId, idx) below `cumulativeAfterMinor`; RELEASE_MILESTONE
 *   `released` false; WITHDRAW_RESERVE the loosen not executed (`queuedLoosen(loosenId).status`).
 *   The DB enforces (a) against the recorded hashes (CHECKs `payments_cancelled_iff_nonce_consumed`,
 *   `payments_nonce_consumed_by_foreign_tx`); (b) is the worker's duty.
 */
export const payments = pgTable(
  'payments',
  {
    id: text('id').notNull(),
    facilityId: facilityRef(),
    kind: paymentKindEnum('kind').notNull(),
    intentId: hex32('intent_id').notNull(),
    /** G0-REVIEW: NULL exactly for WITHDRAW_RESERVE (the reserve is not a line), as in core `Payment`. */
    lineKey: lineKeyEnum('line_key'),
    /** `stringToHex(lineKey, {size: 32})` (§26.3). NULL exactly when `line_key` is NULL. */
    lineId: hex32('line_id'),
    payeeId: text('payee_id').notNull(),
    /** G0-DECISION: set for FUND_MILESTONE / RELEASE_MILESTONE (settlementId derivation, §9.1). */
    orderId: text('order_id'),
    milestoneIdx: integer('milestone_idx'),
    amountMinor: minor('amount_minor').notNull(),
    /**
     * G0-REVIEW (M11): required, as in core `Payment`. No-invoice lines use the on-chain per-line
     * sequence number as bytes32; milestone kinds use the milestone invoice's hash; WITHDRAW_RESERVE
     * uses ZERO_HEX32 (CHECK `payments_withdraw_reserve_zero_invoice`).
     */
    invoiceHash: hex32('invoice_hash').notNull(),
    planVersion: integer('plan_version').notNull(),
    state: paymentStateEnum('state').notNull().default('PROPOSED'),
    /** G0-DECISION: the nonce belongs to (signer_address, chain_id) in `nonces`. */
    signerAddress: address('signer_address'),
    chainId: chainId(),
    rawSignedTx: rawTx(),
    nonce: chainUint('nonce'),
    txHash: hex32('tx_hash'),
    /**
     * G0-AUDIT (v-4, finding 8): every tx hash ever signed for this row other than the current
     * `tx_hash`. A fee bump or same-intent replacement overwrites `raw_signed_tx` / `tx_hash` in place
     * (M11) and appends the previous `tx_hash` here in the SAME UPDATE, because the earlier bytes can
     * still be the ones mined at the nonce. Lowercase Hex32 elements, no NULLs
     * (CHECK `payments_superseded_tx_hashes_hex32`).
     */
    supersededTxHashes: text('superseded_tx_hashes').array().notNull().default(sql`'{}'::text[]`),
    /**
     * G0-AUDIT (v-4, finding 8): the foreign tx that consumed this row's nonce, read at `finalized`. Set
     * exactly when state = CANCELLED, and never the row's own `tx_hash` or an element of
     * `superseded_tx_hashes` (see the CANCELLED rule above).
     */
    nonceConsumedByTxHash: hex32('nonce_consumed_by_tx_hash'),
    /** G0-AUDIT (v-4, finding 9): required for REVERTED (the finalized receipt's block). */
    block: chainUint('block'),
    revertReason: text('revert_reason'),
    /** G0-DECISION: `spendId` from `Spent`, or `keccak256(abi.encode(orderId, idx))` (§9.1 step 4). */
    settlementId: hex32('settlement_id'),
    payoutId: text('payout_id'),
    /** Xendit idempotency-key uses this attempt; a FAILED payout is retried with attempt+1 (§9.1). */
    payoutAttempt: integer('payout_attempt').notNull().default(0),
    payoutStatus: payoutStatusEnum('payout_status').notNull().default('NONE'),
    payoutFailureCode: text('payout_failure_code'),
    /** UUIDv7 (§26.3). G0-REVIEW (H4): NULL exactly for OWNER_SPEND / WITHDRAW_RESERVE. */
    decisionId: uuid('decision_id'),
    /** G0-REVIEW (H4): NULL exactly for OWNER_SPEND / WITHDRAW_RESERVE. */
    rationaleHash: hex32('rationale_hash'),
    /** G0-REVIEW (M11): required, as in core `Payment`. */
    traceId: text('trace_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: 'payments_pk', columns: [t.facilityId, t.id] }),
    tenantFk('payments_payee_fk', [t.facilityId, t.payeeId], [payees.facilityId, payees.id]),
    tenantFk(
      'payments_order_fk',
      [t.facilityId, t.orderId],
      [escrowOrders.facilityId, escrowOrders.orderId],
    ),
    // G0-REVIEW (M11): partial, so a denied / reverted / cancelled attempt does not block the intent.
    // G0-AUDIT (v-4): a DROPPED row still blocks it; its signed bytes can still be mined at its nonce.
    uniqueIndex('payments_facility_intent_id_unique')
      .on(t.facilityId, t.intentId)
      .where(sql`${t.state} NOT IN (${sqlList(INTENT_RELEASED_STATES)})`),
    // G0-REVIEW (M11): one row per signer nonce.
    uniqueIndex('payments_signer_nonce_unique')
      .on(t.signerAddress, t.chainId, t.nonce)
      .where(sql`${t.nonce} IS NOT NULL`),
    index('payments_facility_state_idx').on(t.facilityId, t.state),
    index('payments_state_idx').on(t.state),
    // Reconciler (§9.3, T29): every Spent must match a payment with the same rationaleHash.
    index('payments_rationale_hash_idx').on(t.rationaleHash),
    index('payments_tx_hash_idx').on(t.txHash),
    // G0-REVIEW (H4): agent kinds always carry a decision + rationale; owner kinds never do.
    check(
      'payments_decision_iff_agent_kind',
      sql`CASE WHEN ${t.kind} IN (${sqlList(NON_AGENT_PAYMENT_KINDS)}) THEN ${t.decisionId} IS NULL AND ${t.rationaleHash} IS NULL ELSE ${t.decisionId} IS NOT NULL AND ${t.rationaleHash} IS NOT NULL END`,
    ),
    // G0-REVIEW: the reserve is not a line; line_key and line_id are NULL exactly for WITHDRAW_RESERVE.
    check(
      'payments_line_iff_not_reserve',
      sql`CASE WHEN ${t.kind} = 'WITHDRAW_RESERVE' THEN ${t.lineKey} IS NULL AND ${t.lineId} IS NULL ELSE ${t.lineKey} IS NOT NULL AND ${t.lineId} IS NOT NULL END`,
    ),
    // G0-REVIEW: a reserve withdrawal has no invoice.
    check(
      'payments_withdraw_reserve_zero_invoice',
      sql`${t.kind} <> 'WITHDRAW_RESERVE' OR ${t.invoiceHash} = ${sql.raw(`'${ZERO_HEX32}'`)}`,
    ),
    // G0-REVIEW (M11): milestone kinds name their (orderId, idx), which crash recovery reads on-chain.
    check(
      'payments_milestone_ref',
      sql`${t.kind} NOT IN ('FUND_MILESTONE', 'RELEASE_MILESTONE') OR (${t.orderId} IS NOT NULL AND ${t.milestoneIdx} IS NOT NULL)`,
    ),
    ...hex32Checks('payments', [
      t.intentId,
      t.lineId,
      t.invoiceHash,
      t.txHash,
      t.nonceConsumedByTxHash,
      t.settlementId,
      t.rationaleHash,
    ]),
    hex32ArrayCheck('payments', t.supersededTxHashes),
    ...addressChecks('payments', [t.signerAddress]),
    ...minorChecks('payments', [t.amountMinor]),
    rawTxCheck('payments', t.rawSignedTx),
    ...signedTxChecks(
      'payments',
      {
        rawSignedTx: t.rawSignedTx,
        nonce: t.nonce,
        signerAddress: t.signerAddress,
        chainId: t.chainId,
      },
      t.state,
      UNSIGNED_PAYMENT_STATES,
    ),
    // G0-AUDIT (v-4): POLICY_DENIED releases the intent, so a denied row must never hold signed bytes
    // (with `payments_signed_tx_atomic`, it holds no nonce either). CANCELLED is a signed state: it was
    // signed before its nonce was consumed, so `payments_signed_state_has_tx` keeps its bytes.
    check(
      'payments_policy_denied_unsigned',
      sql`${t.state} <> 'POLICY_DENIED' OR ${t.rawSignedTx} IS NULL`,
    ),
    // G0-AUDIT (v-4, finding 8): CANCELLED releases the intent, so it names the tx that consumed the
    // nonce, and that tx must be none of the row's own hashes. A missing tx_hash fails (nothing to compare
    // against); array_position is NULL-safe where `= ANY` would yield NULL.
    check(
      'payments_cancelled_iff_nonce_consumed',
      sql`(${t.state} = 'CANCELLED') = (${t.nonceConsumedByTxHash} IS NOT NULL)`,
    ),
    check(
      'payments_nonce_consumed_by_foreign_tx',
      sql`${t.nonceConsumedByTxHash} IS NULL OR (${t.txHash} IS NOT NULL AND ${t.nonceConsumedByTxHash} <> ${t.txHash} AND array_position(${t.supersededTxHashes}, ${t.nonceConsumedByTxHash}) IS NULL)`,
    ),
    // G0-AUDIT (v-4, finding 9): REVERTED releases the intent, so it records the finalized receipt.
    check(
      'payments_reverted_has_receipt',
      sql`${t.state} <> 'REVERTED' OR (${t.block} IS NOT NULL AND ${t.txHash} IS NOT NULL)`,
    ),
  ],
);

/**
 * Worker nonce allocator (§12.3). No `facility_id`: one row per signer key per chain, shared by every
 * facility the key serves. Always read with `SELECT … FOR UPDATE` inside the signing transaction.
 */
export const nonces = pgTable(
  'nonces',
  {
    signerAddress: address('signer_address').notNull(),
    chainId: chainId().notNull(),
    nextNonce: chainUint('next_nonce').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: 'nonces_pk', columns: [t.signerAddress, t.chainId] }),
    ...addressChecks('nonces', [t.signerAddress]),
    ...nonNegativeChecks('nonces', [t.nextNonce]),
  ],
);

/** Chunked `getLogs` checkpoint per contract per chain (§9.1). No `facility_id`. */
export const logCheckpoints = pgTable(
  'log_checkpoints',
  {
    contract: address('contract').notNull(),
    chainId: chainId().notNull(),
    lastBlock: chainUint('last_block').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: 'log_checkpoints_pk', columns: [t.contract, t.chainId] }),
    ...addressChecks('log_checkpoints', [t.contract]),
    ...nonNegativeChecks('log_checkpoints', [t.lastBlock]),
  ],
);

/** Chain action states in which nothing has been broadcast (PENDING may already be signed). */
export const UNSIGNED_CHAIN_ACTION_STATES = ['PENDING'] as const;

/**
 * G0-DECISION: not in §12.1. Outbox for every non-payment tx the worker signs (`openFacility`,
 * `fund`, `registerFounderKey`, `commitPlan`, `bindPayee`, `pause`, `recordSale`, `recordDenied`,
 * `queueLoosen`, `executeLoosen`, `releaseStage`, `releaseMilestone`, `confirmSettlement`, …).
 * Backs the frozen `ChainAction{actionId, state, txHash?}` responses (§26.4, §26.6) and gives those txs
 * the same raw-tx + nonce crash safety as payments.
 */
export const chainActions = pgTable(
  'chain_actions',
  {
    /** `actionId` */
    id: text('id').notNull(),
    facilityId: facilityRef(),
    /** `<Contract>.<function>`, e.g. `Treasury.openFacility`. */
    kind: text('kind').notNull(),
    /** Id of the row this action serves (exception, sale, denial, plan, payment for settlement, …). */
    refId: text('ref_id'),
    state: chainActionStateEnum('state').notNull().default('PENDING'),
    signerAddress: address('signer_address'),
    chainId: chainId(),
    rawSignedTx: rawTx(),
    nonce: chainUint('nonce'),
    txHash: hex32('tx_hash'),
    block: chainUint('block'),
    revertReason: text('revert_reason'),
    requestJson: jsonb('request_json'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // G0-REVIEW (M9): tenant-scoped key.
    primaryKey({ name: 'chain_actions_pk', columns: [t.facilityId, t.id] }),
    // G0-REVIEW (M11): one row per signer nonce.
    uniqueIndex('chain_actions_signer_nonce_unique')
      .on(t.signerAddress, t.chainId, t.nonce)
      .where(sql`${t.nonce} IS NOT NULL`),
    index('chain_actions_state_idx').on(t.state),
    index('chain_actions_ref_idx').on(t.facilityId, t.refId),
    ...hex32Checks('chain_actions', [t.txHash]),
    ...addressChecks('chain_actions', [t.signerAddress]),
    rawTxCheck('chain_actions', t.rawSignedTx),
    ...signedTxChecks(
      'chain_actions',
      {
        rawSignedTx: t.rawSignedTx,
        nonce: t.nonce,
        signerAddress: t.signerAddress,
        chainId: t.chainId,
      },
      t.state,
      UNSIGNED_CHAIN_ACTION_STATES,
    ),
  ],
);

/**
 * §9.2 sales oracle. Only the hashed sale id and the bucketed amount are stored (§14.1); the raw
 * amount and buyer data are never persisted. Both uniques mirror on-chain `DuplicateSale` (T23).
 * G0-REVIEW (M9): key and uniques are per facility (one facility = one deployment's SalesOracle), so
 * a second tenant seeded from the same fixtures does not conflict.
 */
export const sales = pgTable(
  'sales',
  {
    id: text('id').notNull(),
    facilityId: facilityRef(),
    stripeEventId: text('stripe_event_id').notNull(),
    /** `keccak256(event.id)` */
    saleIdHash: hex32('sale_id_hash').notNull(),
    /** Bucketed amount in minor units (`recordSale(saleIdHash, amountBucket)`). */
    amountBucket: minor('amount_bucket').notNull(),
    txHash: hex32('tx_hash'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'sales_pk', columns: [t.facilityId, t.id] }),
    uniqueIndex('sales_facility_stripe_event_id_unique').on(t.facilityId, t.stripeEventId),
    uniqueIndex('sales_facility_sale_id_hash_unique').on(t.facilityId, t.saleIdHash),
    ...hex32Checks('sales', [t.saleIdHash, t.txHash]),
    ...minorChecks('sales', [t.amountBucket]),
  ],
);

/** §12.1 denials: policy DENY results, anchored with `recordDenied(decisionId, reasonCode, proposalHash)`. */
export const denials = pgTable(
  'denials',
  {
    id: text('id').notNull(),
    facilityId: facilityRef(),
    decisionId: uuid('decision_id').notNull(),
    proposalJson: jsonb('proposal_json').notNull(),
    proposalHash: hex32('proposal_hash').notNull(),
    reason: text('reason').notNull(),
    reasonCode: text('reason_code').notNull(),
    recordedTx: hex32('recorded_tx'),
    traceId: text('trace_id'),
    createdAt: createdAt(),
  },
  (t) => [
    // G0-REVIEW (M9): tenant-scoped key.
    primaryKey({ name: 'denials_pk', columns: [t.facilityId, t.id] }),
    ...hex32Checks('denials', [t.proposalHash, t.recordedTx]),
  ],
);
