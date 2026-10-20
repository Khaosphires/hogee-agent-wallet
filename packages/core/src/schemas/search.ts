/**
 * Web supplier search (VISION-DECISIONS §3, §9). The query is built server-side from the COMMITTED plan's
 * productCategory + buyFrom; it never carries founder text. Result text is UNTRUSTED: it is read by the quarantined
 * Reader, scored by code, and only counts, ids and checked fields reach a card. Web candidates are always unverified.
 */
import { z } from "zod";
import { IMPERATIVE_FLAGS } from "../taint/imperative";
import { SearchFailure, SearchOmitReason, SearchProvider, SearchStage, SearchStatus, SupplierGate, SupplierOrigin } from "./enums";
import { ExtractedField } from "./invoice";
import { Bps, CurrencyCode, Hex32, HttpUrl, Id, IsoDateTime, Minor, NonNegInt, PosInt, SupplierId } from "./primitives";
import { RedFlag, isWebSupplierId } from "./supplier";

/** A lowercase DNS host name (no port, no userinfo). */
const Host = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62})(?:\.[a-z0-9](?:[a-z0-9-]{0,62}))*$/, "must be a lowercase host name")
  .describe("Lowercase host name");

const HttpsUrl = z.url({ protocol: /^https$/ }).describe("https URL");

/** What the server sends to the search provider (Tavily `include_domains` = the listing allow-list). */
export const WebSearchQuery = z.strictObject({
  query: z.string().min(1).max(200),
  includeDomains: z.array(Host).min(1).max(20),
  // P1 (19 Oct): up to 10 raw results, so the off-list ones can be dropped and 5 clean listings still reach the Reader.
  maxResults: z.number().int().min(1).max(10),
});
export type WebSearchQuery = z.infer<typeof WebSearchQuery>;

/** One provider result, already capped; every text field is untrusted listing text. */
export const WebSearchResult = z.strictObject({
  url: HttpsUrl,
  host: Host,
  title: z.string().max(300),
  snippet: z.string().max(2000),
  rawText: z.string().max(12_000),
});
export type WebSearchResult = z.infer<typeof WebSearchResult>;

/**
 * One parsed provider answer (live and recorded share one parser). `bodySha256` = 0x + sha256 of the RFC 8785 (JCS)
 * canonical JSON of the PARSED answer body, not of its raw bytes (checks parseTavilyBody). A recorded sample hashes its
 * whole file JSON, so its `label` and `recordedAt` are part of the hash.
 */
export const WebSearchAnswer = z.strictObject({
  provider: SearchProvider,
  results: z.array(WebSearchResult).max(10),
  droppedOffList: NonNegInt.describe("Results whose URL was outside the listing allow-list (dropped, never fetched)"),
  retrievedAt: IsoDateTime,
  bodySha256: Hex32,
});
export type WebSearchAnswer = z.infer<typeof WebSearchAnswer>;

/**
 * One candidate as a card shows it. Seller names travel here (a data part / REST), never in chat text. A web candidate
 * is always `unverified` and carries a web supplier id; a catalog candidate never does.
 */
export const CandidateCard = z
  .strictObject({
    supplierId: SupplierId,
    origin: SupplierOrigin,
    displayName: z.string().min(1).max(120),
    rank: PosInt.nullable(),
    landedCostMinor: Minor.nullable(),
    moq: PosInt.nullable(),
    leadTimeDays: NonNegInt.nullable(),
    evidenceCoverageBps: Bps,
    failedGates: z.array(SupplierGate),
    redFlagCount: NonNegInt,
    listingHost: Host.nullable(),
    listingUrl: HttpUrl.nullable(),
    unverified: z.boolean(),
    canOrder: z.boolean(),
    priceFlag: z.boolean().describe("Price under 30% of the median of this search (likely bait)"),
  })
  .refine((c) => c.origin !== "web" || c.unverified, { message: "a web candidate is always unverified", path: ["unverified"] })
  .refine((c) => (c.origin === "web") === isWebSupplierId(c.supplierId), { message: "web candidates (and only they) carry a web supplier id", path: ["supplierId"] });
export type CandidateCard = z.infer<typeof CandidateCard>;

