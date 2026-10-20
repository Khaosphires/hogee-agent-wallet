/** Pacing-slot invoice hashes, as Treasury.spend reads them on a pacing line (`uint(invoiceHash) == lineSequence`). */
import type { Hex32 } from "../schemas/primitives";

const UINT256_MAX = (1n << 256n) - 1n;

/**
 * The invoiceHash of pacing slot `slot`: bytes32(uint256(slot)), as Treasury.spend reads it on a pacing line
 * (`uint(invoiceHash) == lineSequence`). Same as packages/chain `sequenceInvoiceHash` (core cannot import chain).
 */
export function sequenceInvoiceHash(slot: number | bigint): Hex32 {
  const n = typeof slot === "bigint" ? slot : Number.isSafeInteger(slot) ? BigInt(slot) : -1n;
  if (n < 0n || n > UINT256_MAX) throw new RangeError(`pacing slot must be a uint256, got ${String(slot)}`);
  return `0x${n.toString(16).padStart(64, "0")}`;
}

/** True when `invoiceHash` is exactly the sequence invoice hash of `slot` (false for an unreadable slot). */
export function isSequenceInvoiceHash(invoiceHash: string, slot: number): boolean {
  if (!Number.isSafeInteger(slot) || slot < 0) return false;
  return invoiceHash.toLowerCase() === sequenceInvoiceHash(slot);
}
