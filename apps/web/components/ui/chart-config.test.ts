/** Chart colours come from the --chart-1..5 slots, in a fixed order, as CSS variables on the container. */
import { describe, expect, it } from "vitest";
import { CHART_FALLBACKS, chartCssVars, seriesKeyOf, tooltipValueText, type ChartConfig } from "./chart-config";

describe("chartCssVars", () => {
  it("maps each series to --color-<key> from its slot, with a fallback when the slot is not defined", () => {
    const config: ChartConfig = { revenue: { label: "Revenue", slot: 1 }, spent: { label: "Spent", slot: 3 } };
    expect(chartCssVars(config)).toEqual({
      "--color-revenue": `var(--chart-1, ${CHART_FALLBACKS[0]})`,
      "--color-spent": `var(--chart-3, ${CHART_FALLBACKS[2]})`,
    });
  });

  it("assigns slots in key order when none is given", () => {
    expect(chartCssVars({ a: { label: "A" }, b: { label: "B" } })).toEqual({
      "--color-a": `var(--chart-1, ${CHART_FALLBACKS[0]})`,
      "--color-b": `var(--chart-2, ${CHART_FALLBACKS[1]})`,
    });
  });

  it("has five neutral oklch fallbacks", () => {
    expect(CHART_FALLBACKS).toHaveLength(5);
    for (const c of CHART_FALLBACKS) expect(c).toMatch(/^oklch\(0\.\d{3} 0\.\d{3} \d{1,3}\.\d\)$/);
  });

  it("refuses a sixth unslotted series instead of cycling colours", () => {
    const six = Object.fromEntries(["a", "b", "c", "d", "e", "f"].map((k) => [k, { label: k }]));
    expect(() => chartCssVars(six)).toThrow(/more than 5/);
  });

  it("refuses keys that are not safe CSS identifiers", () => {
    for (const key of ["", "1st", "a b", "a;color:red", "a)", "--x", "a}"]) {
      expect(() => chartCssVars({ [key]: { label: "x" } }), JSON.stringify(key)).toThrow(/chart key/);
    }
  });

  it("refuses a slot outside 1..5", () => {
    expect(() => chartCssVars({ a: { label: "A", slot: 6 as 1 } })).toThrow(/slot/);
  });

  it("is empty for an empty config", () => {
    expect(chartCssVars({})).toEqual({});
  });
});

describe("seriesKeyOf", () => {
  const config: ChartConfig = { revenue: { label: "Revenue" }, ads: { label: "Ads" } };

  it("prefers nameKey from the data row, then dataKey, then name", () => {
    expect(seriesKeyOf(config, { dataKey: "revenue", name: "ads", payload: { line: "ads" } }, "line")).toBe("ads");
    expect(seriesKeyOf(config, { dataKey: "revenue", name: "ads" })).toBe("revenue");
    expect(seriesKeyOf(config, { dataKey: (row: unknown) => row, name: "ads" })).toBe("ads");
  });

  it("is undefined for keys the config does not own, including inherited ones", () => {
    expect(seriesKeyOf(config, { dataKey: "other" })).toBeUndefined();
    expect(seriesKeyOf(config, { dataKey: "constructor" })).toBeUndefined();
    expect(seriesKeyOf(config, { name: "toString" })).toBeUndefined();
    expect(seriesKeyOf(config, {})).toBeUndefined();
  });
});

describe("tooltipValueText (default when no formatter is passed)", () => {
  it("prints numbers and strings as given, and a range with an en dash", () => {
    expect(tooltipValueText(1234)).toBe("1234");
    expect(tooltipValueText("1200")).toBe("1200");
    expect(tooltipValueText([10, 20])).toBe("10–20");
  });

  it("prints nothing for a missing value", () => {
    expect(tooltipValueText(undefined)).toBe("");
  });
});
