/**
 * Passkey REGISTRATION (POST /api/passkey/register/options → /verify). Only the founder's P-256 public key leaves
 * this module, after every check a relying party owes (WebAuthn L2 §7.1), so the officer reviews a real key:
 *   - clientDataJSON: type webauthn.create, the server's own challenge (HMAC-bound to the facility, the founder and,
 *     since G2, the officer's enrolment code; 5-minute expiry; stateless, so nothing to store), an allowed origin, not
 *     cross-origin;
 *   - authenticatorData: rpIdHash = sha256(RP ID), user present AND user verified (Touch ID), attested credential
 *     data present, BS only with BE;
 *   - the attested credential id equals the response id; the COSE key is EC2 / ES256 / P-256 and on the curve;
 *   - attestation format "none" (we request none: the key is trusted because the officer approves it, not because
 *     of a vendor certificate).
 */
import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual } from "node:crypto";
import type { Hex } from "viem";
import { CborError, decodeCbor, type CborValue } from "./cbor";

export type RegistrationReason =
  | "MALFORMED"
  | "TYPE"
  | "CHALLENGE"
  | "ORIGIN"
  | "RP_ID"
  | "USER_PRESENCE"
  | "USER_VERIFICATION"
  | "CREDENTIAL_ID"
  | "KEY_TYPE"
  | "ATTESTATION";

export class RegistrationError extends Error {
  override readonly name = "RegistrationError";
  constructor(readonly reason: RegistrationReason) {
    super(reason);
  }
}

export const REGISTRATION_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const NONCE_BYTES = 16;
const MAC_BYTES = 16;

const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string): Buffer => createHash("sha256").update(b).digest();

function macOf(secret: Uint8Array, binding: string, payload: Uint8Array): Buffer {
  return createHmac("sha256", secret).update(`hogee/webauthn-registration|${binding}|`).update(payload).digest().subarray(0, MAC_BYTES);
}

/** A fresh challenge: nonce ‖ expiry (ms, uint64 BE) ‖ HMAC(binding, nonce ‖ expiry)[0:16], base64url. */
export function issueRegistrationChallenge(secret: Uint8Array, binding: string, nowMs: number): string {
  const payload = Buffer.alloc(NONCE_BYTES + 8);
  randomBytes(NONCE_BYTES).copy(payload, 0);
  payload.writeBigUInt64BE(BigInt(Math.floor(nowMs + REGISTRATION_CHALLENGE_TTL_MS)), NONCE_BYTES);
  return b64u(Buffer.concat([payload, macOf(secret, binding, payload)]));
}

export function verifyRegistrationChallenge(secret: Uint8Array, binding: string, challenge: string, nowMs: number): boolean {
  if (typeof challenge !== "string" || !/^[A-Za-z0-9_-]+$/.test(challenge)) return false;
  const raw = Buffer.from(challenge, "base64url");
  if (raw.length !== NONCE_BYTES + 8 + MAC_BYTES) return false;
  const payload = raw.subarray(0, NONCE_BYTES + 8);
  if (!timingSafeEqual(raw.subarray(NONCE_BYTES + 8), macOf(secret, binding, payload))) return false;
  const exp = Number(payload.readBigUInt64BE(NONCE_BYTES));
  return exp > nowMs && exp <= nowMs + REGISTRATION_CHALLENGE_TTL_MS;
}

export interface RegistrationCheck {
  readonly rpId: string;
  readonly origins: readonly string[];
  readonly secret: Uint8Array;
  /** `<facilityId>|<founderId>|<enrolment code hash>` (G2): issued for exactly this founder and enrolment code. */
  readonly binding: string;
  readonly nowMs: number;
}

export interface RegisteredKey {
  readonly credentialId: string;
  readonly qx: Hex;
  readonly qy: Hex;
}

