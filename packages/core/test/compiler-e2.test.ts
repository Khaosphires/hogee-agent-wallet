/** The compiler produces exactly what evals/datasets/e2/LABELING.md describes; deriveE2Fields reads it back. */
import { describe, expect, it } from "vitest";
import {
  E2DeriveError,
  E2LabelRow,
  PackFactMissingError,
  compilePlan,
  deriveE2Fields,
  examplePlanIntent,
  scoreE2Fields,
  type CompileInput,
  type E2Fields,
  type PlanIntent,
} from "../src/index";
import { TEST_PACK_ID, TEST_PACK_MY_MINIMAL } from "./fixtures/packs";
import { RINA_COMPILE_FACILITY, RINA_COMPILE_INPUT } from "./fixtures/rina-compile";

const my = (patch: Partial<PlanIntent>): CompileInput => ({ ...RINA_COMPILE_INPUT, intent: { ...examplePlanIntent, ...patch } as PlanIntent });

const ID_INPUT: CompileInput = {
  ...RINA_COMPILE_INPUT,
  countryPack: TEST_PACK_ID,
  facility: { ...RINA_COMPILE_FACILITY, countryCode: "ID", currency: "IDR", capMinor: "1500000000", reserveFloorBps: 50, payees: [] },
  intent: { ...examplePlanIntent, countryCode: "ID", entityType: "perorangan", budgetCeilingMinor: "1500000000", sellChannel: "tiktok_shop" },
};
const id = (patch: Partial<PlanIntent>): CompileInput => ({ ...ID_INPUT, intent: { ...ID_INPUT.intent, ...patch } as PlanIntent });

const fields = (input: CompileInput): E2Fields => deriveE2Fields(compilePlan(input));

