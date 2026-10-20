/**
 * @hogee/agent: the LLM layer (P1 task 1.11). The LLM never decides amounts, payees or rules: it proposes bounded
 * intents (PlanIntent, question slots) and reads untrusted text into untrusted typed fields; @hogee/core compiles and
 * polices everything. Every model call is rule-checked, redacted (fail closed), canary-scanned and logged.
 */
export { agentModelsForRequest, type AgentModelDeps, type AgentModels } from "./agent";

// Models
export {
  MODEL_ROLES,
  PROVIDERS,
  ModelConfigError,
  createModelRegistry,
  handleFor,
  ollamaBaseUrl,
  resolveModelSpecs,
  type ModelEnv,
  type ModelHandle,
  type ModelRegistry,
  type ModelRole,
  type ModelSpec,
  type ProviderId,
  type ProviderModel,
  type RegistryOptions,
} from "./models/registry";
export { auditCallOptions, callSettingsFor, classifyStop, type CallSettings, type StopClass } from "./models/rules";

// Guard: rules, redaction, canary, call log
export {
  ModelRuleViolationError,
  OutboundBlockedError,
  UnguardedModelError,
  assertGuardedModel,
  guardModel,
  isGuardedModel,
  type GuardContext,
  type GuardDeps,
  type GuardedModel,
} from "./guard/guarded-model";
export {
  RedactionUnavailableError,
  privacyOutboundGuard,
  privacyRedactor,
  redactPrompt,
  type OutboundGuard,
  type PromptRedactionReport,
  type RedactedSpan,
  type Redactor,
} from "./guard/redaction";
export { MemoryCallSink, toLlmCallRow, type LlmCallOutcome, type LlmCallRecord, type LlmCallRole, type LlmCallRow, type LlmCallSink } from "./guard/call-log";

// Hashes and ids
export { jsonHash, rationaleCommitment, rationaleHashOf, uuidV7, type RandomBytes, type RationaleCommitment } from "./hash";

// Planner
export {
  PLANNER_MAX_INVALID_CALLS,
  PLANNER_MAX_STEPS,
  PlannerInputError,
  runPlannerTurn,
  type PlannerContext,
  type PlannerDeps,
  type PlannerInput,
  type PlannerOutcome,
  type PlannerOutcomeKind,
  type PlannerRationale,
  type PlannerTurn,
} from "./planner/planner";
export { FX_PAIRS, plannerTools, type FxPair, type Observation, type PlannerPorts, type PlannerToolOptions } from "./planner/tools";
export { QUESTION_TEMPLATES, questionsFor } from "./planner/questions";
export { groundIntent, statedAmounts, type GroundingResult } from "./planner/grounding";

// Reader
export { ReaderRejectedError, readDocument, type InvoiceReading, type ListingReading, type ReaderDeps, type ReaderRejectReason, type ReaderResult } from "./reader/reader";
export type { CountField, InvoiceFields, ListingFields, MoneyField } from "./reader/fields";
export { READER_MAX_CHARS, ReaderDocument } from "./reader/schemas";
export {
  currenciesNamed,
  isGrounded,
  isNumberGrounded,
  namesCurrency,
  normalizeCurrency,
  parseAmountToMinor,
  prefilterInvoice,
  type InvoicePrefilter,
  type StatedTotal,
} from "./reader/prefilter";
export {
  bindInvoiceSpend,
  bindMilestoneInvoice,
  type InvoiceSpendBinding,
  type InvoiceSpendInput,
  type MilestoneInvoiceBinding,
  type MilestoneInvoiceInput,
} from "./reader/invoice-binding";

// E3 llm_rank baseline (eval only; the comparison, not Hogee)
export {
  BASELINE_MAX_LISTINGS,
  BASELINE_MAX_LISTING_CHARS,
  BaselineRankError,
  rankListingsBaseline,
  type BaselineRankReason,
  type BaselineRanking,
  type RankableListing,
} from "./baseline/rank-listings";

// Chat router (VISION-DECISIONS §7: v-chat-server fills it in)
export { classifySkill, type ClassifyDeps, type ClassifyInput } from "./router/index";

// Explainer
export {
  LINE_LABEL,
  explainDecision,
  explainPlanDraft,
  type DecisionExplanation,
  type DecisionInput,
  type DecisionRationale,
  type PlanExplanation,
  type TemplatedSentence,
} from "./explainer/explainer";

// Memory
export {
  MEMORY_MAX_FUTURE_SKEW_MS,
  MEMORY_SOURCES,
  MemoryEntry,
  MemoryProvenanceError,
  createMemoryEntry,
  renderMemoryBlock,
  verifyMemory,
  type MemoryInput,
  type MemoryOptions,
  type MemoryRejectReason,
  type MemorySource,
} from "./memory/memory";
