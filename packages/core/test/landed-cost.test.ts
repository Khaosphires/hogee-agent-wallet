import { describe, expect, it } from "vitest";
import {
  LandedCost,
  LandedCostError,
  computeLandedCost,
  dutyRouteOf,
  fakeHex32,
  landedCostFromPack,
  resolveDutyRoute,
  type LandedCostInput,
  type Sourced,
} from "../src/index";
import { TEST_PACK_ID, TEST_PACK_MY, TEST_PACK_MY_MINIMAL } from "./fixtures/packs";

const fx = (value: number): Sourced<number> => ({
  value,
  sourceUrl: "https://example.invalid/bnm/fx",
  retrievedAt: "2026-10-16T02:00:00Z",
  snippetHash: fakeHex32("test:bnm:fx"),
  evidence: "tier1",
  sourceType: "mock",
});

/** Supplier A style quote: CNY 12.50 FOB + CNY 1.80 freight per unit, 100 units, CNY→MYR 0.61. */
const base: LandedCostInput = {
  quantity: 100,
  fobUnitMinor: "1250",
  freightPerUnitMinor: "180",
  fx: fx(0.61),
  dutyRoute: "FORM_E",
  dutyRateBps: 0,
  dutyBase: "CIF",
  importTaxRateBps: 1000,
  fees: [{ name: "customs clearance", amountMinor: "1500" }],
};

describe("computeLandedCost (§11)", () => {
  it("Form E, 10% import sales tax on CIF + duty, half-up at the final minor unit", () => {
    // CIF = (125,000 + 18,000) × 1.005 × 0.61 = 87,666.15 → 87,666; SST = 8,766.6 → 8,767.
    const lc = computeLandedCost(base);
    expect(lc).toMatchObject({ cifMinor: "87666", dutyMinor: "0", sstMinor: "8767", feesMinor: "1500", totalMinor: "97933" });
    expect(LandedCost.parse(lc)).toEqual(lc);
    expect(lc.fx).toEqual(base.fx);
  });

  it("MFN duty on the CIF base; tax on CIF + duty", () => {
    // duty = 87,666 × 5% = 4,383.3 → 4,383; SST = (87,666 + 4,383) × 10% = 9,204.9 → 9,205.
    const lc = computeLandedCost({ ...base, dutyRoute: "MFN", dutyRateBps: 500, fees: [] });
    expect(lc).toMatchObject({ cifMinor: "87666", dutyMinor: "4383", sstMinor: "9205", feesMinor: "0", totalMinor: "101254" });
  });

  it("FOB tax base: duty on FOB × fx (rounded once), tax still on CIF + duty", () => {
    // dutyBase = 125,000 × 0.61 = 76,250; duty = 3,812.5 → 3,813 (half up); SST = 9,147.9 → 9,148.
    const lc = computeLandedCost({ ...base, dutyRoute: "MFN", dutyRateBps: 500, dutyBase: "FOB", fees: [] });
    expect(lc).toMatchObject({ dutyMinor: "3813", sstMinor: "9148", totalMinor: "100627" });
  });

  it("rounds exactly half a minor unit up", () => {
    const tiny = { ...base, quantity: 1, fobUnitMinor: "1", freightPerUnitMinor: "0", insuranceBps: 0, fx: fx(0.5), fees: [] };
    expect(computeLandedCost(tiny).cifMinor).toBe("1");
    expect(computeLandedCost({ ...tiny, quantity: 3 }).cifMinor).toBe("2");
    expect(computeLandedCost({ ...tiny, fx: fx(0.49) }).cifMinor).toBe("0");
  });

  it("domestic (EXEMPT) purchases carry no duty and no import tax", () => {
    const lc = computeLandedCost({ ...base, dutyRoute: "EXEMPT", dutyRateBps: 900, fx: fx(1) });
    expect(lc).toMatchObject({ dutyMinor: "0", sstMinor: "0" });
  });

  it("components always add up to the total and stay digit strings for huge orders", () => {
    const lc = computeLandedCost({ ...base, quantity: 10n ** 12n, dutyRoute: "MFN", dutyRateBps: 1234 });
    const sum = BigInt(lc.cifMinor) + BigInt(lc.dutyMinor) + BigInt(lc.sstMinor) + BigInt(lc.feesMinor);
    expect(BigInt(lc.totalMinor)).toBe(sum);
    expect(lc.totalMinor).toMatch(/^[1-9][0-9]*$/);
  });

  it.each([
    ["zero quantity", { quantity: 0 }],
    ["fractional quantity", { quantity: 1.5 }],
    ["decimal price", { fobUnitMinor: "12.50" }],
    ["fractional duty rate", { dutyRoute: "MFN" as const, dutyRateBps: 2.5 }],
    ["tax rate above 100%", { importTaxRateBps: 10_001 }],
    ["non-positive fx", { fx: fx(0) }],
  ])("rejects %s", (_name, patch) => {
    expect(() => computeLandedCost({ ...base, ...patch } as LandedCostInput)).toThrow();
  });
});

