/**
 * Enums (project.md §26.4, §8.5, §26.5, §26.6). Frozen at G0.
 * Each enum exports its value array (UPPER_SNAKE) and a zod schema + type (PascalCase).
 */
import { z } from "zod";

// ---- §26.3 provenance / taint -------------------------------------------------------------
export const EVIDENCE_TIERS = ["tier1", "tier2", "tier3"] as const;
export const SOURCE_TYPES = ["live", "mock"] as const;
export const TRUST_LEVELS = ["trusted", "untrusted"] as const;
export const SENSITIVITIES = ["public", "private"] as const;

// ---- §26.3 / §26.4 domain ------------------------------------------------------------------
export const LINE_KEYS = ["SUPPLIER", "PACKAGING", "LOGISTICS", "ADS", "PLATFORM_FEES", "LICENSING", "CONTINGENCY"] as const;
export const LineKey = z.enum(LINE_KEYS);
export type LineKey = z.infer<typeof LineKey>;

export const COUNTRY_CODES = ["MY", "ID", "SG"] as const;
export const CountryCode = z.enum(COUNTRY_CODES);
export type CountryCode = z.infer<typeof CountryCode>;

export const RESIDENCIES = ["citizen", "pr", "foreigner"] as const;
export const Residency = z.enum(RESIDENCIES);
export type Residency = z.infer<typeof Residency>;

export const PRODUCT_CATEGORIES = ["drinkware_food_contact", "cosmetics", "electrical", "apparel", "food", "other"] as const;
export const ProductCategory = z.enum(PRODUCT_CATEGORIES);
export type ProductCategory = z.infer<typeof ProductCategory>;

export const ENTITY_TYPES_MY = ["sole_prop", "partnership", "sdn_bhd"] as const;
export const ENTITY_TYPES_ID = ["perorangan", "pt_perorangan", "cv", "pt"] as const;
// SG-DECISIONS: sg_sole_prop / sg_partnership register a business name with ACRA (BizFile+); pte_ltd incorporates.
export const ENTITY_TYPES_SG = ["sg_sole_prop", "sg_partnership", "pte_ltd"] as const;
export const ENTITY_TYPES = [...ENTITY_TYPES_MY, ...ENTITY_TYPES_ID, ...ENTITY_TYPES_SG] as const;
export const EntityTypeMY = z.enum(ENTITY_TYPES_MY);
export const EntityTypeID = z.enum(ENTITY_TYPES_ID);
export const EntityTypeSG = z.enum(ENTITY_TYPES_SG);
export const EntityType = z.enum(ENTITY_TYPES);
export type EntityType = z.infer<typeof EntityType>;
/** Which entity types are valid in which country (used by cross-field checks). */
export const ENTITY_TYPES_BY_COUNTRY: { readonly [C in CountryCode]: readonly EntityType[] } = {
  MY: ENTITY_TYPES_MY,
  ID: ENTITY_TYPES_ID,
  SG: ENTITY_TYPES_SG,
};

export const SELL_CHANNELS = ["shopee", "tiktok_shop", "lazada", "own_site"] as const;
export const SellChannel = z.enum(SELL_CHANNELS);
export type SellChannel = z.infer<typeof SellChannel>;

export const REGISTRATIONS = [
  "SSM_SOLE_PROP",
  "SSM_SDN_BHD",
  "LHDN_TIN",
  "SST",
  "MYINVOIS",
  "PBT_LICENCE",
  "NIB_OSS",
  "NPWP_NIK",
  "PKP",
  // SG-DECISIONS: ACRA business-name registration (sole prop / partnership) and incorporation both assign the UEN.
  "ACRA_BUSINESS",
  "ACRA_PTE_LTD",
  "IRAS_GST",
] as const;
export const Registration = z.enum(REGISTRATIONS);
export type Registration = z.infer<typeof Registration>;

export const PRODUCT_APPROVALS = ["NONE", "NPRA", "ST_SIRIM", "JAKIM_HALAL", "BPOM", "BPJPH_HALAL", "KKM_FOOD", "SFA", "HSA", "CPSO_SAFETY_MARK"] as const;
export const ProductApproval = z.enum(PRODUCT_APPROVALS);
export type ProductApproval = z.infer<typeof ProductApproval>;

