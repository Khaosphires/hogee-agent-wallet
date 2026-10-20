/**
 * The geometry of <Segmented> (./segmented.tsx), kept pure so it can be tested. Segments are equal widths in a grid
 * with GAP_PX between them, so the thumb's width is fixed and only its translate moves (transform only).
 */

/** The gap between two segments, and the track's inner padding, in px (Tailwind `gap-0.5`, `p-0.5`). */
export const GAP_PX = 2;
export const PAD_PX = 2;

/** The index of `value` among the options, or -1 when nothing (or something unknown) is chosen. */
export function segmentIndex(values: readonly string[], value: string | undefined): number {
  return value === undefined ? -1 : values.indexOf(value);
}

/** The thumb's width: one segment, as a CSS length against the track's padding box. */
export function thumbWidth(count: number): string {
  if (!Number.isInteger(count) || count < 1) throw new RangeError(`a segmented control needs at least one option, got ${count}`);
  return `calc((100% - ${2 * PAD_PX + (count - 1) * GAP_PX}px) / ${count})`;
}

/** The thumb's `translate` for the chosen index: whole segments plus the gaps between them. -1 stays at the start. */
export function thumbTranslate(index: number): string {
  const i = Math.max(0, index);
  return i === 0 ? "0 0" : `calc(${i} * (100% + ${GAP_PX}px)) 0`;
}
