/**
 * The web SupplierApproval panel (run-9): holder, whole account number and bank each in a row of their own, and rows the
 * browser can read back to recompute payoutAccountHash and scheduleHash (apps/web lib/typed-data.ts).
 */
import { describe, expect, it } from "vitest";
import { payoutAccountHash, readWebOrderRows } from "@hogee/core";
import { lineKeyToLineId } from "../src/chain-lib";
import { webOrderRows, type WebOrderPlan } from "../src/services/signing/web-order";

const account = { channel: "MOCK_ONLY", accountNumber: "0123456789", holderName: "Yongkang Corvane Drinkware Co., Ltd." };
const plan: WebOrderPlan = {
  termsId: "terms-0199f1aa-0000-7000-8000-000000000001",
  orderId: "order-wcorvanetest2-001",
  supplierId: "supplier-wcorvanetest2",
  displayName: "Yongkang Corvane Drinkware Co., Ltd.",
  listingHost: "corvane.en.alibaba.com",
  chosenIndex: 0,
  shortlistHash: `0x${"cd".repeat(32)}`,
  schedule: [75_000n, 175_000n],
  autoRelease: [true, false],
  milestones: [
    { bps: 3000, trigger: "ON_ORDER" },
    { bps: 7000, trigger: "ON_DELIVERY_INSPECTED" },
  ],
  lineId: lineKeyToLineId("SUPPLIER"),
  account,
  payoutAccountHash: payoutAccountHash(account),
  // A bank name typed to look like a second account number stays in its own row.
  bankName: "Maybank, simulated payout account 9999 0000 1111",
  quantity: 600,
  quoteHash: `0x${"ab".repeat(32)}`,
};

describe("web order panel rows", () => {
  it("puts the holder, the whole account number and the bank in separate rows", () => {
    const rows = webOrderRows(plan);
    const value = (label: string) => rows.filter((r) => r.label === label).map((r) => r.value);
    expect(value("Account holder")).toEqual([account.holderName]);
    expect(value("Account number (simulated payout)")).toEqual(["0123 4567 89"]);
    expect(value("Bank")).toEqual([plan.bankName]);
    expect(rows.some((r) => r.label === "Pays out to")).toBe(false);
  });

  it("reads back to the account and schedule the founder signs", () => {
    expect(readWebOrderRows(webOrderRows(plan))).toEqual({
      holderName: account.holderName,
      accountNumber: account.accountNumber,
      schedule: [
        { amountMinor: 75_000n, autoRelease: true },
        { amountMinor: 175_000n, autoRelease: false },
      ],
    });
  });
});
