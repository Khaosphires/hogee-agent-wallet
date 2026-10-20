/**
 * buildCfoReport (VISION-DECISIONS §8 core-cfo): cash-basis numbers from Mei's own records, MA7 linear forecast, no
 * invented data (fewer than 3 days → no projection), UTC day buckets, exact bigint money up to uint128.
 */
import { describe, expect, it } from "vitest";
import { buildCfoReport } from "../src/cfo/report";
import { toCfoReportJson } from "../src/cfo/json";
import { CFO_DISCLAIMER, CfoInputError, type CfoInputs } from "../src/cfo/types";
import { UINT128_MAX } from "../src/money/index";
import { at, fourteenDays, fresh, pay, range, sale } from "./cfo-scenarios";

describe("fresh Mei (nothing paid or sold)", () => {
  const r = buildCfoReport(fresh());

  it("projects nothing: runway, stage-2 date and points are null/empty", () => {
    expect(r.forecast).toEqual({
      method: "MA7_LINEAR",
      sampleDays: 0,
      dailyBurnMinor: 0n,
      dailyRevenueMinor: 0n,
      runwayDays: null,
      stage2Date: null,
      reserveIn30dMinor: 0n,
      points: [],
    });
    expect(r.sales.stageGate).toEqual({ stageId: "stage-2", targetMinor: 200_000n, soFarMinor: 0n, deadline: "2026-11-15", projectedDate: null });
  });

  it("caps cash available at the released stage (400,000), not the 1,000,000 of line allocations", () => {
    expect(r.overview).toEqual({ cashAvailableMinor: 400_000n, spentMinor: 0n, revenueMinor: 0n, reserveMinor: 0n, netMinor: 0n });
  });

  it("zero-fills the last 30 UTC days and has no insights", () => {
    expect(r.spending.daily).toHaveLength(30);
    expect(r.spending.daily[0]).toEqual({ date: "2026-10-01", spentMinor: 0n });
    expect(r.spending.daily.at(-1)).toEqual({ date: "2026-10-30", spentMinor: 0n });
    expect(r.sales.daily.every((d) => d.revenueMinor === 0n && d.count === 0)).toBe(true);
    expect(r.sales).toMatchObject({ count: 0, revenueMinor: 0n, averageMinor: 0n, recent: [] });
    expect(r.pnl).toMatchObject({ from: "2026-10-30", to: "2026-10-30", netMinor: 0n, basis: "cash" });
    expect(r.insights).toEqual([]);
    expect(r.disclaimer).toBe("Estimates from your own records. Not financial advice.");
  });

  it("without releasedMinor, cash available is the sum of the lines' available", () => {
    const { releasedMinor: _omit, ...rest } = fresh();
    expect(buildCfoReport(rest).overview.cashAvailableMinor).toBe(1_000_000n);
  });
});

