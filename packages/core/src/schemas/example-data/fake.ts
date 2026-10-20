/**
 * Deterministic fake values for examples and fixtures. NOT real hashes: an FNV-1a digest of a label,
 * repeated to the required width. Unique per label (tested), browser-safe (no node:crypto).
 */
import type { Address, Hex32, UuidV7 } from "../primitives";

function fnv1a32(label: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i += 1) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const used = new Map<string, string>();

function track(label: string, value: string): string {
  const prev = used.get(value);
  if (prev !== undefined && prev !== label) throw new Error(`fake value collision: ${label} vs ${prev}`);
  used.set(value, label);
  return value;
}

/** Fake 32-byte hex for a label, e.g. fakeHex32("planHash:v1"). */
export function fakeHex32(label: string): Hex32 {
  return track(label, `0x${fnv1a32(label).repeat(8)}`);
}

/** Fake lowercase address for a label. */
export function fakeAddress(label: string): Address {
  return track(`addr:${label}`, `0x${fnv1a32(`addr:${label}`).repeat(5)}`);
}

/** Fake UUIDv7 (timestamp prefix ≈ 2026-10-16) with a sequence number. */
export function fakeUuidV7(n: number): UuidV7 {
  return `01a14202-2800-7000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** All labels handed out so far (for uniqueness tests). */
export function fakeValuesIssued(): ReadonlyMap<string, string> {
  return used;
}