/**
 * SG-CORE: which registration codes and approval agencies a country's pack may name. Appending SG values to the shared
 * enums would otherwise let an MY or ID pack name an SG agency (and the reverse) and compile it; CountryPack refuses a
 * code or agency outside its country's list, so widening the enums turns no refusal into an acceptance.
 */
export const REGISTRATIONS_BY_COUNTRY: { readonly [C in CountryCode]: readonly Registration[] } = {
  MY: ["SSM_SOLE_PROP", "SSM_SDN_BHD", "LHDN_TIN", "SST", "MYINVOIS", "PBT_LICENCE"],
  ID: ["NIB_OSS", "NPWP_NIK", "PKP"],
  SG: ["ACRA_BUSINESS", "ACRA_PTE_LTD", "IRAS_GST"],
};
export const PRODUCT_APPROVALS_BY_COUNTRY: { readonly [C in CountryCode]: readonly ProductApproval[] } = {
  MY: ["NONE", "NPRA", "ST_SIRIM", "JAKIM_HALAL", "KKM_FOOD"],
  ID: ["NONE", "BPOM", "BPJPH_HALAL"],
  SG: ["NONE", "SFA", "HSA", "CPSO_SAFETY_MARK"],
};

export const DUTY_ROUTES = ["MFN", "FORM_E", "EXEMPT"] as const;
export const DutyRoute = z.enum(DUTY_ROUTES);
export type DutyRoute = z.infer<typeof DutyRoute>;

export const COUNTRY_PACK_TIERS = ["VERIFIED", "RESEARCHED", "UNKNOWN"] as const;
export const CountryPackTier = z.enum(COUNTRY_PACK_TIERS);
export type CountryPackTier = z.infer<typeof CountryPackTier>;

// G0-DECISION: Incoterm uses the standard Incoterms 2020 set (spec names the field, not the values).
export const INCOTERMS = ["EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"] as const;
export const Incoterm = z.enum(INCOTERMS);
export type Incoterm = z.infer<typeof Incoterm>;

// ---- PlanIntent ------------------------------------------------------------------------------
export const LINE_EMPHASES = ["low", "med", "high"] as const;
export const LineEmphasis = z.enum(LINE_EMPHASES);
export type LineEmphasis = z.infer<typeof LineEmphasis>;

export const ADS_PACINGS = ["conservative", "standard"] as const;
export const AdsPacing = z.enum(ADS_PACINGS);
export type AdsPacing = z.infer<typeof AdsPacing>;

export const HORIZON_DAYS = [30, 60, 90] as const;
export const HorizonDays = z.literal(HORIZON_DAYS);
export type HorizonDays = z.infer<typeof HorizonDays>;

// G0-DECISION: clarifying-question slots are named after the PlanIntent fields they fill.
// Used by PlanIntent.answeredSlots/assumptions, data-question.slot and E2 hiddenSlot.
export const INTENT_SLOTS = [
  "countryCode",
  "residency",
  "entityType",
  "productCategory",
  "sellChannel",
  "buyFrom",
  "budgetCeilingMinor",
  "horizonDays",
  "adsPacing",
] as const;
export const IntentSlot = z.enum(INTENT_SLOTS);
export type IntentSlot = z.infer<typeof IntentSlot>;

export const STAGE_GATE_METRICS = ["salesMinor", "orders"] as const;
export const StageGateMetric = z.enum(STAGE_GATE_METRICS);
export type StageGateMetric = z.infer<typeof StageGateMetric>;

// G0-DECISION: plan record status for GET /api/plans/current|versions (spec names `status`, no values).
export const PLAN_STATUSES = ["PENDING_SIGNATURE", "SUBMITTED", "COMMITTED", "SUPERSEDED", "REVERTED"] as const;
export const PlanStatus = z.enum(PLAN_STATUSES);
export type PlanStatus = z.infer<typeof PlanStatus>;