describe("14 days of sales, ads pacing and one supplier deposit", () => {
  const r = buildCfoReport(fourteenDays());

  it("overview and P&L: cash basis, auto-released deposit is supplier cost, reserve set aside (not an expense)", () => {
    expect(r.asOf).toBe("2026-10-30T12:00:00.000Z");
    expect(r.overview).toEqual({ cashAvailableMinor: 138_700n, spentMinor: 261_300n, revenueMinor: 126_000n, reserveMinor: 6_300n, netMinor: -135_300n });
    expect(r.pnl).toEqual({
      from: "2026-10-17",
      to: "2026-10-30",
      revenueMinor: 126_000n,
      supplierCostMinor: 150_000n,
      operatingByLine: [
        { lineKey: "SUPPLIER", amountMinor: 0n },
        { lineKey: "PACKAGING", amountMinor: 0n },
        { lineKey: "LOGISTICS", amountMinor: 0n },
        { lineKey: "ADS", amountMinor: 105_000n },
        { lineKey: "PLATFORM_FEES", amountMinor: 6_300n },
        { lineKey: "CONTINGENCY", amountMinor: 0n },
      ],
      operatingMinor: 111_300n,
      netMinor: -135_300n,
      reserveSetAsideMinor: 6_300n,
      basis: "cash",
    });
  });

  it("spending by line mirrors the pockets; the daily series is operating spend per UTC day", () => {
    expect(r.spending.byLine.find((l) => l.lineKey === "SUPPLIER")).toEqual({
      lineKey: "SUPPLIER",
      allocatedMinor: 500_000n,
      spentMinor: 0n,
      escrowedMinor: 150_000n,
      availableMinor: 350_000n,
    });
    expect(r.spending.byLine.map((l) => l.lineKey)).toEqual(["SUPPLIER", "PACKAGING", "LOGISTICS", "ADS", "PLATFORM_FEES", "CONTINGENCY"]);
    const daily = r.spending.daily;
    expect(daily.filter((d) => d.date < "2026-10-17").every((d) => d.spentMinor === 0n)).toBe(true);
    expect(daily.filter((d) => d.date >= "2026-10-17").map((d) => d.spentMinor)).toEqual(range(1, 14).map(() => 7_950n));
  });

  it("sales: count, average, daily, 20 most recent first, stage gate projection", () => {
    expect(r.sales).toMatchObject({ count: 28, revenueMinor: 126_000n, averageMinor: 4_500n });
    expect(r.sales.daily.at(-1)).toEqual({ date: "2026-10-30", revenueMinor: 9_000n, count: 2 });
    expect(r.sales.recent).toHaveLength(20);
    expect(r.sales.recent[0]).toMatchObject({ saleId: "sale-14-b", amountMinor: 4_500n, at: "2026-10-30T11:00:00.000Z" });
    expect(r.sales.stageGate).toEqual({ stageId: "stage-2", targetMinor: 200_000n, soFarMinor: 126_000n, deadline: "2026-11-15", projectedDate: "2026-11-08" });
  });

  it("forecast: MA7 burn and revenue, runway floor, reserve in 30 days, 30 signed cash points", () => {
    expect(r.forecast).toMatchObject({
      method: "MA7_LINEAR",
      sampleDays: 14,
      dailyBurnMinor: 7_950n,
      dailyRevenueMinor: 9_000n,
      runwayDays: 17, // 138,700 / 7,950 = 17.4
      stage2Date: "2026-11-08", // 74,000 left / 9,000 a day = 8.2 → 9 days
      reserveIn30dMinor: 19_800n, // 6,300 + 9,000 × 30 × 5 %
    });
    expect(r.forecast.points).toHaveLength(30);
    expect(r.forecast.points[0]).toEqual({ date: "2026-10-31", cashMinor: 130_750n });
    expect(r.forecast.points.at(-1)).toEqual({ date: "2026-11-29", cashMinor: -99_800n });
  });

  it("reserve section", () => {
    expect(r.reserve).toEqual({ rateBps: 500, skimmedMinor: 6_300n, withdrawnMinor: 0n, balanceMinor: 6_300n, taxPayeeId: "iras-tax", salesCount: 28 });
  });

  it("is deterministic and independent of input order", () => {
    const i = fourteenDays();
    const shuffled: CfoInputs = { ...i, payments: [...i.payments].reverse(), sales: [...i.sales].reverse(), lines: [...i.lines].reverse() };
    expect(buildCfoReport(shuffled)).toEqual(buildCfoReport(i));
  });
});

