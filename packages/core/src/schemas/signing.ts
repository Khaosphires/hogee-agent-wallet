/**
 * Generic signing (project.md §8.7, §26.5 displayModel, §26.6 signature routes) and passkey registration.
 * One <SignDialog> drives every kind: POST /api/signatures/request → POST /api/signatures/:id/submit.
 */
import { z } from "zod";
import { ChainActionState, DisplayEffect, PasskeyOnchainStatus, SignMethod, SignatureKind } from "./enums";
import {
  Address,
  Base64Url,
  ChainId,
  DeploymentId,
  EcdsaSignature,
  Hex32,
  HexBytes,
  Id,
  IsoDateTime,
  NonNegInt,
  UnixSeconds,
} from "./primitives";

/** displayModel: drives the "what you sign" panel; rendered from the same canonical JSON as the digest. */
export const DisplayModel = z.strictObject({
  title: z.string().min(1).max(200),
  kind: SignatureKind,
  rows: z.array(z.strictObject({ label: z.string().min(1).max(100), value: z.string().max(500), effect: DisplayEffect })).min(1),
  digest: Hex32,
  chainId: ChainId,
  contract: Address,
  deploymentId: DeploymentId,
});
export type DisplayModel = z.infer<typeof DisplayModel>;

export const SignatureRequestBody = z.strictObject({
  kind: SignatureKind,
  // G0-DECISION: refId is draftId (PlanApproval), orderId (SupplierApproval, MilestoneRelease),
  // exceptionId (LoosenRequest, StageRelease) or invoiceId (OwnerSpend, the manual-fallback spend).
  refId: Id.describe("draftId | orderId | exceptionId | invoiceId (OwnerSpend), depending on kind"),
  method: SignMethod,
});
export type SignatureRequestBody = z.infer<typeof SignatureRequestBody>;

// typedData is generic here; the struct field lists are owned by packages/chain (eip712.ts hogeeTypes,
// mirroring HogeeTypes.sol). Coordinator note 4: PlanApproval includes linesHash + stagesHash,
// SupplierApproval includes lineId, and OwnerSpend is the sixth struct.
// G0-DECISION: typedData follows viem's TypedDataDefinition JSON: custom domain (§8.7) without
// EIP712Domain in `types`; uint values are decimal strings, bytes/bytes32 are 0x-hex, bools are booleans.
export const Eip712Domain = z.strictObject({
  name: z.literal("Hogee"),
  version: z.literal("1"),
  verifyingContract: Address,
  salt: Hex32,
});
export type Eip712Domain = z.infer<typeof Eip712Domain>;

export const TypedData = z.strictObject({
  domain: Eip712Domain,
  types: z.record(
    z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/),
    z.array(z.strictObject({ name: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/), type: z.string().min(1).max(64) })).min(1),
  ),
  primaryType: SignatureKind,
  message: z.record(z.string(), z.union([z.string(), z.boolean()])),
});
export type TypedData = z.infer<typeof TypedData>;

export const SignatureRequestResponse = z.strictObject({
  requestId: Id,
  typedData: TypedData,
  digest: Hex32,
  challengeB64url: Base64Url.length(43).describe("base64url of the raw 32-byte digest"),
  displayModel: DisplayModel,
  expiresAt: UnixSeconds,
});
export type SignatureRequestResponse = z.infer<typeof SignatureRequestResponse>;

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P256_HALF_N = P256_N >> 1n;

// G0-DECISION: the API rejects high-s passkey signatures (the client encoder must normalise to low-s, §6.1).
// challengeIndex/typeIndex are JS integers; clientDataJSON is the raw UTF-8 JSON text.
export const PasskeyAssertion = z.strictObject({
  credentialId: Base64Url,
  r: Hex32,
  s: Hex32.refine((s) => !/^0x[0-9a-f]{64}$/.test(s) || (BigInt(s) > 0n && BigInt(s) <= P256_HALF_N), "s must be low-s (0 < s ≤ n/2)"),
  challengeIndex: NonNegInt,
  typeIndex: NonNegInt,
  authenticatorData: HexBytes,
  clientDataJSON: z.string().min(1).max(4096),
});
export type PasskeyAssertion = z.infer<typeof PasskeyAssertion>;

