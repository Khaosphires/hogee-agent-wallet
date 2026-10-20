/**
 * Chat (project.md §26.6): POST /api/chat returns an AI SDK UI-message stream.
 * The five G0 data parts below are FROZEN (byte-identical; core test g0-chat-parts pins their JSON Schemas). The
 * chat-first parts (VISION-DECISIONS §4) are additive: they carry ids, and their cards read live state over REST.
 * Other UI parts (text, reasoning, tool-*, step-start, ...) are owned by the AI SDK and validated loosely.
 * Servers run ChatDataPart.parse on every part before it is written. Seller names and listing titles never go into a
 * text part (text parts are fed back to the model); they travel only in data parts or REST.
 *
 * Use with AI SDK: `useChat({ dataPartSchemas: CHAT_DATA_PART_SCHEMAS })` and
 * `UIMessage<unknown, HogeeDataParts>`.
 */
import { z } from "zod";
import { CfoView, IntentSlot, SignatureKind } from "./enums";
import { ChatAction } from "./journey";
import { NeedsChecklist } from "./needs";
import { TermsPrefill } from "./orders";
import { PlanIntent } from "./plan";
import { Id, SupplierId } from "./primitives";
import { RedFlag } from "./supplier";

// G0-DECISION: question options are {value, label}; `value` is what the UI sends back as the answer.
export const DataQuestion = z.strictObject({
  questionId: Id,
  slot: IntentSlot,
  text: z.string().min(1).max(500),
  options: z.array(z.strictObject({ value: z.string().min(1).max(100), label: z.string().min(1).max(200) })),
});
export type DataQuestion = z.infer<typeof DataQuestion>;

export const DataIntent = z.strictObject({ intent: PlanIntent });
export type DataIntent = z.infer<typeof DataIntent>;

export const DataPlanDraft = z.strictObject({ draftId: Id });
export type DataPlanDraft = z.infer<typeof DataPlanDraft>;

export const DataShortlist = z.strictObject({ requestId: Id });
export type DataShortlist = z.infer<typeof DataShortlist>;

export const DataRedflag = RedFlag;
export type DataRedflag = z.infer<typeof DataRedflag>;

// ---- chat-first parts (VISION-DECISIONS §4, additive) ----------------------------------------------
/** The needs checklist the founder approves by signing the plan. */
export const DataNeeds = NeedsChecklist;
export type DataNeeds = z.infer<typeof DataNeeds>;

/** An inline signature card; the sign flow re-reads the request server-side (refId), never this text. */
export const DataSign = z.strictObject({
  kind: SignatureKind,
  refId: Id,
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(300),
  cta: z.string().min(1).max(40),
});
export type DataSign = z.infer<typeof DataSign>;

/** Next-step buttons: each sends its structured action. */
export const DataNext = z.strictObject({
  actions: z.array(z.strictObject({ label: z.string().min(1).max(40), action: ChatAction })).min(1).max(4),
});
export type DataNext = z.infer<typeof DataNext>;

/** On USER messages only: the button the founder pressed. Renders nothing. */
export const DataAction = z.strictObject({ action: ChatAction });
export type DataAction = z.infer<typeof DataAction>;

/** A web search in progress; the card polls getSupplierSearch. */
export const DataSearch = z.strictObject({ searchId: Id });
export type DataSearch = z.infer<typeof DataSearch>;

/** The candidates of a finished search; the card reads getSupplierSearch. */
export const DataCandidates = z.strictObject({ searchId: Id });
export type DataCandidates = z.infer<typeof DataCandidates>;

/** A templated enquiry the founder copies and sends herself (Hogee never sends it). */
export const DataEnquiry = z.strictObject({
  supplierIds: z.array(SupplierId).min(1).max(5),
  subject: z.string().min(1).max(150),
  body: z.string().min(1).max(2000),
});
export type DataEnquiry = z.infer<typeof DataEnquiry>;

/** The terms card's pre-fill; the card's REST form posts submitOrderTerms. */
export const DataTerms = TermsPrefill;
export type DataTerms = z.infer<typeof DataTerms>;

