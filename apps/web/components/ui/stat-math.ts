/**
 * The pure parts of <Stat> (./stat.tsx): the one-time count-up on first view, and the colour a change takes. Money
 * stays a minor-unit string and is interpolated in bigint, never as a JS number (components/ledger/money-parts.ts).
 */
import { parseMinor } from "@hogee/core";

/** How long the count-up runs, once, the first time a stat is on screen (none with reduced motion). */
export const TICK_MS = 900;

/** Ease-out (cubic): fast at first, settling into the final figure; 0 → 0, 1 → 1. Clamped outside 0..1. */
export function easeOut(t: number): number {
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 1));
  return 1 - (1 - x) ** 3;
}

const STEPS = 10_000n;

/**
 * The amount shown at progress `t` (0..1) of the count-up toward `targetMinor`, as a minor-unit string. It counts from
 * zero in the target's direction, lands exactly on the target at 1, and never shows "-0".
 */
export function tickMinor(targetMinor: string, t: number): string {
  const negative = targetMinor.startsWith("-");
  const magnitude = parseMinor(negative ? targetMinor.slice(1) : targetMinor);
  const progress = BigInt(Math.round(easeOut(t) * Number(STEPS)));
  const shown = progress >= STEPS ? magnitude : (magnitude * progress) / STEPS;
  if (shown === 0n) return "0";
  return `${negative ? "-" : ""}${shown}`;
}

/** The same for a plain count (orders, days, a percentage): rounded to the target's own decimals. */
export function tickNumber(target: number, t: number): number {
  if (!Number.isFinite(target)) return target;
  const decimals = (String(target).split(".")[1] ?? "").length;
  const factor = 10 ** Math.min(decimals, 6);
  const shown = Math.round(target * easeOut(t) * factor) / factor;
  return Object.is(shown, -0) ? 0 : shown;
}

export type Trend = "up" | "down" | "flat";
export type DeltaTone = "good" | "bad" | "neutral";

/**
 * Which colour a change takes: green when it is good news, crimson when bad, ink-2 when flat or neither. Whether "up"
 * is good depends on the figure (sales up is good, spending up is not), so the caller says so with `upIsGood`.
 */
export function deltaTone(trend: Trend, upIsGood: boolean | undefined): DeltaTone {
  if (trend === "flat" || upIsGood === undefined) return "neutral";
  return (trend === "up") === upIsGood ? "good" : "bad";
}