describe("supplier milestones are counted once", () => {
  it("without the autoReleased flag a FUND_MILESTONE is escrowed, not cost (spec default)", () => {
    const r = buildCfoReport(fourteenDays(4_500n, { autoReleased: false }));
    expect(r.pnl.supplierCostMinor).toBe(0n);
    expect(r.pnl.netMinor).toBe(14_700n);
  });

  it("a founder-signed RELEASE_MILESTONE is cost; a failed payout or an unmined row is not", () => {
    const i = fourteenDays();
    const r = buildCfoReport({
      ...i,
      payments: [
        ...i.payments,
        pay("RELEASE_MILESTONE", "SUPPLIER", 280_000n, at(13)),
        pay("RELEASE_MILESTONE", "SUPPLIER", 999n, at(13), { state: "SETTLEMENT_FAILED" }),
        pay("RELEASE_MILESTONE", "SUPPLIER", 777n, at(13), { state: "SIGNED" }),
      ],
    });
    expect(r.pnl.supplierCostMinor).toBe(430_000n);
  });

  it("operating spend counts mined SPEND / OWNER_SPEND only (minedByLine states, settlement failures left out)", () => {
    const i = fresh();
    const states = ["PROPOSED", "POLICY_DENIED", "POLICY_OK", "SIGNED", "BROADCAST", "REVERTED", "DROPPED", "CANCELLED", "SETTLEMENT_FAILED"] as const;
    const r = buildCfoReport({
      ...i,
      payments: [
        ...states.map((state) => pay("SPEND", "LOGISTICS", 1_000n, at(13), { state })),
        pay("SPEND", "LOGISTICS", 100n, at(13), { state: "INCLUDED" }),
        pay("SPEND", "LOGISTICS", 200n, at(13), { state: "SETTLEMENT_REQUESTED" }),
        pay("SPEND", "LOGISTICS", 300n, at(13), { state: "SETTLED" }),
        pay("OWNER_SPEND", "LOGISTICS", 400n, at(13)),
        pay("WITHDRAW_RESERVE", null, 5_000n, at(13)),
      ],
    });
    expect(r.pnl.operatingMinor).toBe(1_000n);
    expect(r.pnl.supplierCostMinor).toBe(0n);
  });
});

describe("rounding, days of data, UTC day boundaries", () => {
  it("MA7 and the average round down (floor), never up", () => {
    const i = fresh();
    const amounts = [15n, 15n, 15n, 15n, 15n, 15n, 10n]; // 100 over days 8-14
    const r = buildCfoReport({ ...i, sales: amounts.map((a, k) => sale(`s-${k}`, a, at(8 + k))) });
    expect(r.forecast.sampleDays).toBe(7);
    expect(r.forecast.dailyRevenueMinor).toBe(14n); // 100 / 7 = 14.28
    expect(r.sales.averageMinor).toBe(14n);
  });

  it("averages over the days of data when fewer than 7", () => {
    const i = fresh();
    const r = buildCfoReport({ ...i, sales: [sale("a", 10n, at(12)), sale("b", 10n, at(13)), sale("c", 11n, at(14))] });
    expect(r.forecast.sampleDays).toBe(3);
    expect(r.forecast.dailyRevenueMinor).toBe(10n); // 31 / 3
    expect(r.forecast.points).toHaveLength(30);
  });

  it("2 days of data → no projection (never invent)", () => {
    const i = fresh();
    const r = buildCfoReport({ ...i, sales: [sale("a", 50_000n, at(13)), sale("b", 50_000n, at(14))], payments: [pay("SPEND", "ADS", 7_500n, at(14))] });
    expect(r.forecast).toMatchObject({ sampleDays: 2, runwayDays: null, stage2Date: null, points: [], reserveIn30dMinor: 0n });
    expect(r.sales.stageGate?.projectedDate).toBeNull();
  });

  it("buckets by UTC day: 23:59:59.999 is the previous day, the exact 'now' counts, the future does not", () => {
    const now = new Date("2026-10-30T00:00:00.000Z");
    const i = fresh(now);
    const r = buildCfoReport({
      ...i,
      sales: [
        sale("late", 300n, new Date("2026-10-29T23:59:59.999Z")),
        sale("midnight", 200n, new Date("2026-10-30T00:00:00.000Z")),
        sale("future", 100n, new Date("2026-10-30T00:00:00.001Z")),
      ],
    });
    expect(r.sales.daily.at(-1)).toEqual({ date: "2026-10-30", revenueMinor: 200n, count: 1 });
    expect(r.sales.daily.at(-2)).toEqual({ date: "2026-10-29", revenueMinor: 300n, count: 1 });
    expect(r.sales.count).toBe(2);
    expect(r.forecast.sampleDays).toBe(2);
  });
});