/** An order's terms and escrow; the card reads getOrderTerms + getEscrow. */
export const DataOrder = z.strictObject({ termsId: Id });
export type DataOrder = z.infer<typeof DataOrder>;

/** A CFO view; the card reads getCfoReport and shows this slice. */
export const DataCfo = z.strictObject({ view: CfoView });
export type DataCfo = z.infer<typeof DataCfo>;

/** Keyed by AI SDK data-part name (the UI part type is `data-<name>`). The first five are the frozen G0 parts. */
export const CHAT_DATA_PART_SCHEMAS = {
  question: DataQuestion,
  intent: DataIntent,
  "plan-draft": DataPlanDraft,
  shortlist: DataShortlist,
  redflag: DataRedflag,
  needs: DataNeeds,
  sign: DataSign,
  next: DataNext,
  action: DataAction,
  search: DataSearch,
  candidates: DataCandidates,
  enquiry: DataEnquiry,
  terms: DataTerms,
  order: DataOrder,
  cfo: DataCfo,
} as const;
export type HogeeDataParts = { [K in keyof typeof CHAT_DATA_PART_SCHEMAS]: z.infer<(typeof CHAT_DATA_PART_SCHEMAS)[K]> };
/** The five data parts frozen at G0 (byte-identical since). */
export const G0_CHAT_DATA_PART_TYPES = ["data-question", "data-intent", "data-plan-draft", "data-shortlist", "data-redflag"] as const;
export const CHAT_DATA_PART_TYPES = [
  ...G0_CHAT_DATA_PART_TYPES,
  "data-needs",
  "data-sign",
  "data-next",
  "data-action",
  "data-search",
  "data-candidates",
  "data-enquiry",
  "data-terms",
  "data-order",
  "data-cfo",
] as const;
export type ChatDataPartType = (typeof CHAT_DATA_PART_TYPES)[number];

const dataPart = <T extends string, S extends z.ZodType>(type: T, data: S) =>
  z.strictObject({ type: z.literal(type), id: z.string().min(1).max(128).optional(), data, transient: z.boolean().optional() });

/** A data part as it appears in a UI message (or a UI-message stream chunk). */
export const ChatDataPart = z.discriminatedUnion("type", [
  dataPart("data-question", DataQuestion),
  dataPart("data-intent", DataIntent),
  dataPart("data-plan-draft", DataPlanDraft),
  dataPart("data-shortlist", DataShortlist),
  dataPart("data-redflag", DataRedflag),
  dataPart("data-needs", DataNeeds),
  dataPart("data-sign", DataSign),
  dataPart("data-next", DataNext),
  dataPart("data-action", DataAction),
  dataPart("data-search", DataSearch),
  dataPart("data-candidates", DataCandidates),
  dataPart("data-enquiry", DataEnquiry),
  dataPart("data-terms", DataTerms),
  dataPart("data-order", DataOrder),
  dataPart("data-cfo", DataCfo),
]);
export type ChatDataPart = z.infer<typeof ChatDataPart>;

/** Any non-data UI part (AI SDK-owned shape). */
export const ChatOtherPart = z.looseObject({ type: z.string().regex(/^(?!data-)[a-z][a-z0-9-]*$/, "non-data part type") });

export const ChatPart = z.union([ChatDataPart, ChatOtherPart]);
export type ChatPart = z.infer<typeof ChatPart>;

/** GET /api/chat/:sessionId → ChatMessage[] (AI SDK UIMessage shape). */
export const ChatMessage = z
  .looseObject({
    id: z.string().min(1).max(128),
    role: z.enum(["system", "user", "assistant"]),
    parts: z.array(ChatPart),
  })
  // VISION-DECISIONS §4: data-action records the button a founder pressed, so only a user message carries one.
  .refine((m) => m.role === "user" || !m.parts.some((p) => p.type === "data-action"), { message: "data-action is on user messages only", path: ["parts"] });
export type ChatMessage = z.infer<typeof ChatMessage>;
