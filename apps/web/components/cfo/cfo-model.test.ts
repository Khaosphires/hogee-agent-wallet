import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CFO_VIEWS, CfoReport, exampleCfoReport, type CfoAgentAction } from "@hogee/core";
import { sectionsFor } from "../../lib/sections";
import { agentActionText, bridgeRows, cardTitle, CFO_TABS, cfoHref, dataLabel, insightsFor, isSample, landingSection, pctText, pocketLine, profitLabel, salesFigure, SAMPLE_SENTENCE, sectionNotes, SECTION_OF_VIEW, signedBu, spendSplit, tabOf, taxCells, tilesFor, wholeMinor } from "./cfo-model";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const { checkText } = (await import(join(ROOT, "scripts/lint-wording/index.mjs"))) as { checkText: (text: string) => readonly unknown[] };

const report = CfoReport.parse(exampleCfoReport);

describe("tabs", () => {
  it("one tab per CFO view, in order, in plain words; ?tab= selects a known view, anything else the overview", () => {
    expect(CFO_TABS.map((t) => t.view)).toEqual([...CFO_VIEWS]);
    expect(CFO_TABS.map((t) => t.label)).toEqual(["Overview", "Spending", "Sales", "Profit", "Forecast", "Tax money"]);
    expect(tabOf("pnl")).toBe("pnl");
    expect(tabOf("PNL")).toBe("overview");
    expect(tabOf("constructor")).toBe("overview");
    expect(tabOf(null)).toBe("overview");
    expect(cfoHref("reserve")).toBe("/dashboard?tab=reserve");
  });

  it("every view has a section of the Wallet page, in the page's own order; an old ?tab= link lands on it", () => {
    const ids = sectionsFor("/dashboard").map((s) => s.id);
    const mapped = CFO_VIEWS.map((v) => SECTION_OF_VIEW[v]);
    for (const id of mapped) expect(ids).toContain(id);
    expect(mapped).toEqual([...mapped].sort((a, b) => ids.indexOf(a) - ids.indexOf(b)));
    expect(landingSection("pnl")).toBe("wallet-profit");
    expect(landingSection("reserve")).toBe("wallet-tax");
    expect(landingSection("forecast")).toBe("wallet-forecast");
    // The overview is the top of the page; nothing (or anything unknown) opens there too.
    expect(landingSection("overview")).toBeNull();
    expect(landingSection("bogus")).toBeNull();
    expect(landingSection(null)).toBeNull();
  });
});

describe("signed BU and percentages", () => {
  it("uses a true minus and keeps the unit", () => {
    expect(signedBu("-120000")).toBe("−1,200 BU");
    expect(signedBu("120050")).toBe("1,200.50 BU");
    expect(signedBu("0")).toBe("0 BU");
  });
  it("one decimal, null without a base", () => {
    expect(pctText(1n, 3n)).toBe("33.3%");
    expect(pctText(-1n, 4n)).toBe("−25.0%");
    expect(pctText(5n, 0n)).toBeNull();
  });
});