describe("reserve withdrawals", () => {
  it("balance = skimmed − withdrawn; the 30-day estimate adds MA7 revenue × 30 × rate", () => {
    const i = fourteenDays();
    const r = buildCfoReport({ ...i, reserve: { ...i.reserve, withdrawnMinor: 4_000n } });
    expect(r.reserve).toMatchObject({ skimmedMinor: 6_300n, withdrawnMinor: 4_000n, balanceMinor: 2_300n });
    expect(r.overview.reserveMinor).toBe(2_300n);
    expect(r.forecast.reserveIn30dMinor).toBe(15_800n);
    expect(r.pnl.reserveSetAsideMinor).toBe(6_300n);
  });

  it("refuses more withdrawn than set aside (fail closed)", () => {
    const i = fourteenDays();
    expect(() => buildCfoReport({ ...i, reserve: { ...i.reserve, withdrawnMinor: 6_301n } })).toThrow(CfoInputError);
  });
});

describe("bad input fails closed", () => {
  it.each([
    ["negative sale", (i: CfoInputs): CfoInputs => ({ ...i, sales: [sale("x", -1n, at(13))] })],
    ["sale above uint128", (i: CfoInputs): CfoInputs => ({ ...i, sales: [sale("x", UINT128_MAX + 1n, at(13))] })],
    ["invalid now", (i: CfoInputs): CfoInputs => ({ ...i, now: new Date("nope") })],
    ["invalid payment date", (i: CfoInputs): CfoInputs => ({ ...i, payments: [pay("SPEND", "ADS", 1n, new Date(Number.NaN))] })],
    ["spend without a line", (i: CfoInputs): CfoInputs => ({ ...i, payments: [pay("SPEND", null, 1n, at(13))] })],
    ["negative line value", (i: CfoInputs): CfoInputs => ({ ...i, lines: i.lines.map((l) => ({ ...l, availableMinor: -1n })) })],
    ["reserve rate above 10000", (i: CfoInputs): CfoInputs => ({ ...i, reserve: { ...i.reserve, rateBps: 10_001 } })],
  ])("%s", (_name, mutate) => {
    expect(() => buildCfoReport(mutate(fresh()))).toThrow(CfoInputError);
  });
});

describe("large values near uint128", () => {
  it("keeps money exact through sums, MA and JSON (no Number conversion)", () => {
    const third = UINT128_MAX / 3n;
    const i = fresh();
    const lines = i.lines.map((l) => (l.lineKey === "CONTINGENCY" ? { ...l, allocatedMinor: UINT128_MAX, availableMinor: UINT128_MAX } : l));
    const { releasedMinor: _omit, ...rest } = i;
    const r = buildCfoReport({ ...rest, lines, sales: [12, 13, 14].map((d) => sale(`big-${d}`, third, at(d))) });
    expect(r.sales.revenueMinor).toBe(third * 3n);
    expect(r.forecast.dailyRevenueMinor).toBe(third);
    expect(r.forecast.reserveIn30dMinor).toBe((third * 30n * 500n) / 10_000n);
    const json = toCfoReportJson(r);
    expect(json.sales.revenueMinor).toBe((third * 3n).toString());
    expect(json.overview.cashAvailableMinor).toBe((UINT128_MAX + 900_000n).toString());
  });
});