/** POST /api/signatures/:id/submit body: exactly one of `passkey` or `ecdsa`. */
export const SignatureSubmitBody = z.union([
  z.strictObject({ passkey: PasskeyAssertion }),
  z.strictObject({ ecdsa: z.strictObject({ signature: EcdsaSignature }) }),
]);
export type SignatureSubmitBody = z.infer<typeof SignatureSubmitBody>;

export const ChainAction = z.strictObject({
  actionId: Id,
  state: ChainActionState,
  txHash: Hex32.optional(),
});
export type ChainAction = z.infer<typeof ChainAction>;

// ---- Passkey registration (WebAuthn JSON) ------------------------------------------------------
// G0-DECISION: WebAuthn ceremony JSON is modelled with z.looseObject (shape owned by the W3C spec /
// @simplewebauthn); only the fields we rely on are required. This is the one deliberate strictness exception.
export const PasskeyRegistrationOptions = z.looseObject({
  rp: z.looseObject({ name: z.string().min(1), id: z.string().min(1).optional() }),
  user: z.looseObject({ id: Base64Url, name: z.string().min(1), displayName: z.string() }),
  challenge: Base64Url,
  pubKeyCredParams: z.array(z.looseObject({ type: z.literal("public-key"), alg: z.number().int() })).min(1),
});
export type PasskeyRegistrationOptions = z.infer<typeof PasskeyRegistrationOptions>;

export const PasskeyRegistrationResponse = z.looseObject({
  id: Base64Url,
  rawId: Base64Url,
  type: z.literal("public-key"),
  response: z.looseObject({ clientDataJSON: Base64Url, attestationObject: Base64Url }),
  clientExtensionResults: z.looseObject({}),
});
export type PasskeyRegistrationResponse = z.infer<typeof PasskeyRegistrationResponse>;

export const PasskeyRegistrationResult = z.strictObject({
  credentialId: Base64Url,
  qx: Hex32,
  qy: Hex32,
  onchain: PasskeyOnchainStatus,
});
export type PasskeyRegistrationResult = z.infer<typeof PasskeyRegistrationResult>;

// ---- Founder-key enrolment (G2, closes security-audit run-4 lead 5) ---------------------------------
// The loan officer issues a one-time enrolment code (POST /api/officer/founder-key/enrolment-code) and hands it to
// the founder out of band. POST /api/passkey/register/options takes it, the registration challenge is bound to it,
// and /verify consumes it in the same transaction that stores the PENDING_LENDER key, so only the person holding the
// officer's code can take the founder's slot. 18 random bytes (144 bits), base64url: 24 URL-safe characters. Servers
// store only keccak256(utf8(code)) (Ethereum Keccak-256, never NIST SHA3-256).
export const ENROLMENT_CODE_BYTES = 18;
/** A code expires 15 minutes after it is issued, in wall-clock time (the registration challenge's time base). */
export const ENROLMENT_CODE_TTL_SECONDS = 15 * 60;
export const EnrolmentCode = z
  .string()
  .regex(/^[A-Za-z0-9_-]{24}$/, "must be the 24-character enrolment code from the loan officer")
  .describe("One-time founder enrolment code issued by the loan officer (base64url, 144 bits)");
export type EnrolmentCode = z.infer<typeof EnrolmentCode>;

/** GET /api/officer/founder-key/pending: the founder's key awaiting the officer's review (the route answers null when none). */
export const PendingFounderKey = z.strictObject({
  credentialId: Base64Url,
  qx: Hex32,
  qy: Hex32,
  /** When the founder registered it (off-chain, ISO-8601). */
  createdAt: IsoDateTime,
});
export type PendingFounderKey = z.infer<typeof PendingFounderKey>;
