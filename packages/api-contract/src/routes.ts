/**
 * Every §26.6 route. Register them in this order: static paths come before param paths that could shadow them
 * (e.g. /api/evidence/runs before /api/evidence/:runId).
 */
import { z } from "zod";
import {
  AutonomyStats,
  Balances,
  CfoReport,
  ChainAction,
  ChatDataPart,
  ChatMessage,
  EscrowSchedule,
  EvidenceBundle,
  EvidenceRunSummary,
  Exception,
  ExceptionCreate,
  Health,
  OrderTerms,
  OrderTermsInput,
  PasskeyRegistrationOptions,
  PasskeyRegistrationResponse,
  PasskeyRegistrationResult,
  Payment,
  PendingFounderKey,
  PlanDraft,
  PlanRecord,
  Session,
  Shortlist,
  SignatureRequestBody,
  SignatureRequestResponse,
  SignatureSubmitBody,
  SpendProposal,
  SpendProposalResult,
  SupplierSearch,
  SupplierSearchBody,
  TraceEvent,
} from "@hogee/core";
import { defineRoute, type ReqOf, type ResOf } from "./define";
import * as s from "./schemas";

// SG-DECISIONS Q1: either founder persona; a server resolves every non-officer cookie to its country's founder.
const FOUNDER = ["founder:rina", "founder:mei"] as const;
const OFFICER = ["officer"] as const;

