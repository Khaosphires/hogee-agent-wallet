"use client";

/**
 * The Wallet's recharts marks (DESIGN.md §8, dataviz): bars ≤ 18 px with a 4 px rounded top and 2 px gaps, recessive
 * axes, a hover tooltip. Colour says what the money is: green money in (sales); running costs stacked by pocket in each
 * pocket's slot colour (the same as its tile, ring and split bar), with a neutral part for whatever isn't split yet.
 * Load ONLY through ./cfo-chart.tsx (next/dynamic, no SSR), so /chat and the first paint ship no chart code. Values here
 * are whole BU for geometry; the tables under "Show figures" hold the exact figures.
 */
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import type { LineKey } from "@hogee/core";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig, type ChartSlot } from "@/components/ui/chart";
import { LINE_SLOT } from "@/components/ledger/line-slots";
import { lineLabel } from "@/lib/format";
import { slotVar } from "./pocket-look";
import { UNSPLIT } from "./spend-stack";

const bu = (v: unknown) => `${Number(v).toLocaleString("en-GB")} BU`;
const tick = (v: number) => v.toLocaleString("en-GB");

export interface BarsProps {
  readonly rows: readonly Record<string, string | number>[];
  readonly dataKey: string;
  readonly label: string;
  readonly title: string;
  /** Extra classes; the chart fills its parent's height (the caller sizes the box, as for the skeleton). */
  readonly className?: string;
}

/** One series of daily bars in the money-in green (sales). */
export function DailyBars({ rows, dataKey, label, title, className = "h-full" }: BarsProps) {
  const config = { [dataKey]: { label, slot: 1 } } satisfies ChartConfig;
  const style = { [`--color-${dataKey}`]: "var(--paid)" } as React.CSSProperties;
  return (
    <ChartContainer config={config} aria-label={title} role="img" className={`aspect-auto w-full ${className}`} style={style}>
      <BarChart data={[...rows]} margin={{ top: 6, right: 0, bottom: 0, left: 0 }} barCategoryGap={2}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={28} />
        <YAxis width={40} tickLine={false} axisLine={false} tickCount={3} tickFormatter={tick} />
        <ChartTooltip cursor content={<ChartTooltipContent formatValue={bu} />} />
        <Bar dataKey={dataKey} fill={`var(--color-${dataKey})`} radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive={false} />
      </BarChart>
    </ChartContainer>
  );
}

/** A slot for the config (1..5); neutral pockets and the unsplit part get theirs from the style below. */
const configSlot = (key: string): ChartSlot => {
  const slot = Object.hasOwn(LINE_SLOT, key) ? LINE_SLOT[key as LineKey] : "neutral";
  return slot === "neutral" ? 1 : slot;
};
const colourOf = (key: string): string => (key === UNSPLIT || !Object.hasOwn(LINE_SLOT, key) ? "var(--chart-neutral)" : slotVar(LINE_SLOT[key as LineKey]));
const nameOf = (key: string): string => (key === UNSPLIT ? "Not split yet" : lineLabel(key));

interface SegmentShape {
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  readonly fill?: string;
  readonly payload?: Record<string, unknown>;
  readonly dataKey?: string;
}

/** A stacked segment: a 2 px surface gap above it, and a 4 px rounded top only on the day's top segment. */
function Segment({ x = 0, y = 0, width = 0, height = 0, fill, payload, dataKey }: SegmentShape) {
  if (height <= 0 || width <= 0) return null;
  const top = payload?.__top === dataKey;
  const gap = top ? 0 : Math.min(2, height / 2);
  const h = height - gap;
  const r = top ? Math.min(4, width / 2, h) : 0;
  const yy = y + gap;
  const d = `M${x},${yy + h} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + width - r} Q${x + width},${yy} ${x + width},${yy + r} V${yy + h} Z`;
  return <path d={d} fill={fill} />;
}

/** Running costs per day, stacked by pocket (rows from spend-stack.ts stackRows, whole BU per key, `__top` per row). */
export function StackedDailyBars({ rows, keys, title, className = "h-full" }: { rows: readonly Record<string, string | number>[]; keys: readonly string[]; title: string; className?: string }) {
  const config = Object.fromEntries(keys.map((k) => [k, { label: nameOf(k), slot: configSlot(k) }])) satisfies ChartConfig;
  const style = Object.fromEntries(keys.map((k) => [`--color-${k}`, colourOf(k)])) as React.CSSProperties;
  return (
    <ChartContainer config={config} aria-label={title} role="img" className={`aspect-auto w-full ${className}`} style={style}>
      <BarChart data={[...rows]} margin={{ top: 6, right: 0, bottom: 0, left: 0 }} barCategoryGap={2}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={28} />
        <YAxis width={40} tickLine={false} axisLine={false} tickCount={3} tickFormatter={tick} />
        <ChartTooltip cursor content={<ChartTooltipContent formatValue={bu} />} />
        {keys.map((k) => (
          <Bar key={k} dataKey={k} stackId="day" fill={`var(--color-${k})`} maxBarSize={18} isAnimationActive={false} shape={<Segment dataKey={k} />} />
        ))}
      </BarChart>
    </ChartContainer>
  );
}
