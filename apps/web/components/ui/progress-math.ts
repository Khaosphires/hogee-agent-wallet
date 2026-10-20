/** The pure parts of <Progress> and <ProgressRing> (./progress.tsx). */

/** A percentage clamped to 0..100; anything that is not a finite number counts as 0 (fail closed: never "full"). */
export function clampPct(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export interface RingGeometry {
  /** The circle's radius, inside the box so the stroke is not clipped. */
  readonly r: number;
  /** The circle's length: the stroke-dasharray. */
  readonly circumference: number;
  /** How much of the length is hidden: the stroke-dashoffset for `pct`. */
  readonly offset: number;
}

/** The ring for a `size` px box with a `stroke` px line at `pct` percent (a sliver shows from 1 %). */
export function ringGeometry(size: number, stroke: number, pct: number): RingGeometry {
  if (!(size > 0) || !(stroke > 0) || stroke * 2 >= size) throw new RangeError(`a ring needs size > 2 × stroke > 0, got ${size} and ${stroke}`);
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const p = clampPct(pct);
  const shown = p > 0 && p < 1 ? 1 : p;
  return { r, circumference, offset: circumference * (1 - shown / 100) };
}
