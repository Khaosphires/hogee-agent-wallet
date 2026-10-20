/**
 * Integer money helpers (D16). Money is a `Minor` digit string at every boundary and a `bigint` inside;
 * a JS `number` never holds money. Rates are integer basis points (1 bps = 1/10,000).
 *
 * Rounding rules (used by landed cost and the compiler, named so call sites say which one they mean):
 * - `mulDivFloor`: round toward zero (caps, splits, stage releases: never round a limit UP).
 * - `mulDivHalfUp`: round half up at the final minor unit (landed-cost components: customs-style rounding).
 * - `mulDivCeil`: round up (only where a shortfall must be covered, e.g. a fee line).
 */
import type { Minor } from "../schemas/primitives";

const DIGITS_RE = /^(0|[1-9][0-9]*)$/;
export const UINT128_MAX = (1n << 128n) - 1n;
export const BPS_DENOMINATOR = 10_000n;

export class MoneyError extends Error {
  override readonly name = "MoneyError";
}

/** Parse a `Minor` digit string. Throws on anything else (signs, decimals, leading zeros, > uint128). */
export function parseMinor(value: string, label = "amount"): bigint {
  if (typeof value !== "string" || !DIGITS_RE.test(value)) {
    throw new MoneyError(`${label} must be a minor-unit digit string, got ${JSON.stringify(value)}`);
  }
  const n = BigInt(value);
  if (n > UINT128_MAX) throw new MoneyError(`${label} exceeds uint128`);
  return n;
}

/** Like `parseMinor` but returns null instead of throwing (for checkers that report instead of fail). */
export function tryParseMinor(value: unknown): bigint | null {
  if (typeof value !== "string" || !DIGITS_RE.test(value)) return null;
  const n = BigInt(value);
  return n > UINT128_MAX ? null : n;
}

/** Format a non-negative bigint as a `Minor` digit string. */
export function toMinor(value: bigint, label = "amount"): Minor {
  if (value < 0n) throw new MoneyError(`${label} is negative: ${value}`);
  if (value > UINT128_MAX) throw new MoneyError(`${label} exceeds uint128`);
  return value.toString();
}

function assertDivisor(d: bigint): void {
  if (d <= 0n) throw new MoneyError(`divisor must be positive, got ${d}`);
}

function assertNonNegative(...xs: bigint[]): void {
  for (const x of xs) if (x < 0n) throw new MoneyError(`negative operand ${x}`);
}

/** floor(a × b / d) for non-negative operands. */
export function mulDivFloor(a: bigint, b: bigint, d: bigint): bigint {
  assertDivisor(d);
  assertNonNegative(a, b);
  return (a * b) / d;
}

/** ceil(a × b / d) for non-negative operands. */
export function mulDivCeil(a: bigint, b: bigint, d: bigint): bigint {
  assertDivisor(d);
  assertNonNegative(a, b);
  return (a * b + d - 1n) / d;
}

/** round-half-up(a × b / d) for non-negative operands (0.5 minor rounds up). */
export function mulDivHalfUp(a: bigint, b: bigint, d: bigint): bigint {
  assertDivisor(d);
  assertNonNegative(a, b);
  return (2n * a * b + d) / (2n * d);
}

/** floor(amount × bps / 10,000). */
export function bpsFloor(amount: bigint, bps: number | bigint): bigint {
  return mulDivFloor(amount, BigInt(bps), BPS_DENOMINATOR);
}

/** round-half-up(amount × bps / 10,000). */
export function bpsHalfUp(amount: bigint, bps: number | bigint): bigint {
  return mulDivHalfUp(amount, BigInt(bps), BPS_DENOMINATOR);
}

export function minBig(...xs: bigint[]): bigint {
  if (xs.length === 0) throw new MoneyError("minBig of nothing");
  return xs.reduce((m, x) => (x < m ? x : m));
}

export function maxBig(...xs: bigint[]): bigint {
  if (xs.length === 0) throw new MoneyError("maxBig of nothing");
  return xs.reduce((m, x) => (x > m ? x : m));
}

export function sumBig(xs: readonly bigint[]): bigint {
  return xs.reduce((s, x) => s + x, 0n);
}

/** Sum of `Minor` strings as a `Minor` string. */
export function sumMinor(xs: readonly string[]): Minor {
  return toMinor(sumBig(xs.map((x) => parseMinor(x))));
}

/** "1234567" → "12,345.67 BU" (1 BU = 100 minor). Display only. */
export function formatBu(minor: bigint | string): string {
  const v = typeof minor === "string" ? parseMinor(minor) : minor;
  const whole = (v / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = (v % 100n).toString().padStart(2, "0");
  return cents === "00" ? `${whole} BU` : `${whole}.${cents} BU`;
}

/** Positive exact rational num/den (both bigint, den > 0). */
export interface Rational {
  readonly num: bigint;
  readonly den: bigint;
}

/**
 * Exact rational of a finite positive JS number via its shortest round-trip decimal string
 * (ECMAScript Number::toString, the same digits Python's repr gives). 0.61 → 61/100, 1e-7 → 1/10,000,000.
 * Used only for rates (FX), never for money.
 */
export function rationalOf(x: number, label = "rate"): Rational {
  if (typeof x !== "number" || !Number.isFinite(x) || x <= 0) {
    throw new MoneyError(`${label} must be a finite positive number, got ${String(x)}`);
  }
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(x));
  if (!m) throw new MoneyError(`${label}: cannot read ${String(x)} as a decimal`);
  const intPart = m[1] ?? "0";
  const frac = m[2] ?? "";
  const exp = Number(m[3] ?? "0") - frac.length;
  const digits = BigInt(intPart + frac);
  if (exp >= 0) return { num: digits * 10n ** BigInt(exp), den: 1n };
  return { num: digits, den: 10n ** BigInt(-exp) };
}

export * from "./wallet";
