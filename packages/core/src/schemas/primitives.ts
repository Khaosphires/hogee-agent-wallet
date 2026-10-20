/**
 * Primitives and formats (project.md §26.3). Frozen at G0.
 *
 * Conventions shared by every schema in this folder:
 * - Money is always `Minor`: a digit string in minor units (1 BU = 100 minor). Never a JS number.
 * - Off-chain timestamps are ISO-8601 UTC strings ending in `Z`.
 * - Chain-mirrored times and durations are digit strings in seconds.
 * - Hex values are lowercase so that JCS hashing (RFC 8785) sees one canonical form.
 */
import { z } from "zod";
import { EVIDENCE_TIERS, SOURCE_TYPES, SENSITIVITIES, TRUST_LEVELS } from "./enums";

// G2 (§26.10): a removal is a breaking change, so the major version moves. 2.0.0 removed POLICY_ESCALATION from
// ExceptionCreate and added the founder-key enrolment routes; the PlanManifest shape is unchanged.
export const SCHEMA_VERSION = "2.0.0" as const;
/**
 * Versions a stored PlanManifest may carry. New manifests carry SCHEMA_VERSION; a plan compiled under 1.0.0 stays
 * readable because its manifest shape is identical and its hash (with `schemaVersion` inside) may already be on-chain,
 * so it can never be rewritten.
 */
export const READABLE_SCHEMA_VERSIONS = ["1.0.0", SCHEMA_VERSION] as const;
export const SchemaVersion = z.enum(READABLE_SCHEMA_VERSIONS);

const DIGITS_RE = /^(0|[1-9][0-9]*)$/;
const UINT128_MAX = (1n << 128n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT32_MAX = 2 ** 32 - 1;

/** Minor units as a digit string, no leading zeros except "0". Bounded by uint128 (on-chain amount type). */
export const Minor = z
  .string()
  .max(39)
  .regex(DIGITS_RE, "must be a minor-unit digit string (no sign, no decimals, no leading zeros)")
  // zod runs refinements even after a failed regex, so guard before BigInt().
  .refine((s) => !DIGITS_RE.test(s) || BigInt(s) <= UINT128_MAX, "exceeds uint128")
  .describe("Money in minor units (1 BU = 100 minor), digit string");
export type Minor = z.infer<typeof Minor>;

/**
 * VISION-DECISIONS §0.4: signed money (a P&L net, a forecast cash point) as a digit string with an optional leading
 * minus, in minor units. Canonical: no "-0", no leading zeros; |value| is bounded by uint128 like Minor.
 */
const SIGNED_DIGITS_RE = /^-?(0|[1-9]\d{0,38})$/;
export const SignedMinor = z
  .string()
  .max(40)
  .regex(SIGNED_DIGITS_RE, "must be a signed minor-unit digit string (optional leading minus, no decimals, no leading zeros)")
  .refine((s) => s !== "-0", "must not be -0")
  .refine((s) => !SIGNED_DIGITS_RE.test(s) || BigInt(s.replace(/^-/, "")) <= UINT128_MAX, "exceeds uint128 in magnitude")
  .describe("Signed money in minor units (1 BU = 100 minor), digit string with optional leading minus");
export type SignedMinor = z.infer<typeof SignedMinor>;

/** A non-money unsigned integer carried as a digit string (e.g. a stage-gate order count). */
// G0-REVIEW (M10): bounded by uint128 (Stage.target is uint128 on-chain).
export const DigitString = z
  .string()
  .max(39)
  .regex(DIGITS_RE, "must be an unsigned integer digit string")
  .refine((s) => !DIGITS_RE.test(s) || BigInt(s) <= UINT128_MAX, "exceeds uint128")
  .describe("Unsigned integer (uint128), digit string");
export type DigitString = z.infer<typeof DigitString>;

/** Unix seconds as a digit string (chain-mirrored times: validUntil, expiresAt, deadline, executableAt). */
export const UnixSeconds = z
  .string()
  .max(20)
  .regex(DIGITS_RE, "must be unix seconds as a digit string")
  .refine((s) => !DIGITS_RE.test(s) || BigInt(s) <= UINT64_MAX, "exceeds uint64")
  .describe("Unix seconds, digit string");
export type UnixSeconds = z.infer<typeof UnixSeconds>;

/** A duration in seconds as a digit string (e.g. windowSeconds). */
// G0-REVIEW (M10): bounded by uint32 (Line.windowSeconds is uint32 on-chain).
export const Seconds = z
  .string()
  .max(10)
  .regex(DIGITS_RE, "must be seconds as a digit string")
  .refine((s) => !DIGITS_RE.test(s) || Number(s) <= UINT32_MAX, "exceeds uint32")
  .describe("Duration in seconds (uint32), digit string");
export type Seconds = z.infer<typeof Seconds>;

/** ISO-8601 UTC timestamp, `Z` suffix required, optional fractional seconds. */
export const IsoDateTime = z.iso.datetime().describe("ISO-8601 UTC timestamp ending in Z");
export type IsoDateTime = z.infer<typeof IsoDateTime>;

/** Calendar date YYYY-MM-DD (e.g. verifiedOn). */
export const IsoDate = z.iso.date().describe("Calendar date YYYY-MM-DD");
export type IsoDate = z.infer<typeof IsoDate>;

/** 0x + 64 lowercase hex characters. */
export const Hex32 = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/, "must be 0x + 64 lowercase hex characters")
  .describe("32-byte value, 0x + 64 lowercase hex");
