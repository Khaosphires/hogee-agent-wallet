/**
 * Signature checks for POST /api/signatures/:id/submit (P1 review of #5, point 9): a signature must pass the chain's
 * own checks against the key store.ts's founderKeyFor names, so it takes that key's authenticator (or the wallet's
 * private key), not just an HTTP client. Before the officer registers a key that is the founder's pending key, which
 * the chain would not accept yet (founderKeyFor says what that means); after, only the registered key signs.
 * - passkey: OpenZeppelin 5.7 `WebAuthn.verify` over the request's digest: `"type":"webauthn.get"` and
 *   `"challenge":"<digest, base64url>"` at their byte offsets, user present + verified, P-256 over
 *   sha256(authenticatorData ‖ sha256(clientDataJSON)) with low-s only.
 * - ECDSA (MetaMask): OpenZeppelin `ECDSA.recover` of the EIP-712 digest (v 27/28, low-s).
 */
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { recoverAddress, type Address, type Hex } from "viem";
import type { PasskeyAssertion } from "@hogee/core";

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P256_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

// authenticatorData flags byte (offset 32, after the rpIdHash).
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;

export interface P256Key {
  readonly qx: string;
  readonly qy: string;
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

const bytesOf = (hex: string): Buffer => Buffer.from(hex.slice(2), "hex");
const b64url = (hex: string): string => bytesOf(hex).toString("base64url");

/**
 * (qx, qy) as a key, or undefined unless it is what OZ `P256.isValidPublicKey` accepts (PlanRegistry.registerFounderKey
 * reverts InvalidSignature otherwise): both coordinates below p, and a point on P-256 (node refuses an off-curve JWK).
 */
export function p256PublicKey(key: P256Key): KeyObject | undefined {
  if (!HEX32.test(key.qx) || !HEX32.test(key.qy) || BigInt(key.qx) >= P256_P || BigInt(key.qy) >= P256_P) return undefined;
  try {
    return createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64url(key.qx), y: b64url(key.qy) }, format: "jwk" });
  } catch {
    return undefined; // not a point on P-256 (e.g. the core example's placeholder key)
  }
}

/** `text` starts at byte `index` of `bytes` (how WebAuthn.verify finds the type and the challenge). */
function startsAt(bytes: Buffer, index: number, text: string): boolean {
  const want = Buffer.from(text, "utf8");
  return index + want.length <= bytes.length && bytes.subarray(index, index + want.length).equals(want);
}

function clientDataMatches(clientDataJSON: string, challengeB64url: string): boolean {
  try {
    const parsed = JSON.parse(clientDataJSON) as { type?: unknown; challenge?: unknown };
    return parsed.type === "webauthn.get" && parsed.challenge === challengeB64url;
  } catch {
    return false;
  }
}

/** True iff `a` is an assertion by the P-256 key (qx, qy) over `challengeB64url` (base64url of the raw digest). */
export function verifyPasskeyAssertion(a: PasskeyAssertion, key: P256Key, challengeB64url: string): boolean {
  const r = BigInt(a.r);
  const s = BigInt(a.s);
  if (r === 0n || r >= P256_N || s === 0n || s > P256_N >> 1n) return false;
  const authenticatorData = bytesOf(a.authenticatorData);
  const flags = authenticatorData[32];
  if (authenticatorData.length < 37 || flags === undefined) return false;
  if (!(flags & FLAG_UP) || !(flags & FLAG_UV) || (flags & FLAG_BS && !(flags & FLAG_BE))) return false;
  const clientData = Buffer.from(a.clientDataJSON, "utf8");
  if (!startsAt(clientData, a.typeIndex, '"type":"webauthn.get"')) return false;
  if (!startsAt(clientData, a.challengeIndex, `"challenge":"${challengeB64url}"`)) return false;
  if (!clientDataMatches(a.clientDataJSON, challengeB64url)) return false;
  const publicKey = p256PublicKey(key);
  if (!publicKey) return false;
  const signed = Buffer.concat([authenticatorData, createHash("sha256").update(clientData).digest()]);
  return verify("sha256", signed, { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.concat([bytesOf(a.r), bytesOf(a.s)]));
}

/** The address that signed `digest`, or undefined for a malformed, high-s or unrecoverable signature. */
export async function recoverEcdsaSigner(digest: Hex, signature: Hex): Promise<Address | undefined> {
  const bytes = bytesOf(signature);
  if (bytes.length !== 65) return undefined;
  const s = BigInt(`0x${bytes.subarray(32, 64).toString("hex")}`);
  const v = bytes[64];
  if (s === 0n || s > SECP256K1_N >> 1n || (v !== 27 && v !== 28)) return undefined;
  try {
    return await recoverAddress({ hash: digest, signature });
  } catch {
    return undefined;
  }
}
