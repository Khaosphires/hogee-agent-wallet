/**
 * The web SupplierApproval rows the signing panel re-verifies (run-9): one field per row, built by the API and the mock
 * with the same functions, and read back strictly (anything not in the exact built form is refused).
 */
import { describe, expect, it } from "vitest";
import { catalogMilestoneRows, groupDigits, readCatalogScheduleRows, readWebOrderRows, webMilestoneRows, webPayoutRows, type WebOrderRow } from "../src/index";

const PAYOUT = { holderName: "Yongkang Corvane Drinkware Co., Ltd.", accountNumber: "0123456789", bankName: "Maybank" };
const SCHEDULE = [
  { trigger: "ON_ORDER", amountMinor: 75_000n, autoRelease: true },
  { trigger: "ON_DELIVERY_INSPECTED", amountMinor: 175_050n, autoRelease: false },
] as const;
const rows = (): WebOrderRow[] => [
  { label: "Order", value: "order-wcorvanetest2-001", effect: "neutral" },
  ...webPayoutRows(PAYOUT),
  ...webMilestoneRows(SCHEDULE),
  { label: "Paid from", value: "The supplier pocket, through escrow only", effect: "neutral" },
];

describe("web order rows", () => {
  it("puts the holder, the whole account number and the bank in rows of their own", () => {
    const r = webPayoutRows(PAYOUT);
    expect(r.map((x) => x.label)).toEqual(["Account holder", "Account number (simulated payout)", "Bank"]);
    expect(r.map((x) => x.value)).toEqual([PAYOUT.holderName, "0123 4567 89", "Maybank"]);
    expect(groupDigits("100200300400")).toBe("1002 0030 0400");
  });

  it("reads back exactly what was built", () => {
    expect(readWebOrderRows(rows())).toEqual({
      holderName: PAYOUT.holderName,
      accountNumber: PAYOUT.accountNumber,
      schedule: [
        { amountMinor: 75_000n, autoRelease: true },
        { amountMinor: 175_050n, autoRelease: false },
      ],
    });
    expect(webMilestoneRows(SCHEDULE).map((x) => [x.label, x.value])).toEqual([
      ["Milestone 1: Deposit on order", "750 BU, paid by the agent by itself after the cooling period"],
      ["Milestone 2: Balance after delivery check", "1,750.50 BU, paid only when you release it with inspection evidence"],
    ]);
  });

  it("refuses rows that are missing, repeated, out of order or not in the built form", () => {
    const edit = (f: (r: WebOrderRow[]) => WebOrderRow[]) => readWebOrderRows(f(rows()));
    const set = (label: string, value: string) => (r: WebOrderRow[]) => r.map((x) => (x.label === label ? { ...x, value } : x));
    expect(edit((r) => r.filter((x) => x.label !== "Account holder"))).toBeUndefined();
    expect(edit((r) => [...r, { label: "Account holder", value: "Other Co Ltd", effect: "loosen" }])).toBeUndefined();
    expect(edit((r) => r.filter((x) => !x.label.startsWith("Milestone")))).toBeUndefined();
    expect(edit((r) => r.filter((x) => x.label !== "Milestone 1: Deposit on order"))).toBeUndefined();
    expect(edit(set("Account number (simulated payout)", "0123 4567 89, also 9999 0000"))).toBeUndefined();
    expect(edit(set("Account number (simulated payout)", "01234 56789"))).toBeUndefined();
    expect(edit(set("Milestone 1: Deposit on order", "750.00 BU, paid by the agent by itself after the cooling period"))).toBeUndefined();
    expect(edit(set("Milestone 1: Deposit on order", "750 BU, paid by the agent"))).toBeUndefined();
    expect(edit(set("Milestone 1: Deposit on order", "0750 BU, paid by the agent by itself after the cooling period"))).toBeUndefined();
    expect(edit(set("Account holder", ""))).toBeUndefined();
  });
});

describe("catalog SupplierApproval milestone rows (re-check review LOW 2)", () => {
  // Rina's catalog order (api signing/supplier-approval.ts milestoneSchedule): sample, deposit, balance.
  const CATALOG = [
    { amountMinor: 30_000n, autoRelease: true },
    { amountMinor: 120_000n, autoRelease: true },
    { amountMinor: 280_000n, autoRelease: false },
  ];
  const catalogRows = (): WebOrderRow[] => [
    { label: "Order", value: "order-a-001", effect: "neutral" },
    { label: "Pays out to", value: "Example Co., MOCK_ONLY account ending 6789", effect: "loosen" },
    ...catalogMilestoneRows(CATALOG),
    { label: "Paid from", value: "The supplier pocket, through escrow only", effect: "neutral" },
  ];

  it("builds the live API's catalog wording and reads the amounts and who pays back exactly", () => {
    expect(catalogMilestoneRows(CATALOG).map((x) => [x.label, x.value])).toEqual([
      ["Milestone 1: Sample", "300 BU, paid by the agent when funded"],
      ["Milestone 2: Deposit", "1,200 BU, paid by the agent when funded"],
      ["Milestone 3: Balance", "2,800 BU, released only with your signature and inspection evidence"],
    ]);
    expect(readCatalogScheduleRows(catalogRows())).toEqual(CATALOG);
  });

  it("refuses missing, repeated, renumbered or reworded milestones, and the web wording", () => {
    const edit = (f: (r: WebOrderRow[]) => WebOrderRow[]) => readCatalogScheduleRows(f(catalogRows()));
    expect(edit((r) => r.filter((x) => !x.label.startsWith("Milestone")))).toBeUndefined();
    expect(edit((r) => r.filter((x) => x.label !== "Milestone 2: Deposit"))).toBeUndefined();
    expect(edit((r) => [...r, { label: "Milestone 3: Balance", value: "1 BU, paid by the agent when funded", effect: "neutral" }])).toBeUndefined();
    expect(edit((r) => r.map((x) => (x.label === "Milestone 3: Balance" ? { ...x, value: "2,800 BU, paid soon" } : x)))).toBeUndefined();
    expect(readCatalogScheduleRows(webMilestoneRows(SCHEDULE))).toBeUndefined();
    expect(readWebOrderRows([...webPayoutRows(PAYOUT), ...catalogMilestoneRows(CATALOG)])).toBeUndefined();
  });
});
