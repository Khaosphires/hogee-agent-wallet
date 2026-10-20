/**
 * Escrow terms (VISION-DECISIONS §2, §8): the founder's payment split → the escrow schedule, the preset check, and a
 * deterministic reader for terms typed in chat. Pure, no I/O.
 *
 * The enum arrays (MILESTONE_TRIGGERS, TERMS_PRESETS, TERMS_ERROR_CODES) are deliberately NOT re-exported: they belong
 * to schemas/enums.ts after the merge (see constants.ts), so `export * from "./escrow-terms/index"` in the core barrel
 * cannot clash with them.
 */
export { MILESTONE_LABELS, TERMS_PRESET_MILESTONES, type TermsMilestone } from "./constants";
export { parseTermsHint, type TermsHint } from "./hint";
export { presetAvailability, type PresetAvailability } from "./presets";
export {
  BU_MINOR,
  floorBu,
  termsToSchedule,
  type TermsFailure,
  type TermsInput,
  type TermsLimits,
  type TermsOrigin,
  type TermsScheduleResult,
} from "./schedule";
export {
  CATALOG_MILESTONE_NAMES,
  CATALOG_MILESTONE_TEXT,
  WEB_ORDER_ROW_LABELS,
  WEB_PAYOUT_CHANNEL,
  catalogMilestoneRows,
  groupDigits,
  readCatalogScheduleRows,
  readWebOrderRows,
  webMilestoneRows,
  webPayoutRows,
  type WebOrderPreimage,
  type WebOrderRow,
} from "./web-order-rows";
export { webQuoteHash, webQuotePreimage, type WebQuote } from "./web-quote";
