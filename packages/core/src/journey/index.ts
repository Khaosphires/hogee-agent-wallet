/** The chat journey shared by the live API and the mock (VISION-DECISIONS §3, §7: v-chat-server). */
export { deriveJourney, hasOrder, planSigned, plannerStage, stageOf } from "./derive";
export {
  BUTTON,
  CFO_BUTTON,
  CFO_TEXT,
  FAILURE_TEXT,
  PRESET_BUTTON,
  SIGN,
  STAGE_TEXT,
  TEXT,
  actionLabel,
  stageText,
} from "./templates";
export {
  DEFAULT_JOURNEY_ENV,
  actionUserParts,
  needsPart,
  partsForState,
  planDraftPart,
  planSignPart,
  randomActionId,
  stageCards,
  stateText,
  textPart,
  type JourneyEnv,
  type JourneyPart,
  type JourneyTextPart,
} from "./parts";
export { alreadyDone, effectsForAction, presetPrefill, replyToAction, type JourneyReply } from "./actions";
export { effectsForSkill, presetOf, replyToSkill, textPrefill } from "./skills";
export { JOURNEY_FAILURES, effectFailed, effectOk, type EffectOutcomes, type JourneyEffect, type JourneyEffectKind, type JourneyFailure, type Outcome, type PresetCheck } from "./effects";
export { HISTORY_PART_TYPES, readHistory, termsIdsNewestFirst, type HistoryMessage, type JourneyHistory } from "./history";
export { CHAT_HISTORY_WINDOW, CHAT_SESSION_MAX_MESSAGES, sessionFull, sessionFullReply } from "./session";
export {
  allCandidates,
  estimateTotalMinor,
  journeyFactsOf,
  listOfSearch,
  resolveCandidate,
  resolveRanks,
  type CandidateList,
  type ListCandidate,
  type SourceFacts,
} from "./facts";
export { JOURNEY_CONTRACT_STEPS, type ContractIds, type ContractStep } from "./contract";
export { NEXT_STEP_KEYS, NEXT_STEP_TEXT, fillNextStep, nextStepText, stageNextStep, type NextStepKey, type NextStepValues } from "./next";
export { QUICK_MAX_CHARS, quickIntent, quickReply, type QuickHints, type QuickIntent } from "./quick";
