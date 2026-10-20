/**
 * walletFigures: what the founder's wallet shows (the chat rail and the CFO page's tiles) from the chain's raw numbers.
 * On chain a released escrow milestone stays in escrowedMinor and never enters a pocket's spentMinor, so the paid-out
 * part comes from one shared source (the CFO report's supplier cost). The demo order: 2,500 BU at 30/70 on a 10,000 BU
 * plan, its 750 BU deposit paid by the agent after cooling, then the 1,750 BU balance released by the founder.
 */
import { describe, expect, it } from "vitest";
import { MoneyError, walletFigures } from "../src/index";

const pockets = (supplierSpent = "0") => [
  { spent: supplierSpent, available: "250000" },
  { spent: "12000", available: "138000" },
];

describe("walletFigures", () => {
  it("after the deposit: 7,500 BU left, 2,500 committed in escrow of which 750 paid and 1,750 still held", () => {
    expect(walletFigures({ planTotalMinor: "1000000", pockets: pockets(), escrowMinor: "250000", supplierPaidMinor: "75000" })).toEqual({
      totalMinor: "1000000",
      leftMinor: "738000",
      freeMinor: "388000",
      escrowCommittedMinor: "250000",
      supplierPaidMinor: "75000",
      escrowHeldMinor: "175000",
      spentMinor: "87000",
    });
  });

  it("after the founder's release: nothing is held, the whole order counts as spent, and left does not move", () => {
    const f = walletFigures({ planTotalMinor: "1000000", pockets: pockets(), escrowMinor: "250000", supplierPaidMinor: "250000" });
    expect(f).toMatchObject({ leftMinor: "738000", escrowCommittedMinor: "250000", escrowHeldMinor: "0", spentMinor: "262000" });
  });

  it("escrow funded but nothing paid out yet: everything committed is held", () => {
    expect(walletFigures({ planTotalMinor: "1000000", pockets: pockets(), escrowMinor: "175000", supplierPaidMinor: "0" })).toMatchObject({
      leftMinor: "813000",
      escrowHeldMinor: "175000",
      spentMinor: "12000",
    });
  });

  it("while the paid-out figure is unknown, says nothing about spent or held (never a guess)", () => {
    expect(walletFigures({ planTotalMinor: "1000000", pockets: pockets(), escrowMinor: "250000", supplierPaidMinor: null })).toMatchObject({
      leftMinor: "738000",
      escrowCommittedMinor: "250000",
      supplierPaidMinor: null,
      escrowHeldMinor: null,
      spentMinor: null,
    });
  });

  it("refuses a paid-out figure above what escrow ever held (the two sources disagree): spent and held stay unknown", () => {
    expect(walletFigures({ planTotalMinor: "1000000", pockets: pockets(), escrowMinor: "75000", supplierPaidMinor: "250000" })).toMatchObject({
      supplierPaidMinor: null,
      escrowHeldMinor: null,
      spentMinor: null,
    });
  });

  it("without a plan: no total and nothing left to state, the rest as usual (the CFO page's tiles)", () => {
    expect(walletFigures({ planTotalMinor: null, pockets: pockets(), escrowMinor: "250000", supplierPaidMinor: "75000" })).toMatchObject({
      totalMinor: null,
      leftMinor: null,
      escrowHeldMinor: "175000",
      spentMinor: "87000",
    });
  });

  it("free to spend now is capped by the released stage and the funding, as the chain's CapExceeded is (CFO cash)", () => {
    // Stage 1 released 4,000 BU; 12,000 minor spent + 250,000 committed to escrow leaves 138,000 under the ceiling.
    const f = walletFigures({ planTotalMinor: "1000000", pockets: pockets(), escrowMinor: "250000", supplierPaidMinor: "75000", releasedMinor: "400000", fundedMinor: "1000000" });
    expect(f.freeMinor).toBe("138000");
    expect(f.leftMinor).toBe("738000");
  });

  it("a ceiling already passed reads zero free, never negative; a ceiling above the pockets leaves Σ available", () => {
    expect(walletFigures({ planTotalMinor: "1000000", pockets: pockets(), escrowMinor: "250000", supplierPaidMinor: "0", releasedMinor: "200000" }).freeMinor).toBe("0");
    expect(walletFigures({ planTotalMinor: "1000000", pockets: pockets(), escrowMinor: "250000", supplierPaidMinor: "0", releasedMinor: "1000000", fundedMinor: "1000000" }).freeMinor).toBe("388000");
  });

  it("never reads left below zero", () => {
    expect(walletFigures({ planTotalMinor: "100000", pockets: pockets("0"), escrowMinor: "250000", supplierPaidMinor: "0" }).leftMinor).toBe("0");
  });

  it("throws on an amount that is not a minor-unit digit string", () => {
    expect(() => walletFigures({ planTotalMinor: "10.5", pockets: [], escrowMinor: "0", supplierPaidMinor: null })).toThrow(MoneyError);
    expect(() => walletFigures({ planTotalMinor: "1000", pockets: [{ spent: "-1", available: "0" }], escrowMinor: "0", supplierPaidMinor: null })).toThrow(MoneyError);
    expect(() => walletFigures({ planTotalMinor: "1000", pockets: [], escrowMinor: "0", supplierPaidMinor: "x" })).toThrow(MoneyError);
  });
});
