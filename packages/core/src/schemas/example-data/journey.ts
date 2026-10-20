/**
 * Chat-first examples (VISION-DECISIONS §3, §4), in Mei's numbers (SG, SGD minor units; core demo/mei.ts): a web search
 * for the tumblers, the terms the founder reports (30% deposit, 70% after the delivery check), the CFO report and the needs
 * checklist. Same conventions as the other examples: fake hashes, example.invalid URLs, fictional sellers. The web
 * supplier id has the right format but is not derived from a real URL.
 */
import { MEI_COMMIT_AT_ISO, MEI_IDS, MEI_SESSION_ID } from "../../demo/mei";
import type { CfoAgentAction, CfoInsight, CfoReport } from "../cfo";
import type { ChatDataPart } from "../chat";
import type { ChatAction, JourneyFacts, JourneyState, SkillCall } from "../journey";
import type { NeedsChecklist } from "../needs";
import { MILESTONE_LABELS, TERMS_PRESET_MILESTONES, type OrderTerms, type OrderTermsInput, type TermsPrefill } from "../orders";
import type { CandidateCard, SupplierSearch, SupplierSearchBody, WebSearchAnswer, WebSearchQuery, WebSearchResult } from "../search";
import { fakeHex32, fakeUuidV7 } from "./fake";

const AT = MEI_COMMIT_AT_ISO;
const LATER = "2026-10-23T09:30:00Z";
const DRAFT_ID = "draft-mei-001";
const SEARCH_ID = "search-mei-001";
const TERMS_ID = "terms-mei-001";
/** A format-valid web supplier id ("supplier-w" + 12 base32 characters). */
export const EXAMPLE_WEB_SUPPLIER_ID = "supplier-wqk3vt7ma2xrb";
const LISTING_URL = "https://listing.example.invalid/insulated-tumbler-500ml";

const action = (n: number) => fakeUuidV7(0x5e00 + n);

/** One example per action type. */
export const exampleChatActions: readonly ChatAction[] = [
  { type: "start_search", actionId: action(1), quantity: 500 },
  { type: "use_catalog", actionId: action(2) },
  { type: "show_candidates", actionId: action(3), searchId: SEARCH_ID },
  { type: "pick", actionId: action(4), searchId: SEARCH_ID, supplierIds: [EXAMPLE_WEB_SUPPLIER_ID, MEI_IDS.supplierAId] },
  { type: "start_terms", actionId: action(5), supplierId: EXAMPLE_WEB_SUPPLIER_ID, preset: "P30_70" },
  { type: "terms_saved", actionId: action(6), termsId: TERMS_ID },
  { type: "signed", actionId: action(7), kind: "SupplierApproval", refId: TERMS_ID },
  { type: "show_cfo", actionId: action(8), view: "overview" },
];

export const exampleSkillCall: SkillCall = { skill: "report_terms", candidateRanks: [1], cfoView: null };

export const exampleJourneyFacts: JourneyFacts = {
  facilityId: MEI_IDS.facilityId,
  persona: "founder:mei",
  draftId: DRAFT_ID,
  planStatus: "COMMITTED",
  founderKeyActive: true,
  search: { searchId: SEARCH_ID, status: "READY", origin: "web" },
  pickedSupplierIds: [EXAMPLE_WEB_SUPPLIER_ID],
  terms: { termsId: TERMS_ID, supplierId: EXAMPLE_WEB_SUPPLIER_ID, status: "CONFIRMED" },
  order: null,
  now: LATER,
};

export const exampleJourneyState: JourneyState = { stage: "TERMS_CONFIRMED", facts: exampleJourneyFacts };

// ---- search ------------------------------------------------------------------------------------------
export const exampleWebSearchQuery: WebSearchQuery = {
  query: "insulated stainless steel tumbler manufacturer China",
  includeDomains: ["alibaba.com", "made-in-china.com", "globalsources.com", "1688.com"],
  maxResults: 8,
};

export const exampleWebSearchResult: WebSearchResult = {
  url: LISTING_URL,
  host: "listing.example.invalid",
  title: "500 ml insulated tumbler, custom logo (recorded sample)",
  snippet: "Double-wall stainless steel tumbler. MOQ 300 pieces. FOB unit price CNY 21.50. Lead time 25 days.",
  rawText: "Example Drinkware Co., Ltd. (recorded sample). 500 ml double-wall tumbler, food-grade 304 steel. MOQ 300. FOB CNY 21.50 per piece. Lead time 25 days.",
};