describe("duty route from the country pack (LABELING §3.5)", () => {
  it.each([
    ["MY", TEST_PACK_MY, "MY", "EXEMPT"],
    ["CN", TEST_PACK_MY, "CN", "FORM_E"],
    ["VN (ASEAN: ATIGA not modelled)", TEST_PACK_MY, "VN", "MFN"],
    ["US", TEST_PACK_ID, "US", "MFN"],
    ["US, pack without an imports section (no FTA route to decide)", TEST_PACK_MY_MINIMAL, "US", "MFN"],
    ["MY, pack without an imports section", TEST_PACK_MY_MINIMAL, "MY", "EXEMPT"],
  ] as const)("%s", (_name, pack, origin, route) => {
    expect(resolveDutyRoute(origin, pack)).toBe(route);
  });

  it("CN with no imports section is not assumed to be Form E: it fails closed naming imports.ftaCertificates", () => {
    expect(dutyRouteOf("CN", TEST_PACK_MY_MINIMAL)).toEqual({ missing: "imports.ftaCertificates" });
    expect(() => resolveDutyRoute("CN", TEST_PACK_MY_MINIMAL)).toThrow(expect.objectContaining({ name: "LandedCostError", code: "INVALID_INPUT" }));
    expect(() => resolveDutyRoute("CN", TEST_PACK_MY_MINIMAL)).toThrow(/^PACK_FACT_MISSING:imports\.ftaCertificates \(MY pack test-minimal; goods from CN\)/);
  });

  it("CN is MFN when the pack lists FTA certificates but no CN Form E", () => {
    const pack = { ...TEST_PACK_MY, imports: { ...TEST_PACK_MY.imports!, ftaCertificates: [] } };
    expect(resolveDutyRoute("CN", pack)).toBe("MFN");
  });

  it("landedCostFromPack takes route, rate, base and tax from the pack", () => {
    const q = { countryPack: TEST_PACK_MY, origin: "CN", quantity: 100, fobUnitMinor: "1250", freightPerUnitMinor: "180", fx: fx(0.61) };
    const out = landedCostFromPack({ ...q, fees: [{ name: "customs clearance", amountMinor: "1500" }] });
    expect(out.dutyRoute).toBe("FORM_E");
    expect(out.landedCost).toEqual(computeLandedCost(base));
    expect(() => landedCostFromPack({ ...q, origin: "VN" })).toThrow(LandedCostError);
    expect(landedCostFromPack({ ...q, origin: "VN", mfnDutyRateBps: 500 }).landedCost.dutyMinor).toBe("4383");
  });
});

describe("landedCostFromPack fails closed on a missing pack fact (never 0% tax or a CIF base by default)", () => {
  const q = { origin: "CN", quantity: 100, fobUnitMinor: "1250", freightPerUnitMinor: "180", fx: fx(0.61) };
  const { rate: _rate, ...thresholdOnly } = TEST_PACK_MY.indirectTax!;
  const noRate = { ...TEST_PACK_MY, indirectTax: thresholdOnly };
  const { imports: _imports, ...noImports } = TEST_PACK_MY;

  it.each([
    ["no import tax rate, Form E", noRate, "CN", {}, /^PACK_FACT_MISSING:indirectTax\.rate \(/],
    ["no import tax rate, MFN", noRate, "VN", { mfnDutyRateBps: 500 }, /^PACK_FACT_MISSING:indirectTax\.rate \(/],
    ["no imports section, CN (route undecided)", noImports, "CN", {}, /^PACK_FACT_MISSING:imports\.ftaCertificates \(/],
    ["no imports section, MFN (no duty base)", noImports, "VN", { mfnDutyRateBps: 500 }, /^PACK_FACT_MISSING:imports\.taxBase \(/],
    ["minimal pack, MFN: both leaves at once", TEST_PACK_MY_MINIMAL, "VN", { mfnDutyRateBps: 500 }, /^PACK_FACT_MISSING:imports\.taxBase,indirectTax\.rate \(/],
  ] as const)("%s", (_name, pack, origin, extra, message) => {
    const run = () => landedCostFromPack({ ...q, ...extra, countryPack: pack, origin });
    expect(run).toThrow(expect.objectContaining({ name: "LandedCostError", code: "INVALID_INPUT" }));
    expect(run).toThrow(message);
  });

  it("a domestic purchase needs no import facts (duty and import tax are 0 by law, not by default)", () => {
    const out = landedCostFromPack({ ...q, origin: "MY", countryPack: TEST_PACK_MY_MINIMAL, fx: fx(1) });
    expect(out.dutyRoute).toBe("EXEMPT");
    expect(out.landedCost).toMatchObject({ dutyMinor: "0", sstMinor: "0" });
    expect(out.landedCost).toEqual(landedCostFromPack({ ...q, origin: "MY", countryPack: TEST_PACK_MY, fx: fx(1) }).landedCost);
  });
});