// G0-DECISION (coordinator note, chain freeze): constitution codes mirror HogeeKinds.sol CONST_* exactly
// (name without the CONST_ prefix, same uint8 in PlanInvariantViolated(uint8)): one per §8.3 rule (1-11)
// plus structural checks TOTALS_MISMATCH (12) and MALFORMED_PLAN (13), and G0-AUDIT (v-1) REPLAN_LOOSENS (14): a
// founder-only re-commit (planVersion() > 0) that loosens the current on-chain state (IPlanRegistry.commitPlan NatSpec).
export const CONSTITUTION_CODES = [
  "LINES_EXCEED_FACILITY_CAP",
  "AGENT_EXPIRY_TOO_LATE",
  "AGENT_EXPIRY_TOO_EARLY",
  "PER_TX_CAP_OVER_25PCT",
  "WINDOW_CAP_OVER_50PCT",
  "LINE_VALIDITY_TOO_LONG",
  "RESERVE_BELOW_FLOOR",
  "STAGE1_OVER_40PCT",
  "PLAN_ADDS_PAYEE",
  "SUPPLIER_LINE_NOT_ESCROW",
  "PAYEE_CAP_OVER_SCHEDULE",
  "TOTALS_MISMATCH",
  "MALFORMED_PLAN",
  "REPLAN_LOOSENS",
] as const;
export const ConstitutionCode = z.enum(CONSTITUTION_CODES);
export type ConstitutionCode = z.infer<typeof ConstitutionCode>;
export const CONSTITUTION_CODE_UINT8: { readonly [C in ConstitutionCode]: number } = {
  LINES_EXCEED_FACILITY_CAP: 1,
  AGENT_EXPIRY_TOO_LATE: 2,
  AGENT_EXPIRY_TOO_EARLY: 3,
  PER_TX_CAP_OVER_25PCT: 4,
  WINDOW_CAP_OVER_50PCT: 5,
  LINE_VALIDITY_TOO_LONG: 6,
  RESERVE_BELOW_FLOOR: 7,
  STAGE1_OVER_40PCT: 8,
  PLAN_ADDS_PAYEE: 9,
  SUPPLIER_LINE_NOT_ESCROW: 10,
  PAYEE_CAP_OVER_SCHEDULE: 11,
  TOTALS_MISMATCH: 12,
  MALFORMED_PLAN: 13,
  REPLAN_LOOSENS: 14,
};

// ---- Suppliers (§11, §26.4) -------------------------------------------------------------------
export const SUPPLIER_DEFECTS = [
  "NO_ESCROW",
  "PERSONAL_PAYEE",
  "MISSING_CERT",
  "OFF_PLATFORM_DISCOUNT",
  "AI_INJECTION",
  "OVER_MOQ",
  "SANCTIONS",
  "FAKE_REPORT",
] as const;
export const SupplierDefect = z.enum(SUPPLIER_DEFECTS);
export type SupplierDefect = z.infer<typeof SupplierDefect>;

// G0-DECISION: hard gates = defects minus FAKE_REPORT (a fake report only drops evidence to tier3, T25).
// OVER_MOQ covers "over MOQ or budget".
export const SUPPLIER_GATES = [
  "NO_ESCROW",
  "PERSONAL_PAYEE",
  "MISSING_CERT",
  "OFF_PLATFORM_DISCOUNT",
  "AI_INJECTION",
  "OVER_MOQ",
  "SANCTIONS",
] as const;
export const SupplierGate = z.enum(SUPPLIER_GATES);
export type SupplierGate = z.infer<typeof SupplierGate>;

export const SUPPLIER_CRITERIA = [
  "landed_cost",
  "quality_evidence",
  "trust_verification",
  "lead_time",
  "compliance",
  "terms",
  "communication",
] as const;
export const SupplierCriterion = z.enum(SUPPLIER_CRITERIA);
export type SupplierCriterion = z.infer<typeof SupplierCriterion>;
/** Frozen scorer weights (§11); they sum to 100. */
export const SUPPLIER_CRITERION_WEIGHTS: { readonly [C in SupplierCriterion]: number } = {
  landed_cost: 25,
  quality_evidence: 20,
  trust_verification: 20,
  lead_time: 10,
  compliance: 10,
  terms: 10,
  communication: 5,
};

