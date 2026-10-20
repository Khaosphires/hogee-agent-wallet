/**
 * One example request and 2xx response per route (typed: a missing route is a compile error).
 * Used by tests, by the api-mock contract test, and as copy-paste material for P2.
 * SG-DECISIONS: Singapore (Mei) is the main demo, so the requests that name a demo record use MEI_IDS (the api-mock's
 * default demo serves them); the preview example switches to Malaysia. Response bodies are the @hogee/core examples
 * (built from Rina's numbers, which are Mei's in minor units); only their shape is checked.
 */
import {
  MEI_IDS,
  MEI_SESSION_ID,
  type ApiErrorCode,
  exampleAutonomyStats,
  exampleBalances,
  exampleBundleManifest,
  exampleChainAction,
  exampleCfoReport,
  exampleChatDataParts,
  exampleChatMessages,
  exampleE1AttackRow,
  exampleEnrolmentCode,
  exampleEscrowSchedule,
  exampleEvidenceBundle,
  exampleEvidenceRunSummary,
  exampleException,
  exampleExceptionCreate,
  exampleExceptions,
  exampleHealth,
  exampleOrderTerms,
  exampleOrderTermsInput,
  examplePasskeyRegistrationOptions,
  examplePasskeyRegistrationResponse,
  examplePasskeyRegistrationResult,
  examplePayment,
  examplePendingFounderKey,
  examplePlanDraft,
  examplePlanIntent,
  examplePlanRecord,
  exampleSessionMei,
  exampleShortlist,
  exampleShortlistSpec,
  exampleSignatureRequestBody,
  exampleSignatureRequestResponse,
  exampleSignatureSubmitPasskey,
  exampleSpendProposal,
  exampleSpendProposalResult,
  exampleSupplierSearch,
  exampleSupplierSearchBody,
  exampleSupplierWithEvidence,
  exampleTraceEvent,
  fakeHex32,
} from "@hogee/core";
import type { RouteName, RouteReq, RouteRes } from "./routes";

export interface RouteExample<N extends RouteName> {
  readonly req: RouteReq<N>;
  readonly res: RouteRes<N>;
  /**
   * G0-REVIEW (M13): set only on an ERROR example. The contract test then expects this ApiError code;
   * every other example request must get a 2xx from the mock.
   */
  readonly expectError?: ApiErrorCode;
}

const sessionId = MEI_SESSION_ID;
/** Mei's compiled draft id (core meiCompileInput); the api-mock's SG example draft carries it. */
const MEI_DRAFT_ID = "draft-mei-001";
const evidenceHash = fakeHex32("evidence:inspection");
/** The FISCO BCOS mirror pack tracked in evidence/fisco/ (its folder name). */
const FISCO_PACK_ID = "fm-c2b22fa376a165da";

