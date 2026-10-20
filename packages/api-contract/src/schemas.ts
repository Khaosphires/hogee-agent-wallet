/**
 * Route-specific request/response schemas (project.md §26.6). Domain objects live in @hogee/core.
 */
import { z } from "zod";
import {
  Base64Url,
  Bps,
  ChainAction,
  ChatAction,
  CountryCode,
  E1Case,
  EnrolmentCode,
  EvalAblation,
  EvalArm,
  EvidenceTaskId,
  ExceptionStatus,
  Exception,
  Hex32,
  Id,
  IsoDateTime,
  LineKey,
  Minor,
  OrderId,
  Payment,
  PaymentState,
  PlanDraft,
  PlanIntent,
  Persona,
  PosInt,
  SessionId,
  ShortlistMode,
  ShortlistSpec,
  SignMethod,
  SignatureRequestResponse,
  SupplierWithEvidence,
  TraceEvent,
} from "@hogee/core";

// ---- params ------------------------------------------------------------------------------------
export const IdParams = z.strictObject({ id: Id });
export const SessionIdParams = z.strictObject({ sessionId: SessionId });
export const OrderIdParams = z.strictObject({ orderId: OrderId });
export const TraceIdParams = z.strictObject({ traceId: Id });
export const RunIdParams = z.strictObject({ runId: Id });
// G0-DECISION: the evidence file route uses Hono's regex param `:path{.+}` (spec: /files/*), so the file path
// (which may contain slashes) is a named param.
/** A bundle-relative file path: no leading slash, no "..", the characters a bundle writes (also a FISCO pack's). */
const BundlePath = z.string().min(1).max(300).regex(/^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]+$/, "relative path without ..");
export const EvidenceFileParams = z.strictObject({ runId: Id, path: BundlePath });
// REG-BRIEF (fisco-proof): a FISCO BCOS mirror pack is evidence/fisco/<packId>/, named after its packId (fm- and the
// first 16 hex of a keccak256; @hogee/verify-evidence fisco PACK_DIR_RE, the same literal). Its file paths are bundle
// paths; its Sepolia anchor is the sidecar evidence/fisco/anchors/<packId>.sepolia.json.
export const FiscoPackId = z.string().regex(/^fm-[0-9a-f]{16}$/, "fm- and 16 lowercase hex");
export const FiscoPackParams = z.strictObject({ packId: FiscoPackId });
export const FiscoFileParams = z.strictObject({ packId: FiscoPackId, path: BundlePath });

// ---- query (strings only; unknown keys stripped) ------------------------------------------------
// G0-DECISION: pagination cursor = paymentId of the last item of the previous page (exclusive); page size is
// server-defined; the response stays a bare array as in §26.6.
export const ListPaymentsQuery = z.object({ state: PaymentState.optional(), lineKey: LineKey.optional(), cursor: Id.optional() });
// G0-DECISION: traces `since` is an ISO-8601 timestamp (exclusive), `limit` a digit string 1..500.
export const ListTracesQuery = z.object({
  since: IsoDateTime.optional(),
  limit: z.string().regex(/^([1-9][0-9]{0,1}|[1-4][0-9]{2}|500)$/, "1..500").optional(),
});
export const ListExceptionsQuery = z.object({ status: ExceptionStatus.optional() });

// ---- bodies --------------------------------------------------------------------------------------
// G0-AUDIT (v-2): the officer persona selects actions the server performs with the server-held demo LENDER key
// (approveException's officer branch, approveFounderKey, openFacility, fundFacility), so minting it needs proof:
// `officerToken` must equal the operator secret OFFICER_TOKEN (env, 32..256 chars, strength-checked), compared in
// constant time (packages/api officerTokenMatches). Unset/weak OFFICER_TOKEN or a mismatch → 403 FORBIDDEN and no
// cookie; attempt limiting and a trace event per failure are the handler's job (task 1.12).
// The founder persona needs no token (and a founder body carrying one is rejected: strict).
// SG-DECISIONS Q1: both founder personas parse here; the server accepts only the founder of its HOGEE_COUNTRY
// (SG → founder:mei, MY → founder:rina) and refuses the other with 403 FORBIDDEN.
export const OfficerToken = z.string().min(32).max(256).describe("Operator secret OFFICER_TOKEN (never logged)");
export const SetPersonaBody = z.discriminatedUnion("persona", [
  z.strictObject({ persona: Persona.extract(["founder:rina", "founder:mei"]) }),
  z.strictObject({ persona: Persona.extract(["officer"]), officerToken: OfficerToken }),
]);
// G0-DECISION: `message` is the user's plain text; the server owns the (append-only) history.
export const ChatTextBody = z.strictObject({ sessionId: SessionId, message: z.string().min(1).max(4000) });
// VISION-DECISIONS §5: a button press is a structured action instead (no free text; it skips the model and redaction,
// not the rate limit). Both shapes are strict, so a body carrying a message AND an action is refused.
export const ChatActionBody = z.strictObject({ sessionId: SessionId, action: ChatAction });
export const ChatBody = z.union([ChatTextBody, ChatActionBody]);
export const DraftPlanBody = z.strictObject({ sessionId: SessionId });
export const PreviewCountryBody = z.strictObject({ draftId: Id, country: CountryCode });
// G0-AUDIT (v-2): the officer approves exactly the credential they reviewed (fields as in core
// PasskeyRegistrationResult); the server answers 409 CONFLICT when it differs from the founder's pending registration.
export const ApproveFounderKeyBody = z.strictObject({ founderId: Id, credentialId: Base64Url, qx: Hex32, qy: Hex32 });
// G2 (closes security-audit run-4 lead 5): registration needs the one-time code the loan officer issued; the WebAuthn
// challenge is bound to it, and /verify consumes it with the PENDING_LENDER key. A wrong, used, revoked or expired
// code is 403 FORBIDDEN. The officer can reject a pending key (never one registered on-chain) to restart enrolment.
export const PasskeyRegisterOptionsBody = z.strictObject({ enrolmentCode: EnrolmentCode });
export const RejectFounderKeyBody = z.strictObject({ credentialId: Base64Url });
export const OpenFacilityBody = z.strictObject({ capMinor: Minor, reserveFloorBps: Bps });
export const FundFacilityBody = z.strictObject({ amountMinor: Minor });
export const ShortlistBody = z.strictObject({ spec: ShortlistSpec });
export const InspectionUploadBody = z.strictObject({ file: z.instanceof(Blob) });
// G0-DECISION: approve takes an optional signing method (founder path; default passkey).
export const ApproveExceptionBody = z.strictObject({ method: SignMethod.optional() });
export const ReasonBody = z.strictObject({ reason: z.string().min(1).max(500) });
export const StripeWebhookHeaders = z.object({ "stripe-signature": z.string().min(1) });
export const StripeWebhookBody = z.string().describe("Raw request body, verified with Stripe-Signature");

