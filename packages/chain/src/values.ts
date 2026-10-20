/**
 * Runtime checks and on-chain encodings for the typed values the tx builder accepts (§26.3).
 * Every builder input is a bigint, number, boolean or Hex; these helpers turn off-chain ids into bytes32
 * and reject anything malformed before viem encodes it.
 */
import { isAddress, pad, type Address, type Hex } from 'viem';
import { toBytes32Tag } from './eip712';

export class TxValueError extends Error {
  override readonly name = 'TxValueError';
}

const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
const SHORT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const REASON_CODE_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const LINE_KEYS = ['SUPPLIER', 'PACKAGING', 'LOGISTICS', 'ADS', 'PLATFORM_FEES', 'LICENSING', 'CONTINGENCY'] as const;
export type LineKey = (typeof LINE_KEYS)[number];

export const ZERO_BYTES32 = `0x${'0'.repeat(64)}` as const;

export function assertHex32(value: Hex, field: string): Hex {
  if (typeof value !== 'string' || !HEX32_RE.test(value)) throw new TxValueError(`${field} must be 0x + 64 hex chars`);
  return value;
}

export function assertBytes(value: Hex, field: string): Hex {
  if (typeof value !== 'string' || !HEX_RE.test(value)) throw new TxValueError(`${field} must be 0x-prefixed hex bytes`);
  return value;
}

export function assertAddress(value: Address, field: string): Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) {
    throw new TxValueError(`${field} must be a 20-byte address`);
  }
  return value;
}

/** Checks `0 <= value < 2^bits` for a bigint uint. */
export function assertUint(value: bigint, bits: number, field: string): bigint {
  if (typeof value !== 'bigint') throw new TxValueError(`${field} must be a bigint`);
  if (value < 0n || value >= 1n << BigInt(bits)) throw new TxValueError(`${field} is out of uint${bits} range`);
  return value;
}

/** Checks `0 <= value < 2^bits` for a small uint passed as a JS integer (uint8/uint16/uint32). */
export function assertSmallUint(value: number, bits: 8 | 16 | 32, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** bits) {
    throw new TxValueError(`${field} must be an integer in uint${bits} range`);
  }
  return value;
}

/** ShortId (`[a-z0-9_-]`, ≤32) → right-padded bytes32, like lineId: payeeId, orderId, stageId, supplierId. */
export function shortIdToBytes32(id: string, field = 'id'): Hex {
  if (typeof id !== 'string' || !SHORT_ID_RE.test(id)) throw new TxValueError(`${field} must be a ShortId [a-z0-9_-]{1,32}`);
  return toBytes32Tag(id);
}

/** §26.3 lineId = stringToHex(lineKey, {size: 32}). */
export function lineKeyToLineId(lineKey: LineKey): Hex {
  if (!(LINE_KEYS as readonly string[]).includes(lineKey)) throw new TxValueError('lineKey is not a LineKey');
  return toBytes32Tag(lineKey);
}

/** Reason / settlement-failure code → bytes32 (stringToHex), as in recordDenied and failSettlement. */
export function reasonCodeToBytes32(code: string, field = 'reasonCode'): Hex {
  if (typeof code !== 'string' || !REASON_CODE_RE.test(code)) {
    throw new TxValueError(`${field} must be ≤32 chars [A-Za-z0-9_], letter first`);
  }
  return toBytes32Tag(code);
}

/** §26.3: a UUID decisionId (lowercase) left-padded to bytes32 on-chain. */
export function decisionIdToBytes32(uuid: string): Hex {
  if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) throw new TxValueError('decisionId must be a lowercase UUID');
  return pad(`0x${uuid.replaceAll('-', '')}`, { size: 32 });
}

/** Inverse of {@link decisionIdToBytes32}; undefined when the high 16 bytes are not zero. */
export function bytes32ToDecisionId(value: Hex): string | undefined {
  assertHex32(value, 'decisionId');
  const hex = value.slice(2).toLowerCase();
  if (!hex.startsWith('0'.repeat(32))) return undefined;
  const u = hex.slice(32);
  return `${u.slice(0, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}-${u.slice(16, 20)}-${u.slice(20)}`;
}
