import { describe, expect, it } from "vitest";
import { CfoReport, exampleCfoReport } from "@hogee/core";
import type { Receipt } from "../../lib/receipts";
import { activityOf, aiSummary, aiTitle, automaticPayments, foldRuns, relativeTime, STATUS_TEXT, type ActivityItem } from "./wallet-activity-model";

const report = CfoReport.parse(exampleCfoReport);

const receipt = (over: Partial<Receipt>): Receipt => ({
  key: "r",
  at: "2026-10-19T08:00:00Z",
  title: "Ads",
  count: null,
  amountMinor: "7500",
  supplierId: null,
  how: "auto",
  state: "paid",
  txHash: null,
  ...over,
});

describe("activityOf", () => {
  const sales = { ...report.sales, recent: [{ saleId: "s1", amountMinor: "4200", at: "2026-10-19T06:00:00Z", txHash: null }] };
  const agentActions = [{ at: "2026-10-19T07:00:00Z", action: "LOWER_WINDOW_CAP" as const, lineKey: "ADS" as const, newValue: "52500", reason: "Ads ran fast", txHash: null }];

  it("puts payments, sales and the AI's own changes in one list, newest first, money in positive and money out negative", () => {
    const items = activityOf({
      receipts: [receipt({ key: "ads-1" }), receipt({ key: "dep", title: "Deposit", supplierId: "sup-a", amountMinor: "120000", at: "2026-10-18T08:00:00Z" })],
      names: new Map([["sup-a", "Jinhua Pellora"]]),
      report: { sales, agentActions },
    });
    expect(items.map((i) => i.kind)).toEqual(["payment", "ai", "sale", "payment"]);
    expect(items[0]).toMatchObject({ title: "Ads", amountMinor: "-7500", lineKey: "ADS", status: "auto" });
    expect(items[1]).toMatchObject({ title: "Lowered the Ads weekly limit to 525 BU", amountMinor: null, status: "ai" });
    expect(items[2]).toMatchObject({ title: "Sale", amountMinor: "4200", status: "sale", lineKey: null });
    expect(items[3]).toMatchObject({ title: "Deposit to Jinhua Pellora", amountMinor: "-120000", lineKey: "SUPPLIER" });
  });

  it("a just-paid supplier payment (no row yet) comes first; state beats who paid; tax has no pocket", () => {
    const items = activityOf({
      receipts: [
        receipt({ key: "a", at: "2026-10-19T09:00:00Z", state: "sending" }),
        receipt({ key: "b", at: null, title: "Balance", supplierId: "sup-a", how: "passkey" }),
        receipt({ key: "c", at: "2026-10-19T08:30:00Z", state: "failed" }),
        receipt({ key: "d", at: "2026-10-19T08:00:00Z", title: "Tax payment", how: "tax" }),
      ],
      names: new Map(),
      report: null,
    });
    expect(items.map((i) => i.status)).toEqual(["passkey", "sending", "failed", "tax"]);
    expect(items[0]?.title).toBe("Balance");
    expect(items[3]?.lineKey).toBeNull();
  });

  it("an empty wallet is an empty feed", () => {
    expect(activityOf({ receipts: [], names: new Map(), report: null })).toEqual([]);
    expect(activityOf({ receipts: [], names: new Map(), report: { sales: { ...report.sales, recent: [] }, agentActions: [] } })).toEqual([]);
  });

  it("says each status in plain words", () => {
    expect(STATUS_TEXT.auto).toBe("Automatic");
    expect(STATUS_TEXT.failed).toBe("Needs a look");
    expect(STATUS_TEXT.ai).toBe("Hogee's AI, by itself");
    expect(aiTitle({ action: "PAUSE", lineKey: null, newValue: "0" })).toBe("Paused all spending");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-10-19T12:00:00Z");
  it("reads like a phone: just now, minutes, hours, yesterday, days, then the day", () => {
    expect(relativeTime(null, now)).toBe("Just now");
    expect(relativeTime("2026-10-19T11:59:30Z", now)).toBe("Just now");
    expect(relativeTime("2026-10-19T11:55:00Z", now)).toBe("5 min ago");
    expect(relativeTime("2026-10-19T10:00:00Z", now)).toBe("2 h ago");
    expect(relativeTime("2026-10-18T10:00:00Z", now)).toBe("Yesterday");
    expect(relativeTime("2026-10-16T12:00:00Z", now)).toBe("3 days ago");
    expect(relativeTime("2026-10-05T12:00:00Z", now, "SGD")).toBe("5 Oct");
  });
  it("never shows a future time (a clock ahead reads 'Just now'), and says so when it can't read one", () => {
    expect(relativeTime("2026-10-20T12:00:00Z", now, "SGD")).toBe("Just now");
    expect(relativeTime("2026-10-19T12:30:00Z", now)).toBe("Just now");
    expect(relativeTime("not a time", now)).toBe("Unknown time");
  });
});

describe("foldRuns", () => {
  const item = (over: Partial<ActivityItem>): ActivityItem => ({
    key: over.key ?? "k",
    kind: "payment",
    at: "2026-10-19T08:00:00Z",
    title: "Ads",
    amountMinor: "-7500",
    lineKey: "ADS",
    status: "auto",
    txHash: null,
    supplier: false,
    ...over,
  });

  it("folds a run of the same pocket's payments into one row with the run's total, kinds still mixed by time", () => {
    const rows = foldRuns([
      item({ key: "s1", kind: "sale", title: "Sale", amountMinor: "3300", lineKey: null, status: "sale" }),
      ...[1, 2, 3, 4, 5].map((n) => item({ key: `ads-${n}` })),
      item({ key: "s2", kind: "sale", title: "Sale", amountMinor: "3100", lineKey: null, status: "sale" }),
    ]);
    expect(rows.map((r) => (r.fold ? r.title : r.item.title))).toEqual(["Sale", "Ads · 5 payments", "Sale"]);
    const ads = rows[1];
    expect(ads?.fold && ads.totalMinor).toBe("-37500");
    expect(ads?.fold && ads.items.map((i) => i.key)).toEqual(["ads-1", "ads-2", "ads-3", "ads-4", "ads-5"]);
  });

  it("folds neighbouring sales; never folds supplier payments, failed transfers, tax payments or AI changes", () => {
    const rows = foldRuns([
      item({ key: "s1", kind: "sale", title: "Sale", amountMinor: "3300", lineKey: null, status: "sale" }),
      item({ key: "s2", kind: "sale", title: "Sale", amountMinor: "3100", lineKey: null, status: "sale" }),
      item({ key: "d1", title: "Deposit to A", lineKey: "SUPPLIER", supplier: true }),
      item({ key: "d2", title: "Balance to A", lineKey: "SUPPLIER", supplier: true, status: "passkey" }),
      item({ key: "f1", status: "failed" }),
      item({ key: "f2", status: "failed" }),
      item({ key: "a1", kind: "ai", amountMinor: null, status: "ai" }),
      item({ key: "a2", kind: "ai", amountMinor: null, status: "ai" }),
    ]);
    expect(rows.map((r) => (r.fold ? `${r.title} ${r.totalMinor}` : r.item.key))).toEqual(["2 sales 6400", "d1", "d2", "f1", "f2", "a1", "a2"]);
  });

  it("a different pocket or status breaks the run; one item is never a fold", () => {
    const rows = foldRuns([item({ key: "a" }), item({ key: "b", status: "sending" }), item({ key: "c", lineKey: "PACKAGING", title: "Packaging" })]);
    expect(rows.every((r) => !r.fold)).toBe(true);
    expect(foldRuns([])).toEqual([]);
  });
});

describe("what the AI did by itself", () => {
  it("counts the payments the wallet made alone (not failed ones) and says so instead of 'changed nothing'", () => {
    const n = automaticPayments([receipt({ how: "auto" }), receipt({ how: "auto", state: "sending" }), receipt({ how: "auto", state: "failed" }), receipt({ how: "passkey" })]);
    expect(n).toBe(2);
    expect(aiSummary(n)).toBe("Hogee's AI paid only what you signed (2 automatic payments) and changed no limits.");
    expect(aiSummary(1)).toBe("Hogee's AI paid only what you signed (1 automatic payment) and changed no limits.");
    expect(aiSummary(0)).toBe("Hogee's AI hasn't paid or changed anything by itself yet. It can only make limits stricter.");
  });
});
