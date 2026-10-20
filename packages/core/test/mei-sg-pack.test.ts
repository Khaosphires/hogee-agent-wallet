/**
 * Mei on the REAL Singapore pack: data/country-packs/SG.json (tier RESEARCHED, built by build_sg.py from the sourced
 * research ledger). The fixture-pack golden stays in sg-compile.test.ts; this file pins what the demo shows from the real
 * pack: ACRA registration only (no GST at launch), the free SFA importer registration, 9% import GST on CIF in landed
 * cost, and GST wording (never SST).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CountryPack,
  MEI_IDS,
  MEI_LINES,
  PackFactMissingError,
  PlanDraft,
  compilePlan,
  constitutionOk,
  deriveE2Fields,
  landedCostFromPack,
  meiCompileInput,
  type CompileInput,
  type PlanIntent,
  type Sourced,
} from "../src/index";
import { REPO_ROOT } from "../scripts/lib/paths";

const CORE_DIR = join(REPO_ROOT, "packages", "core");
const PACK: CountryPack = CountryPack.parse(JSON.parse(readFileSync(join(REPO_ROOT, "data", "country-packs", "SG.json"), "utf8")));
const MEI = meiCompileInput(PACK);
const DRAFT = compilePlan(MEI);
const RULES = DRAFT.manifest.rules;
const rule = (id: string) => RULES.find((r) => r.ruleId === id);
const withIntent = (patch: Partial<PlanIntent>): CompileInput => ({ ...MEI, intent: { ...MEI.intent, ...patch } as PlanIntent });

describe("SG.json loads through the core schema", () => {
  it("is the RESEARCHED SG pack, in SGD, with no eInvoicing section and no human sign-off yet", () => {
    expect([PACK.countryCode, PACK.currency, PACK.tier]).toEqual(["SG", "SGD", "RESEARCHED"]);
    expect(PACK.eInvoicing).toBeUndefined();
    expect(JSON.stringify(PACK)).not.toMatch(/"verified(By|On)"/);
  });

  it("passes validate:data with the country packs required", () => {
    const out = execFileSync(join(CORE_DIR, "node_modules", ".bin", "tsx"), ["scripts/validate-data.ts", "--require", "data/country-packs/*.json"], {
      cwd: CORE_DIR,
      encoding: "utf8",
    });
    expect(out).toContain("OK    data/country-packs/SG.json (1 record)");
    expect(out).toMatch(/validate:data: \d+ ok, \d+ skipped, 0 failed/);
  }, 60_000);
});

describe("compilePlan(meiCompileInput(SG.json))", () => {
  it("compiles to a valid draft with Mei's lines that passes every constitution rule", () => {
    expect(PlanDraft.parse(DRAFT)).toEqual(DRAFT);
    expect(constitutionOk(DRAFT.constitutionReport)).toBe(true);
    const m = DRAFT.manifest;
    expect([m.countryCode, m.displayCurrency, m.facilityId, m.totalMinor, m.reserveBps]).toEqual(["SG", "SGD", MEI_IDS.facilityId, "1000000", 500]);
    expect(m.lines.map((l) => [l.lineKey, l.amountMinor, l.perTxCapMinor])).toEqual(MEI_LINES.map((l) => [l.lineKey, l.amountMinor, l.perTxCapMinor]));
  });

  it("registers ACRA only: GST (IRAS_GST) is not required at launch, below the pack's SGD 1M threshold", () => {
    expect(deriveE2Fields(DRAFT)).toEqual({
      entityType: "sg_sole_prop",
      registrations: ["ACRA_BUSINESS"],
      indirectTaxRegistered: false,
      eInvoicing: false,
      dutyRoute: "MFN",
      productApproval: "SFA",
      reserveBps: 500,
      licenceCostMinor: "11500",
    });
    expect(rule("registration.acra_business.fee.11500")?.text).toBe("Register: ACRA business registration, government fee SGD 115.00; paid by the founder before funding.");
    expect(RULES.some((r) => r.ruleId.startsWith("registration.iras_gst"))).toBe(false);
    expect(rule("indirect-tax.not-registered")?.text).toBe("No GST registration at launch: a reseller below SGD 1,000,000.00 turnover.");
  });

  it("carries the SFA importer registration step (approval.sfa.fee.0), sourced from SFA's own fee table", () => {
    const sfa = rule("approval.sfa.fee.0");
    expect(sfa?.text).toBe("Product approval: SFA, fee SGD 0.00 for 1 product.");
    expect(sfa?.sourceRef).toBe("/productApprovals/drinkware_food_contact/cost");
    expect([sfa?.source?.sourceType, sfa?.source?.evidence, new URL(sfa?.source?.sourceUrl ?? "x:").hostname]).toEqual(["live", "tier1", "www.sfa.gov.sg"]);
    expect(DRAFT.manifest.lines.some((l) => l.lineKey === "LICENSING")).toBe(false);
  });

  it("puts import GST in landed cost: MFN at the pack's 0% duty, 9% on CIF + duty", () => {
    expect(rule("duty.mfn")?.text).toBe("Import from CN at the MFN tariff rate: duty 0.00% for drinkware_food_contact.");
    expect(rule("import-tax.rate")?.text).toBe("Import GST 9.00% on CIF + duty.");
    const fx: Sourced<number> = { value: 0.19, sourceUrl: "https://example.invalid/sg/test/fx", retrievedAt: "2026-10-18T02:00:00Z", snippetHash: `0x${"ab".repeat(32)}`, evidence: "tier3", sourceType: "mock" };
    // Same quote as sg-landed-cost.test.ts: CIF = 715,000 × 1.005 × 0.19 → 136,529; GST = 136,529 × 9% → 12,288.
    const out = landedCostFromPack({ countryPack: PACK, origin: "CN", quantity: 500, fobUnitMinor: "1250", freightPerUnitMinor: "180", fx, productCategory: "drinkware_food_contact" });
    expect([out.dutyRoute, out.dutyRateBps]).toEqual(["MFN", 0]);
    expect(out.landedCost).toMatchObject({ cifMinor: "136529", dutyMinor: "0", sstMinor: "12288", totalMinor: "148817" });
  });

  it("explains in Singapore terms: GST and InvoiceNow, never SST or another country's scheme", () => {
    const text = RULES.map((r) => r.text).join(" ");
    expect(text).toMatch(/\bGST\b/);
    expect(text).toContain("InvoiceNow");
    expect(text).not.toMatch(/\b(SST|PKP|SSM|LHDN|MyInvois|e-Faktur|RM|MYR)\b/);
  });
});

describe("other SG intents on the real pack", () => {
  it.each([
    ["cosmetics", "HSA", "1300"],
    ["electrical", "CPSO_SAFETY_MARK", "18000"],
    ["food", "SFA", "0"],
    ["apparel", "NONE", "0"],
  ] as const)("%s → %s, fee %s, from the pack", (productCategory, approval, fee) => {
    const f = deriveE2Fields(compilePlan(withIntent({ productCategory })));
    expect([f.productApproval, BigInt(f.licenceCostMinor) - 11_500n]).toEqual([approval, BigInt(fee)]);
  });

  it("'other' is not in the pack, so it fails closed instead of reading as no approval", () => {
    expect(() => compilePlan(withIntent({ productCategory: "other" }))).toThrow(PackFactMissingError);
    expect(() => compilePlan(withIntent({ productCategory: "other" }))).toThrow(/^PACK_FACT_MISSING:productApprovals\.other /);
  });

  it("a foreign founder keeps the sole proprietorship: the pack marks it open to foreigners (ACRA, with local representation)", () => {
    const d = compilePlan(withIntent({ residency: "foreigner" }));
    expect(deriveE2Fields(d).entityType).toBe("sg_sole_prop");
    expect(d.manifest.rules.some((r) => r.ruleId === "entity.override")).toBe(false);
  });
});
