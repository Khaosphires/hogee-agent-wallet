/**
 * v-cfo: the mock's GET /api/cfo runs core buildCfoReport over the store (features/cfo.ts): the default demo and the
 * fresh scenario before and after a plan (no sample sales before the first supplier order), the labelled 14-day sample
 * series, and supplier cost from the escrow map.
 */
import { bpsFloor, CfoReport, type PlanRecord } from "@hogee/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { hasSupplierOrder, mockCfoReport, sampleSales, SAMPLE_DAYS } from "../src/features/cfo";
import { app } from "../src/index";
import { readEnv } from "../src/env";
import { getState, resetState } from "../src/store";
import { harness, secret } from "./support/harness";

const NOW = Date.parse("2026-10-19T09:00:00Z");

beforeAll(() => {
  process.env.DEMO_MODE = "1";
  process.env.PERSONA_COOKIE_SECRET = secret();
  process.env.OFFICER_TOKEN = secret();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetState(readEnv());
});

const h = harness(app);

describe("the sample sales series (mock only)", () => {
  it("covers the 14 days before today, rising from 1 to 4 sales a day, whole BU, no tx, labelled by id", () => {
    const s = sampleSales(NOW);
    expect(s).toHaveLength(32);
    const days = new Set(s.map((x) => x.at.toISOString().slice(0, 10)));
    expect(days.size).toBe(SAMPLE_DAYS);
    expect([...days].sort()[0]).toBe("2026-10-05");
    expect([...days].sort().at(-1)).toBe("2026-10-18");
    for (const x of s) {
      expect(x.saleId).toMatch(/^sale-sample-\d+-\d+$/);
      expect(x.amountMinor % 100n).toBe(0n);
      expect(x.txHash).toBeNull();
    }
    expect(sampleSales(NOW + 3_600_000)).toEqual(s); // same day, same history
  });
});

describe("default scenario", () => {
  it("is a schema-valid report from the store: pockets, escrow cost, sample sales and their reserve", () => {
    const st = getState(readEnv());
    const r = CfoReport.parse(mockCfoReport(st, NOW));
    const sample = sampleSales(NOW);
    const revenue = sample.reduce((a, x) => a + x.amountMinor, 0n);
    expect(r.sales.count).toBe(sample.length);
    expect(r.sales.revenueMinor).toBe(revenue.toString());
    expect(r.sales.recent.every((x) => x.txHash === null)).toBe(true);
    // The escrow map's released milestone (30,000) once; the funded-but-held milestone is escrow, not cost.
    expect(r.pnl.supplierCostMinor).toBe("30000");
    expect(r.reserve.rateBps).toBe(500);
    expect(r.reserve.skimmedMinor).toBe(sample.reduce((a, x) => a + bpsFloor(x.amountMinor, 500), 0n).toString());
    expect(r.spending.byLine.map((l) => l.lineKey)).toEqual(st.balances.pockets.map((p) => p.lineKey));
    expect(r.spending.byLine.find((l) => l.lineKey === "SUPPLIER")?.escrowedMinor).toBe(st.balances.escrowMinor);
    expect(r.sales.stageGate).toMatchObject({ stageId: "stage-2", targetMinor: "200000" });
    expect(r.agentActions).toEqual([]);
    expect(r.forecast.sampleDays).toBeGreaterThanOrEqual(3);
  });

  it("an insight that links the change requests stays schema-valid (MOVE_BUDGET on a nearly used pocket)", () => {
    const st = getState(readEnv());
    st.balances = { ...st.balances, pockets: st.balances.pockets.map((p) => (p.lineKey === "ADS" ? { ...p, available: "10000", spent: "110000" } : p)) };
    const r = CfoReport.parse(mockCfoReport(st, NOW));
    expect(r.insights.find((i) => i.kind === "MOVE_BUDGET")?.suggestion?.href).toBe("/dashboard#change-requests");
  });

  it("GET /api/cfo answers it over HTTP", async () => {
    const res = await h.call<unknown>("/api/cfo");
    expect(res.status).toBe(200);
    expect(CfoReport.safeParse(res.body).success).toBe(true);
  });

  it("a demo sale in the mock is today's sale on top of the sample", () => {
    const st = getState(readEnv());
    st.balances = { ...st.balances, revenueMinor: "12300", reserveMinor: "615" };
    const r = mockCfoReport(st, NOW);
    expect(r.sales.count).toBe(sampleSales(NOW).length + 1);
    expect(r.sales.recent[0]).toMatchObject({ saleId: "sale-mock-today", amountMinor: "12300" });
  });
});

describe("fresh scenario", () => {
  it("before a plan: no sales, no lines, zeros (nothing invented)", () => {
    vi.stubEnv("MOCK_SCENARIO", "fresh");
    const r = CfoReport.parse(mockCfoReport(getState(readEnv()), NOW));
    expect(r.sales.count).toBe(0);
    expect(r.overview).toEqual({ cashAvailableMinor: "0", spentMinor: "0", revenueMinor: "0", reserveMinor: "0", netMinor: "0" });
    expect(r.forecast.runwayDays).toBeNull();
  });

  it("a committed plan with no supplier order yet: no sample sales (nothing to sell), nothing set aside for tax", () => {
    vi.stubEnv("MOCK_SCENARIO", "fresh");
    const fresh = getState(readEnv());
    const seeded = (() => {
      vi.stubEnv("MOCK_SCENARIO", "default");
      return resetState(readEnv());
    })();
    fresh.plans = [seeded.plans.find((p) => p.status === "COMMITTED") as PlanRecord];
    expect(hasSupplierOrder(fresh)).toBe(false);
    const r = CfoReport.parse(mockCfoReport(fresh, NOW));
    expect(r.sales.count).toBe(0);
    expect(r.sales.revenueMinor).toBe("0");
    expect(r.sales.recent).toEqual([]);
    expect(r.reserve.skimmedMinor).toBe("0");
    expect(r.overview.revenueMinor).toBe("0");
    // A demo sale is a real mock sale, not the sample: it still counts before any order.
    fresh.balances = { ...fresh.balances, revenueMinor: "12300", reserveMinor: "615" };
    expect(mockCfoReport(fresh, NOW).sales.recent.map((s) => s.saleId)).toEqual(["sale-mock-today"]);
  });

  it("after the plan is committed and the deposit is released by the escrow: the sample series and the deposit as cost", () => {
    vi.stubEnv("MOCK_SCENARIO", "fresh");
    const fresh = getState(readEnv());
    const seeded = (() => {
      vi.stubEnv("MOCK_SCENARIO", "default");
      return resetState(readEnv());
    })();
    const plan: PlanRecord = seeded.plans.find((p) => p.status === "COMMITTED") as PlanRecord;
    fresh.plans = [plan];
    fresh.escrow.set("order-wabcdefghijkl-001", [
      { idx: 0, amountMinor: "75000", funded: "75000", released: true, autoRelease: true },
      { idx: 1, amountMinor: "175000", funded: "175000", released: false, autoRelease: false },
    ]);
    const r = CfoReport.parse(mockCfoReport(fresh, NOW));
    expect(r.sales.count).toBe(sampleSales(NOW).length);
    expect(r.pnl.supplierCostMinor).toBe("75000");
  });
});
