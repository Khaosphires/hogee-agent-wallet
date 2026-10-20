/**
 * SG compile (SG-DECISIONS) against the TEST-ONLY SG fixture pack (fixtures/pack-sg.ts; every fact is a labelled mock).
 * Mei compiles to Rina's numbers; the SG rules come from the pack; e-invoicing follows GST registration (no eInvoicing
 * section needed, and only because SG has no turnover-based rule); every missing SG fact fails closed.
 */
import { describe, expect, it } from "vitest";
import {
  CompileError,
  ENTITY_TYPES_SG,
  MEI_COMPILE_FACILITY,
  MEI_IDS,
  MEI_LINES,
  MEI_PLAN,
  MEI_PLAN_INTENT,
  MEI_STAGES,
  PRODUCT_APPROVALS_BY_COUNTRY,
  PRODUCT_CATEGORIES,
  PackFactMissingError,
  PlanDraft,
  REGISTRATIONS_BY_COUNTRY,
  RESIDENCIES,
  RINA_LINES,
  SELL_CHANNELS,
  checkConstitution,
  compilePlan,
  constitutionOk,
  deriveE2Fields,
  hashObject,
  jcs,
  meiCompileInput,
  type CompileInput,
  type CountryPack,
  type PlanIntent,
} from "../src/index";
import { TEST_PACK_MY } from "./fixtures/packs";
import { TEST_PACK_SG, TEST_PACK_SG_R } from "./fixtures/pack-sg";

const MEI = meiCompileInput(TEST_PACK_SG);
const withSg = (patch: Partial<PlanIntent> = {}, pack: CountryPack = TEST_PACK_SG): CompileInput => ({ ...MEI, countryPack: pack, intent: { ...MEI.intent, ...patch } as PlanIntent });
const rulesOf = (input: CompileInput) => compilePlan(input).manifest.rules;
const ruleText = (input: CompileInput, id: string) => rulesOf(input).find((r) => r.ruleId === id)?.text;
const draftHash = (input: CompileInput): string => hashObject(JSON.parse(jcs(compilePlan(input))));

function packGap(input: CompileInput): PackFactMissingError {
  try {
    compilePlan(input);
  } catch (e) {
    if (e instanceof PackFactMissingError) return e;
    throw e;
  }
  throw new Error("expected the compile to fail closed with PACK_FACT_MISSING");
}
const codeOf = (input: CompileInput): string | undefined => {
  try {
    compilePlan(input);
  } catch (e) {
    return e instanceof CompileError ? e.code : `not a CompileError: ${String(e)}`;
  }
  return undefined;
};

/** Golden for Mei on the SG fixture (sg-core). The MY and ID goldens live in compiler-pack-facts.test.ts. */
const MEI_DRAFT_HASH = "0xf65833d7c9d062cd9df6f481b98a1e455166c8816bfa4eca897009307c154bc7";