describe("the P&L bridge", () => {
  const pnl = { ...report.pnl, revenueMinor: "100000", supplierCostMinor: "30000", operatingByLine: [{ lineKey: "ADS" as const, amountMinor: "20000" }, { lineKey: "LOGISTICS" as const, amountMinor: "0" }], operatingMinor: "20000", netMinor: "50000" };

  it("runs from sales through each non-zero cost to net, costs negative", () => {
    const rows = bridgeRows(pnl);
    expect(rows.map((r) => [r.key, r.amountMinor, r.kind])).toEqual([
      ["SALES", "100000", "total"],
      ["SUPPLIER_COST", "-30000", "cost"],
      ["ADS", "-20000", "cost"],
      ["NET", "50000", "net"],
    ]);
    expect(rows.map((r) => r.label)).toEqual(["Sales", "Paid to the supplier", "Ads", "Profit"]);
    expect(rows.map((r) => [r.left, r.width])).toEqual([
      [0, 100],
      [70, 30],
      [50, 20],
      [0, 50],
    ]);
    expect(rows.map((r) => r.pctOfSales)).toEqual(["100.0%", "−30.0%", "−20.0%", "50.0%"]);
  });

  it("a loss puts zero inside the track and net left of it, named Loss, never drawn or counted as a profit", () => {
    const rows = bridgeRows({ ...pnl, revenueMinor: "20000", netMinor: "-30000" });
    const net = rows.at(-1);
    expect(net?.amountMinor).toBe("-30000");
    expect(net?.label).toBe("Loss");
    expect(net?.loss).toBe(true);
    expect(rows.filter((r) => r.loss)).toHaveLength(1);
    // Costs above sales: no "−150% of sales".
    expect(rows.every((r) => r.pctOfSales === null)).toBe(true);
    expect(profitLabel({ netMinor: "-30000" })).toBe("Loss so far");
    expect(profitLabel({ netMinor: "0" })).toBe("Profit so far");
    expect(net && net.left + net.width).toBeCloseTo(60, 5); // zero sits at 30 / 50 of the span
    for (const r of rows) expect(r.left >= 0 && r.left + r.width <= 100.0001).toBe(true);
  });

  it("no records: one empty bar each, no % of sales", () => {
    const rows = bridgeRows({ ...pnl, revenueMinor: "0", supplierCostMinor: "0", operatingByLine: [], operatingMinor: "0", netMinor: "0" });
    expect(rows.map((r) => r.key)).toEqual(["SALES", "NET"]);
    expect(rows.every((r) => r.width === 0 && r.pctOfSales === null)).toBe(true);
  });
});

describe("the Wallet's one page", () => {
  it("splits Paid out by where it went, largest first, and the parts add up to it", () => {
    const parts = spendSplit({ supplierCostMinor: "30000", operatingByLine: [{ lineKey: "ADS", amountMinor: "22500" }, { lineKey: "LOGISTICS", amountMinor: "0" }, { lineKey: "PACKAGING", amountMinor: "45000" }] });
    expect(parts.map((p) => [p.label, p.lineKey, p.amountMinor])).toEqual([
      ["Packaging", "PACKAGING", "45000"],
      ["Supplier", "SUPPLIER", "30000"],
      ["Ads", "ADS", "22500"],
    ]);
    expect(parts.reduce((a, p) => a + BigInt(p.amountMinor), 0n)).toBe(97500n);
    expect(parts[0]?.pct).toBeCloseTo(46.15, 2);
    expect(spendSplit({ supplierCostMinor: "0", operatingByLine: [] })).toEqual([]);
  });

  it("draws the tax share as cells of 100", () => {
    expect(taxCells(500)).toEqual({ full: 5, part: 0 });
    expect(taxCells(750)).toEqual({ full: 7, part: 0.5 });
    expect(taxCells(0)).toEqual({ full: 0, part: 0 });
    expect(taxCells(20_000)).toEqual({ full: 100, part: 0 });
  });

  it("never says a note twice: a section leaves out what the Overview already shows", () => {
    const warn = { ...report.insights[0]!, insightId: "w1", kind: "BURN_ALERT" as const, severity: "warn" as const };
    const info = { ...report.insights[0]!, insightId: "i1", kind: "MOVE_BUDGET" as const, severity: "info" as const };
    const extra = { ...report.insights[0]!, insightId: "i2", kind: "BURN_ALERT" as const, severity: "info" as const };
    const r = { ...report, insights: [info, warn, extra] };
    expect(insightsFor(r, "overview", 2).map((i) => i.insightId)).toEqual(["w1", "i1"]);
    expect(sectionNotes(r, "spending").map((i) => i.insightId)).toEqual(["i2"]);
    expect(sectionNotes(r, "reserve")).toEqual([]);
  });
});