export const PAYEE_TYPES = ["company", "personal"] as const;
export const PayeeType = z.enum(PAYEE_TYPES);
export type PayeeType = z.infer<typeof PayeeType>;

export const SHORTLIST_STATUSES = ["PENDING", "READY", "FAILED"] as const;
export const ShortlistStatus = z.enum(SHORTLIST_STATUSES);
export type ShortlistStatus = z.infer<typeof ShortlistStatus>;

// ---- Chain / payments ---------------------------------------------------------------------------
export const CHAIN_ACTION_STATES = ["PENDING", "BROADCAST", "INCLUDED", "FINALIZED", "REVERTED"] as const;
export const ChainActionState = z.enum(CHAIN_ACTION_STATES);
export type ChainActionState = z.infer<typeof ChainActionState>;

// G0-REVIEW (H4): OWNER_SPEND = the owner's manual fallback (ownerSpend, emits OwnerSpent);
// WITHDRAW_RESERVE = settlement of a reserve withdrawal (LOOSEN_WITHDRAW_RESERVE). Neither has an agent decision.
export const PAYMENT_KINDS = ["SPEND", "FUND_MILESTONE", "RELEASE_MILESTONE", "OWNER_SPEND", "WITHDRAW_RESERVE"] as const;
/** Payment kinds without an agent decision: decisionId and rationaleHash are null exactly for these. */
export const NON_AGENT_PAYMENT_KINDS = ["OWNER_SPEND", "WITHDRAW_RESERVE"] as const;
export const PaymentKind = z.enum(PAYMENT_KINDS);
export type PaymentKind = z.infer<typeof PaymentKind>;

export const PAYMENT_STATES = [
  "PROPOSED",
  "POLICY_DENIED",
  "POLICY_OK",
  "SIGNED",
  "BROADCAST",
  "INCLUDED",
  "FINALIZED",
  "SETTLEMENT_REQUESTED",
  "SETTLED",
  "SETTLEMENT_FAILED",
  "REVERTED",
  "DROPPED",
  // G0-AUDIT (v-4): terminal. The row's nonce was consumed by another tx (no-op cancel or a different tx), so its
  // signed bytes can never execute. Only CANCELLED, REVERTED and POLICY_DENIED release the intent; DROPPED does not.
  "CANCELLED",
] as const;
export const PaymentState = z.enum(PAYMENT_STATES);
export type PaymentState = z.infer<typeof PaymentState>;

export const PAYOUT_STATUSES = ["NONE", "REQUESTED", "SUCCEEDED", "FAILED"] as const;
export const PayoutStatus = z.enum(PAYOUT_STATUSES);
export type PayoutStatus = z.infer<typeof PayoutStatus>;

/** §8.5 custom errors, plus the G0-REVIEW additions (mirrored in IHogee.sol by the contracts session). */
export const CONTRACT_ERROR_NAMES = [
  "PlanInvariantViolated",
  "StalePlan",
  "PayeeNotBound",
  "PayeeCooling",
  "CapExceeded",
  "LineExpired",
  "DuplicateIntent",
  "DuplicateInvoice",
  "DuplicateSale",
  "NotOwner",
  "NotLender",
  "NotAgent",
  "NotOracle",
  "AgentExpired",
  "ReserveLocked",
  "TimelockActive",
  "Paused",
  "MilestoneLocked",
  "EvidenceMissing",
  "AmountExceedsSchedule",
  "SignatureExpired",
  "InvalidSignature",
  "CircuitOpen",
  // G0-REVIEW: added at the G0 review.
  "FounderKeyAlreadySet",
  "MissingDecision",
  "SettlementClosed",
  // G0-REVIEW: ownerSpend/spend on an escrowOnly line (§8.3: the supplier line pays only through escrow).
  "EscrowOnly",
] as const;
export const ContractErrorName = z.enum(CONTRACT_ERROR_NAMES);
export type ContractErrorName = z.infer<typeof ContractErrorName>;

