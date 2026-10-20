/**
 * @hogee/api-contract — every HTTP route of project.md §26.6 as typed zod definitions (frozen at G0).
 * Changes follow §26.10 (additive only after G0).
 */
export * from "./define";
export * from "./schemas";
export * from "./routes";
export * from "./examples";

// Chat data parts (POST /api/chat stream; the G0 five frozen, the chat-first ten additive) and shared envelopes,
// re-exported for clients.
export {
  API_ERROR_HTTP_STATUS,
  ApiError,
  CHAT_DATA_PART_SCHEMAS,
  CHAT_DATA_PART_TYPES,
  ChatAction,
  ChatDataPart,
  ChatMessage,
  ChatPart,
  DataAction,
  DataCandidates,
  DataCfo,
  DataEnquiry,
  DataIntent,
  DataNeeds,
  DataNext,
  DataOrder,
  DataPlanDraft,
  DataQuestion,
  DataRedflag,
  DataSearch,
  DataShortlist,
  DataSign,
  DataTerms,
  G0_CHAT_DATA_PART_TYPES,
  PERSONA_COOKIE,
  type HogeeDataParts,
} from "@hogee/core";
