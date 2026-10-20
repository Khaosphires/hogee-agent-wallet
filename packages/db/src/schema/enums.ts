/**
 * Postgres enums. Every value array is exported `as const` so a parity test can compare it with the
 * zod enums in `@hogee/core` (this package must not import core).
 *
 * Arrays marked "§26.x" are frozen spec values. Arrays marked `G0-DECISION` are not in the spec and
 * were chosen here; they need lead approval.
 */
import { pgEnum } from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------------------------
// Frozen spec enums
// ---------------------------------------------------------------------------------------------

/** §26.4 */
export const countryCodeValues = ['MY', 'ID', 'SG'] as const;
/** §26.4 */
export const residencyValues = ['citizen', 'pr', 'foreigner'] as const;
/** §26.3 LineKey */
export const lineKeyValues = [
  'SUPPLIER',
  'PACKAGING',
  'LOGISTICS',
  'ADS',
  'PLATFORM_FEES',
  'LICENSING',
  'CONTINGENCY',
] as const;
/** §26.3 Sourced.evidence */
export const evidenceTierValues = ['tier1', 'tier2', 'tier3'] as const;
/** §26.3 Sourced.sourceType */
export const sourceTypeValues = ['live', 'mock'] as const;
/** §26.3 Taint.trust (stored inside `taint` jsonb; checked by a CHECK constraint) */
export const taintTrustValues = ['trusted', 'untrusted'] as const;
/** §26.3 Taint.sensitivity (stored inside `taint` jsonb; checked by a CHECK constraint) */
export const taintSensitivityValues = ['public', 'private'] as const;

/**
 * §26.5 Payment.kind. G0-REVIEW (H4): + OWNER_SPEND (founder's manual fallback, `ownerSpend`) and
 * WITHDRAW_RESERVE (reserve withdrawal after timelock), mirrored in @hogee/core PAYMENT_KINDS.
 */
export const paymentKindValues = [
  'SPEND',
  'FUND_MILESTONE',
  'RELEASE_MILESTONE',
  'OWNER_SPEND',
  'WITHDRAW_RESERVE',
] as const;
/** §26.5 Payment.state (state machine in §12.3) */
export const paymentStateValues = [
  'PROPOSED',
  'POLICY_DENIED',
  'POLICY_OK',
  'SIGNED',
  'BROADCAST',
  'INCLUDED',
  'FINALIZED',
  'SETTLEMENT_REQUESTED',
  'SETTLED',
  'SETTLEMENT_FAILED',
  'REVERTED',
  'DROPPED',
  // G0-AUDIT (v-4): terminal. The row's nonce was consumed by another tx (no-op cancel or a different
  // tx), so its signed bytes can never execute. Same position as @hogee/core PAYMENT_STATES. Only the
  // worker sets it, from `finalized` reads, with proof (`payments.nonce_consumed_by_tx_hash`, payments.ts).
  'CANCELLED',
] as const;
/** §26.5 Payment.payout.status */
export const payoutStatusValues = ['NONE', 'REQUESTED', 'SUCCEEDED', 'FAILED'] as const;

/** §26.5 Exception.kind */
export const exceptionKindValues = [
  'RAISE_CAP',
  'ADD_PAYEE',
  'EXTEND_EXPIRY',
  'MOVE_POCKETS',
  'UNPAUSE',
  'WITHDRAW_RESERVE',
  'RELEASE_ESCROW_BALANCE',
  'RELEASE_STAGE',
  'REPLAN',
  'POLICY_ESCALATION',
] as const;
/** §26.5 Exception.status */
export const exceptionStatusValues = [
  'OPEN',
  'FOUNDER_SIGNED',
  'APPROVED',
  'QUEUED',
  'EXECUTABLE',
  'EXECUTED',
  'DENIED',
  'CANCELLED',
  'EXPIRED',
] as const;

