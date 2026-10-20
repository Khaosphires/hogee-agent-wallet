/** Web supplier search helpers shared by the live API and the mock (VISION-DECISIONS §7: v-search). */
export { buildEnquiry, type EnquiryInput } from "./enquiry";
export {
  WEB_CERT_ISSUER,
  WEB_METRICS,
  WEB_SENTINEL_ACCOUNT,
  WEB_SENTINEL_CHANNEL,
  WEB_UNKNOWN_LEAD_TIME_DAYS,
  candidateToSupplier,
  webSupplierIdOf,
  type WebCandidateFacts,
} from "./candidate";
export { COUNTRY_NAME, DEFAULT_SEARCH_QUANTITY, QUERY_BY_CATEGORY, QUERY_SOURCE, supplierQuery } from "./query";
export { NAME_HIDDEN, cardSafeName, passesWording } from "./wording";
export { canonicalListingUrl, canonicalPath } from "./listing-url";
export { WEB_LISTING_DOMAINS, coreWebAnswer, isListingHost, type ProviderAnswer } from "./answer";
export {
  CARD_NAME_MAX,
  MAX_CANDIDATE_CARDS,
  PRICE_FLAG_BPS_OF_MEDIAN,
  WEB_FREIGHT_BPS_OF_FOB,
  WEB_UNKNOWN_MOQ,
  assembleWebSearch,
  hasScreenableText,
  isSellerName,
  pricedDrafts,
  registryIdsInText,
  screenWebDrafts,
  textGates,
  textPreGate,
  webVerdict,
  type WebAssembly,
  type WebAssemblyInput,
  type WebDraft,
  type WebListing,
  type WebReading,
  type WebScreening,
  type WebVerdict,
} from "./assemble";