export const ROUTE_EXAMPLES: { readonly [N in RouteName]: RouteExample<N> } = {
  getSession: { req: {}, res: exampleSessionMei },
  // G0-AUDIT (v-2): a placeholder token, never valid: @hogee/api isStrongSecret rejects any configured OFFICER_TOKEN
  // containing "example" or "not-a-secret". Real tokens come from OFFICER_TOKEN only.
  setPersona: {
    req: { body: { persona: "officer", officerToken: "example-officer-token-not-a-secret-0000" } },
    res: { ...exampleSessionMei, persona: "officer" },
  },
  getHealth: { req: {}, res: exampleHealth },
  chat: { req: { body: { sessionId, message: "I want to sell custom insulated tumblers on Shopee Singapore, budget S$10,000" } }, res: exampleChatDataParts[0]! },
  getChat: { req: { params: { sessionId } }, res: [...exampleChatMessages] },
  draftPlan: { req: { body: { sessionId } }, res: examplePlanDraft },
  // SG is the base; the switch previews Malaysia (the core example draft is an MY draft).
  previewCountry: {
    req: { body: { draftId: MEI_DRAFT_ID, country: "MY" } },
    res: { ...examplePlanDraft, draftId: `${MEI_DRAFT_ID}-my` },
  },
  getCurrentPlan: { req: {}, res: examplePlanRecord },
  listPlanVersions: { req: {}, res: [examplePlanRecord] },
  // G2: the code the officer issued (the contract test uses one the mock issued: codes are random and single use).
  passkeyRegisterOptions: { req: { body: { enrolmentCode: exampleEnrolmentCode } }, res: examplePasskeyRegistrationOptions },
  passkeyRegisterVerify: { req: { body: examplePasskeyRegistrationResponse }, res: examplePasskeyRegistrationResult },
  approveFounderKey: {
    // G0-AUDIT (v-2): the reviewed credential, i.e. passkeyRegisterVerify's example result.
    req: {
      body: {
        founderId: MEI_IDS.founderId,
        credentialId: examplePasskeyRegistrationResult.credentialId,
        qx: examplePasskeyRegistrationResult.qx,
        qy: examplePasskeyRegistrationResult.qy,
      },
    },
    res: exampleChainAction,
  },
  getPendingFounderKey: { req: {}, res: examplePendingFounderKey },
  issueEnrolmentCode: { req: {}, res: { code: exampleEnrolmentCode, expiresAt: "2026-10-15T08:15:00Z" } },
  rejectFounderKey: {
    req: { body: { credentialId: examplePendingFounderKey.credentialId } },
    res: { credentialId: examplePendingFounderKey.credentialId, status: "REJECTED" },
  },
  openFacility: { req: { body: { capMinor: "1000000", reserveFloorBps: 300 } }, res: exampleChainAction },
  fundFacility: { req: { body: { amountMinor: "1000000" } }, res: exampleChainAction },
  requestSignature: { req: { body: { ...exampleSignatureRequestBody, refId: MEI_DRAFT_ID } }, res: exampleSignatureRequestResponse },
  submitSignature: { req: { params: { id: exampleSignatureRequestResponse.requestId }, body: exampleSignatureSubmitPasskey }, res: exampleChainAction },
  shortlistSuppliers: { req: { body: { spec: exampleShortlistSpec } }, res: { requestId: exampleShortlist.requestId } },
  getShortlist: { req: { params: { id: exampleShortlist.requestId } }, res: exampleShortlist },
  startSupplierSearch: { req: { body: exampleSupplierSearchBody }, res: { searchId: exampleSupplierSearch.searchId } },
  getSupplierSearch: { req: { params: { id: exampleSupplierSearch.searchId } }, res: exampleSupplierSearch },
  getSupplier: { req: { params: { id: MEI_IDS.supplierAId } }, res: { ...exampleSupplierWithEvidence, orderId: MEI_IDS.supplierAOrderId } },
  getEscrow: { req: { params: { orderId: MEI_IDS.supplierAOrderId } }, res: exampleEscrowSchedule },
  uploadInspection: {
    req: { params: { orderId: MEI_IDS.supplierAOrderId }, body: { file: new Blob(["inspection report (example)"], { type: "application/pdf" }) } },
    res: { evidenceHash },
  },
  submitOrderTerms: { req: { body: exampleOrderTermsInput }, res: exampleOrderTerms },
  getOrderTerms: { req: { params: { id: exampleOrderTerms.termsId } }, res: exampleOrderTerms },
  getBalances: { req: {}, res: exampleBalances },
  listPayments: { req: { query: { state: "SETTLED", lineKey: "SUPPLIER" } }, res: [examplePayment] },
  getPayment: { req: { params: { id: examplePayment.paymentId } }, res: { ...examplePayment, traces: [exampleTraceEvent] } },
  listTraces: { req: { query: { since: "2026-10-16T00:00:00Z", limit: "50" } }, res: [exampleTraceEvent] },
  getTrace: { req: { params: { traceId: exampleTraceEvent.traceId } }, res: [exampleTraceEvent] },
  getCfoReport: { req: {}, res: exampleCfoReport },
  listExceptions: { req: { query: { status: "OPEN" } }, res: [...exampleExceptions] },
  createException: { req: { body: exampleExceptionCreate }, res: exampleException },
  approveException: {
    req: { params: { id: exampleException.exceptionId }, body: {} },
    res: { outcome: "APPROVED", exception: { ...exampleException, status: "APPROVED" } },
  },
  denyException: {
    req: { params: { id: exampleException.exceptionId }, body: { reason: "Ads cap raise not justified yet" } },
    res: { ...exampleException, status: "DENIED" },
  },
  vetoException: {
    req: { params: { id: exampleException.exceptionId }, body: { reason: "Veto during timelock" } },
    res: { ...exampleException, status: "CANCELLED" },
  },
  proposeSpend: { req: { body: exampleSpendProposal }, res: exampleSpendProposalResult },
  pause: { req: {}, res: { ...exampleChainAction, actionId: "act-pause" } },
  getAutonomyStats: { req: {}, res: exampleAutonomyStats },
  listEvidenceRuns: { req: {}, res: [exampleEvidenceRunSummary] },
  exportEvidence: { req: {}, res: { runId: exampleEvidenceRunSummary.runId } },
  getEvidenceRun: { req: { params: { runId: exampleBundleManifest.runId } }, res: exampleEvidenceBundle },
  getEvidenceFile: { req: { params: { runId: exampleBundleManifest.runId, path: "receipts/T1.json" } }, res: {} },
  // REG-BRIEF (fisco-proof): the tracked mirror pack (evidence/fisco/); the contract test reads the mock's own listing.
  listFiscoPacks: { req: {}, res: [{ packId: FISCO_PACK_ID, createdAt: "2026-10-19T21:03:15.402Z", files: ["chain.json", "hashes.json", "pack.json", "steps.json"], anchored: false }] },
  getFiscoFile: { req: { params: { packId: FISCO_PACK_ID, path: "pack.json" } }, res: {} },
  getFiscoAnchor: { req: { params: { packId: FISCO_PACK_ID } }, res: {} },
  stripeWebhook: {
    req: { headers: { "stripe-signature": "t=1792108800,v1=0000" }, body: '{"id":"evt_test_example","type":"payment_intent.succeeded"}' },
    res: {},
    // Error example: the fake Stripe-Signature must be rejected with 400 VALIDATION.
    expectError: "VALIDATION",
  },
  evalCase: { req: { body: { arm: "hogee", case: exampleE1AttackRow } }, res: { executed: false, refusalTraceId: "trace-0007", lossMinor: "0" } },
  evalPlan: {
    req: { body: { promptId: "e2-my-001", text: "Nak jual tumbler kat Shopee, budget dalam 10k.", model: "claude-sonnet-5-5", repeat: 1 } },
    res: { intent: examplePlanIntent, draft: examplePlanDraft, turns: 3 },
  },
  evalShortlist: { req: { body: { setId: "set-01", mode: "hogee" } }, res: exampleShortlist },
  demoAttack: {
    req: { body: { attackId: "T1" } },
    res: {
      refusal: { ...exampleTraceEvent, actor: "policy", kind: "DENIAL", verdict: "DENY", reasonCode: "PayeeNotBound" },
      forced: { txHash: fakeHex32("tx:T1:forced"), revertReason: "PayeeNotBound" },
    },
  },
  demoSale: { req: { body: { amountMinor: "50000" } }, res: { paymentIntentId: "pi_test_example" } },
  demoCrashNextBroadcast: { req: {}, res: { armed: true } },
  demoAutonomyStart: { req: {}, res: { running: true } },
  demoAutonomyStop: { req: {}, res: { running: false } },
  demoReset: { req: {}, res: { ok: true } },
};