/** §26.5 TraceEvent.actor */
export const traceActorValues = [
  'planner',
  'reader',
  'policy',
  'txbuilder',
  'executor',
  'worker',
  'founder',
  'officer',
  'oracle',
  'reconciler',
] as const;
/** §26.5 TraceEvent.kind */
export const traceKindValues = [
  'LLM_CALL',
  'TOOL_CALL',
  'PROPOSAL',
  'POLICY_VERDICT',
  'TX',
  'PAYOUT',
  'SIGNATURE',
  'EXCEPTION',
  'DENIAL',
  'ALERT',
] as const;
/** §26.5 TraceEvent.verdict (also the policy engine result, §7.2) */
export const policyVerdictValues = ['AUTO', 'NEEDS_FOUNDER', 'NEEDS_OFFICER', 'DENY'] as const;

/** §26.4 ChainAction.state */
export const chainActionStateValues = [
  'PENDING',
  'BROADCAST',
  'INCLUDED',
  'FINALIZED',
  'REVERTED',
] as const;
/** §26.4 Shortlist.status */
export const shortlistStatusValues = ['PENDING', 'READY', 'FAILED'] as const;

/** §26.6 POST /api/signatures/request `kind` */
export const signatureKindValues = [
  'PlanApproval',
  'SupplierApproval',
  'MilestoneRelease',
  'LoosenRequest',
  'StageRelease',
  'OwnerSpend', // G0-DECISION: owner's manual-fallback spend, signed then relayed (IHogee.sol)
] as const;
/** §26.6 POST /api/signatures/request `method` */
export const signatureMethodValues = ['passkey', 'eip712'] as const;
/** §12.1 payees.kind */
export const payeeKindValues = ['supplier', 'platform'] as const;
/** §26.6 POST /api/passkey/register/verify `onchain` */
export const founderKeyStatusValues = ['PENDING_LENDER', 'REGISTERED'] as const;

// ---------------------------------------------------------------------------------------------
// G0-DECISION enums (not in the spec)
// ---------------------------------------------------------------------------------------------

/**
 * G0-DECISION: plans.status, identical to @hogee/core PLAN_STATUSES (parity test).
 * PENDING_SIGNATURE → SUBMITTED (founder signature stored, commit tx in flight) → COMMITTED.
 * REVERTED = commit reverted (e.g. PlanInvariantViolated, StalePlan). SUPERSEDED = a newer version committed.
 */
export const planStatusValues = [
  'PENDING_SIGNATURE',
  'SUBMITTED',
  'COMMITTED',
  'SUPERSEDED',
  'REVERTED',
] as const;
/** G0-DECISION: payees.status. COOLING = bound on-chain, cooling period running; CANCELLED = vetoed (T3). */
export const payeeStatusValues = ['PENDING', 'COOLING', 'BOUND', 'CANCELLED'] as const;
/** G0-DECISION: signature_requests.status. */
export const signatureRequestStatusValues = ['PENDING', 'SUBMITTED', 'REJECTED', 'EXPIRED'] as const;
/** G0-DECISION: evidence_runs.status (async evidence-export job). */
export const evidenceRunStatusValues = ['PENDING', 'READY', 'FAILED'] as const;
/**
 * G0-DECISION: memory_entries.source (§7.4). Only trusted provenance exists as a value, so an
 * untrusted source can never be persisted as memory (T14).
 */
export const memorySourceValues = ['USER_TURN', 'ORACLE_FACT'] as const;
/** G0-DECISION: chat_messages.role (AI SDK UI message roles). */
export const chatRoleValues = ['system', 'user', 'assistant'] as const;
/** G0-DECISION: llm_calls.role, from the §7.1 model roles that run in the runtime/eval path. */
export const llmRoleValues = ['planner', 'reader', 'explainer', 'judge', 'classifier'] as const;

/**
 * VISION-DECISIONS §6 (0004_chat_first): shortlists.source, identical to @hogee/core SUPPLIER_ORIGINS (parity test).
 * Stored as text + CHECK (not a pg enum), so a later value needs no ALTER TYPE.
 */
export const shortlistSourceValues = ['catalog', 'web'] as const;
/** VISION-DECISIONS §6: supplier_terms.status, identical to @hogee/core TERMS_STATUSES (text + CHECK). */
export const supplierTermsStatusValues = ['CONFIRMED', 'SUPERSEDED', 'USED'] as const;

// ---------------------------------------------------------------------------------------------
// pg enums
// ---------------------------------------------------------------------------------------------