export const exampleWebSearchAnswer: WebSearchAnswer = {
  provider: "recorded",
  results: [exampleWebSearchResult],
  droppedOffList: 1,
  retrievedAt: AT,
  bodySha256: fakeHex32("search:body:mei"),
};

export const exampleWebCandidate: CandidateCard = {
  supplierId: EXAMPLE_WEB_SUPPLIER_ID,
  origin: "web",
  displayName: "Example Drinkware Co., Ltd.",
  rank: 1,
  landedCostMinor: "412000",
  moq: 300,
  leadTimeDays: 25,
  evidenceCoverageBps: 4200,
  failedGates: [],
  redFlagCount: 0,
  listingHost: "listing.example.invalid",
  listingUrl: LISTING_URL,
  unverified: true,
  canOrder: true,
  priceFlag: false,
};

export const exampleCatalogCandidate: CandidateCard = {
  supplierId: MEI_IDS.supplierAId,
  origin: "catalog",
  displayName: "Supplier A (demo catalog)",
  rank: 2,
  landedCostMinor: "430000",
  moq: 500,
  leadTimeDays: 21,
  evidenceCoverageBps: 7800,
  failedGates: [],
  redFlagCount: 0,
  listingHost: null,
  listingUrl: null,
  unverified: false,
  canOrder: true,
  priceFlag: false,
};

export const exampleSupplierSearch: SupplierSearch = {
  searchId: SEARCH_ID,
  status: "READY",
  stage: "DONE",
  provider: "recorded",
  sourcesFound: 6,
  omitted: [
    { reason: "OFF_LIST", count: 1 },
    { reason: "READER_REJECTED", count: 1 },
  ],
  excludedByGate: [{ gate: "AI_INJECTION", count: 1 }],
  failure: null,
  shortlistRequestId: "sl-web-mei-001",
  candidates: [exampleWebCandidate],
  quantity: 500,
  createdAt: AT,
};

export const exampleFailedSupplierSearch: SupplierSearch = {
  ...exampleSupplierSearch,
  searchId: "search-mei-002",
  status: "FAILED",
  stage: "SEARCHING",
  provider: "tavily",
  sourcesFound: 0,
  omitted: [],
  excludedByGate: [],
  failure: "PROVIDER_DOWN",
  shortlistRequestId: null,
  candidates: [],
};

export const exampleSupplierSearchBody: SupplierSearchBody = { quantity: 500 };

// ---- terms -------------------------------------------------------------------------------------------
// The demo order (P1, 19 Oct): 2,500 BU at 30/70, a 750 BU deposit on order and a 1,750 BU balance after the delivery check.
const P30_70 = TERMS_PRESET_MILESTONES.P30_70.map((m) => ({ ...m }));

export const exampleOrderTermsInput: OrderTermsInput = {
  supplierId: EXAMPLE_WEB_SUPPLIER_ID,
  searchId: SEARCH_ID,
  quantity: 500,
  totalMinor: "250000",
  milestones: P30_70,
  payout: { holderName: "Example Drinkware Co., Ltd.", bankName: "Example Bank", accountNumber: "6200123456", payeeType: "company" },
};

export const exampleOrderTerms: OrderTerms = {
  termsId: TERMS_ID,
  status: "CONFIRMED",
  supplierId: EXAMPLE_WEB_SUPPLIER_ID,
  displayName: "Example Drinkware Co., Ltd.",
  origin: "web",
  currency: "SGD",
  totalMinor: "250000",
  quantity: 500,
  milestones: P30_70,
  schedule: [
    { idx: 0, trigger: "ON_ORDER", label: MILESTONE_LABELS.ON_ORDER, amountMinor: "75000", autoRelease: true, released: false, txHash: null },
    { idx: 1, trigger: "ON_DELIVERY_INSPECTED", label: MILESTONE_LABELS.ON_DELIVERY_INSPECTED, amountMinor: "175000", autoRelease: false, released: false, txHash: null },
  ],
  payoutAccountHash: fakeHex32(`payout:${TERMS_ID}`),
  holderName: "Example Drinkware Co., Ltd.",
  orderId: null,
  coolingEndsAt: null,
  bindTxHash: null,
  createdAt: LATER,
};

