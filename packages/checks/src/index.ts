// Supplier and FX checks (project.md §11, §26.8; ROLE-P3 task 3.11). Signatures frozen at G0; the trailing
// options arguments are additive (tests inject fetch and paths). Every external call has a timeout + retry, reaches
// one fixed host and never carries user data. Everything fails closed: a check that cannot run throws
// (CheckUnavailableError) instead of returning a "clean" or "valid" result.
export type { FxPair, LeiRecord, SanctionsResult, ValidationResult } from "./types";
export { CheckInputError, CheckUnavailableError } from "./types";
export type { HttpOptions } from "./http";
export { USCC_CHARSET, usccCheckChar, validateSSM, validateUEN, validateUSCC } from "./registry";
export { UN_SC_LIST, defaultSanctionsPath, nameKeys, screenSanctions, type ScreenOptions } from "./sanctions";
export { GLEIF_HOST, leiChecksumValid, lookupLEI } from "./gleif";
export { BNM_ACCEPT, BNM_HOST, BNM_SESSION, FX_DEADLINE_MS, FX_LOOKBACK_DAYS, bnmRateUrl, getFx, type FxOptions } from "./fx";
export { HttpStatusError, httpPostJson, type HttpPostTarget } from "./http";
export {
  LISTING_DOMAINS,
  RECORDED_LABEL,
  TAVILY_HOST,
  TAVILY_SEARCH_URL,
  WEB_SEARCH_MAX_RESULTS,
  WebSearchLimitError,
  allowedListingUrl,
  listingTextOf,
  parseTavilyBody,
  recordedSearch,
  tavilySearch,
  webSupplierId,
  type TavilyOptions,
  type WebSearchAnswer,
  type WebSearchQuery,
  type WebSearchResult,
} from "./websearch";