describe("E2 fields (LABELING.md §3)", () => {
  it("Rina: MY citizen, sole proprietorship, drinkware from CN", () => {
    expect(fields(RINA_COMPILE_INPUT)).toEqual({
      entityType: "sole_prop",
      registrations: ["LHDN_TIN", "SSM_SOLE_PROP"],
      indirectTaxRegistered: false,
      eInvoicing: false,
      dutyRoute: "FORM_E",
      productApproval: "NONE",
      reserveBps: 500,
      licenceCostMinor: "6000",
    });
  });

  it("MY foreigner: the drafted sole proprietorship is replaced by Sdn Bhd (§3.1) and the override is a rule", () => {
    const d = compilePlan(my({ residency: "foreigner", entityType: "sole_prop" }));
    expect(deriveE2Fields(d)).toMatchObject({ entityType: "sdn_bhd", registrations: ["LHDN_TIN", "SSM_SDN_BHD"], licenceCostMinor: "106000" });
    expect(d.manifest.rules.map((r) => r.ruleId)).toContain("entity.override");
    expect(d.intent.entityType).toBe("sole_prop"); // the LLM's intent is kept as drafted, for audit
  });

  it("MY partnership keeps SSM_SOLE_PROP (§3.2)", () => {
    expect(fields(my({ entityType: "partnership" }))).toMatchObject({ entityType: "partnership", registrations: ["LHDN_TIN", "SSM_SOLE_PROP"] });
  });

  it("MY cosmetics: NPRA fee joins the licence cost and gets a LICENSING line carved from contingency", () => {
    const d = compilePlan(my({ productCategory: "cosmetics" }));
    expect(deriveE2Fields(d)).toMatchObject({ productApproval: "NPRA", licenceCostMinor: "11000" });
    const amounts = Object.fromEntries(d.manifest.lines.map((l) => [l.lineKey, l.amountMinor]));
    expect(amounts).toMatchObject({ LICENSING: "5000", CONTINGENCY: "95000" });
    expect(d.manifest.lines.map((l) => l.lineKey)).toEqual(["SUPPLIER", "PACKAGING", "LOGISTICS", "ADS", "PLATFORM_FEES", "LICENSING", "CONTINGENCY"]);
  });

  it.each([
    ["domestic supplier", "MY", "EXEMPT"],
    ["China (ACFTA)", "CN", "FORM_E"],
    ["ASEAN (ATIGA not in the enum: [DECIDE] → MFN)", "TH", "MFN"],
    ["anywhere else", "US", "MFN"],
  ])("dutyRoute: %s", (_name, buyFrom, route) => {
    expect(fields(my({ buyFrom })).dutyRoute).toBe(route);
  });

  it("ID citizen perorangan: NIB + NPWP (NIK), 0.5% reserve (§3.7)", () => {
    expect(fields(ID_INPUT)).toEqual({
      entityType: "perorangan",
      registrations: ["NIB_OSS", "NPWP_NIK"],
      indirectTaxRegistered: false,
      eInvoicing: false,
      dutyRoute: "FORM_E",
      productApproval: "NONE",
      reserveBps: 50,
      licenceCostMinor: "0",
    });
  });

  it("ID CV keeps the intent's entity and the 5% reserve ([DECIDE] proposal)", () => {
    expect(fields(id({ entityType: "cv" }))).toMatchObject({ entityType: "cv", reserveBps: 500 });
  });

  it("ID foreigner: perorangan → PT (pack has no entity table: LABELING fallback); no NPWP_NIK for non-citizens", () => {
    expect(fields(id({ residency: "foreigner" }))).toMatchObject({ entityType: "pt", registrations: ["NIB_OSS"], reserveBps: 500 });
  });

  it("ID cosmetics → BPOM (fee 0: no LICENSING line); ID food → BPJPH_HALAL", () => {
    const d = compilePlan(id({ productCategory: "cosmetics" }));
    expect(deriveE2Fields(d).productApproval).toBe("BPOM");
    expect(d.manifest.lines.some((l) => l.lineKey === "LICENSING")).toBe(false);
    expect(fields(id({ productCategory: "food" })).productApproval).toBe("BPJPH_HALAL");
  });

  it("a minimal pack has no fallback: the compile fails closed and names every leaf the intent needs", () => {
    const leaves = [
      "registrations.SSM_SOLE_PROP.cost",
      "registrations.LHDN_TIN.cost",
      "indirectTax.registrationThreshold",
      "eInvoicing.threshold",
      "imports.ftaCertificates",
      "indirectTax.rate",
      "productApprovals.food",
    ];
    const run = () => compilePlan({ ...RINA_COMPILE_INPUT, countryPack: TEST_PACK_MY_MINIMAL, intent: { ...examplePlanIntent, productCategory: "food" } });
    expect(run).toThrow(expect.objectContaining({ code: "COMPILE_FAILED", violations: [], leaves }));
    expect(run).toThrow(PackFactMissingError);
    expect(run).toThrow(new RegExp(`^PACK_FACT_MISSING:${leaves.join(",").replace(/[.[\]]/g, "\\$&")} \\(MY pack test-minimal; `));
  });

  it("ID: with no e-invoicing threshold, e-Faktur follows PKP and cites the PKP threshold (LABELING §3.4)", () => {
    const rule = compilePlan(ID_INPUT).manifest.rules.find((r) => r.ruleId === "einvoicing.not-required");
    expect(rule?.sourceRef).toBe("/indirectTax/registrationThreshold");
  });

  it("every pack-sourced rule carries the leaf's provenance", () => {
    const d = compilePlan(RINA_COMPILE_INPUT);
    for (const r of d.manifest.rules.filter((x) => x.sourceRef.startsWith("/"))) expect(r.source?.sourceType).toBe("mock");
  });
});

describe("deriveE2Fields / scoreE2Fields", () => {
  it("output is a valid E2 label row", () => {
    expect(E2LabelRow.safeParse({ promptId: "e2-my-001", fields: fields(RINA_COMPILE_INPUT) }).success).toBe(true);
  });

  it("refuses a draft without the compliance rules", () => {
    const d = compilePlan(RINA_COMPILE_INPUT);
    const stripped = { ...d, manifest: { ...d.manifest, rules: d.manifest.rules.filter((r) => !r.ruleId.startsWith("duty.")) } };
    expect(() => deriveE2Fields(stripped)).toThrow(E2DeriveError);
  });

  it("scores registrations as a set and everything else exactly", () => {
    const derived = fields(RINA_COMPILE_INPUT);
    const label: E2Fields = { ...derived, registrations: ["SSM_SOLE_PROP", "LHDN_TIN"], licenceCostMinor: "3000" };
    const score = Object.fromEntries(scoreE2Fields(derived, label).map((s) => [s.field, s.correct]));
    expect(score).toMatchObject({ registrations: true, licenceCostMinor: false, entityType: true });
    expect(scoreE2Fields(derived, { ...label, registrations: ["SSM_SOLE_PROP"] }).find((s) => s.field === "registrations")?.correct).toBe(false);
  });
});