describe("Mei compiles against the SG fixture pack", () => {
  const draft = compilePlan(MEI);
  const m = draft.manifest;

  it("is a valid PlanDraft that passes every constitution rule", () => {
    expect(PlanDraft.parse(draft)).toEqual(draft);
    expect(constitutionOk(draft.constitutionReport)).toBe(true);
    expect(checkConstitution(m, MEI_COMPILE_FACILITY, BigInt(MEI.now)).every((r) => r.ok)).toBe(true);
    expect([m.countryCode, m.displayCurrency, m.facilityId, m.totalMinor]).toEqual(["SG", "SGD", MEI_IDS.facilityId, "1000000"]);
  });

  it("reproduces MEI_LINES (Rina's numbers in SGD), the reserve, stages and expiries", () => {
    expect(m.lines.map((l) => [l.lineKey, l.amountMinor, l.perTxCapMinor, l.windowCapMinor, l.pacing?.amountMinor ?? null, l.escrowOnly, l.payeeIds])).toEqual(
      MEI_LINES.map((l) => [l.lineKey, l.amountMinor, l.perTxCapMinor, l.windowCapMinor, l.pacingPerDayMinor ?? null, l.escrowOnly, [...l.payeeIds]]),
    );
    expect(MEI_LINES.map(({ payeeIds: _p, ...rest }) => rest)).toEqual(RINA_LINES.map(({ payeeIds: _p, ...rest }) => rest));
    expect(m.lines.every((l) => l.windowSeconds === MEI_PLAN.windowSeconds && l.validUntil === MEI_PLAN.validUntil)).toBe(true);
    expect(m.reserveBps).toBe(MEI_PLAN.reserveBps);
    expect(m.agent.expiresAt).toBe(MEI_PLAN.agentExpiresAt);
    expect(m.stages).toEqual(MEI_STAGES.map((s) => ({ stageId: s.stageId, releaseMinor: s.releaseMinor, gate: s.gate })));
  });

  it("derives Mei's E2 fields from the rule ids", () => {
    expect(deriveE2Fields(draft)).toEqual({
      entityType: "sg_sole_prop",
      registrations: ["ACRA_BUSINESS"],
      indirectTaxRegistered: false,
      eInvoicing: false,
      dutyRoute: "MFN",
      productApproval: "SFA",
      reserveBps: 500,
      licenceCostMinor: "11500",
    });
  });

  it("speaks SG: GST, InvoiceNow and import GST, citing the pack; no MY or ID scheme names", () => {
    expect(ruleText(MEI, "registration.acra_business.fee.11500")).toBe("Register: ACRA business registration, government fee SGD 115.00; paid by the founder before funding.");
    expect(ruleText(MEI, "indirect-tax.not-registered")).toBe("No GST registration at launch: a reseller below SGD 1,000,000.00 turnover.");
    expect(ruleText(MEI, "einvoicing.not-required")).toBe("E-invoicing (InvoiceNow) not required: it is for GST-registered businesses, and there is no GST registration at launch.");
    expect(ruleText(MEI, "duty.mfn")).toBe("Import from CN at the MFN tariff rate: duty 0.00% for drinkware_food_contact.");
    expect(ruleText(MEI, "import-tax.rate")).toBe("Import GST 9.00% on CIF + duty.");
    // SG-DECISIONS correction (22:50): the SFA importer registration step comes from the pack (free, so no LICENSING line).
    expect(ruleText(MEI, "approval.sfa.fee.0")).toBe("Product approval: SFA, fee SGD 0.00 for 1 product.");
    expect(m.rules.some((r) => r.ruleId === "approval.none")).toBe(false);
    const byId = new Map(m.rules.map((r) => [r.ruleId, r]));
    expect(byId.get("duty.mfn")?.sourceRef).toBe("/imports/mfnDutyRateBps/drinkware_food_contact");
    expect(byId.get("einvoicing.not-required")?.sourceRef).toBe("/indirectTax/registrationThreshold");
    expect(byId.get("approval.sfa.fee.0")?.sourceRef).toBe("/productApprovals/drinkware_food_contact/cost");
    expect(byId.get("duty.mfn")?.source?.sourceType).toBe("mock");
    expect(m.rules.map((r) => r.text).join(" ")).not.toMatch(/\b(SST|PKP|SSM|LHDN|MyInvois|e-Faktur|RM|MYR)\b/);
  });

  it("is pinned: Mei's draft, byte for byte (regenerate only for an intended SG output change)", () => {
    expect(draftHash(MEI)).toBe(MEI_DRAFT_HASH);
  });
});