export const GENERIC_API_ERROR_CODES = ["VALIDATION", "NOT_FOUND", "FORBIDDEN", "CONFLICT", "UPSTREAM", "COMPILE_FAILED"] as const;
export const API_ERROR_CODES = [...CONTRACT_ERROR_NAMES, ...GENERIC_API_ERROR_CODES] as const;
export const ApiErrorCode = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

// ---- Exceptions (§26.5) ----------------------------------------------------------------------
export const EXCEPTION_KINDS = [
  "RAISE_CAP",
  "ADD_PAYEE",
  "EXTEND_EXPIRY",
  "MOVE_POCKETS",
  "UNPAUSE",
  "WITHDRAW_RESERVE",
  "RELEASE_ESCROW_BALANCE",
  "RELEASE_STAGE",
  "REPLAN",
  "POLICY_ESCALATION",
] as const;
export const ExceptionKind = z.enum(EXCEPTION_KINDS);
export type ExceptionKind = z.infer<typeof ExceptionKind>;

export const EXCEPTION_STATUSES = [
  "OPEN",
  "FOUNDER_SIGNED",
  "APPROVED",
  "QUEUED",
  "EXECUTABLE",
  "EXECUTED",
  "DENIED",
  "CANCELLED",
  "EXPIRED",
] as const;
export const ExceptionStatus = z.enum(EXCEPTION_STATUSES);
export type ExceptionStatus = z.infer<typeof ExceptionStatus>;

// G0-DECISION: who opened an exception (spec names `requestedBy`, no values).
export const EXCEPTION_REQUESTERS = ["agent", "founder", "officer", "worker"] as const;
export const ExceptionRequester = z.enum(EXCEPTION_REQUESTERS);
export type ExceptionRequester = z.infer<typeof ExceptionRequester>;

// G0-DECISION (coordinator note, chain freeze): RAISE_CAP payload field `cap` says which cap it raises;
// on-chain these are LOOSEN_RAISE_PER_TX_CAP (perTx) and LOOSEN_RAISE_WINDOW_CAP (window).
export const CAP_KINDS = ["perTx", "window"] as const;
export const CapKind = z.enum(CAP_KINDS);
export type CapKind = z.infer<typeof CapKind>;

// G0-DECISION (coordinator note, chain freeze): EXTEND_EXPIRY targets the agent key
// (LOOSEN_EXTEND_AGENT_EXPIRY) or one line's validUntil (LOOSEN_EXTEND_LINE_EXPIRY).
export const EXPIRY_TARGETS = ["agent", "line"] as const;
export const ExpiryTarget = z.enum(EXPIRY_TARGETS);
export type ExpiryTarget = z.infer<typeof ExpiryTarget>;

// ---- Traces / policy (§26.5, §7.2) -----------------------------------------------------------
export const TRACE_ACTORS = [
  "planner",
  "reader",
  "policy",
  "txbuilder",
  "executor",
  "worker",
  "founder",
  "officer",
  "oracle",
  "reconciler",
] as const;
export const TraceActor = z.enum(TRACE_ACTORS);
export type TraceActor = z.infer<typeof TraceActor>;

export const TRACE_KINDS = [
  "LLM_CALL",
  "TOOL_CALL",
  "PROPOSAL",
  "POLICY_VERDICT",
  "TX",
  "PAYOUT",
  "SIGNATURE",
  "EXCEPTION",
  "DENIAL",
  "ALERT",
] as const;
export const TraceKind = z.enum(TRACE_KINDS);
export type TraceKind = z.infer<typeof TraceKind>;

export const POLICY_VERDICTS = ["AUTO", "NEEDS_FOUNDER", "NEEDS_OFFICER", "DENY"] as const;
export const PolicyVerdict = z.enum(POLICY_VERDICTS);
export type PolicyVerdict = z.infer<typeof PolicyVerdict>;

