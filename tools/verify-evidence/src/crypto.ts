/**
 * Signature checks, synchronous and browser-safe (@noble/curves; Ethereum keccak256 from viem, never NIST SHA3):
 *   ECDSA (Sig kind 0): 65 bytes r‖s‖v, v ∈ {27, 28}, 0 < r < n, 0 < s ≤ n/2 (OZ ECDSA.tryRecover); returns the
 *     recovered address.
 *   WebAuthn (Sig kind 1, OZ WebAuthn.verify with requireUV): `"type":"webauthn.get"` at typeIndex,
 *     `"challenge":"<base64url(digest)>"` at challengeIndex, UP and UV set, BS only with BE, 0 < r < n,
 *     0 < s ≤ n/2, P-256 over sha256(authenticatorData ‖ sha256(clientDataJSON)).
 *   Raw signed transactions: keccak256(raw) is the tx hash, and the sender is recovered from the signature. Only the
 *     one canonical form is read: 0 < r < n, 0 < s ≤ n/2 (EIP-2 low s), and the parsed tx with its signature must
 *     re-serialise to exactly `raw`. Otherwise a malleated twin (n − s, the other recovery bit) or a non-canonical
 *     RLP encoding (a zero written as 0x00) would recover the same sender under another keccak256.
 */
import { p256 } from "@noble/curves/p256";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak256, parseTransaction, serializeTransaction, sha256, type Hex, type Signature, type TransactionSerializable } from "viem";
import type { PasskeyAssertion } from "@hogee/core";
import { bytesToHex, concatBytes, hexToBytesOrNull, utf8Bytes } from "./util";

const SECP256K1_N = secp256k1.CURVE.n;
const P256_N = p256.CURVE.n;

const addressOfPublicKey = (uncompressed: Uint8Array): Hex => `0x${keccak256(uncompressed.slice(1)).slice(-40)}` as Hex;

function recover(digest: Hex, r: bigint, s: bigint, bit: number): Hex | null {
  try {
    const sig = new secp256k1.Signature(r, s).addRecoveryBit(bit);
    return addressOfPublicKey(sig.recoverPublicKey(digest.slice(2)).toRawBytes(false));
  } catch {
    return null;
  }
}

/** The signer of a 65-byte ECDSA signature under OZ's rules, or null (malformed, high-s, bad v). */
export function recoverEcdsa(digest: Hex, signature: string): Hex | null {
  const raw = hexToBytesOrNull(signature);
  if (!raw || raw.length !== 65) return null;
  const r = BigInt(bytesToHex(raw.subarray(0, 32)));
  const s = BigInt(bytesToHex(raw.subarray(32, 64)));
  const v = raw[64] as number;
  if (v !== 27 && v !== 28) return null;
  if (r === 0n || r >= SECP256K1_N || s === 0n || s > SECP256K1_N / 2n) return null;
  return recover(digest, r, s, v - 27);
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;

function at(json: Uint8Array, index: number, expected: string): boolean {
  const want = utf8Bytes(expected);
  if (!Number.isSafeInteger(index) || index < 0 || index + want.length > json.length) return false;
  return want.every((b, i) => json[index + i] === b);
}

const base64url = (b: Uint8Array): string => {
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

/** Why a passkey assertion fails for `digest` and key (qx, qy), or null when it verifies. */
export function passkeyProblem(digest: Hex, a: PasskeyAssertion, key: { readonly qx: Hex; readonly qy: Hex }): string | null {
  const zero = `0x${"0".repeat(64)}`;
  if (key.qx === zero && key.qy === zero) return "no P-256 founder key is registered";
  const authData = hexToBytesOrNull(a.authenticatorData);
  const digestBytes = hexToBytesOrNull(digest);
  if (!authData || authData.length <= 36 || !digestBytes || digestBytes.length !== 32) return "malformed authenticatorData";
  const json = utf8Bytes(a.clientDataJSON);
  if (!at(json, a.typeIndex, '"type":"webauthn.get"')) return "clientDataJSON type is not webauthn.get at typeIndex";
  if (!at(json, a.challengeIndex, `"challenge":"${base64url(digestBytes)}"`)) return "clientDataJSON challenge is not the digest";
  const flags = authData[32] as number;
  if (!(flags & FLAG_UP) || !(flags & FLAG_UV)) return "user presence or verification flag missing";
  if (flags & FLAG_BS && !(flags & FLAG_BE)) return "backup state without backup eligibility";
  const r = BigInt(a.r);
  const s = BigInt(a.s);
  if (r === 0n || r >= P256_N || s === 0n || s > P256_N / 2n) return "r or s out of range (or high s)";
  const message = sha256(concatBytes(authData, hexToBytesOrNull(sha256(json)) as Uint8Array));
  const publicKey = `04${key.qx.slice(2)}${key.qy.slice(2)}`;
  try {
    const sig = new p256.Signature(r, s);
    return p256.verify(sig, message.slice(2), publicKey, { lowS: false, prehash: false }) ? null : "P-256 signature does not verify";
  } catch {
    return "P-256 signature does not verify";
  }
}

export interface ParsedTx {
  readonly hash: Hex;
  readonly from: Hex;
  readonly to: Hex | null;
  readonly data: Hex;
  readonly nonce: number;
  readonly chainId: number | null;
}

/** The hash, recovered sender and call of a raw signed transaction; a string saying why it can't be read. */
export function parseSignedTx(raw: Hex): ParsedTx | string {
  let tx: ReturnType<typeof parseTransaction>;
  try {
    tx = parseTransaction(raw);
  } catch {
    return "the raw transaction does not parse";
  }
  const { r, s, v, yParity, ...unsigned } = tx as typeof tx & { r?: Hex; s?: Hex; v?: bigint; yParity?: number };
  if (!r || !s) return "the raw transaction is unsigned";
  const rN = BigInt(r);
  const sN = BigInt(s);
  if (rN === 0n || rN >= SECP256K1_N || sN === 0n) return "the raw transaction's r or s is out of range";
  if (sN > SECP256K1_N / 2n) return "the raw transaction's signature has a high s (EIP-2 requires s ≤ n/2)";
  let bit: number;
  if (yParity === 0 || yParity === 1) bit = yParity;
  else if (v === 27n || v === 28n) bit = Number(v - 27n);
  else if (v !== undefined && tx.chainId !== undefined) bit = Number(v - BigInt(tx.chainId) * 2n - 35n);
  else return "the raw transaction has no recovery id";
  if (bit !== 0 && bit !== 1) return "the raw transaction has a bad recovery id";
  let signingHash: Hex;
  let reserialised: Hex;
  try {
    signingHash = keccak256(serializeTransaction(unsigned as TransactionSerializable));
    const signature = { r, s, ...(v === undefined ? {} : { v }), ...(yParity === undefined ? {} : { yParity }) } as Signature;
    reserialised = serializeTransaction(unsigned as TransactionSerializable, signature);
  } catch {
    return "the raw transaction cannot be re-serialised";
  }
  if (reserialised.toLowerCase() !== raw.toLowerCase()) return "the raw transaction is not in canonical form (it does not re-serialise to the same bytes)";
  const from = recover(signingHash, rN, sN, bit);
  if (!from) return "the raw transaction's signature does not recover";
  return { hash: keccak256(raw), from, to: tx.to ? (tx.to.toLowerCase() as Hex) : null, data: (tx.data ?? "0x") as Hex, nonce: tx.nonce ?? 0, chainId: tx.chainId ?? null };
}