export const EvalCaseBody = z.strictObject({ arm: EvalArm, case: E1Case });
export const EvalPlanBody = z.strictObject({
  promptId: Id,
  text: z.string().min(1).max(4000),
  model: z.string().min(1).max(100),
  repeat: PosInt,
  ablation: EvalAblation.optional(),
});
export const EvalShortlistBody = z.strictObject({ setId: z.string().regex(/^set-[0-9]{2}$/), mode: ShortlistMode });
// G0-DECISION: demo attack ids are evidence task ids (T1..T33, D-poison, D-plug, S*).
export const DemoAttackBody = z.strictObject({ attackId: EvidenceTaskId });
export const DemoSaleBody = z.strictObject({ amountMinor: Minor });

// ---- responses -------------------------------------------------------------------------------------
export const RequestIdResponse = z.strictObject({ requestId: Id });
// VISION-DECISIONS §5: POST /api/suppliers/search starts a web search; poll GET /api/suppliers/search/:id.
export const SearchIdResponse = z.strictObject({ searchId: Id });
export const EvidenceHashResponse = z.strictObject({ evidenceHash: Hex32 });
export const RunIdResponse = z.strictObject({ runId: Id });
/**
 * REG-BRIEF (fisco-proof): a FISCO mirror pack this tenant may read (its source Sepolia bundle is one of the tenant's
 * runs today): its id, pack.json's createdAt, every file in it (at most 400, the pack's own cap) and whether its Sepolia
 * anchor sidecar is there. Newest first. The browser verifies the files; the API vouches for none of them.
 */
export const FiscoPackSummary = z.strictObject({
  packId: FiscoPackId,
  createdAt: IsoDateTime,
  files: z.array(BundlePath).max(400),
  anchored: z.boolean(),
});
export type FiscoPackSummary = z.infer<typeof FiscoPackSummary>;
export const PaymentWithTraces = Payment.extend({ traces: z.array(TraceEvent) });
export type PaymentWithTraces = z.infer<typeof PaymentWithTraces>;
// G2 (P2 request): the supplier's newest escrow order, so the suppliers page reads it instead of hard-coding the demo
// id. null until the founder's SupplierApproval created an order for this supplier.
export const SupplierWithOrder = SupplierWithEvidence.extend({ orderId: OrderId.nullable() });
export type SupplierWithOrder = z.infer<typeof SupplierWithOrder>;
// G2: `code` is shown once and stored only as keccak256(utf8(code)); it expires at `expiresAt` (wall clock, 15 min).
export const EnrolmentCodeResult = z.strictObject({ code: EnrolmentCode, expiresAt: IsoDateTime });
export type EnrolmentCodeResult = z.infer<typeof EnrolmentCodeResult>;
export const RejectFounderKeyResult = z.strictObject({ credentialId: Base64Url, status: z.literal("REJECTED") });
export type RejectFounderKeyResult = z.infer<typeof RejectFounderKeyResult>;

// G0-DECISION: approve returns a tagged union instead of a bare "Exception | signatures/request".
export const ApproveExceptionResult = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("APPROVED"), exception: Exception, action: ChainAction.optional() }),
  z.strictObject({ outcome: z.literal("SIGNATURE_REQUIRED"), signature: SignatureRequestResponse }),
]);
export type ApproveExceptionResult = z.infer<typeof ApproveExceptionResult>;

export const StripeWebhookResponse = z.strictObject({ duplicate: z.literal(true).optional() });

export const EvalCaseResult = z.strictObject({
  executed: z.boolean(),
  txHash: Hex32.optional(),
  revertReason: z.string().min(1).max(200).optional(),
  refusalTraceId: Id.optional(),
  lossMinor: Minor,
});
export const EvalPlanResult = z.strictObject({ intent: PlanIntent, draft: PlanDraft, turns: PosInt });
export const DemoAttackResult = z.strictObject({
  refusal: TraceEvent,
  forced: z.strictObject({ txHash: Hex32, revertReason: z.string().min(1).max(200) }).optional(),
});
// G0-DECISION: bodies of the demo control responses (spec gives none).
export const DemoSaleResult = z.strictObject({ paymentIntentId: z.string().min(1).max(255) });
export const DemoArmedResult = z.strictObject({ armed: z.literal(true) });
export const DemoAutonomyResult = z.strictObject({ running: z.boolean() });
export const OkResult = z.strictObject({ ok: z.literal(true) });
