/**
 * The colour tones the ux2 primitives share (IconTile, Progress, ProgressRing, Stat; DESIGN.md §3, §12). A tone keeps
 * its meaning everywhere: a pocket's slot colour (LINE_SLOT), green for money in (`paid`), cobalt for what the wallet
 * did alone (`agent`), amber for "only you can act" (`waiting`), crimson for refused (`blocked`), cinnabar for Mei's
 * signature only (`seal`), and two neutrals (`ink`, `grey`).
 *
 * Each tone has four forms, written out in full so Tailwind sees every class at build time:
 * - `solid`: the colour as a fill (a white glyph on it is at least 3:1);
 * - `tint`: the colour at 13 % as a fill;
 * - `ink`: the colour for a glyph or a figure on its tint (at least 4.5:1 there, on white and on the canvas);
 * - `stroke`: the colour for an SVG stroke (rings, sparklines).
 */
import type { LineSlot } from "@/components/ledger/line-slots";

export const TONES = [
  "ink",
  "grey",
  "slot-1",
  "slot-2",
  "slot-3",
  "slot-4",
  "slot-5",
  "slot-neutral",
  "paid",
  "agent",
  "waiting",
  "blocked",
  "seal",
] as const;

export type Tone = (typeof TONES)[number];

export interface ToneClasses {
  readonly solid: string;
  readonly tint: string;
  readonly ink: string;
  readonly stroke: string;
}

export const TONE: Readonly<Record<Tone, ToneClasses>> = {
  ink: { solid: "bg-ink", tint: "bg-tint-ink", ink: "text-ink", stroke: "stroke-ink" },
  grey: { solid: "bg-chart-neutral", tint: "bg-tint-neutral", ink: "text-slot-neutral-ink", stroke: "stroke-chart-neutral" },
  "slot-1": { solid: "bg-chart-1", tint: "bg-tint-1", ink: "text-slot-1-ink", stroke: "stroke-chart-1" },
  "slot-2": { solid: "bg-chart-2", tint: "bg-tint-2", ink: "text-slot-2-ink", stroke: "stroke-chart-2" },
  "slot-3": { solid: "bg-chart-3", tint: "bg-tint-3", ink: "text-slot-3-ink", stroke: "stroke-chart-3" },
  "slot-4": { solid: "bg-chart-4", tint: "bg-tint-4", ink: "text-slot-4-ink", stroke: "stroke-chart-4" },
  "slot-5": { solid: "bg-chart-5", tint: "bg-tint-5", ink: "text-slot-5-ink", stroke: "stroke-chart-5" },
  "slot-neutral": { solid: "bg-chart-neutral", tint: "bg-tint-neutral", ink: "text-slot-neutral-ink", stroke: "stroke-chart-neutral" },
  paid: { solid: "bg-paid", tint: "bg-tint-paid", ink: "text-paid", stroke: "stroke-paid" },
  agent: { solid: "bg-agent", tint: "bg-tint-agent", ink: "text-agent", stroke: "stroke-agent" },
  waiting: { solid: "bg-tile-waiting", tint: "bg-tint-waiting", ink: "text-waiting", stroke: "stroke-waiting-dot" },
  blocked: { solid: "bg-blocked", tint: "bg-tint-blocked", ink: "text-blocked", stroke: "stroke-blocked" },
  seal: { solid: "bg-seal", tint: "bg-tint-seal", ink: "text-seal-ink", stroke: "stroke-seal" },
};

/** The tone of a budget line's slot (LINE_SLOT[key]): `slotTone(LINE_SLOT.SUPPLIER)` is "slot-1". */
export function slotTone(slot: LineSlot): Tone {
  return `slot-${slot}`;
}

/** True for a value that names a tone (for props read from data). */
export function isTone(value: unknown): value is Tone {
  return typeof value === "string" && (TONES as readonly string[]).includes(value);
}
