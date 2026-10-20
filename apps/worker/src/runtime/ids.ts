/** UUIDv7 (RFC 9562), lowercase: 48-bit unix ms, version 7, variant 10, 74 random bits. Used for decisionIds (§26.3). */
import { randomBytes } from 'node:crypto';

export function uuidv7(nowMs: number = Date.now()): string {
  const b = randomBytes(16);
  const ms = BigInt(nowMs);
  for (let i = 0; i < 6; i += 1) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x70;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
