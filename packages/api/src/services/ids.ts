/** Ids (§26.3): UUIDv7 for decisionIds and chat; `<prefix>-<uuidv7>` for every other off-chain id (core `Id`). */
import { randomBytes } from "node:crypto";
import type { Hex } from "viem";

/** UUIDv7 (RFC 9562), lowercase: 48-bit unix ms, version 7, variant 10, 74 random bits. */
export function uuidv7(nowMs: number = Date.now()): string {
  const b = randomBytes(16);
  const ms = BigInt(nowMs);
  for (let i = 0; i < 6; i += 1) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x70;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const newId = (prefix: string): string => `${prefix}-${uuidv7()}`;

/** A random uint256 for an EIP-712 struct nonce (the contracts use unordered nonces). */
export const randomNonce = (): bigint => BigInt(`0x${randomBytes(32).toString("hex")}`);

/** A random bytes32 (planId of a new plan series). */
export const randomBytes32 = (): Hex => `0x${randomBytes(32).toString("hex")}`;
