/**
 * Passkey (WebAuthn, P-256) → OpenZeppelin 5.5 `WebAuthn.WebAuthnAuth` encoding (project.md §6.1, §8.7; ROLE-P2 2.6).
 * Dependency-free on purpose: P1 copies this file into packages/chain at gate G2, so it must run unchanged in the
 * browser, Node and the worker.
 *
 * - DER signature → (r, s), strict DER only (short-form lengths, minimal positive INTEGERs).
 * - s is normalised to low-s (s ≤ n/2): OZ WebAuthn.verify rejects high-s, and about half of raw authenticator
 *   signatures are high-s.
 * - challengeIndex / typeIndex are BYTE offsets of `"challenge"` / `"type"` in the UTF-8 clientDataJSON.
 * - (qx, qy) are the last 64 bytes of the SPKI DER public key (uncompressed point 0x04 ‖ x ‖ y).
 */

export type Hex = `0x${string}`;

/** P-256 group order n. */
export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
export const P256_HALF_N = P256_N >> 1n;

/** WebAuthnAuth field order of OpenZeppelin 5.5 `WebAuthn.WebAuthnAuth`. */
export interface WebAuthnAuth {
  readonly r: Hex;
  readonly s: Hex;
  readonly challengeIndex: number;
  readonly typeIndex: number;
  readonly authenticatorData: Hex;
  /** Raw UTF-8 JSON text (not base64). */
  readonly clientDataJSON: string;
}

export class PasskeyEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasskeyEncodingError";
  }
}

// ---- bytes ---------------------------------------------------------------------------------------

export function bytesToHex(bytes: Uint8Array): Hex {
  let out = "0x";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out as Hex;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new PasskeyEncodingError(`not a hex byte string: ${hex.slice(0, 20)}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function base64UrlToBytes(value: string): Uint8Array {
  if (/[^A-Za-z0-9_-]/.test(value)) throw new PasskeyEncodingError("not base64url");
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const bytesToBigInt = (bytes: Uint8Array): bigint => (bytes.length === 0 ? 0n : BigInt(bytesToHex(bytes)));

/** 0x + 64 lowercase hex (bytes32). */
export function toHex32(x: bigint): Hex {
  if (x < 0n || x >= 1n << 256n) throw new PasskeyEncodingError("value does not fit in 32 bytes");
  return `0x${x.toString(16).padStart(64, "0")}`;
}

// ---- DER ECDSA signature ---------------------------------------------------------------------------

function readInteger(der: Uint8Array, offset: number): { value: bigint; next: number } {
  if (der[offset] !== 0x02) throw new PasskeyEncodingError("DER: expected INTEGER");
  const len = der[offset + 1];
  if (len === undefined || len === 0 || len > 33 || len & 0x80) throw new PasskeyEncodingError("DER: bad INTEGER length");
  const start = offset + 2;
  const body = der.subarray(start, start + len);
  if (body.length !== len) throw new PasskeyEncodingError("DER: truncated INTEGER");
  const first = body[0] ?? 0;
  if (first & 0x80) throw new PasskeyEncodingError("DER: negative INTEGER");
  if (first === 0 && len > 1 && !((body[1] ?? 0) & 0x80)) throw new PasskeyEncodingError("DER: non-minimal INTEGER");
  return { value: bytesToBigInt(body), next: start + len };
}

/** Parses a strict-DER ECDSA signature `SEQUENCE { INTEGER r, INTEGER s }`. */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  if (der[0] !== 0x30) throw new PasskeyEncodingError("DER: expected SEQUENCE");
  const seqLen = der[1];
  if (seqLen === undefined || seqLen & 0x80 || seqLen + 2 !== der.length) throw new PasskeyEncodingError("DER: bad SEQUENCE length");
  const r = readInteger(der, 2);
  const s = readInteger(der, r.next);
  if (s.next !== der.length) throw new PasskeyEncodingError("DER: trailing bytes");
  for (const [name, v] of [["r", r.value], ["s", s.value]] as const) {
    if (v === 0n || v >= P256_N) throw new PasskeyEncodingError(`DER: ${name} out of range`);
  }
  return { r: r.value, s: s.value };
}

/** s' = n − s when s > n/2 (the signature stays valid; OZ only accepts the low form). */
export function normalizeLowS(s: bigint): bigint {
  return s > P256_HALF_N ? P256_N - s : s;
}

// ---- clientDataJSON ----------------------------------------------------------------------------------

/** Byte offset of `needle` in the UTF-8 encoding of `text`. */
function utf8IndexOf(text: string, needle: string): number {
  const at = text.indexOf(needle);
  if (at < 0) throw new PasskeyEncodingError(`clientDataJSON has no ${needle}`);
  return new TextEncoder().encode(text.slice(0, at)).length;
}

export function clientDataIndices(clientDataJSON: string): { challengeIndex: number; typeIndex: number } {
  return { challengeIndex: utf8IndexOf(clientDataJSON, '"challenge"'), typeIndex: utf8IndexOf(clientDataJSON, '"type"') };
}

/** Checks that clientDataJSON is a webauthn.get over exactly this digest (base64url of the raw 32 bytes). */
export function assertChallengeMatches(clientDataJSON: string, digest: Hex): void {
  const parsed = JSON.parse(clientDataJSON) as { type?: unknown; challenge?: unknown };
  if (parsed.type !== "webauthn.get") throw new PasskeyEncodingError("clientDataJSON is not a webauthn.get assertion");
  if (parsed.challenge !== bytesToBase64Url(hexToBytes(digest))) throw new PasskeyEncodingError("clientDataJSON challenge is not this digest");
}

// ---- public key ------------------------------------------------------------------------------------

/** (qx, qy) from a P-256 SPKI DER key: the last 64 bytes after the 0x04 uncompressed-point marker. */
export function publicKeyFromSpki(spki: Uint8Array): { qx: Hex; qy: Hex } {
  if (spki.length < 65 || spki[spki.length - 65] !== 0x04) throw new PasskeyEncodingError("SPKI: not an uncompressed P-256 point");
  const xy = spki.subarray(spki.length - 64);
  return { qx: bytesToHex(xy.subarray(0, 32)), qy: bytesToHex(xy.subarray(32)) };
}

// ---- assertion → WebAuthnAuth ------------------------------------------------------------------------

export interface RawAssertion {
  readonly signature: Uint8Array;
  readonly authenticatorData: Uint8Array;
  /** The UTF-8 bytes the authenticator returned. */
  readonly clientDataJSON: Uint8Array;
}

/** Encodes a raw WebAuthn assertion for `WebAuthn.verify(abi.encodePacked(digest), auth, qx, qy)`. */
export function encodeWebAuthnAuth(raw: RawAssertion, digest?: Hex): WebAuthnAuth {
  const clientDataJSON = new TextDecoder("utf-8", { fatal: true }).decode(raw.clientDataJSON);
  if (digest) assertChallengeMatches(clientDataJSON, digest);
  const { r, s } = parseDerSignature(raw.signature);
  const { challengeIndex, typeIndex } = clientDataIndices(clientDataJSON);
  return {
    r: toHex32(r),
    s: toHex32(normalizeLowS(s)),
    challengeIndex,
    typeIndex,
    authenticatorData: bytesToHex(raw.authenticatorData),
    clientDataJSON,
  };
}
