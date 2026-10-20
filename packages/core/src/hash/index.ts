/**
 * Hashing (D16, project.md §26.3):
 * - Object hash = keccak256(utf8(JCS(obj))), JCS = RFC 8785 via `canonicalize`.
 * - snippetHash = 0x + sha256(utf8(trimmed, whitespace-collapsed sentence)).
 * - payoutAccountHash = hashObject({channel, accountNumber, holderName}) (§8.7 SupplierApproval).
 *
 * `jcs` is stricter than RFC 8785 on purpose: it only accepts plain JSON data. It rejects undefined,
 * bigint, functions, symbols, NaN/±Infinity, sparse arrays, cycles and non-plain objects (Date, Map,
 * class instances, anything with toJSON), because those would otherwise be dropped or coerced silently
 * and two "equal" plans could hash differently in TS and Python. Money is a digit string, never a bigint.
 */
import canonicalize from "canonicalize";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import type { Hex32 } from "../schemas/primitives";
import { payoutAccountPreimage } from "../schemas/supplier";

export class JcsError extends Error {
  override readonly name = "JcsError";
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return (Object.getPrototypeOf(v) as { constructor?: { name?: string } } | null)?.constructor?.name ?? "object";
  return typeof v;
}

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Throws JcsError unless `value` is plain JSON data (see module doc). */
export function assertJsonData(value: unknown, path = "$", stack: Set<object> = new Set()): void {
  switch (typeof value) {
    case "string":
      if (LONE_SURROGATE_RE.test(value)) throw new JcsError(`${path}: string contains a lone surrogate`);
      return;
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) throw new JcsError(`${path}: non-finite number ${String(value)}`);
      return;
    case "object":
      break;
    default:
      throw new JcsError(`${path}: ${typeName(value)} is not JSON data (money must be a digit string)`);
  }
  if (value === null) return;
  if (stack.has(value)) throw new JcsError(`${path}: circular reference`);
  stack.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (!(i in value)) throw new JcsError(`${path}[${i}]: sparse array hole`);
      assertJsonData(value[i], `${path}[${i}]`, stack);
    }
  } else {
    if (!isPlainObject(value)) throw new JcsError(`${path}: ${typeName(value)} is not a plain object`);
    if (Object.getOwnPropertySymbols(value).length > 0) throw new JcsError(`${path}: symbol keys are not JSON`);
    for (const [k, v] of Object.entries(value)) {
      if (LONE_SURROGATE_RE.test(k)) throw new JcsError(`${path}: key contains a lone surrogate`);
      assertJsonData(v, `${path}.${k}`, stack);
    }
  }
  stack.delete(value);
}

/** RFC 8785 canonical JSON of plain JSON data. */
export function jcs(value: unknown): string {
  assertJsonData(value);
  const out = canonicalize(value);
  if (out === undefined) throw new JcsError("value has no JSON representation");
  return out;
}

/** 0x + lowercase hex of 32 bytes. */
function hex32(bytes: Uint8Array): Hex32 {
  if (bytes.length !== 32) throw new Error(`expected 32 bytes, got ${bytes.length}`);
  return `0x${bytesToHex(bytes)}`;
}

/** keccak256(utf8(text)). */
export function keccak256Utf8(text: string): Hex32 {
  return hex32(keccak_256(utf8ToBytes(text)));
}

/** sha256(utf8(text)), 0x-prefixed. */
export function sha256Utf8(text: string): Hex32 {
  return hex32(sha256(utf8ToBytes(text)));
}

/** sha256 of raw bytes (e.g. an API response body for API-sourced facts, §26.3), 0x-prefixed. */
export function sha256Bytes(bytes: Uint8Array): Hex32 {
  return hex32(sha256(bytes));
}

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const UINT128_MAX = (1n << 128n) - 1n;

/** The bytes32 words of a spend intent: ids are stringToBytes32 values, as the chain encodes them. */
export interface SpendIntentParams {
  readonly planId: string;
  readonly lineId: string;
  readonly payeeId: string;
  readonly invoiceHash: string;
  readonly amountMinor: bigint;
}

/**
 * §8.4 intentId (= spendId) = keccak256(abi.encode(bytes32 planId, bytes32 lineId, bytes32 payeeId, bytes32
 * invoiceHash, uint128 amount)): five static 32-byte words. Same as packages/chain `intentId` (core cannot import it).
 */
export function spendIntentId(p: SpendIntentParams): Hex32 {
  const words = [p.planId, p.lineId, p.payeeId, p.invoiceHash].map((w) => {
    if (!BYTES32_RE.test(w)) throw new RangeError(`spendIntentId: not a bytes32 value: ${w}`);
    return w.slice(2).toLowerCase();
  });
  if (p.amountMinor < 0n || p.amountMinor > UINT128_MAX) throw new RangeError(`spendIntentId: amount is not a uint128: ${p.amountMinor}`);
  return hex32(keccak_256(hexToBytes(words.join("") + p.amountMinor.toString(16).padStart(64, "0"))));
}

/** Object hash = keccak256(utf8(JCS(value))): planHash, countryPackHash, shortlistHash, payoutAccountHash. */
export function hashObject(value: unknown): Hex32 {
  return keccak256Utf8(jcs(value));
}

/**
 * Whitespace for snippet normalisation = exactly the code points Python's `str.split()` splits on
 * (str.isspace), so `" ".join(s.split())` in scripts/snippet-hash.py gives the same string.
 * Differs from the JS regex class `\s`: adds U+001C..U+001F and U+0085, drops U+FEFF (BOM).
 * Listed numerically on purpose (no invisible characters in source).
 */
export const SNIPPET_WHITESPACE_CODE_POINTS: ReadonlySet<number> = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/** Trim and collapse every whitespace run to one ASCII space (no Unicode normalisation). */
export function normalizeSnippet(sentence: string): string {
  const words: string[] = [];
  let word = "";
  for (const ch of sentence) {
    if (SNIPPET_WHITESPACE_CODE_POINTS.has(ch.codePointAt(0) ?? -1)) {
      if (word !== "") words.push(word);
      word = "";
    } else {
      word += ch;
    }
  }
  if (word !== "") words.push(word);
  return words.join(" ");
}

/** snippetHash = 0x + sha256(utf8(normalizeSnippet(sentence))) (§26.3). */
export function snippetHash(sentence: string): Hex32 {
  return sha256Utf8(normalizeSnippet(sentence));
}

export interface PayoutAccount {
  readonly channel: string;
  readonly accountNumber: string;
  readonly holderName: string;
}

/** payoutAccountHash = keccak256(utf8(JCS({channel, accountNumber, holderName}))); extra keys are dropped. */
export function payoutAccountHash(account: PayoutAccount): Hex32 {
  return hashObject(payoutAccountPreimage(account));
}