describe("SG registrations, entities and approvals", () => {
  it.each([
    ["sg_sole_prop", "citizen", ["ACRA_BUSINESS"], "11500"],
    ["sg_partnership", "pr", ["ACRA_BUSINESS"], "11500"],
    ["pte_ltd", "citizen", ["ACRA_PTE_LTD"], "31500"],
  ] as const)("%s (%s) registers %j for %s", (entityType, residency, registrations, fee) => {
    const f = deriveE2Fields(compilePlan(withSg({ entityType, residency })));
    expect([f.entityType, f.registrations, f.licenceCostMinor]).toEqual([entityType, registrations, fee]);
  });

  it("a foreigner's sole proprietorship compiles as a pte_ltd (FOREIGNER_ENTITY.SG), with the override rule", () => {
    const d = compilePlan(withSg({ residency: "foreigner" }));
    expect(deriveE2Fields(d).entityType).toBe("pte_ltd");
    expect(d.manifest.rules.find((r) => r.ruleId === "entity.override")?.text).toBe(
      "The drafted sole proprietorship is not open to a foreigner; compiled as Pte Ltd (private limited company).",
    );
  });

  it.each([
    ["cosmetics", "HSA", "2000"],
    ["electrical", "CPSO_SAFETY_MARK", "50000"],
    ["food", "SFA", "8000"],
    ["apparel", "NONE", "0"],
    ["drinkware_food_contact", "SFA", "0"],
  ] as const)("%s → %s from the pack (fee %s)", (productCategory, approval, fee) => {
    const d = compilePlan(withSg({ productCategory }));
    const f = deriveE2Fields(d);
    expect(f.productApproval).toBe(approval);
    expect(BigInt(f.licenceCostMinor) - 11_500n).toBe(BigInt(fee));
    // A LICENSING line only for a fee: the free SFA registration is a rule, not a pocket.
    expect(d.manifest.lines.some((l) => l.lineKey === "LICENSING")).toBe(fee !== "0");
  });

  it("the approval is the pack's, not code's: the same intent follows whatever the pack says", () => {
    const drink = TEST_PACK_SG.productApprovals!.drinkware_food_contact!;
    const withDrink = (agency: "NONE" | "HSA", cost: string): CountryPack => ({
      ...TEST_PACK_SG_R,
      productApprovals: { ...TEST_PACK_SG.productApprovals, drinkware_food_contact: { ...drink, agency: { ...drink.agency, value: agency }, cost: { ...drink.cost, value: cost } } },
    });
    expect(deriveE2Fields(compilePlan(withSg({}, withDrink("NONE", "0")))).productApproval).toBe("NONE");
    const hsa = compilePlan(withSg({}, withDrink("HSA", "4000")));
    expect([deriveE2Fields(hsa).productApproval, hsa.manifest.lines.find((l) => l.lineKey === "LICENSING")?.amountMinor]).toEqual(["HSA", "4000"]);
  });

  it("a domestic SG supplier is EXEMPT: no import duty and no import GST rule", () => {
    const rules = rulesOf(withSg({ buyFrom: "SG" }));
    expect(rules.find((r) => r.ruleId === "duty.exempt")?.text).toBe("Domestic supplier: no import duty or import tax.");
    expect(rules.some((r) => r.ruleId === "import-tax.rate")).toBe(false);
  });

  it("an import is never EXEMPT: CN and US goods are MFN and pay import GST", () => {
    for (const buyFrom of ["CN", "US", "MY"]) {
      const d = compilePlan(withSg({ buyFrom }));
      expect(deriveE2Fields(d).dutyRoute).toBe("MFN");
      expect(d.manifest.rules.some((r) => r.ruleId === "import-tax.rate")).toBe(true);
    }
  });
});

