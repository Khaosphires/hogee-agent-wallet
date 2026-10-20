/**
 * Hashes and ids for the LLM layer.
 * - `jsonHash`: keccak256(utf8(JCS(json-normalised value))) for prompt/response hashes in the LLM call log.
 * - `rationaleCommitment`: rationaleHash = keccak256(utf8(JCS(rationale)) ‖ salt) (project.md §7.2 step 6). The salted
 *   preimage goes in the evidence bundle; only the hash goes on-chain / in the payment row.
 * - `uuidV7`: decision ids (core `DecisionId` is a lowercase UUIDv7, left-padded to bytes32 on-chain).
 * Ethereum keccak256 comes from @noble/hashes (never node:crypto "sha3-256", which is NIST SHA3).
 */
import { randomBytes as nodeRandomBytes } from "node:crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { hashObject, jcs, type Hex32 } from "@hogee/core";

export type RandomBytes = (n: number) => Uint8Array;
export const defaultRandomBytes: RandomBytes = (n) => new Uint8Array(nodeRandomBytes(n));

/** Plain-JSON copy of `v` (undefined dropped, typed arrays rejected by the caller's schema): what the wire carries. */
export function toJsonValue(v: unknown): unknown {
  return v === undefined ? null : (JSON.parse(JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x))) as unknown);
}

/** keccak256(utf8(JCS(v))) of the JSON form of `v`. Never throws: a value JCS refuses (lone surrogate) hashes its JSON text. */
export function jsonHash(v: unknown): Hex32 {
  const json = toJsonValue(v);
  try {
    return hashObject(json);
  } catch {
    return `0x${bytesToHex(keccak_256(utf8ToBytes(JSON.stringify(json))))}`;
  }
}

export interface RationaleCommitment<R> {
  readonly rationale: R;
  /** 0x + 64 hex: the 32-byte salt (keep private until the evidence export). */
  readonly salt: Hex32;
  readonly rationaleHash: Hex32;
}

/** rationaleHash = keccak256(utf8(JCS(rationale)) ‖ salt), with a fresh 32-byte salt. */
export function rationaleCommitment<R>(rationale: R, randomBytes: RandomBytes = defaultRandomBytes): RationaleCommitment<R> {
  const salt = randomBytes(32);
  if (salt.length !== 32) throw new RangeError("salt must be 32 bytes");
  return { rationale, salt: `0x${bytesToHex(salt)}`, rationaleHash: rationaleHashOf(rationale, salt) };
}

/** Recompute a rationale hash from its preimage (the evidence verifier does the same). */
export function rationaleHashOf(rationale: unknown, salt: Uint8Array | Hex32): Hex32 {
  if (typeof salt === "string" && !/^0x[0-9a-f]{64}$/.test(salt)) throw new RangeError("salt must be 0x + 64 lowercase hex");
  const saltBytes = typeof salt === "string" ? hexToBytes(salt.slice(2)) : salt;
  if (saltBytes.length !== 32) throw new RangeError("salt must be 32 bytes");
  return `0x${bytesToHex(keccak_256(concatBytes(utf8ToBytes(jcs(rationale)), saltBytes)))}`;
}

/** Lowercase UUIDv7: 48-bit unix ms, version 7, variant 10, 74 random bits. */
export function uuidV7(nowMs: number = Date.now(), randomBytes: RandomBytes = defaultRandomBytes): string {
  const b = Uint8Array.from(randomBytes(16));
  const ms = BigInt(Math.max(0, Math.floor(nowMs)));
  for (let i = 0; i < 6; i += 1) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x70;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = bytesToHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