describe("toCfoReportJson: the §3 wire shape", () => {
  const json = toCfoReportJson(buildCfoReport(fourteenDays()));
  const MINOR = /^(0|[1-9]\d{0,38})$/;
  const SIGNED = /^-?(0|[1-9]\d{0,38})$/;

  it("has exactly the §3 field names", () => {
    expect(Object.keys(json)).toEqual(["asOf", "currency", "facilityId", "overview", "spending", "sales", "pnl", "forecast", "reserve", "insights", "agentActions", "disclaimer"]);
    expect(Object.keys(json.overview)).toEqual(["cashAvailableMinor", "spentMinor", "revenueMinor", "reserveMinor", "netMinor"]);
    expect(Object.keys(json.spending)).toEqual(["byLine", "daily"]);
    expect(Object.keys(json.spending.byLine[0] ?? {})).toEqual(["lineKey", "allocatedMinor", "spentMinor", "escrowedMinor", "availableMinor"]);
    expect(Object.keys(json.spending.daily[0] ?? {})).toEqual(["date", "spentMinor"]);
    expect(Object.keys(json.sales)).toEqual(["count", "revenueMinor", "averageMinor", "daily", "recent", "stageGate"]);
    expect(Object.keys(json.sales.daily[0] ?? {})).toEqual(["date", "revenueMinor", "count"]);
    expect(Object.keys(json.sales.recent[0] ?? {})).toEqual(["saleId", "amountMinor", "at", "txHash"]);
    expect(Object.keys(json.sales.stageGate ?? {})).toEqual(["stageId", "targetMinor", "soFarMinor", "deadline", "projectedDate"]);
    expect(Object.keys(json.pnl)).toEqual(["from", "to", "revenueMinor", "supplierCostMinor", "operatingByLine", "operatingMinor", "netMinor", "reserveSetAsideMinor", "basis"]);
    expect(Object.keys(json.forecast)).toEqual(["method", "sampleDays", "dailyBurnMinor", "dailyRevenueMinor", "runwayDays", "stage2Date", "reserveIn30dMinor", "points"]);
    expect(Object.keys(json.forecast.points[0] ?? {})).toEqual(["date", "cashMinor"]);
    expect(Object.keys(json.reserve)).toEqual(["rateBps", "skimmedMinor", "withdrawnMinor", "balanceMinor", "taxPayeeId", "salesCount"]);
    expect(Object.keys(json.insights[0] ?? {})).toEqual(["insightId", "kind", "severity", "title", "detail", "lineKey", "suggestion"]);
    expect(json.disclaimer).toBe(CFO_DISCLAIMER);
  });

  it("serialises money as digit strings (signed only where §3 says SignedMinor) and survives JSON.stringify", () => {
    expect(json.overview.netMinor).toBe("-135300");
    expect(json.forecast.points.at(-1)?.cashMinor).toBe("-99800");
    expect(json.overview.cashAvailableMinor).toMatch(MINOR);
    for (const d of json.spending.daily) expect(d.spentMinor).toMatch(MINOR);
    for (const p of json.forecast.points) expect(p.cashMinor).toMatch(SIGNED);
    expect(json.sales.count).toBe(28);
    expect(json.forecast.runwayDays).toBe(17);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  it("caps the lists at §3's bounds", () => {
    expect(json.spending.daily.length).toBeLessThanOrEqual(30);
    expect(json.sales.daily.length).toBeLessThanOrEqual(30);
    expect(json.sales.recent.length).toBeLessThanOrEqual(20);
    expect(json.forecast.points.length).toBeLessThanOrEqual(30);
    expect(json.insights.length).toBeLessThanOrEqual(8);
    expect(json.agentActions.length).toBeLessThanOrEqual(10);
  });

  it("keeps the 10 most recent agent actions, newest first", () => {
    const i = fourteenDays();
    const actions = range(1, 12).map((d) => ({
      at: at(d).toISOString(),
      action: "LOWER_PER_TX_CAP" as const,
      lineKey: "ADS" as const,
      newValue: String(30_000 - d * 100),
      reason: "Ads spent faster than planned.",
      txHash: null,
    }));
    const r = buildCfoReport({ ...i, agentActions: actions });
    expect(r.agentActions).toHaveLength(10);
    expect(r.agentActions[0]?.at).toBe(at(12).toISOString());
    expect(r.agentActions.at(-1)?.at).toBe(at(3).toISOString());
  });
});