// ---- Evidence (§26.5) ------------------------------------------------------------------------
export const EVIDENCE_TASK_IDS = [
  "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S12",
  "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11",
  "T12", "T13", "T14", "T15", "T16", "T17", "T18", "T19", "T20", "T21", "T22",
  "T23", "T24", "T25", "T26", "T27", "T28", "T29", "T30", "T31", "T32", "T33",
  "D-poison", "D-plug",
] as const;
export const EvidenceTaskId = z.enum(EVIDENCE_TASK_IDS);
export type EvidenceTaskId = z.infer<typeof EvidenceTaskId>;

export const EVIDENCE_EXPECTEDS = ["success", "revert", "refused"] as const;
export const EVIDENCE_LAYERS = ["agent_refusal", "onchain_revert", "onchain_success", "offchain"] as const;
export const EVIDENCE_OUTCOMES = ["pass", "fail"] as const;

// ---- Session / signing (§26.6) ---------------------------------------------------------------
// founder:mei (Singapore, the main demo) appended 18 Oct; the API accepts only the founder of its HOGEE_COUNTRY.
export const PERSONAS = ["founder:rina", "officer", "founder:mei"] as const;
export const Persona = z.enum(PERSONAS);
export type Persona = z.infer<typeof Persona>;

export const API_MODES = ["live", "mock", "replay"] as const;
export const ApiMode = z.enum(API_MODES);
export type ApiMode = z.infer<typeof ApiMode>;

// G0-DECISION (coordinator note, chain freeze): 6th kind OwnerSpend = the founder's manual-fallback spend
// (NFRA 二十六), signed then relayed; struct OwnerSpend{lineId, payeeId, amountMinor, invoiceHash, deploymentId, nonce, expiry}.
export const SIGNATURE_KINDS = [
  "PlanApproval",
  "SupplierApproval",
  "MilestoneRelease",
  "LoosenRequest",
  "StageRelease",
  "OwnerSpend",
] as const;
export const SignatureKind = z.enum(SIGNATURE_KINDS);
export type SignatureKind = z.infer<typeof SignatureKind>;

export const SIGN_METHODS = ["passkey", "eip712"] as const;
export const SignMethod = z.enum(SIGN_METHODS);
export type SignMethod = z.infer<typeof SignMethod>;

export const DISPLAY_EFFECTS = ["loosen", "tighten", "neutral"] as const;
export const DisplayEffect = z.enum(DISPLAY_EFFECTS);
export type DisplayEffect = z.infer<typeof DisplayEffect>;

export const PASSKEY_ONCHAIN_STATUSES = ["PENDING_LENDER", "REGISTERED"] as const;
export const PasskeyOnchainStatus = z.enum(PASSKEY_ONCHAIN_STATUSES);
export type PasskeyOnchainStatus = z.infer<typeof PasskeyOnchainStatus>;

// G0-DECISION: GET /api/health reports each dependency as ok|degraded|down (spec names keys only).
export const HEALTH_STATUSES = ["ok", "degraded", "down"] as const;
export const HealthStatus = z.enum(HEALTH_STATUSES);
export type HealthStatus = z.infer<typeof HealthStatus>;

// ---- Datasets (§26.4, §26.8) -----------------------------------------------------------------
export const E1_CATEGORIES = [
  "INVOICE_INJECTION",
  "LISTING_INJECTION",
  "WEBHOOK_FORGERY",
  "PAYEE_SUBSTITUTION",
  "AMOUNT_MANIPULATION",
  "MEMORY_POISONING",
  "DATA_EXTRACTION",
  "ENCODED_PAYLOAD",
] as const;
export const E1Category = z.enum(E1_CATEGORIES);
export type E1Category = z.infer<typeof E1Category>;

export const ATTACKER_GOAL_KINDS = [
  "PAY_UNBOUND_PAYEE",
  "EXCEED_CAP",
  "DUPLICATE_PAY",
  "LEAK_SECRET",
  "LEAK_PII",
  "ALTER_PLAN",
  "FAKE_SALE",
] as const;
export const AttackerGoalKind = z.enum(ATTACKER_GOAL_KINDS);
export type AttackerGoalKind = z.infer<typeof AttackerGoalKind>;