export const routes = {
  // ---- session / health ---------------------------------------------------------------------------
  getSession: defineRoute({
    name: "getSession", method: "GET", path: "/api/session", summary: "Persona, facility and API mode (live|mock|replay)",
    req: {}, res: Session, errors: [],
  }),
  setPersona: defineRoute({
    name: "setPersona", method: "POST", path: "/api/session/persona", summary: "Set the HMAC-signed demo persona cookie",
    // G0-REVIEW (M14): demo only (404 unless DEMO_MODE=1).
    // G0-AUDIT (v-2): officer requires officerToken == OFFICER_TOKEN (constant time); a wrong token, or an unset or
    // weak OFFICER_TOKEN, is 403 FORBIDDEN and sets no cookie. A missing token is VALIDATION. The Set-Cookie is
    // HttpOnly; SameSite=Strict; Path=/api; no Domain; Max-Age ≤ 8 h (@hogee/api signPersonaCookie).
    req: { body: s.SetPersonaBody }, res: Session, errors: ["VALIDATION", "NOT_FOUND", "FORBIDDEN"], demoOnly: true,
  }),
  getHealth: defineRoute({
    name: "getHealth", method: "GET", path: "/api/health", summary: "Dependency health",
    req: {}, res: Health, errors: [],
  }),

  // ---- chat / plans --------------------------------------------------------------------------------
  chat: defineRoute({
    name: "chat", method: "POST", path: "/api/chat", summary: "AI SDK UI-message stream with frozen data parts",
    // G2: CONFLICT (facility not open, plan drift) and NOT_FOUND (no country pack) were rewritten to UPSTREAM.
    // VISION-DECISIONS §5: the body is {sessionId, message} (free text) or {sessionId, action} (a button's ChatAction).
    req: { body: s.ChatBody }, res: ChatDataPart, errors: ["VALIDATION", "NOT_FOUND", "FORBIDDEN", "CONFLICT", "UPSTREAM"], personas: FOUNDER, stream: true,
  }),
  getChat: defineRoute({
    name: "getChat", method: "GET", path: "/api/chat/:sessionId", summary: "Chat history (UI messages)",
    req: { params: s.SessionIdParams }, res: z.array(ChatMessage), errors: ["VALIDATION", "NOT_FOUND"],
  }),
  draftPlan: defineRoute({
    name: "draftPlan", method: "POST", path: "/api/plans/draft", summary: "Compile the session's PlanIntent into a PlanDraft",
    req: { body: s.DraftPlanBody }, res: PlanDraft, errors: ["VALIDATION", "NOT_FOUND", "FORBIDDEN", "CONFLICT", "COMPILE_FAILED", "UPSTREAM"],
    personas: FOUNDER,
  }),
  previewCountry: defineRoute({
    name: "previewCountry", method: "POST", path: "/api/plans/preview-country", summary: "Off-chain country switch (MY → ID)",
    req: { body: s.PreviewCountryBody }, res: PlanDraft, errors: ["VALIDATION", "NOT_FOUND", "FORBIDDEN", "CONFLICT", "COMPILE_FAILED", "UPSTREAM"],
    personas: FOUNDER,
  }),
  getCurrentPlan: defineRoute({
    name: "getCurrentPlan", method: "GET", path: "/api/plans/current", summary: "Current plan version",
    req: {}, res: PlanRecord, errors: ["NOT_FOUND"],
  }),
  listPlanVersions: defineRoute({
    name: "listPlanVersions", method: "GET", path: "/api/plans/versions", summary: "All plan versions, oldest first",
    req: {}, res: z.array(PlanRecord), errors: [],
  }),

  // ---- passkey / facility --------------------------------------------------------------------------
  passkeyRegisterOptions: defineRoute({
    name: "passkeyRegisterOptions", method: "POST", path: "/api/passkey/register/options", summary: "WebAuthn creation options",
    // G2 (run-4 lead 5): the body carries the loan officer's one-time enrolment code and the challenge is bound to it.
    // A wrong, used, revoked or expired code is FORBIDDEN.
    req: { body: s.PasskeyRegisterOptionsBody }, res: PasskeyRegistrationOptions, errors: ["VALIDATION", "FORBIDDEN", "CONFLICT"], personas: FOUNDER,
  }),
  passkeyRegisterVerify: defineRoute({
    name: "passkeyRegisterVerify", method: "POST", path: "/api/passkey/register/verify", summary: "Verify attestation; returns P-256 key",
    // G2: consumes the enrolment code the challenge is bound to, atomically with storing the PENDING_LENDER key
    // (FORBIDDEN when that code is no longer open). A second key is FounderKeyAlreadySet (was rewritten to CONFLICT).
    req: { body: PasskeyRegistrationResponse }, res: PasskeyRegistrationResult, errors: ["VALIDATION", "FORBIDDEN", "CONFLICT", "FounderKeyAlreadySet"],
    personas: FOUNDER,
  }),
  approveFounderKey: defineRoute({
    name: "approveFounderKey", method: "POST", path: "/api/officer/founder-key/approve", summary: "registerFounderKey (lender)",
    req: { body: s.ApproveFounderKeyBody }, res: ChainAction,
    // G0-REVIEW: FounderKeyAlreadySet added.
    // G0-AUDIT (v-2): the body names the reviewed credentialId/qx/qy; CONFLICT when it is not the founder's pending
    // registration, so the lender key never registers a key the officer did not see.
    errors: ["VALIDATION", "NOT_FOUND", "FORBIDDEN", "CONFLICT", "UPSTREAM", "NotLender", "FounderKeyAlreadySet"], personas: OFFICER,
  }),
  // G2 (P2 request): the officer console reads the key under review here instead of from the founder's browser.
  getPendingFounderKey: defineRoute({
    name: "getPendingFounderKey", method: "GET", path: "/api/officer/founder-key/pending", summary: "The founder's key awaiting review, or null",
    req: {}, res: PendingFounderKey.nullable(), errors: ["FORBIDDEN"], personas: OFFICER,
  }),
  // G2 (run-4 lead 5): one open code per facility; issuing another revokes the previous one.
  issueEnrolmentCode: defineRoute({
    name: "issueEnrolmentCode", method: "POST", path: "/api/officer/founder-key/enrolment-code", summary: "One-time founder enrolment code (15 min)",
    req: {}, res: s.EnrolmentCodeResult, errors: ["FORBIDDEN", "CONFLICT"], personas: OFFICER,
  }),
  // G2 (run-4 lead 5): rejects the pending key so a fresh enrolment can start. A key registered on-chain is never
  // touched (FounderKeyAlreadySet), nor one whose approval is already on its way to the chain (CONFLICT).
  rejectFounderKey: defineRoute({
    name: "rejectFounderKey", method: "POST", path: "/api/officer/founder-key/reject", summary: "Reject the pending founder key",
    req: { body: s.RejectFounderKeyBody }, res: s.RejectFounderKeyResult,
    errors: ["VALIDATION", "NOT_FOUND", "FORBIDDEN", "CONFLICT", "UPSTREAM", "FounderKeyAlreadySet"], personas: OFFICER,
  }),
  openFacility: defineRoute({
    name: "openFacility", method: "POST", path: "/api/facility/open", summary: "openFacility(cap, reserveFloorBps) (lender)",
    req: { body: s.OpenFacilityBody }, res: ChainAction, errors: ["VALIDATION", "FORBIDDEN", "CONFLICT", "UPSTREAM", "NotLender"],
    personas: OFFICER,
  }),
  fundFacility: defineRoute({
    name: "fundFacility", method: "POST", path: "/api/facility/fund", summary: "fund(amount), capped at the plan total (lender)",
    req: { body: s.FundFacilityBody }, res: ChainAction,
    errors: ["VALIDATION", "FORBIDDEN", "CONFLICT", "UPSTREAM", "NotLender", "CapExceeded"], personas: OFFICER,
  }),

  // ---- signing ---------------------------------------------------------------------------------------
  requestSignature: defineRoute({
    name: "requestSignature", method: "POST", path: "/api/signatures/request", summary: "Typed data + digest + displayModel to sign",
    // G2: the policy refusals prepare mirrors (loosening, milestone release, owner spend) were rewritten to CONFLICT.
    req: { body: SignatureRequestBody }, res: SignatureRequestResponse,
    errors: [
      "VALIDATION", "NOT_FOUND", "FORBIDDEN", "CONFLICT", "UPSTREAM",
      "PlanInvariantViolated", "PayeeCooling", "PayeeNotBound", "CapExceeded", "LineExpired", "DuplicateInvoice", "DuplicateIntent",
      "EscrowOnly", "AmountExceedsSchedule", "MilestoneLocked", "EvidenceMissing",
    ],
    personas: FOUNDER,
  }),
  submitSignature: defineRoute({
    name: "submitSignature", method: "POST", path: "/api/signatures/:id/submit", summary: "Submit passkey/ECDSA signature; relayer sends",
    req: { params: s.IdParams, body: SignatureSubmitBody }, res: ChainAction,
    errors: [
      "VALIDATION", "NOT_FOUND", "FORBIDDEN", "CONFLICT", "UPSTREAM",
      "InvalidSignature", "SignatureExpired", "PlanInvariantViolated", "StalePlan",
      "NotOwner", "NotLender", "PayeeCooling", "PayeeNotBound", "CapExceeded", "LineExpired", "DuplicateInvoice",
      "AmountExceedsSchedule", "MilestoneLocked", "EvidenceMissing", "TimelockActive",
      // G2: an owner spend's mirrored refusals and the simulated ownerSpend/bindPayee reverts.
      "EscrowOnly", "DuplicateIntent",
    ],
    personas: FOUNDER,
  }),

  // ---- suppliers / escrow ------------------------------------------------------------------------------
  shortlistSuppliers: defineRoute({
    name: "shortlistSuppliers", method: "POST", path: "/api/suppliers/shortlist", summary: "Start a shortlist job",
    req: { body: s.ShortlistBody }, res: s.RequestIdResponse, errors: ["VALIDATION", "FORBIDDEN", "CONFLICT", "UPSTREAM"], personas: FOUNDER,
  }),
  getShortlist: defineRoute({
    name: "getShortlist", method: "GET", path: "/api/suppliers/shortlist/:id", summary: "Poll until status READY",
    req: { params: s.IdParams }, res: Shortlist, errors: ["NOT_FOUND"],
  }),
  // VISION-DECISIONS §5: web supplier search. The query is built server-side from the COMMITTED plan (the body only
  // carries a quantity); refusals name a SEARCH_* reason in details. Static path, so before /api/suppliers/:id.
  startSupplierSearch: defineRoute({
    name: "startSupplierSearch", method: "POST", path: "/api/suppliers/search", summary: "Start a web supplier search from the committed plan",
    req: { body: SupplierSearchBody }, res: s.SearchIdResponse, errors: ["VALIDATION", "FORBIDDEN", "CONFLICT", "UPSTREAM"], personas: FOUNDER,
  }),
  getSupplierSearch: defineRoute({
    name: "getSupplierSearch", method: "GET", path: "/api/suppliers/search/:id", summary: "Poll a web supplier search until READY or FAILED",
    req: { params: s.IdParams }, res: SupplierSearch, errors: ["NOT_FOUND"],
  }),
  getSupplier: defineRoute({
    name: "getSupplier", method: "GET", path: "/api/suppliers/:id", summary: "Supplier + evidence + its escrow order id",
    req: { params: s.IdParams }, res: s.SupplierWithOrder, errors: ["NOT_FOUND"],
  }),
  getEscrow: defineRoute({
    name: "getEscrow", method: "GET", path: "/api/escrow/:orderId", summary: "Milestones of an escrow order",
    req: { params: s.OrderIdParams }, res: EscrowSchedule, errors: ["VALIDATION", "NOT_FOUND"],
  }),
  uploadInspection: defineRoute({
    name: "uploadInspection", method: "POST", path: "/api/escrow/:orderId/inspection", summary: "Upload inspection evidence (multipart `file`)",
    // Run-7 re-check M1: no upload limit answers CONFLICT any more (a new hash is always stored); CONFLICT stays
    // declared for the frozen shape.
    req: { params: s.OrderIdParams, body: s.InspectionUploadBody }, res: s.EvidenceHashResponse,
    errors: ["VALIDATION", "NOT_FOUND", "FORBIDDEN", "CONFLICT"], personas: FOUNDER, multipart: true,
  }),
  // VISION-DECISIONS §5, §9: the founder's reported terms and the supplier's payout account (this form is the ONLY way an
  // account arrives: never chat, listing text or a model). Refusals name a TERMS_* reason in details; sanctions that
  // cannot be screened answer 503.
  submitOrderTerms: defineRoute({
    name: "submitOrderTerms", method: "POST", path: "/api/orders/terms", summary: "Confirm supplier terms (schedule + payout account)",
    req: { body: OrderTermsInput }, res: OrderTerms, errors: ["VALIDATION", "NOT_FOUND", "FORBIDDEN", "CONFLICT", "UPSTREAM"], personas: FOUNDER,
  }),
  getOrderTerms: defineRoute({
    name: "getOrderTerms", method: "GET", path: "/api/orders/terms/:id", summary: "Confirmed supplier terms and their schedule",
    req: { params: s.IdParams }, res: OrderTerms, errors: ["NOT_FOUND"],
  }),

  // ---- dashboard -----------------------------------------------------------------------------------------
  getBalances: defineRoute({
    name: "getBalances", method: "GET", path: "/api/balances", summary: "Pockets, reserve, escrow, agent key, drift",
    req: {}, res: Balances, errors: ["UPSTREAM"],
  }),
  listPayments: defineRoute({
    name: "listPayments", method: "GET", path: "/api/payments", summary: "Payments, newest first",
    req: { query: s.ListPaymentsQuery }, res: z.array(Payment), errors: ["VALIDATION"],
  }),
  getPayment: defineRoute({
    name: "getPayment", method: "GET", path: "/api/payments/:id", summary: "Payment + its traces",
    req: { params: s.IdParams }, res: s.PaymentWithTraces, errors: ["NOT_FOUND"],
  }),
  listTraces: defineRoute({
    name: "listTraces", method: "GET", path: "/api/traces", summary: "Trace events (glass box)",
    req: { query: s.ListTracesQuery }, res: z.array(TraceEvent), errors: ["VALIDATION"],
  }),
  getTrace: defineRoute({
    name: "getTrace", method: "GET", path: "/api/traces/:traceId", summary: "All events of one trace",
    req: { params: s.TraceIdParams }, res: z.array(TraceEvent), errors: ["NOT_FOUND"],
  }),
  // VISION-DECISIONS §5: the AI CFO report (cash basis, from the facility's own records).
  getCfoReport: defineRoute({
    name: "getCfoReport", method: "GET", path: "/api/cfo", summary: "CFO report: spending, sales, P&L, forecast, reserve",
    req: {}, res: CfoReport, errors: ["NOT_FOUND", "UPSTREAM"],
  }),

  // ---- exceptions / proposals / control -------------------------------------------------------------------
  listExceptions: defineRoute({
    name: "listExceptions", method: "GET", path: "/api/exceptions", summary: "Exception console",
    req: { query: s.ListExceptionsQuery }, res: z.array(Exception), errors: ["VALIDATION"],
  }),
  createException: defineRoute({
    name: "createException", method: "POST", path: "/api/exceptions", summary: "Founder requests a loosening / release",
    // G2: POLICY_ESCALATION is not in ExceptionCreate (422). A loosening the chain would refuse answers its mirrored error.
    req: { body: ExceptionCreate }, res: Exception,
    errors: ["VALIDATION", "FORBIDDEN", "CONFLICT", "UPSTREAM", "PlanInvariantViolated", "PayeeNotBound", "CapExceeded", "LineExpired"],
    personas: FOUNDER,
  }),
  approveException: defineRoute({
    name: "approveException", method: "POST", path: "/api/exceptions/:id/approve",
    summary: "Officer: server signs with the demo lender key. Founder: returns a signature request",
    // G0-AUDIT (v-2): officer branch iff the verified persona === "officer" (signed cookie, @hogee/api
    // verifyPersonaCookie). A missing, unsigned, forged or expired cookie is the deployment's founder, so it gets the founder
    // branch (SIGNATURE_REQUIRED) or an error, never a server lender signature.
    // G2: the mirrored refusals of the loosening / stage-gate checks (officer) and of the founder's signature request
    // (loosening, milestone release) were rewritten to CONFLICT. An escalation is approved as an override, never
    // re-checked here (the worker re-checks payee and caps when it pays), so EscrowOnly and Paused cannot come back.
    req: { params: s.IdParams, body: s.ApproveExceptionBody }, res: s.ApproveExceptionResult,
    errors: [
      "VALIDATION", "NOT_FOUND", "FORBIDDEN", "CONFLICT", "UPSTREAM", "NotLender", "TimelockActive",
      "PlanInvariantViolated", "PayeeCooling", "PayeeNotBound", "CapExceeded", "LineExpired", "AmountExceedsSchedule", "MilestoneLocked",
      "EvidenceMissing",
    ],
  }),
  denyException: defineRoute({
    name: "denyException", method: "POST", path: "/api/exceptions/:id/deny", summary: "Officer denies",
    req: { params: s.IdParams, body: s.ReasonBody }, res: Exception, errors: ["VALIDATION", "NOT_FOUND", "FORBIDDEN", "CONFLICT"],
    personas: OFFICER,
  }),
  vetoException: defineRoute({
    name: "vetoException", method: "POST", path: "/api/exceptions/:id/veto", summary: "Veto during the timelock window",
    req: { params: s.IdParams, body: s.ReasonBody }, res: Exception, errors: ["VALIDATION", "NOT_FOUND", "FORBIDDEN", "CONFLICT"],
  }),
  proposeSpend: defineRoute({
    name: "proposeSpend", method: "POST", path: "/api/proposals/spend",
    summary: "Policy-checked spend proposal (MCP wrapper demo): invoiceId or pacingSlot; server derives payee + amount",
    // G0-REVIEW (D6/H1): body names an invoice or pacing slot only; demo only.
    req: { body: SpendProposal }, res: SpendProposalResult, errors: ["VALIDATION", "NOT_FOUND", "FORBIDDEN", "CONFLICT"], demoOnly: true,
  }),
  pause: defineRoute({
    name: "pause", method: "POST", path: "/api/control/pause", summary: "Pause (tighten-only, instant)",
    req: {}, res: ChainAction, errors: ["CONFLICT", "UPSTREAM"],
  }),
  getAutonomyStats: defineRoute({
    name: "getAutonomyStats", method: "GET", path: "/api/stats/autonomy", summary: "Autonomous loop stats",
    req: {}, res: AutonomyStats, errors: ["UPSTREAM"],
  }),

  // ---- evidence ---------------------------------------------------------------------------------------------
  listEvidenceRuns: defineRoute({
    name: "listEvidenceRuns", method: "GET", path: "/api/evidence/runs", summary: "Evidence bundles",
    req: {}, res: z.array(EvidenceRunSummary), errors: [],
  }),
  // REG-BRIEF (fisco-proof): the FISCO BCOS mirror packs (evidence/fisco/fm-*/), served with the bundle reader's guards
  // and only to the tenant that may read the pack's source Sepolia bundle today. Static "/fisco" paths, so they come
  // before getEvidenceRun, which would read "fisco" as a run id.
  listFiscoPacks: defineRoute({
    name: "listFiscoPacks", method: "GET", path: "/api/evidence/fisco", summary: "FISCO BCOS mirror packs, newest first",
    req: {}, res: z.array(s.FiscoPackSummary), errors: [],
  }),
  getFiscoFile: defineRoute({
    name: "getFiscoFile", method: "GET", path: "/api/evidence/fisco/:packId/files/:path{.+}", summary: "Raw FISCO mirror pack file",
    req: { params: s.FiscoFileParams }, res: z.unknown(), errors: ["VALIDATION", "NOT_FOUND"], fileResponse: true,
  }),
  getFiscoAnchor: defineRoute({
    name: "getFiscoAnchor", method: "GET", path: "/api/evidence/fisco/:packId/anchor", summary: "The pack's Sepolia anchor sidecar (404 if none)",
    req: { params: s.FiscoPackParams }, res: z.unknown(), errors: ["VALIDATION", "NOT_FOUND"], fileResponse: true,
  }),
  exportEvidence: defineRoute({
    name: "exportEvidence", method: "POST", path: "/api/evidence/export", summary: "Build an evidence bundle",
    req: {}, res: s.RunIdResponse, errors: ["CONFLICT", "UPSTREAM"],
  }),
  getEvidenceRun: defineRoute({
    name: "getEvidenceRun", method: "GET", path: "/api/evidence/:runId", summary: "Bundle manifest + rows + file list",
    req: { params: s.RunIdParams }, res: EvidenceBundle, errors: ["NOT_FOUND"],
  }),
  getEvidenceFile: defineRoute({
    name: "getEvidenceFile", method: "GET", path: "/api/evidence/:runId/files/:path{.+}", summary: "Raw bundle file",
    req: { params: s.EvidenceFileParams }, res: z.unknown(), errors: ["VALIDATION", "NOT_FOUND"], fileResponse: true,
  }),

  // ---- webhooks ----------------------------------------------------------------------------------------------
  stripeWebhook: defineRoute({
    name: "stripeWebhook", method: "POST", path: "/api/webhooks/stripe", summary: "Signed Stripe test webhook → record-sale",
    req: { headers: s.StripeWebhookHeaders, body: s.StripeWebhookBody }, res: s.StripeWebhookResponse,
    // G0-DECISION: a bad Stripe-Signature is 400 with code VALIDATION.
    errors: ["VALIDATION"], errorStatus: { VALIDATION: 400 }, rawBody: true,
  }),

  // ---- eval (DEMO_MODE=1 only) -------------------------------------------------------------------------------
  evalCase: defineRoute({
    name: "evalCase", method: "POST", path: "/api/eval/case", summary: "E1 case on Anvil + MockRail",
    req: { body: s.EvalCaseBody }, res: s.EvalCaseResult, errors: ["VALIDATION", "NOT_FOUND", "UPSTREAM"], demoOnly: true,
  }),
  evalPlan: defineRoute({
    name: "evalPlan", method: "POST", path: "/api/eval/plan", summary: "E2/E4 plan run (auto-answers hiddenSlot)",
    req: { body: s.EvalPlanBody }, res: s.EvalPlanResult, errors: ["VALIDATION", "NOT_FOUND", "COMPILE_FAILED", "UPSTREAM"], demoOnly: true,
  }),
  evalShortlist: defineRoute({
    name: "evalShortlist", method: "POST", path: "/api/eval/shortlist", summary: "E3 shortlist run",
    req: { body: s.EvalShortlistBody }, res: Shortlist, errors: ["VALIDATION", "NOT_FOUND", "UPSTREAM"], demoOnly: true,
  }),

  // ---- demo (DEMO_MODE=1 only) -------------------------------------------------------------------------------
  demoAttack: defineRoute({
    name: "demoAttack", method: "POST", path: "/api/demo/attack", summary: "Canned refusal + optional forced revert",
    req: { body: s.DemoAttackBody }, res: s.DemoAttackResult, errors: ["VALIDATION", "NOT_FOUND", "CONFLICT", "UPSTREAM"], demoOnly: true,
  }),
  demoSale: defineRoute({
    name: "demoSale", method: "POST", path: "/api/demo/sale", summary: "Create a Stripe test payment (real webhook path)",
    req: { body: s.DemoSaleBody }, res: s.DemoSaleResult, errors: ["VALIDATION", "NOT_FOUND", "UPSTREAM"], demoOnly: true,
  }),
  demoCrashNextBroadcast: defineRoute({
    name: "demoCrashNextBroadcast", method: "POST", path: "/api/demo/crash-next-broadcast", summary: "Pull the plug after next broadcast",
    // G0-REVIEW (M14): destructive demo routes are officer-only.
    req: {}, res: s.DemoArmedResult, errors: ["NOT_FOUND", "FORBIDDEN"], demoOnly: true, personas: OFFICER,
  }),
  demoAutonomyStart: defineRoute({
    name: "demoAutonomyStart", method: "POST", path: "/api/demo/autonomy/start", summary: "Start the demo autonomy loop",
    req: {}, res: s.DemoAutonomyResult, errors: ["NOT_FOUND", "FORBIDDEN"], demoOnly: true, personas: OFFICER,
  }),
  demoAutonomyStop: defineRoute({
    name: "demoAutonomyStop", method: "POST", path: "/api/demo/autonomy/stop", summary: "Stop the demo autonomy loop",
    req: {}, res: s.DemoAutonomyResult, errors: ["NOT_FOUND", "FORBIDDEN"], demoOnly: true, personas: OFFICER,
  }),
  demoReset: defineRoute({
    name: "demoReset", method: "POST", path: "/api/demo/reset", summary: "Reset demo state",
    req: {}, res: s.OkResult, errors: ["NOT_FOUND", "FORBIDDEN"], demoOnly: true, personas: OFFICER,
  }),
} as const;

export type Routes = typeof routes;
export type RouteName = keyof Routes;
export const ROUTE_NAMES = Object.keys(routes) as RouteName[];

/** Request parts of a route, e.g. RouteReq<"listPayments"> = { query: {...} }. */
export type RouteReq<N extends RouteName> = ReqOf<Routes[N]>;
/** 2xx response body of a route, e.g. RouteRes<"getBalances"> = Balances. */
export type RouteRes<N extends RouteName> = ResOf<Routes[N]>;
export type RouteParams<N extends RouteName> = RouteReq<N> extends { params: infer P } ? P : never;
export type RouteQuery<N extends RouteName> = RouteReq<N> extends { query: infer Q } ? Q : never;
export type RouteBody<N extends RouteName> = RouteReq<N> extends { body: infer B } ? B : never;