export type Hex32 = z.infer<typeof Hex32>;

export const ZERO_HEX32: Hex32 = `0x${"0".repeat(64)}`;

// G0-DECISION: addresses are 0x + 40 LOWERCASE hex. JCS hashing is case-sensitive, so one canonical
// form is required; EIP-55 checksums cannot be verified here without a keccak dependency. UIs may
// display checksummed addresses (viem getAddress) but must send/store lowercase.
export const Address = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/, "must be 0x + 40 lowercase hex characters")
  .describe("EVM address, 0x + 40 lowercase hex");
export type Address = z.infer<typeof Address>;

/** Arbitrary-length byte string, 0x + even number of lowercase hex characters (at least 1 byte). */
export const HexBytes = z
  .string()
  .regex(/^0x([0-9a-f]{2})+$/, "must be 0x + lowercase hex bytes")
  .describe("Byte string, 0x + lowercase hex");
export type HexBytes = z.infer<typeof HexBytes>;

/** 65-byte ECDSA signature (r ‖ s ‖ v). */
export const EcdsaSignature = z
  .string()
  .regex(/^0x[0-9a-f]{130}$/, "must be a 65-byte signature, 0x + 130 lowercase hex")
  .describe("65-byte ECDSA signature");
export type EcdsaSignature = z.infer<typeof EcdsaSignature>;

// G0-DECISION: UUIDv7 ids must be lowercase (canonical form for JCS; crypto/uuid libraries emit lowercase).
export const UuidV7 = z
  .uuidv7()
  .regex(/^[0-9a-f-]+$/, "must be lowercase")
  .describe("UUIDv7, lowercase");
export type UuidV7 = z.infer<typeof UuidV7>;

export const SessionId = UuidV7.describe("Chat session id (UUIDv7, created by the client)");
export const DecisionId = UuidV7.describe("Agent decision id (UUIDv7; left-padded to bytes32 on-chain)");

// G0-DECISION: opaque off-chain ids (paymentId, exceptionId, draftId, requestId, traceId, actionId,
// runId, evidenceId, invoiceId, founderId, facilityId, supplierId, llmCallId, payoutId) share one format.
export const Id = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, "must be an id: [A-Za-z0-9._:-], 1-128 chars, alphanumeric first")
  .describe("Opaque id");
export type Id = z.infer<typeof Id>;

// G0-DECISION: ids that go on-chain as bytes32 (payeeId, orderId, deploymentId) are short lowercase ASCII
// strings encoded exactly like lineId: stringToHex(id, { size: 32 }) (right-padded). See stringToBytes32.
export const ShortId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, "must be a short id: [a-z0-9_-], 1-32 chars, alphanumeric first")
  .describe("Short on-chain id (≤32 ASCII bytes, encoded as bytes32 via stringToHex)");
export type ShortId = z.infer<typeof ShortId>;

export const PayeeId = ShortId.describe("Payee id (bytes32 on-chain via stringToHex)");
export type PayeeId = z.infer<typeof PayeeId>;
export const OrderId = ShortId.describe("Escrow order id (bytes32 on-chain via stringToHex)");
export type OrderId = z.infer<typeof OrderId>;
export const DeploymentId = ShortId.describe("Deployment id, e.g. loop-1, final-1");
export type DeploymentId = z.infer<typeof DeploymentId>;
// G0-DECISION (chain freeze): Stage.stageId and SupplierApproval.supplierId are bytes32 on-chain, encoded with
// stringToHex like lineId (packages/chain eip712.ts), so off-chain they are ShortIds too ("stage-1", "supplier-a").
export const StageId = ShortId.describe("Stage id (bytes32 on-chain via stringToHex), e.g. stage-1");
export type StageId = z.infer<typeof StageId>;
export const SupplierId = ShortId.describe("Supplier id (bytes32 on-chain via stringToHex), e.g. supplier-a");
export type SupplierId = z.infer<typeof SupplierId>;

// G0-DECISION (coordinator note 5, chain freeze): reason codes and settlement failure codes go on-chain as
// stringToHex(code, {size: 32}) (recordDenied, failSettlement), so they are ≤32 ASCII chars: a §8.5 error
// name (PayeeNotBound) or a policy/payout code (WITHIN_PLAN, INVALID_DESTINATION).
export const ReasonCode = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/, "must be ≤32 chars [A-Za-z0-9_], letter first")
  .describe("Code stored on-chain as bytes32 (stringToHex)");
