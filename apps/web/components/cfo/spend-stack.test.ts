import { describe, expect, it } from "vitest";
import { CfoReport, exampleCfoReport } from "@hogee/core";
import { chartDays, runningCostsByDay, stackKeys, stackRows, UNSPLIT } from "./spend-stack";

const base = CfoReport.parse(exampleCfoReport);
const days = ["2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19"];
const report = {
  ...base,
  asOf: "2026-10-19T09:00:00.000Z",
  pnl: { ...base.pnl, from: "2026-10-17" },
  spending: { ...base.spending, daily: days.map((date, i) => ({ date, spentMinor: ["0", "10000", "7500", "12000"][i] ?? "0" })) },
};
const pay = (lineKey: string, amountMinor: string, updatedAt: string, over: Partial<{ kind: string; state: string }> = {}) =>
  ({ kind: "SPEND", state: "FINALIZED", lineKey, amountMinor, updatedAt, ...over }) as Parameters<typeof runningCostsByDay>[0][number];

describe("the Spending chart stacked by pocket", () => {
  it("starts at the first record, not 30 days back", () => {
    expect(chartDays(report).map((d) => d.date)).toEqual(["2026-10-17", "2026-10-18", "2026-10-19"]);
  });

  it("counts only what the report counts: running costs with a receipt, by UTC day, none after asOf", () => {
    const by = runningCostsByDay(
      [
        pay("ADS", "7500", "2026-10-18T23:30:00Z"),
        pay("ADS", "100", "2026-10-18T01:00:00Z", { state: "BROADCAST" }),
        pay("SUPPLIER", "75000", "2026-10-18T02:00:00Z", { kind: "FUND_MILESTONE" }),
        pay("PACKAGING", "999", "2026-10-19T10:00:00Z"),
        pay("LOGISTICS", "2500", "2026-10-18T05:00:00Z", { kind: "OWNER_SPEND" }),
      ],
      report.asOf,
    );
    expect([...by.keys()]).toEqual(["2026-10-18"]);
    expect(Object.fromEntries(by.get("2026-10-18") ?? [])).toEqual({ ADS: 7500n, LOGISTICS: 2500n });
  });

  it("keeps every bar's height the report's figure; the split colours it, the rest stays neutral", () => {
    const rows = stackRows(report, [pay("ADS", "7500", "2026-10-17T03:00:00Z"), pay("LOGISTICS", "2500", "2026-10-17T05:00:00Z"), pay("ADS", "7500", "2026-10-18T05:00:00Z"), pay("PACKAGING", "4000", "2026-10-19T05:00:00Z")]);
    expect(rows).toEqual([
      { date: "2026-10-17", totalMinor: "10000", parts: { LOGISTICS: "2500", ADS: "7500" } },
      { date: "2026-10-18", totalMinor: "7500", parts: { ADS: "7500" } },
      { date: "2026-10-19", totalMinor: "12000", parts: { PACKAGING: "4000", [UNSPLIT]: "8000" } },
    ]);
    for (const r of rows) expect(Object.values(r.parts).reduce((s, x) => s + BigInt(x), 0n).toString()).toBe(r.totalMinor);
    expect(stackKeys(rows)).toEqual(["PACKAGING", "LOGISTICS", "ADS", UNSPLIT]);
  });

  it("a split that comes to more than the report's figure is drawn whole and neutral, never taller", () => {
    const rows = stackRows(report, [pay("ADS", "20000", "2026-10-18T05:00:00Z")]);
    expect(rows.find((r) => r.date === "2026-10-18")?.parts).toEqual({ [UNSPLIT]: "7500" });
    expect(rows.find((r) => r.date === "2026-10-17")?.parts).toEqual({ [UNSPLIT]: "10000" });
  });
});
