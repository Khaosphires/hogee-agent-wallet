/**
 * Chart series config behind <ChartContainer>, kept free of React and recharts so it can be unit-tested.
 *
 * Each series key becomes a CSS variable on the container, `--color-<key>: var(--chart-N, <fallback>)`, so marks
 * use `fill="var(--color-revenue)"` and the palette lives in globals.css (--chart-1..5). The variables are set as
 * inline style properties, not a generated <style> block, so a key can never inject CSS.
 *
 * Colours follow the series, never its rank: give each series a fixed `slot` so a filter that hides one does not
 * repaint the rest. Unslotted series take slots in key order. There are five slots and no cycling: a sixth series
 * belongs in "Other" or a second chart.
 */

export const CHART_SLOTS = [1, 2, 3, 4, 5] as const;
export type ChartSlot = (typeof CHART_SLOTS)[number];

/**
 * Used until globals.css defines --chart-1..5: a categorical order checked for colour-vision separation (adjacent
 * pairs ΔE ≥ 9) on a light surface. Slots 3–5 sit under 3:1 contrast, so charts using them keep visible labels or
 * a table view.
 */
export const CHART_FALLBACKS = [
  "oklch(0.575 0.163 255.5)", // blue
  "oklch(0.671 0.175 40.6)", // orange
  "oklch(0.669 0.141 162.1)", // aqua
  "oklch(0.764 0.161 75.1)", // amber
  "oklch(0.716 0.141 357.4)", // pink
] as const;

export interface ChartSeries {
  /** Plain text shown in the tooltip and legend. */
  label: string;
  slot?: ChartSlot;
}

export type ChartConfig = Record<string, ChartSeries>;

// A CSS custom-property name part: a letter first, then letters, digits, "-" or "_".
const KEY = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** `{"--color-<key>": "var(--chart-N, <fallback>)"}` for every series; throws on a config it cannot colour safely. */
export function chartCssVars(config: ChartConfig): Record<`--color-${string}`, string> {
  const entries = Object.entries(config);
  const vars: Record<`--color-${string}`, string> = {};
  entries.forEach(([key, series], i) => {
    if (!KEY.test(key)) throw new Error(`chart key ${JSON.stringify(key)} is not a CSS identifier (letters, digits, - and _)`);
    const slot = series.slot ?? i + 1;
    if (!(CHART_SLOTS as readonly number[]).includes(slot)) {
      throw new Error(
        series.slot === undefined
          ? `chart has more than 5 series: fold the rest into "Other" or split the chart`
          : `chart key ${JSON.stringify(key)} has slot ${String(slot)}; slots are 1..5`,
      );
    }
    vars[`--color-${key}`] = `var(--chart-${slot}, ${CHART_FALLBACKS[slot - 1]})`;
  });
  return vars;
}

/** The parts of a recharts tooltip or legend entry used to find its series. */
export interface SeriesEntry {
  dataKey?: unknown;
  name?: unknown;
  value?: unknown;
  payload?: unknown;
}

const own = (config: ChartConfig, key: unknown): key is string => typeof key === "string" && Object.hasOwn(config, key);

/** The config key for an entry: the row's `nameKey` field, else the entry's dataKey, else its name. */
export function seriesKeyOf(config: ChartConfig, entry: SeriesEntry, nameKey?: string): string | undefined {
  if (nameKey !== undefined && typeof entry.payload === "object" && entry.payload !== null) {
    const fromRow = (entry.payload as Record<string, unknown>)[nameKey];
    if (own(config, fromRow)) return fromRow;
  }
  if (own(config, entry.dataKey)) return entry.dataKey;
  if (own(config, entry.name)) return entry.name;
  return undefined;
}

/** Default tooltip value text when the chart passes no formatter. */
export function tooltipValueText(value: number | string | ReadonlyArray<number | string> | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "number" || typeof value === "string") return String(value);
  return value.map(String).join("–");
}
