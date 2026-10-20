/**
 * The chart colour of each budget line (DESIGN.md §7–8: "Slots follow the line, never its rank"). Five categorical
 * slots; the buffer (CONTINGENCY) and the rare licensing line share the neutral, and their rows name them, so colour
 * never carries identity alone. Use the same slot in every chart that shows a line (ChartConfig `slot`).
 */
import type { LineKey } from "@hogee/core";

export type LineSlot = 1 | 2 | 3 | 4 | 5 | "neutral";

export const LINE_SLOT: Record<LineKey, LineSlot> = {
  SUPPLIER: 1,
  PACKAGING: 2,
  LOGISTICS: 3,
  ADS: 4,
  PLATFORM_FEES: 5,
  LICENSING: "neutral",
  CONTINGENCY: "neutral",
};

/** The Tailwind background for a slot (written out so the classes exist at build time). */
export const SLOT_BG: Record<LineSlot, string> = {
  1: "bg-chart-1",
  2: "bg-chart-2",
  3: "bg-chart-3",
  4: "bg-chart-4",
  5: "bg-chart-5",
  neutral: "bg-chart-neutral",
};