interface RegistrationJson {
  readonly id: string;
  readonly rawId: string;
  readonly response: { readonly clientDataJSON: string; readonly attestationObject: string };
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

function checkClientData(b64: string, c: RegistrationCheck): void {
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
  } catch {
    throw new RegistrationError("MALFORMED");
  }
  const d = data as { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown } | null;
  if (!d || typeof d !== "object") throw new RegistrationError("MALFORMED");
  if (d.type !== "webauthn.create") throw new RegistrationError("TYPE");
  if (typeof d.challenge !== "string" || !verifyRegistrationChallenge(c.secret, c.binding, d.challenge, c.nowMs)) throw new RegistrationError("CHALLENGE");
  if (typeof d.origin !== "string" || !c.origins.includes(d.origin) || d.crossOrigin === true) throw new RegistrationError("ORIGIN");
}

function attestation(b64: string): { fmt: string; attStmt: CborValue; authData: Uint8Array } {
  try {
    const { value } = decodeCbor(Buffer.from(b64, "base64url"));
    if (!(value instanceof Map)) throw new RegistrationError("MALFORMED");
    const fmt = value.get("fmt");
    const authData = value.get("authData");
    if (typeof fmt !== "string" || !(authData instanceof Uint8Array)) throw new RegistrationError("MALFORMED");
    return { fmt, attStmt: value.get("attStmt") ?? null, authData };
  } catch (e) {
    if (e instanceof RegistrationError) throw e;
    if (e instanceof CborError) throw new RegistrationError("MALFORMED");
    throw e;
  }
}

function coseP256(key: CborValue): { qx: Hex; qy: Hex } {
  if (!(key instanceof Map)) throw new RegistrationError("KEY_TYPE");
  const x = key.get(-2);
  const y = key.get(-3);
  if (key.get(1) !== 2 || key.get(3) !== -7 || key.get(-1) !== 1) throw new RegistrationError("KEY_TYPE");
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) throw new RegistrationError("KEY_TYPE");
  try {
    createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(x), y: b64u(y) }, format: "jwk" });
  } catch {
    throw new RegistrationError("KEY_TYPE"); // not a point on P-256
  }
  return { qx: `0x${Buffer.from(x).toString("hex")}`, qy: `0x${Buffer.from(y).toString("hex")}` };
}

function parseAuthData(authData: Uint8Array, c: RegistrationCheck): { credentialId: string; key: { qx: Hex; qy: Hex } } {
  if (authData.length < 37 + 18) throw new RegistrationError("MALFORMED");
  if (!timingSafeEqual(Buffer.from(authData.subarray(0, 32)), sha256(c.rpId))) throw new RegistrationError("RP_ID");
  const flags = authData[32] as number;
  if (!(flags & FLAG_UP)) throw new RegistrationError("USER_PRESENCE");
  if (!(flags & FLAG_UV)) throw new RegistrationError("USER_VERIFICATION");
  if (!(flags & FLAG_AT) || (flags & FLAG_BS && !(flags & FLAG_BE))) throw new RegistrationError("MALFORMED");
  const idLen = ((authData[53] as number) << 8) | (authData[54] as number);
  if (idLen < 16 || idLen > 1023 || 55 + idLen >= authData.length) throw new RegistrationError("MALFORMED");
  const credentialId = b64u(authData.subarray(55, 55 + idLen));
  let cose: CborValue;
  try {
    cose = decodeCbor(authData.subarray(55 + idLen), false).value;
  } catch {
    throw new RegistrationError("MALFORMED");
  }
  return { credentialId, key: coseP256(cose) };
}

/** Verifies a registration response (see module doc). Throws RegistrationError(reason). */
export function parseRegistration(resp: RegistrationJson, c: RegistrationCheck): RegisteredKey {
  checkClientData(resp.response.clientDataJSON, c);
  const att = attestation(resp.response.attestationObject);
  if (att.fmt !== "none" || !(att.attStmt instanceof Map) || att.attStmt.size !== 0) throw new RegistrationError("ATTESTATION");
  const { credentialId, key } = parseAuthData(att.authData, c);
  if (credentialId !== resp.id || credentialId !== resp.rawId) throw new RegistrationError("CREDENTIAL_ID");
  return { credentialId, ...key };
}