describe("every SG fact the compile needs comes from the pack: a missing one fails closed with its leaf", () => {
  const sg = TEST_PACK_SG_R;
  const without = (code: string): CountryPack => ({ ...sg, registrations: sg.registrations!.filter((r) => r.code !== code) });
  const { registrationThreshold: _t, ...rateOnly } = sg.indirectTax!;
  const { rate: _r, ...thresholdOnly } = sg.indirectTax!;
  const { imports: _i, ...noImports } = sg;
  const { cosmetics: _c, ...approvalsNoCosmetics } = sg.productApprovals!;

  it.each([
    ["the ACRA business registration fee", "registrations.ACRA_BUSINESS.cost", withSg({}, without("ACRA_BUSINESS"))],
    ["the incorporation fee for a pte_ltd", "registrations.ACRA_PTE_LTD.cost", withSg({ entityType: "pte_ltd" }, without("ACRA_PTE_LTD"))],
    ["the GST threshold (GST and InvoiceNow both cite it; it is the only leaf)", "indirectTax.registrationThreshold", withSg({}, { ...sg, indirectTax: rateOnly })],
    ["the import GST rate (goods from CN)", "indirectTax.rate", withSg({}, { ...sg, indirectTax: thresholdOnly })],
    ["the CN duty route (no imports section)", "imports.ftaCertificates", withSg({}, noImports)],
    ["the category's approval agency", "productApprovals.cosmetics", withSg({ productCategory: "cosmetics" }, { ...sg, productApprovals: approvalsNoCosmetics })],
  ] as const)("%s → PACK_FACT_MISSING:%s", (_name, leaf, input) => {
    const e = packGap(input);
    expect([e.code, e.violations, e.leaves]).toEqual(["COMPILE_FAILED", [], [leaf]]);
    expect(e.message.startsWith(`PACK_FACT_MISSING:${leaf} (SG pack ${input.countryPack.version}; `)).toBe(true);
  });

  it("no eInvoicing section is needed for SG, but MY still fails closed without one", () => {
    expect(TEST_PACK_SG.eInvoicing).toBeUndefined();
    expect(codeOf(MEI)).toBeUndefined();
    const { eInvoicing: _e, ...myNoEInvoicing } = { ...TEST_PACK_MY, tier: "RESEARCHED" as const };
    const myInput: CompileInput = { ...MEI, countryPack: myNoEInvoicing, facility: { ...MEI_COMPILE_FACILITY, countryCode: "MY", currency: "MYR" }, intent: { ...MEI_PLAN_INTENT, countryCode: "MY", entityType: "sole_prop" } };
    expect(packGap(myInput).leaves).toEqual(["eInvoicing.threshold"]);
  });

  it("an SG pack with a turnover e-invoicing threshold is refused (INVALID_INPUT), never compiled as MY's rule", () => {
    expect(codeOf(withSg({}, { ...sg, eInvoicing: TEST_PACK_MY.eInvoicing }))).toBe("INVALID_INPUT");
  });

  it("a pack naming another country's agency or registration is refused before it can compile", () => {
    const cos = sg.productApprovals!.cosmetics!;
    expect(codeOf(withSg({ productCategory: "cosmetics" }, { ...sg, productApprovals: { ...sg.productApprovals, cosmetics: { ...cos, agency: { ...cos.agency, value: "NPRA" } } } }))).toBe("INVALID_INPUT");
    expect(codeOf(withSg({}, { ...sg, registrations: sg.registrations!.map((r) => (r.code === "ACRA_BUSINESS" ? { ...r, code: "SSM_SOLE_PROP" as const, entityTypes: [] } : r)) }))).toBe("INVALID_INPUT");
  });

  it("country and currency must agree across intent, facility and pack", () => {
    expect(codeOf({ ...MEI, countryPack: TEST_PACK_MY })).toBe("COUNTRY_MISMATCH");
    expect(codeOf({ ...MEI, facility: { ...MEI_COMPILE_FACILITY, currency: "MYR" } })).toBe("CURRENCY_MISMATCH");
    expect(codeOf({ ...MEI, intent: { ...MEI_PLAN_INTENT, entityType: "sole_prop" } })).toBe("INVALID_INPUT");
  });
});

describe("every SG residency × entity × category × origin × channel on the fixture", () => {
  it("compiles to SG-only codes or fails closed with a pack leaf (never another country's rules)", () => {
    let compiled = 0;
    for (const residency of RESIDENCIES)
      for (const entityType of ENTITY_TYPES_SG)
        for (const productCategory of PRODUCT_CATEGORIES)
          for (const buyFrom of ["CN", "SG", "MY", "US"])
            for (const sellChannel of SELL_CHANNELS) {
              const f = deriveE2Fields(compilePlan(withSg({ residency, entityType, productCategory, buyFrom, sellChannel })));
              expect(ENTITY_TYPES_SG).toContain(f.entityType);
              for (const r of f.registrations) expect(REGISTRATIONS_BY_COUNTRY.SG).toContain(r);
              expect(PRODUCT_APPROVALS_BY_COUNTRY.SG).toContain(f.productApproval);
              expect(f.dutyRoute).toBe(buyFrom === "SG" ? "EXEMPT" : "MFN");
              compiled += 1;
            }
    expect(compiled).toBe(3 * 3 * 6 * 4 * 4);
  });
});