describe("agent actions", () => {
  const act = (o: Partial<CfoAgentAction>): CfoAgentAction => ({ at: "2026-10-19T00:00:00Z", action: "LOWER_WINDOW_CAP", lineKey: "ADS", newValue: "52500", reason: "r", txHash: null, ...o });
  it("say what Hogee's AI changed, in BU or %, in plain words", () => {
    expect(agentActionText(act({}))).toBe("Hogee's AI lowered the Ads weekly limit to 525 BU");
    expect(agentActionText(act({ action: "LOWER_PER_TX_CAP", lineKey: "PLATFORM_FEES", newValue: "10000" }))).toBe("Hogee's AI lowered the Marketplace fees per-payment limit to 100 BU");
    expect(agentActionText(act({ action: "RAISE_RESERVE_BPS", lineKey: null, newValue: "600" }))).toBe("Hogee's AI raised the share kept for tax to 6.0% of each sale");
    expect(agentActionText(act({ action: "REVOKE_AGENT", lineKey: null, newValue: "0" }))).toBe("Hogee's AI switched off its own paying key");
  });
});

describe("the chat card's slice", () => {
  it("four overview tiles: Ready to spend from the wallet, the rest from the report (the e2e reads them by key)", () => {
    expect(tilesFor(report, "overview", "212500").map((t) => [t.key, t.label, t.value])).toEqual([
      ["cash", "Ready to spend", "212500"],
      ["spent", "Paid out", report.overview.spentMinor],
      ["revenue", "Sales", report.overview.revenueMinor],
      ["reserve", "Kept for tax", report.overview.reserveMinor],
    ]);
    // Until the wallet loads, Ready to spend has no value rather than the report's copy of it.
    expect(tilesFor(report, "overview")[0]?.value).toBeNull();
  });

  it("the overview card leads with Ready to spend, not a repeat of its first note", () => {
    expect(cardTitle(report, "overview", "150000")).toBe("You can spend 1,500 BU now");
    expect(cardTitle({ ...report, pnl: { ...report.pnl, netMinor: "-114400" } }, "pnl")).toBe("Loss so far: −1,144 BU");
  });

  it("marks the figures built on sales as sample, and never the money that really moved", () => {
    const sample = (view: (typeof CFO_VIEWS)[number]) => tilesFor(report, view, "0").filter((t) => t.sample).map((t) => t.key);
    expect(sample("overview")).toEqual(["revenue", "reserve"]);
    expect(sample("spending")).toEqual([]);
    expect(sample("pnl")).toEqual(["revenue", "net"]);
  });

  it("states per-day averages in whole BU", () => {
    expect(wholeMinor("12214")).toBe("12200");
    expect(wholeMinor("12250")).toBe("12300");
    expect(wholeMinor("-12214")).toBe("-12200");
    expect(wholeMinor("49")).toBe("0");
  });

  it("at most 2 insights, warnings first, only those that fit the view", () => {
    for (const view of CFO_VIEWS) expect(insightsFor(report, view).length).toBeLessThanOrEqual(2);
    const warnFirst = insightsFor(report, "overview", 8);
    const firstInfo = warnFirst.findIndex((i) => i.severity !== "warn");
    expect(firstInfo === -1 || warnFirst.slice(firstInfo).every((i) => i.severity !== "warn")).toBe(true);
    expect(insightsFor(report, "reserve").every((i) => i.kind === "RESERVE_STATUS")).toBe(true);
  });

  it("every title and label passes the wording lint", () => {
    for (const view of CFO_VIEWS) {
      expect(checkText(cardTitle(report, view)), view).toEqual([]);
      expect(checkText(cardTitle(report, view, "100000")), view).toEqual([]);
      for (const t of tilesFor(report, view)) expect(checkText(t.label), t.key).toEqual([]);
    }
    expect(checkText(SAMPLE_SENTENCE)).toEqual([]);
    for (const t of CFO_TABS) expect(checkText(t.label)).toEqual([]);
    expect(checkText(agentActionText({ action: "RAISE_RESERVE_BPS", lineKey: null, newValue: "600" }))).toEqual([]);
  });
});

