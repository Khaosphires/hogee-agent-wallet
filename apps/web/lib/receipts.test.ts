/**
 * Mei's receipts (ux-money, UX-PLAN D8/D18): supplier payments from the order's schedule, named Deposit / Balance with
 * "payment 1 of 2"; nothing for money only set aside for a later step; refused attempts left to the activity record.
 */
import { describe, expect, it } from "vitest";
import type { Payment } from "@hogee/core";
import { howText, paymentNames, receiptState, receiptsOf, supplierPayees, type SupplierOrderIn } from "./receipts";

const SUPPLIER = "supplier-wabcdefghijkl";
const ORDER = "order-wabcdefghijkl-001";
let n = 0;
const pay = (o: Partial<Payment>): Payment =>
  ({
    paymentId: `pay-${(n += 1)}`,
    kind: "SPEND",
    lineKey: "ADS",
    payeeId: "shopee-sg-ads",
    amountMinor: "7500",
    state: "FINALIZED",
    txHash: `0x${"a".repeat(64)}`,
    updatedAt: "2026-10-19T05:00:00.000Z",
    ...o,
  }) as Payment;

const order = (released: [boolean, boolean]): SupplierOrderIn => ({
  supplierId: SUPPLIER,
  orderId: ORDER,
  schedule: [
    { idx: 0, amountMinor: "75000", released: released[0], autoRelease: true },
    { idx: 1, amountMinor: "175000", released: released[1], autoRelease: false },
  ],
});

describe("receiptsOf", () => {
  const deposit = pay({ kind: "FUND_MILESTONE", lineKey: "SUPPLIER", payeeId: SUPPLIER, amountMinor: "75000", state: "SETTLED", updatedAt: "2026-10-19T05:33:00.000Z" });
  const heldBalance = pay({ kind: "FUND_MILESTONE", lineKey: "SUPPLIER", payeeId: SUPPLIER, amountMinor: "175000", state: "FINALIZED", updatedAt: "2026-10-19T05:34:00.000Z" });
  const release = pay({ kind: "RELEASE_MILESTONE", lineKey: "SUPPLIER", payeeId: SUPPLIER, amountMinor: "175000", state: "SETTLED", updatedAt: "2026-10-19T06:10:00.000Z" });

  it("after the automatic deposit: one Deposit receipt, and nothing for the balance set aside for later", () => {
    const r = receiptsOf([heldBalance, deposit], [order([true, false])]);
    expect(r.map((x) => [x.title, x.count, x.amountMinor, x.how, x.state, x.at])).toEqual([["Deposit", "payment 1 of 2", "75000", "auto", "paid", deposit.updatedAt]]);
    expect(r[0]?.txHash).toBe(deposit.txHash);
  });

  it("after the balance is paid with her passkey: Balance first (newest), then Deposit", () => {
    const r = receiptsOf([release, heldBalance, deposit], [order([true, true])]);
    expect(r.map((x) => [x.title, x.count, x.how])).toEqual([
      ["Balance", "payment 2 of 2", "passkey"],
      ["Deposit", "payment 1 of 2", "auto"],
    ]);
  });

  it("a paid milestone whose row hasn't loaded still shows, without a time or a receipt link", () => {
    const r = receiptsOf([], [order([true, false])]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ title: "Deposit", at: null, txHash: null, state: "paid" });
  });

  it("pocket payments read in plain words; refused or reverted attempts move no money and get no row", () => {
    const r = receiptsOf(
      [
        pay({ lineKey: "LOGISTICS" }),
        pay({ state: "POLICY_DENIED" }),
        pay({ state: "REVERTED" }),
        pay({ state: "BROADCAST" }),
        pay({ kind: "OWNER_SPEND", lineKey: "PACKAGING" }),
        pay({ kind: "WITHDRAW_RESERVE", lineKey: null, payeeId: "iras-tax" }),
        pay({ state: "SETTLEMENT_FAILED" }),
      ],
      [],
    );
    expect(r.map((x) => [x.title, x.how, x.state])).toEqual([
      ["Delivery", "auto", "paid"],
      ["Ads", "auto", "sending"],
      ["Packaging", "you", "paid"],
      ["Tax payment", "tax", "paid"],
      ["Ads", "auto", "failed"],
    ]);
  });

  it("two milestones of the same amount never share one payment row", () => {
    const even: SupplierOrderIn = {
      supplierId: SUPPLIER,
      orderId: ORDER,
      schedule: [
        { idx: 0, amountMinor: "125000", released: true, autoRelease: true },
        { idx: 1, amountMinor: "125000", released: true, autoRelease: false },
      ],
    };
    const a = pay({ kind: "FUND_MILESTONE", payeeId: SUPPLIER, amountMinor: "125000", updatedAt: "2026-10-19T05:00:00.000Z" });
    const b = pay({ kind: "FUND_MILESTONE", payeeId: SUPPLIER, amountMinor: "125000", updatedAt: "2026-10-19T05:01:00.000Z" });
    const c = pay({ kind: "RELEASE_MILESTONE", payeeId: SUPPLIER, amountMinor: "125000", updatedAt: "2026-10-19T06:00:00.000Z" });
    const r = receiptsOf([c, b, a], [even]);
    expect(r.map((x) => [x.title, x.at])).toEqual([
      ["Balance", c.updatedAt],
      ["Deposit", a.updatedAt],
    ]);
  });
});

describe("names and states", () => {
  it("names a web order's payments Deposit / Balance, three parts with a second payment, a catalog order sample first", () => {
    expect(paymentNames(ORDER, 2)).toEqual(["Deposit", "Balance"]);
    expect(paymentNames(ORDER, 3)).toEqual(["Deposit", "Second payment", "Balance"]);
    expect(paymentNames(ORDER, 4)).toEqual(["Deposit", "Payment 2", "Payment 3", "Balance"]);
    expect(paymentNames("order-catalog-1", 3)).toEqual(["Sample order", "Deposit", "Balance"]);
    expect(paymentNames(ORDER, 1)).toEqual(["Payment"]);
  });

  it("maps payment states to sending, paid, failed or no receipt", () => {
    expect(receiptState("SIGNED")).toBe("sending");
    expect(receiptState("INCLUDED")).toBe("paid");
    expect(receiptState("SETTLED")).toBe("paid");
    expect(receiptState("SETTLEMENT_FAILED")).toBe("failed");
    expect(receiptState("CANCELLED")).toBeNull();
  });

  it("says how it was paid in the tense of its state", () => {
    expect(howText({ how: "auto", state: "paid" })).toBe("Paid automatically, within your rules");
    expect(howText({ how: "passkey", state: "sending" })).toBe("Sending with your passkey");
    expect(howText({ how: "auto", state: "failed" })).toBe("Sent automatically, within your rules, but the bank transfer failed");
  });

  it("finds the supplier payees whose orders the receipts need", () => {
    expect(supplierPayees([pay({}), pay({ kind: "FUND_MILESTONE", payeeId: SUPPLIER }), pay({ kind: "RELEASE_MILESTONE", payeeId: SUPPLIER })])).toEqual([SUPPLIER]);
  });
});