export type ReasonCode = z.infer<typeof ReasonCode>;

/** base64url without padding (WebAuthn credential ids, challenges). */
export const Base64Url = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "must be base64url without padding")
  .describe("base64url, no padding");
export type Base64Url = z.infer<typeof Base64Url>;

/** ISO 3166-1 alpha-2 country code (e.g. CN for buyFrom). */
export const Iso2 = z.string().regex(/^[A-Z]{2}$/, "must be an ISO 3166-1 alpha-2 code").describe("ISO 3166-1 alpha-2");
export type Iso2 = z.infer<typeof Iso2>;

/** ISO 4217 currency code. */
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, "must be an ISO 4217 code").describe("ISO 4217 currency code");
export type CurrencyCode = z.infer<typeof CurrencyCode>;

/** Basis points, integer 0..10000. */
export const Bps = z.number().int().min(0).max(10_000).describe("Basis points (integer 0..10000)");
export type Bps = z.infer<typeof Bps>;

/** Small on-chain counters (plan version, stage id, milestone idx, trace seq) are JS integers. */
export const NonNegInt = z.number().int().min(0);
export const PosInt = z.number().int().min(1);
// G0-REVIEW (M10): numbers bound for the chain carry their real width.
/** uint8 (milestone idx, MilestoneRelease.idx). */
export const Uint8 = z.number().int().min(0).max(255);
/** Plan version: uint32 on-chain, starts at 1. */
export const PlanVersion = z.number().int().min(1).max(UINT32_MAX);

export const ChainId = PosInt.describe("EVM chain id (11155111 Sepolia, 31337 Anvil)");
// G0-DECISION: block numbers are JS integers (well below 2^53), not digit strings.
export const BlockNumber = NonNegInt.describe("Block number");

export const HttpUrl = z.url({ protocol: /^https?$/ }).describe("http(s) URL");

/** Upper snake case code, e.g. flags and reason codes. */
export const UpperSnake = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, "must be UPPER_SNAKE_CASE");

export const EvidenceTier = z.enum(EVIDENCE_TIERS);
export type EvidenceTier = z.infer<typeof EvidenceTier>;
export const SourceType = z.enum(SOURCE_TYPES);
export type SourceType = z.infer<typeof SourceType>;

/** Taint label (§7.3): travels with the value. */
export const Taint = z.strictObject({
  trust: z.enum(TRUST_LEVELS),
  sensitivity: z.enum(SENSITIVITIES),
});
export type Taint = z.infer<typeof Taint>;

/** Provenance fields of a `Sourced` leaf, without the value. */
export const SourceMeta = z.strictObject({
  sourceUrl: HttpUrl,
  retrievedAt: IsoDateTime,
  snippetHash: Hex32.describe("0x + sha256 of the trimmed, whitespace-collapsed sentence (scripts/snippet-hash.py)"),
  evidence: EvidenceTier,
  sourceType: SourceType,
  verifiedBy: z.string().min(1).max(64).optional(),
  verifiedOn: IsoDate.optional(),
});
export type SourceMeta = z.infer<typeof SourceMeta>;

/** `Sourced<T>` factory (§26.3): `{value, sourceUrl, retrievedAt, snippetHash, evidence, sourceType, verifiedBy?, verifiedOn?}`. */
export function sourced<T extends z.ZodType>(value: T) {
  return z.strictObject({ value, ...SourceMeta.shape });
}
export type Sourced<T> = { value: T } & SourceMeta;

/**
 * Encode a short ASCII id as bytes32 exactly like viem `stringToHex(id, { size: 32 })`
 * (UTF-8 bytes, right-padded with zeros). Used for lineId, payeeId, orderId, deploymentId.
 */
export function stringToBytes32(id: string): Hex32 {
  if (!/^[\x20-\x7e]*$/.test(id)) throw new Error(`stringToBytes32: non-ASCII id ${JSON.stringify(id)}`);
  if (id.length > 32) throw new Error(`stringToBytes32: id longer than 32 bytes: ${id}`);
  let hex = "";
  for (let i = 0; i < id.length; i += 1) hex += id.charCodeAt(i).toString(16).padStart(2, "0");
  return `0x${hex.padEnd(64, "0")}`;
}

/** Build a strict object whose keys are the given enum values, each optional (JSON-Schema friendly partial record). */
export function partialKeyed<const K extends readonly [string, ...string[]], V extends z.ZodType>(keys: K, value: V) {
  const shape = Object.fromEntries(keys.map((k) => [k, value.optional()])) as { [P in K[number]]: z.ZodOptional<V> };
  return z.strictObject(shape);
}