// VISION-DECISIONS §2: "web_search" appended (red-team cases on web listings, variant "WEB").
export const E1_VECTORS = ["invoice", "listing", "email", "webhook", "memory", "chat", "web_search"] as const;
export const E1Vector = z.enum(E1_VECTORS);
export type E1Vector = z.infer<typeof E1Vector>;

export const LANGS = ["en", "ms", "id"] as const;
export const Lang = z.enum(LANGS);
export type Lang = z.infer<typeof Lang>;

/** Frozen PII entity names (§12.2). */
// SG-DECISIONS: SG_NRIC = NRIC/FIN ([STFGM] + 7 digits + checksum letter); SG_PHONE = 8 digits from 3/6/8/9, optional +65.
export const PII_ENTITIES = ["MY_NRIC", "ID_NIK", "ID_NPWP", "MY_BANK_ACCOUNT", "MY_PHONE", "ID_PHONE", "SG_NRIC", "SG_PHONE"] as const;
export const PiiEntity = z.enum(PII_ENTITIES);
export type PiiEntity = z.infer<typeof PiiEntity>;

export const EVAL_ARMS = ["hogee", "hogee_classifier"] as const;
export const EvalArm = z.enum(EVAL_ARMS);
export type EvalArm = z.infer<typeof EvalArm>;

export const EVAL_ABLATIONS = ["no_pack", "no_questions"] as const;
export const EvalAblation = z.enum(EVAL_ABLATIONS);
export type EvalAblation = z.infer<typeof EvalAblation>;

export const SHORTLIST_MODES = ["hogee", "llm_rank"] as const;
export const ShortlistMode = z.enum(SHORTLIST_MODES);
export type ShortlistMode = z.infer<typeof ShortlistMode>;

// ---- Chat-first journey (VISION-DECISIONS §2, appended 19 Oct) ------------------------------------
export const JOURNEY_STAGES = [
  "INTAKE",
  "NEEDS_REVIEW",
  "FOUNDER_KEY_PENDING",
  "PLAN_PENDING",
  "PLAN_ACTIVE",
  "SEARCHING",
  "CANDIDATES",
  "PICKED",
  "TERMS_DRAFT",
  "TERMS_CONFIRMED",
  "ORDER_PENDING",
  "COOLING",
  "OPERATING",
] as const;
export const JourneyStage = z.enum(JOURNEY_STAGES);
export type JourneyStage = z.infer<typeof JourneyStage>;

/** What the chat router may classify a founder's free text as (one terminal tool, this fixed enum). */
export const SKILLS = ["plan", "find_suppliers", "pick_suppliers", "report_terms", "cfo", "status", "help", "out_of_scope"] as const;
export const Skill = z.enum(SKILLS);
export type Skill = z.infer<typeof Skill>;

/** Escrow milestone triggers, in the only order a schedule may use them (non-decreasing). */
export const MILESTONE_TRIGGERS = ["ON_ORDER", "ON_SAMPLE_OK", "ON_SHIPMENT", "ON_DELIVERY_INSPECTED"] as const;
export const MilestoneTrigger = z.enum(MILESTONE_TRIGGERS);
export type MilestoneTrigger = z.infer<typeof MilestoneTrigger>;

export const TERMS_PRESETS = ["P30_70", "P50_50", "P0_100", "P30_40_30"] as const;
export const TermsPreset = z.enum(TERMS_PRESETS);
export type TermsPreset = z.infer<typeof TermsPreset>;

export const TERMS_STATUSES = ["CONFIRMED", "SUPERSEDED", "USED"] as const;
export const TermsStatus = z.enum(TERMS_STATUSES);
export type TermsStatus = z.infer<typeof TermsStatus>;

