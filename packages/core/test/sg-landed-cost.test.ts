/**
 * SG landed cost (SG-DECISIONS import model) on the TEST-ONLY SG fixture pack: CN goods are MFN at the pack's sourced
 * 0% duty and pay 9% import GST on CIF + duty. EXEMPT stays the domestic route only, so an import never loses its GST.
 * Every missing fact fails closed; MY and ID are untouched (their goldens are in landed-cost.test.ts).
 */
import { describe, expect, it } from "vitest";
import { LandedCostError, computeLandedCost, dutyRouteOf, fakeHex32, landedCostFromPack, type PackLandedCostInput, type Sourced } from "../src/index";
import { TEST_PACK_MY } from "./fixtures/packs";
import { TEST_PACK_SG, TEST_PACK_SG_R } from "./fixtures/pack-sg";

const fx = (value: number): Sourced<number> => ({
  value,
  sourceUrl: "https://example.invalid/sg/fixture/fx",
  retrievedAt: "2026-10-18T02:00:00Z",
  snippetHash: fakeHex32("test:sg:fx"),
  evidence: "tier3",
  sourceType: "mock",
});

/** Supplier A style quote for Mei: CNY 12.50 FOB + CNY 1.80 freight per unit, 500 units, CNY→SGD 0.19 (fixture). */
const quote: PackLandedCostInput = {
  countryPack: TEST_PACK_SG,
  origin: "CN",
  quantity: 500,
  fobUnitMinor: "1250",
  freightPerUnitMinor: "180",
  fx: fx(0.19),
  productCategory: "drinkware_food_contact",
  fees: [{ name: "customs clearance", amountMinor: "1500" }],
};

const thrown = (f: () => unknown): LandedCostError => {
  try {
    f();
  } catch (e) {
    if (e instanceof LandedCostError) return e;
    throw e;
  }
  throw new Error("expected a LandedCostError");
};

describe("landedCostFromPack: SG imports", () => {
  it("CN tumblers: MFN at the pack's 0% duty, 9% import GST on CIF + duty (in sstMinor), half-up once", () => {
    // CIF = (625,000 + 90,000) × 1.005 × 0.19 = 136,529.25 → 136,529; duty 0; GST = 12,287.61 → 12,288.
    const out = landedCostFromPack(quote);
    expect([out.dutyRoute, out.dutyRateBps]).toEqual(["MFN", 0]);
    expect(out.landedCost).toMatchObject({ cifMinor: "136529", dutyMinor: "0", sstMinor: "12288", feesMinor: "1500", totalMinor: "150317" });
  });

  it("equals computeLandedCost with the same facts (MFN, 0 bps, CIF base, 900 bps)", () => {
    const direct = computeLandedCost({ ...quote, dutyRoute: "MFN", dutyRateBps: 0, dutyBase: "CIF", importTaxRateBps: 900 });
    expect(landedCostFromPack(quote).landedCost).toEqual(direct);
  });

  it("a caller's tariff-line rate wins over the pack's category rate", () => {
    // duty = 136,529 × 5% = 6,826.45 → 6,826; GST = 143,355 × 9% = 12,901.95 → 12,902.
    const out = landedCostFromPack({ ...quote, mfnDutyRateBps: 500 });
    expect(out.dutyRateBps).toBe(500);
    expect(out.landedCost).toMatchObject({ dutyMinor: "6826", sstMinor: "12902", totalMinor: "157757" });
  });

  it("an import is never EXEMPT: the CN route is MFN when the pack lists no Form E", () => {
    expect(dutyRouteOf("CN", TEST_PACK_SG)).toEqual({ route: "MFN" });
    expect(dutyRouteOf("SG", TEST_PACK_SG)).toEqual({ route: "EXEMPT" });
  });

  it("a domestic SG supplier is EXEMPT: no duty and no import GST", () => {
    const out = landedCostFromPack({ ...quote, origin: "SG", fx: fx(1) });
    expect(out.dutyRoute).toBe("EXEMPT");
    expect(out.landedCost).toMatchObject({ cifMinor: "718575", dutyMinor: "0", sstMinor: "0", totalMinor: "720075" });
  });
});

describe("SG landed cost fails closed on a missing fact (never 0% duty or 0% GST by default)", () => {
  it("no category and no caller rate: MFN_RATE_REQUIRED (unchanged message)", () => {
    const { productCategory: _c, ...noCategory } = quote;
    const e = thrown(() => landedCostFromPack(noCategory));
    expect([e.code, e.message]).toEqual(["MFN_RATE_REQUIRED", "no FTA route from CN; pass the MFN duty rate"]);
  });

  it("a category the pack has no MFN rate for: MFN_RATE_REQUIRED naming the leaf", () => {
    const e = thrown(() => landedCostFromPack({ ...quote, productCategory: "other" }));
    expect(e.code).toBe("MFN_RATE_REQUIRED");
    expect(e.message).toMatch(/^PACK_FACT_MISSING:imports\.mfnDutyRateBps\.other \(SG pack test-sg-2026\.10\.18; goods from CN; or pass the MFN duty rate\)/);
  });

  it("no GST rate: PACK_FACT_MISSING:indirectTax.rate", () => {
    const { rate: _r, ...thresholdOnly } = TEST_PACK_SG_R.indirectTax!;
    const e = thrown(() => landedCostFromPack({ ...quote, countryPack: { ...TEST_PACK_SG_R, indirectTax: thresholdOnly } }));
    expect(e.code).toBe("INVALID_INPUT");
    expect(e.message).toMatch(/^PACK_FACT_MISSING:indirectTax\.rate \(SG pack /);
  });

  it("no imports section: the CN route cannot be decided (PACK_FACT_MISSING:imports.ftaCertificates)", () => {
    const { imports: _i, ...noImports } = TEST_PACK_SG_R;
    expect(thrown(() => landedCostFromPack({ ...quote, countryPack: noImports })).message).toMatch(/^PACK_FACT_MISSING:imports\.ftaCertificates \(SG pack /);
  });
});

describe("the category option leaves MY unchanged", () => {
  const my = { ...quote, countryPack: TEST_PACK_MY, fx: fx(0.61) };

  it("a Form E route ignores the category", () => {
    const { productCategory: _c, ...noCategory } = my;
    expect(landedCostFromPack(my)).toEqual(landedCostFromPack(noCategory));
  });

  it("an MY MFN import still needs the caller's rate (MY packs carry no per-category MFN rate)", () => {
    const e = thrown(() => landedCostFromPack({ ...my, origin: "VN" }));
    expect(e.code).toBe("MFN_RATE_REQUIRED");
    expect(e.message).toMatch(/^PACK_FACT_MISSING:imports\.mfnDutyRateBps\.drinkware_food_contact \(MY pack /);
    expect(landedCostFromPack({ ...my, origin: "VN", mfnDutyRateBps: 500 }).dutyRateBps).toBe(500);
  });
});