describe("the data label", () => {
  it("names sample data in mock and replay mode and a local chain's time-shifted history; nothing on a public chain", () => {
    expect(dataLabel({ mode: "mock", chainId: 31337 })).toBe("Sample data");
    // REPLAY serves the mock's sample sales series too (api-mock features/cfo.ts), on the fixtures' Sepolia session.
    expect(dataLabel({ mode: "replay", chainId: 11_155_111 })).toBe("Sample data");
    expect(dataLabel({ mode: "replay", chainId: 31337 })).toBe("Sample data");
    expect(dataLabel({ mode: "live", chainId: 31337 })).toBe("Test blockchain: some sales are demo history");
    expect(isSample({ mode: "mock", chainId: 31337 })).toBe(true);
    expect(isSample({ mode: "live", chainId: 11_155_111 })).toBe(false);
    expect(dataLabel({ mode: "live", chainId: 11_155_111 })).toBeNull();
    expect(dataLabel(undefined)).toBeNull();
  });
});

describe("one rule for sales (Wallet, Plan, the loan officer's page)", () => {
  it("is every recorded sale: the same figure as the overview and the release goal's 'so far'", () => {
    const gate = { stageId: "stage-2", targetMinor: "200000", soFarMinor: "187200", deadline: "2026-11-15", projectedDate: "2026-10-21" };
    const r = { ...report, sales: { ...report.sales, revenueMinor: "187200", count: 62, stageGate: gate } };
    const f = salesFigure(r);
    expect(f).toEqual({ soFarMinor: "187200", count: 62, targetMinor: "200000", deadline: "2026-11-15", projectedDate: "2026-10-21", pct: 93.6 });
    expect(f.soFarMinor).toBe(gate.soFarMinor);
  });
  it("no goal: no target, 0 %; past the goal: 100 %", () => {
    expect(salesFigure({ sales: { ...report.sales, revenueMinor: "500", count: 1, stageGate: null } })).toMatchObject({ targetMinor: null, deadline: null, pct: 0 });
    const over = { stageId: "s", targetMinor: "100", soFarMinor: "250", deadline: "2026-11-15", projectedDate: null };
    expect(salesFigure({ sales: { ...report.sales, revenueMinor: "250", stageGate: over } }).pct).toBe(100);
  });
});

describe("one pocket line", () => {
  const pocket = (over: Partial<{ lineKey: string; allocated: string; spent: string; available: string }>) => ({ lineKey: "ADS", allocated: "120000", spent: "60000", available: "60000", ...over });
  it("a running-cost pocket: paid is its own spent, nothing set aside, left is available", () => {
    expect(pocketLine(pocket({}), { escrowMinor: "220000", supplierPaidMinor: "150000" })).toEqual({ allocatedMinor: "120000", leftMinor: "60000", paidMinor: "60000", setAsideMinor: "0" });
  });
  it("the supplier: paid from the report, set aside = what the held box still holds (750 paid · 1,750 set aside · 2,500 left of 5,000)", () => {
    const supplier = pocket({ lineKey: "SUPPLIER", allocated: "500000", spent: "0", available: "250000" });
    expect(pocketLine(supplier, { escrowMinor: "250000", supplierPaidMinor: "75000" })).toEqual({ allocatedMinor: "500000", leftMinor: "250000", paidMinor: "75000", setAsideMinor: "175000" });
    // After the balance: everything held was paid out.
    expect(pocketLine(supplier, { escrowMinor: "250000", supplierPaidMinor: "250000" })).toMatchObject({ paidMinor: "250000", setAsideMinor: "0" });
  });
  it("while the sources disagree or the report isn't in, the supplier's split is not guessed", () => {
    const supplier = pocket({ lineKey: "SUPPLIER", allocated: "500000", spent: "0", available: "250000" });
    expect(pocketLine(supplier, { escrowMinor: "250000", supplierPaidMinor: null })).toMatchObject({ paidMinor: null, setAsideMinor: null, leftMinor: "250000" });
    expect(pocketLine(supplier, { escrowMinor: "50000", supplierPaidMinor: "75000" })).toMatchObject({ paidMinor: null, setAsideMinor: null });
  });
});