/** 50/50 would auto-release 2,000 BU on order, over the supplier line's 1,250 BU per-payment cap. */
export const exampleTermsPrefill: TermsPrefill = {
  supplierId: EXAMPLE_WEB_SUPPLIER_ID,
  searchId: SEARCH_ID,
  milestones: P30_70,
  preset: "P30_70",
  source: "preset",
  question: null,
  presetAvailability: [
    { preset: "P30_70", ok: true, code: null },
    { preset: "P50_50", ok: false, code: "TERMS_AUTO_OVER_PER_TX" },
    { preset: "P0_100", ok: true, code: null },
    { preset: "P30_40_30", ok: true, code: null },
  ],
};

// ---- CFO ---------------------------------------------------------------------------------------------
export const exampleCfoInsight: CfoInsight = {
  insightId: "insight-mei-001",
  kind: "BURN_ALERT",
  severity: "warn",
  title: "Ads spending is ahead of plan",
  detail: "Ads ran at 1.6 times the planned daily pace for 3 days. The agent lowered the ads per-payment cap.",
  lineKey: "ADS",
  suggestion: { kind: "TIGHTEN", href: "/dashboard?tab=spending" },
};

export const exampleCfoAgentAction: CfoAgentAction = {
  at: LATER,
  action: "LOWER_PER_TX_CAP",
  lineKey: "ADS",
  newValue: "20000",
  reason: "Ads spending ran at 1.6 times the planned pace for 3 days",
  txHash: fakeHex32("tx:tighten:mei:ads"),
};

export const exampleCfoReport: CfoReport = {
  asOf: LATER,
  currency: "SGD",
  facilityId: MEI_IDS.facilityId,
  overview: { cashAvailableMinor: "214500", spentMinor: "185500", revenueMinor: "96000", reserveMinor: "4800", netMinor: "-89500" },
  spending: {
    byLine: [
      { lineKey: "SUPPLIER", allocatedMinor: "500000", spentMinor: "120000", escrowedMinor: "0", availableMinor: "380000" },
      { lineKey: "ADS", allocatedMinor: "120000", spentMinor: "45000", escrowedMinor: "0", availableMinor: "75000" },
      { lineKey: "PLATFORM_FEES", allocatedMinor: "50000", spentMinor: "13600", escrowedMinor: "0", availableMinor: "36400" },
      { lineKey: "LOGISTICS", allocatedMinor: "80000", spentMinor: "6900", escrowedMinor: "0", availableMinor: "73100" },
    ],
    daily: [
      { date: "2026-10-21", spentMinor: "9000" },
      { date: "2026-10-22", spentMinor: "9600" },
    ],
  },
  sales: {
    count: 12,
    revenueMinor: "96000",
    averageMinor: "8000",
    daily: [
      { date: "2026-10-21", revenueMinor: "16000", count: 2 },
      { date: "2026-10-22", revenueMinor: "24000", count: 3 },
    ],
    recent: [{ saleId: "sale-mei-012", amountMinor: "8000", at: LATER, txHash: fakeHex32("tx:sale:mei:012") }],
    stageGate: { stageId: MEI_IDS.stage2Id, targetMinor: "200000", soFarMinor: "96000", deadline: "2026-11-15", projectedDate: "2026-11-04" },
  },
  pnl: {
    from: "2026-10-16",
    to: "2026-10-23",
    revenueMinor: "96000",
    supplierCostMinor: "120000",
    operatingByLine: [
      { lineKey: "ADS", amountMinor: "45000" },
      { lineKey: "PLATFORM_FEES", amountMinor: "13600" },
      { lineKey: "LOGISTICS", amountMinor: "6900" },
    ],
    operatingMinor: "65500",
    netMinor: "-89500",
    reserveSetAsideMinor: "4800",
    basis: "cash",
  },
  forecast: {
    method: "MA7_LINEAR",
    sampleDays: 7,
    dailyBurnMinor: "9400",
    dailyRevenueMinor: "13700",
    runwayDays: 22,
    stage2Date: "2026-11-04",
    reserveIn30dMinor: "25350",
    points: [
      { date: "2026-10-24", cashMinor: "218800" },
      { date: "2026-10-25", cashMinor: "223100" },
    ],
  },
  reserve: { rateBps: 500, skimmedMinor: "4800", withdrawnMinor: "0", balanceMinor: "4800", taxPayeeId: MEI_IDS.taxPayeeId, salesCount: 12 },
  insights: [exampleCfoInsight],
  agentActions: [exampleCfoAgentAction],
  disclaimer: "Estimates from your own records. Not financial advice.",
};