export const countryCodeEnum = pgEnum('country_code', countryCodeValues);
export const residencyEnum = pgEnum('residency', residencyValues);
export const lineKeyEnum = pgEnum('line_key', lineKeyValues);
export const evidenceTierEnum = pgEnum('evidence_tier', evidenceTierValues);
export const sourceTypeEnum = pgEnum('source_type', sourceTypeValues);
export const paymentKindEnum = pgEnum('payment_kind', paymentKindValues);
export const paymentStateEnum = pgEnum('payment_state', paymentStateValues);
export const payoutStatusEnum = pgEnum('payout_status', payoutStatusValues);
export const exceptionKindEnum = pgEnum('exception_kind', exceptionKindValues);
export const exceptionStatusEnum = pgEnum('exception_status', exceptionStatusValues);
export const traceActorEnum = pgEnum('trace_actor', traceActorValues);
export const traceKindEnum = pgEnum('trace_kind', traceKindValues);
export const policyVerdictEnum = pgEnum('policy_verdict', policyVerdictValues);
export const chainActionStateEnum = pgEnum('chain_action_state', chainActionStateValues);
export const shortlistStatusEnum = pgEnum('shortlist_status', shortlistStatusValues);
export const signatureKindEnum = pgEnum('signature_kind', signatureKindValues);
export const signatureMethodEnum = pgEnum('signature_method', signatureMethodValues);
export const payeeKindEnum = pgEnum('payee_kind', payeeKindValues);
export const founderKeyStatusEnum = pgEnum('founder_key_status', founderKeyStatusValues);
export const planStatusEnum = pgEnum('plan_status', planStatusValues);
export const payeeStatusEnum = pgEnum('payee_status', payeeStatusValues);
export const signatureRequestStatusEnum = pgEnum(
  'signature_request_status',
  signatureRequestStatusValues,
);
export const evidenceRunStatusEnum = pgEnum('evidence_run_status', evidenceRunStatusValues);
export const memorySourceEnum = pgEnum('memory_source', memorySourceValues);
export const chatRoleEnum = pgEnum('chat_role', chatRoleValues);
export const llmRoleEnum = pgEnum('llm_role', llmRoleValues);

// ---------------------------------------------------------------------------------------------
// TS unions
// ---------------------------------------------------------------------------------------------

export type CountryCode = (typeof countryCodeValues)[number];
export type Residency = (typeof residencyValues)[number];
export type LineKey = (typeof lineKeyValues)[number];
export type EvidenceTier = (typeof evidenceTierValues)[number];
export type SourceType = (typeof sourceTypeValues)[number];
export type TaintTrust = (typeof taintTrustValues)[number];
export type TaintSensitivity = (typeof taintSensitivityValues)[number];
export type PaymentKind = (typeof paymentKindValues)[number];
export type PaymentState = (typeof paymentStateValues)[number];
export type PayoutStatus = (typeof payoutStatusValues)[number];
export type ExceptionKind = (typeof exceptionKindValues)[number];
export type ExceptionStatus = (typeof exceptionStatusValues)[number];
export type TraceActor = (typeof traceActorValues)[number];
export type TraceKind = (typeof traceKindValues)[number];
export type PolicyVerdict = (typeof policyVerdictValues)[number];
export type ChainActionState = (typeof chainActionStateValues)[number];
export type ShortlistStatus = (typeof shortlistStatusValues)[number];
export type SignatureKind = (typeof signatureKindValues)[number];
export type SignatureMethod = (typeof signatureMethodValues)[number];
export type PayeeKind = (typeof payeeKindValues)[number];
export type FounderKeyStatus = (typeof founderKeyStatusValues)[number];
export type PlanStatus = (typeof planStatusValues)[number];
export type PayeeStatus = (typeof payeeStatusValues)[number];
export type SignatureRequestStatus = (typeof signatureRequestStatusValues)[number];
export type EvidenceRunStatus = (typeof evidenceRunStatusValues)[number];
export type MemorySource = (typeof memorySourceValues)[number];
export type ChatRole = (typeof chatRoleValues)[number];
export type LlmRole = (typeof llmRoleValues)[number];
export type ShortlistSource = (typeof shortlistSourceValues)[number];
export type SupplierTermsStatus = (typeof supplierTermsStatusValues)[number];
