"use client";

/**
 * A thin recharts wrapper in the shadcn chart style. Load it with next/dynamic: this module reads no browser
 * globals at import time (ResponsiveContainer measures in effects only).
 *
 *   const config = { revenue: { label: "Revenue", slot: 1 } } satisfies ChartConfig;
 *   <ChartContainer config={config} aria-label="Daily revenue">
 *     <BarChart data={rows}>
 *       <Bar dataKey="revenue" fill="var(--color-revenue)" />
 *       <ChartTooltip content={<ChartTooltipContent formatValue={(v) => bu(String(v))} />} />
 *       <ChartLegend content={<ChartLegendContent />} />
 *     </BarChart>
 *   </ChartContainer>
 */
import * as React from "react";
import * as RechartsPrimitive from "recharts";
import type { LegendPayload, TooltipContentProps, TooltipPayloadEntry } from "recharts";
import { chartCssVars, seriesKeyOf, tooltipValueText, type ChartConfig } from "@/components/ui/chart-config";
import { cn } from "@/lib/utils";

type ChartValue = TooltipPayloadEntry["value"];

const ChartContext = React.createContext<{ config: ChartConfig } | null>(null);

function useChart() {
  const context = React.useContext(ChartContext);
  if (!context) throw new Error("useChart must be used within a <ChartContainer />");
  return context;
}

function ChartContainer({
  config,
  className,
  style,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  config: ChartConfig;
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"];
}) {
  const vars = React.useMemo(() => chartCssVars(config), [config]);
  const value = React.useMemo(() => ({ config }), [config]);
  return (
    <ChartContext.Provider value={value}>
      <div
        data-slot="chart"
        className={cn(
          "flex aspect-video justify-center text-xs tabular-nums",
          // Recessive axes and grid in the theme's own inks; recharts' default #ccc / #fff strokes are re-mapped.
          "[&_.recharts-cartesian-axis-tick_text]:fill-ink-3 [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-line",
          "[&_.recharts-curve.recharts-tooltip-cursor]:stroke-line-2 [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-canvas",
          "[&_.recharts-polar-grid_[stroke='#ccc']]:stroke-border [&_.recharts-radial-bar-background-sector]:fill-muted [&_.recharts-reference-line_[stroke='#ccc']]:stroke-border",
          "[&_.recharts-dot[stroke='#fff']]:stroke-surface [&_.recharts-sector[stroke='#fff']]:stroke-surface",
          "[&_.recharts-layer]:outline-hidden [&_.recharts-sector]:outline-hidden [&_.recharts-surface]:outline-hidden",
          className,
        )}
        style={{ ...vars, ...style }}
        {...props}
      >
        <RechartsPrimitive.ResponsiveContainer>{children}</RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

const ChartTooltip = RechartsPrimitive.Tooltip;

type ChartTooltipContentProps = Partial<Pick<TooltipContentProps, "active" | "payload" | "label">> & {
  className?: string;
  /** Formats each value (e.g. minor units → "1,200 BU"); defaults to the raw value. */
  formatValue?: (value: ChartValue, key: string | undefined, entry: TooltipPayloadEntry) => React.ReactNode;
  /** Formats the heading (the x value: a date, a line name). */
  formatLabel?: (label: string | number) => React.ReactNode;
  hideLabel?: boolean;
  hideIndicator?: boolean;
  indicator?: "dot" | "line";
  /** Field of the data row that names the series (for one-series-per-row data such as a pie). */
  nameKey?: string;
};

/** Tooltip body: the label, then one row per series with a colour key, its config label and the formatted value. */
function ChartTooltipContent({
  active,
  payload,
  label,
  className,
  formatValue,
  formatLabel,
  hideLabel = false,
  hideIndicator = false,
  indicator = "dot",
  nameKey,
}: ChartTooltipContentProps) {
  const { config } = useChart();
  if (!active || !payload?.length) return null;

  const heading = hideLabel || label === undefined ? null : (formatLabel?.(label) ?? String(label));

  return (
    <div
      data-slot="chart-tooltip"
      className={cn(
        "grid min-w-32 items-start gap-1.5 rounded-md bg-ink px-2.5 py-2 text-[0.78125rem] leading-[1.4] text-ink-on shadow-pop",
        className,
      )}
    >
      {heading !== null ? <div className="font-semibold">{heading}</div> : null}
      <div className="grid gap-1">
        {payload
          .filter((entry) => entry.type !== "none")
          .map((entry, i) => {
            const key = seriesKeyOf(config, entry, nameKey);
            const name = key !== undefined ? config[key]?.label : String(entry.name ?? entry.dataKey ?? "");
            const color = key !== undefined ? `var(--color-${key})` : (entry.color ?? entry.fill);
            return (
              <div key={`${key ?? i}`} className="flex items-center gap-2">
                {hideIndicator ? null : (
                  <span
                    aria-hidden
                    className={cn("shrink-0 rounded-[2px]", indicator === "dot" ? "size-2.5" : "h-3 w-1")}
                    style={{ backgroundColor: color }}
                  />
                )}
                <span className="flex-1 text-ink-on/75">{name}</span>
                <span className="font-medium text-ink-on tabular-nums">
                  {formatValue ? formatValue(entry.value, key, entry) : tooltipValueText(entry.value)}
                </span>
              </div>
            );
          })}
      </div>
    </div>
  );
}

const ChartLegend = RechartsPrimitive.Legend;

/** Legend body: colour key and config label per series, in text inks (never the series colour). */
function ChartLegendContent({
  payload,
  verticalAlign = "bottom",
  className,
  nameKey,
}: {
  payload?: readonly LegendPayload[];
  verticalAlign?: "top" | "middle" | "bottom";
  className?: string;
  nameKey?: string;
}) {
  const { config } = useChart();
  if (!payload?.length) return null;

  return (
    <ul
      data-slot="chart-legend"
      className={cn("flex flex-wrap items-center justify-center gap-x-4 gap-y-1", verticalAlign === "top" ? "pb-3" : "pt-3", className)}
    >
      {payload
        .filter((entry) => entry.type !== "none")
        .map((entry, i) => {
          const key = seriesKeyOf(config, entry, nameKey);
          return (
            <li key={`${key ?? i}`} className="flex items-center gap-1.5 text-meta text-ink-2">
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-[3px]"
                style={{ backgroundColor: key !== undefined ? `var(--color-${key})` : entry.color }}
              />
              {key !== undefined ? config[key]?.label : (entry.value ?? "")}
            </li>
          );
        })}
    </ul>
  );
}

export { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, useChart };
export type { ChartTooltipContentProps };
export { CHART_FALLBACKS, CHART_SLOTS, type ChartConfig, type ChartSeries, type ChartSlot } from "@/components/ui/chart-config";