// ---- needs -------------------------------------------------------------------------------------------
export const exampleNeedsChecklist: NeedsChecklist = {
  draftId: DRAFT_ID,
  currency: "SGD",
  totalMinor: "1000000",
  reserveBps: 500,
  items: [
    { itemId: "need-acra", group: "REGISTRATION", title: "Register your business name with ACRA (BizFile+)", detail: null, amountMinor: "11500", lineKey: null, sourceRef: "/registrations/0", status: "IN_PLAN" },
    { itemId: "need-sfa", group: "REGISTRATION", title: "Register as an importer of food-contact articles with SFA", detail: "Free, about 1 working day.", amountMinor: "0", lineKey: null, sourceRef: "/productApprovals/drinkware_food_contact", status: "IN_PLAN" },
    { itemId: "need-line-supplier", group: "BUDGET_LINE", title: "Supplier (escrow milestones only)", detail: null, amountMinor: "500000", lineKey: "SUPPLIER", sourceRef: "compiler:line.supplier", status: "IN_PLAN" },
    { itemId: "need-supplier-tumblers", group: "SUPPLIER", title: "Find a tumbler supplier", detail: null, amountMinor: null, lineKey: "SUPPLIER", sourceRef: "compiler:payee.supplier", status: "TODO" },
    { itemId: "need-shopee", group: "ACCOUNT", title: "Shopee Singapore seller account", detail: null, amountMinor: null, lineKey: null, sourceRef: null, status: "TODO" },
    { itemId: "need-reserve", group: "TAX_RESERVE", title: "Set aside 5% of each sale for tax", detail: null, amountMinor: null, lineKey: null, sourceRef: "constitution:RESERVE_BELOW_FLOOR", status: "IN_PLAN" },
  ],
};

// ---- chat parts --------------------------------------------------------------------------------------
/** One example per chat-first data part (VISION-DECISIONS §4). */
export const exampleJourneyDataParts: readonly ChatDataPart[] = [
  { type: "data-needs", id: `needs-${DRAFT_ID}`, data: exampleNeedsChecklist },
  {
    type: "data-sign",
    id: `sign-${DRAFT_ID}`,
    data: { kind: "PlanApproval", refId: DRAFT_ID, title: "Approve your launch plan", summary: "Sign the plan with your passkey. The budget lines and caps become rules the wallet enforces.", cta: "Sign the plan" },
  },
  {
    type: "data-next",
    data: { actions: [{ label: "Find suppliers", action: exampleChatActions[0] as ChatAction }, { label: "Use the demo catalog", action: exampleChatActions[1] as ChatAction }] },
  },
  { type: "data-action", data: { action: exampleChatActions[3] as ChatAction } },
  { type: "data-search", id: SEARCH_ID, data: { searchId: SEARCH_ID } },
  { type: "data-candidates", id: `candidates-${SEARCH_ID}`, data: { searchId: SEARCH_ID } },
  {
    type: "data-enquiry",
    data: {
      supplierIds: [EXAMPLE_WEB_SUPPLIER_ID],
      subject: "Enquiry: 500 insulated tumblers",
      body: "Hello, I would like a quote for 500 insulated tumblers. Please confirm your unit price, MOQ, lead time, product certificates, and whether you accept milestone payments (a deposit on order, the balance after a delivery check).",
    },
  },
  { type: "data-terms", id: `terms-prefill-${EXAMPLE_WEB_SUPPLIER_ID}`, data: exampleTermsPrefill },
  { type: "data-order", id: `order-${TERMS_ID}`, data: { termsId: TERMS_ID } },
  { type: "data-cfo", data: { view: "overview" } },
];

/** A founder's button press and the assistant's answer, as GET /api/chat stores them. */
export const exampleJourneyMessages = [
  { id: "msg-mei-0101", role: "user", parts: [{ type: "text", text: "Find suppliers" }, { type: "data-action", data: { action: exampleChatActions[0] as ChatAction } }] },
  { id: "msg-mei-0102", role: "assistant", parts: [{ type: "text", text: "Searching supplier listings now." }, { type: "data-search", id: SEARCH_ID, data: { searchId: SEARCH_ID } }] },
] as const;

/** Mei's chat session (for journey examples that name one). */
export const EXAMPLE_JOURNEY_SESSION_ID = MEI_SESSION_ID;
