/**
 * The founder's money figures (ux-money, UX-PLAN D8): Ready to spend has one source, core walletFigures over GET
 * /api/balances, the same rule as the CFO report's cashAvailable; the next budget release comes from the signed plan.
 */
import { describe, expect, it } from "vitest";
import { buildCfoReport, meiCfoInputs } from "@hogee/core";
import { nextRelease, readyToSpendOf } from "./money";

const pocket = (available: string, spent = "0") => ({ available, spent });
const balances = (over: Partial<{ released: string; funded: string; escrow: string }> = {}, pockets = [pocket("300000"), pocket("150000", "50000")]) => ({
  pockets,
  escrowMinor: over.escrow ?? "0",
  releasedMinor: over.released ?? "1000000",
  fundedMinor: over.funded ?? "1000000",
});

describe("readyToSpendOf", () => {
  it("is every pocket's available BU when nothing caps it", () => {
    expect(readyToSpendOf(balances() as never)).toBe("450000");
  });

  it("is capped by the released budget less what already left (spent and held for the supplier)", () => {
    // released 4,000 − (spent 500 + escrow 2,500) = 1,000 BU
    expect(readyToSpendOf(balances({ released: "400000", escrow: "250000" }) as never)).toBe("100000");
  });

  it("is zero before the loan officer adds money", () => {
    expect(readyToSpendOf(balances({ funded: "0" }) as never)).toBe("0");
  });

  it("matches the CFO report's cashAvailable for the same pockets (one rule, two readers)", () => {
    const inputs = meiCfoInputs(new Date("2026-10-19T06:00:00Z"));
    const report = buildCfoReport(inputs);
    const fromBalances = readyToSpendOf({
      pockets: inputs.lines.map((l) => ({ available: l.availableMinor.toString(), spent: l.spentMinor.toString() })),
      escrowMinor: "0",
      releasedMinor: (inputs.releasedMinor ?? 0n).toString(),
      fundedMinor: "1000000",
    } as never);
    expect(fromBalances).toBe(report.overview.cashAvailableMinor.toString());
  });
});

describe("nextRelease", () => {
  const stages = [
    { releaseMinor: "400000", gate: null },
    { releaseMinor: "600000", gate: { metric: "salesMinor" as const, target: "200000", deadline: "1794787200" } },
  ];

  it("names the first stage not released yet, its sales goal and deadline", () => {
    expect(nextRelease(stages, "400000")).toEqual({ releaseMinor: "600000", targetMinor: "200000", deadline: "1794787200" });
  });

  it("is null once every stage is released", () => {
    expect(nextRelease(stages, "1000000")).toBeNull();
  });

  it("is null when the next stage opens on an order count, which has no BU goal", () => {
    expect(nextRelease([stages[0]!, { releaseMinor: "600000", gate: { metric: "orders" as const, target: "30", deadline: "1794787200" } }], "400000")).toBeNull();
  });
});