/** GET /api/suppliers/search/:id. `failure` is set exactly when the search FAILED. */
export const SupplierSearch = z
  .strictObject({
    searchId: Id,
    status: SearchStatus,
    stage: SearchStage,
    provider: SearchProvider,
    sourcesFound: NonNegInt,
    omitted: z.array(z.strictObject({ reason: SearchOmitReason, count: NonNegInt })),
    excludedByGate: z.array(z.strictObject({ gate: SupplierGate, count: NonNegInt })),
    failure: SearchFailure.nullable(),
    shortlistRequestId: Id.nullable(),
    candidates: z.array(CandidateCard).max(8),
    quantity: PosInt,
    createdAt: IsoDateTime,
  })
  .refine((s) => (s.status === "FAILED") === (s.failure !== null), { message: "failure is set exactly when the search FAILED", path: ["failure"] });
export type SupplierSearch = z.infer<typeof SupplierSearch>;

/** POST /api/suppliers/search. The query is built server-side from the committed plan, never from this body. */
export const SupplierSearchBody = z.strictObject({ quantity: PosInt.max(100_000).optional() });
export type SupplierSearchBody = z.infer<typeof SupplierSearchBody>;

// ---- recorded mode data files (data/suppliers/search/**; validate:data) ------------------------------------------
const RECORDED_LABEL = z.literal("recorded sample");

/**
 * data/suppliers/search/recorded/<category>-<buyFrom>.json: a raw Tavily search response, as the provider returns it,
 * labelled "recorded sample" (synthetic, fictional listings). One parser reads it and live answers (checks
 * parseTavilyBody); this schema only guards the committed file.
 */
export const RecordedTavilySearch = z.strictObject({
  label: RECORDED_LABEL,
  recordedAt: IsoDateTime,
  query: z.string().min(1).max(400),
  answer: z.string().max(4000).nullable().optional(),
  images: z.array(z.unknown()).max(0),
  follow_up_questions: z.array(z.string()).nullable().optional(),
  results: z
    .array(
      z.strictObject({
        title: z.string().max(500),
        url: HttpsUrl,
        content: z.string().max(5000),
        score: z.number().min(0).max(1),
        raw_content: z.string().max(50_000).nullable(),
        favicon: z.string().max(500).optional(),
      }),
    )
    .max(20),
  response_time: z.union([z.string().regex(/^[0-9]+(\.[0-9]+)?$/), z.number().min(0)]),
  request_id: z.string().min(1).max(100).optional(),
});
export type RecordedTavilySearch = z.infer<typeof RecordedTavilySearch>;

const readerLabel = <T extends z.ZodType>(value: T) =>
  z.strictObject({
    value,
    taint: z.strictObject({ trust: z.literal("untrusted"), sensitivity: z.literal("public") }),
    source: z.string().regex(/^reader:listing:supplier-w[a-z2-7]{12}$/, "a web listing reading's source"),
  });

const ReaderNumberMeta = {
  unit: z.string().min(1).max(32),
  sourceUrl: HttpUrl.nullable(),
  snippetHash: Hex32,
};

/**
 * data/suppliers/search/reader/<supplierId>.json: the quarantined Reader's recorded output for one web listing (the
 * agent's ListingReading), so recorded mode needs no model key. Every field is untrusted; the file name is its docId.
 */
export const RecordedListingReading = z.strictObject({
  label: RECORDED_LABEL,
  kind: z.literal("listing"),
  docId: SupplierId.refine(isWebSupplierId, "a recorded reading names a web supplier id"),
  fields: z.strictObject({
    sellerName: readerLabel(z.string().min(1).max(200)).nullable(),
    productTitle: readerLabel(z.string().min(1).max(300)).nullable(),
    unitPrice: readerLabel(z.strictObject({ amountMinor: Minor, currency: CurrencyCode, ...ReaderNumberMeta, method: z.enum(["regex", "llm"]) })).nullable(),
    moq: readerLabel(z.strictObject({ value: z.string().regex(/^[0-9]{1,12}$/), ...ReaderNumberMeta, method: z.literal("llm") })).nullable(),
    leadTimeDays: readerLabel(z.strictObject({ value: z.string().regex(/^[0-9]{1,12}$/), ...ReaderNumberMeta, method: z.literal("llm") })).nullable(),
    certificates: readerLabel(z.array(z.string().min(1).max(200)).max(20)),
    claimsEscrow: readerLabel(z.boolean().nullable()),
  }),
  flags: z.array(z.strictObject({ flag: z.enum(IMPERATIVE_FLAGS), index: NonNegInt, excerpt: z.string().max(300) })),
  redFlags: z.array(RedFlag),
  supplierGates: z.array(SupplierGate),
  dropped: z.array(z.string().min(1).max(64)),
  repaired: z.boolean(),
  llmCallIds: z.array(Id),
  extracted: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,31}$/), ExtractedField),
});
export type RecordedListingReading = z.infer<typeof RecordedListingReading>;