/** Stable refusal codes of supplier terms (ApiError `details.reason`); core termsToSchedule checks the first 13 in order. */
export const TERMS_ERROR_CODES = [
  // core termsToSchedule (pure), checked in this order:
  "TERMS_COUNT",
  "TERMS_PCT_RANGE",
  "TERMS_PCT_SUM",
  "TERMS_TRIGGER_ORDER",
  "TERMS_LAST_NOT_INSPECTED",
  "TERMS_TOTAL_INVALID",
  "TERMS_OVER_POCKET",
  "TERMS_MILESTONE_ZERO",
  "TERMS_AUTO_NOT_FIRST",
  "TERMS_WEB_AUTO_COUNT",
  "TERMS_AUTO_OVER_PER_TX",
  "TERMS_UPFRONT_OVER_HALF",
  "TERMS_UPFRONT_OVER_WINDOW",
  // api confirm / prepare / finalize:
  "TERMS_CANDIDATE",
  "TERMS_CURRENCY",
  "TERMS_PAYEE_PERSONAL",
  "TERMS_ACCOUNT_FORMAT",
  "TERMS_HOLDER_MISMATCH",
  "TERMS_SANCTIONS",
  "TERMS_ALREADY_BOUND",
  "TERMS_SUPERSEDED",
] as const;
export const TermsErrorCode = z.enum(TERMS_ERROR_CODES);
export type TermsErrorCode = z.infer<typeof TermsErrorCode>;

/** Where a supplier came from (= shortlists.source): the demo catalog or a web search. */
export const SUPPLIER_ORIGINS = ["catalog", "web"] as const;
export const SupplierOrigin = z.enum(SUPPLIER_ORIGINS);
export type SupplierOrigin = z.infer<typeof SupplierOrigin>;

export const SEARCH_PROVIDERS = ["tavily", "recorded"] as const;
export const SearchProvider = z.enum(SEARCH_PROVIDERS);
export type SearchProvider = z.infer<typeof SearchProvider>;

export const SEARCH_STATUSES = ["PENDING", "READY", "FAILED"] as const;
export const SearchStatus = z.enum(SEARCH_STATUSES);
export type SearchStatus = z.infer<typeof SearchStatus>;

export const SEARCH_STAGES = ["SEARCHING", "READING", "CHECKING", "SCORING", "DONE"] as const;
export const SearchStage = z.enum(SEARCH_STAGES);
export type SearchStage = z.infer<typeof SearchStage>;

/** Why a web result was left out before scoring (counted per search, never shown as listing text). */
export const SEARCH_OMIT_REASONS = ["OFF_LIST", "NO_PRICE", "NO_SELLER", "READER_REJECTED", "CURRENCY", "WORDING"] as const;
export const SearchOmitReason = z.enum(SEARCH_OMIT_REASONS);
export type SearchOmitReason = z.infer<typeof SearchOmitReason>;

export const SEARCH_FAILURES = ["PROVIDER_DOWN", "PROVIDER_LIMIT", "BUDGET", "SANCTIONS_UNAVAILABLE", "NO_PLAN", "TOO_LARGE"] as const;
export const SearchFailure = z.enum(SEARCH_FAILURES);
export type SearchFailure = z.infer<typeof SearchFailure>;

export const CFO_VIEWS = ["overview", "spending", "sales", "pnl", "forecast", "reserve"] as const;
export const CfoView = z.enum(CFO_VIEWS);
export type CfoView = z.infer<typeof CfoView>;

export const CFO_INSIGHT_KINDS = ["BURN_ALERT", "RUNWAY_SHORT", "STAGE2_ON_TRACK", "STAGE2_AT_RISK", "RESERVE_STATUS", "MOVE_BUDGET"] as const;
export const CfoInsightKind = z.enum(CFO_INSIGHT_KINDS);
export type CfoInsightKind = z.infer<typeof CfoInsightKind>;

export const NEEDS_GROUPS = ["REGISTRATION", "BUDGET_LINE", "SUPPLIER", "ACCOUNT", "TAX_RESERVE"] as const;
export const NeedsGroup = z.enum(NEEDS_GROUPS);
export type NeedsGroup = z.infer<typeof NeedsGroup>;

export const NEEDS_STATUSES = ["TODO", "IN_PLAN", "DONE"] as const;
export const NeedsStatus = z.enum(NEEDS_STATUSES);
export type NeedsStatus = z.infer<typeof NeedsStatus>;
