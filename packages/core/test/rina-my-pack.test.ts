/**
 * Rina (§26.2) against the researched pack data/country-packs/MY.json, not the mock TEST_PACK_MY: the pack must parse
 * with core's CountryPack schema and Rina must compile from its facts alone, every compliance rule citing a live source.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CountryPack,
  PackFactMissingError,
  compilePlan,
  deriveE2Fields,
  fakeHex32,
  landedCostFromPack,
  type CompileInput,
  type PlanIntent,
} from "../src/index";
import { RINA_COMPILE_INPUT } from "./fixtures/rina-compile";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MY_PACK = CountryPack.parse(JSON.parse(readFileSync(resolve(REPO_ROOT, "data/country-packs/MY.json"), "utf8")));

const withIntent = (patch: Partial<PlanIntent> = {}): CompileInput => ({
  ...RINA_COMPILE_INPUT,
  countryPack: MY_PACK,
  intent: { ...RINA_COMPILE_INPUT.intent, ...patch } as PlanIntent,
});

/** A 1:1 FX rate, labelled test data, so the landed-cost numbers read directly in MYR. */
const TEST_FX_1 = {
  value: 1,
  sourceUrl: "https://example.invalid/fx/cny-myr",
  retrievedAt: "2026-10-16T00:00:00Z",
  snippetHash: fakeHex32("test:fx:1"),
  evidence: "tier3" as const,
  sourceType: "mock" as const,
};

/** Compliance rules a plan derives from pack facts (the rest are budget and constitution rules). */
const PACK_RULE = /^(entity\.|registration\.|indirect-tax\.|einvoicing\.|duty\.|import-tax\.|approval\.|reserve\.)/;

describe("data/country-packs/MY.json", () => {
  it("parses with core's CountryPack schema as a RESEARCHED pack", () => {
    expect(MY_PACK.countryCode).toBe("MY");
    expect(MY_PACK.tier).toBe("RESEARCHED");
  });
});

describe("Rina compiles against the researched MY pack", () => {
  const draft = compilePlan(withIntent());
  const rules = draft.manifest.rules;

  it("with the expected E2 fields (sole proprietorship, SSM + LHDN, Form E, no approval, reserve 500)", () => {
    expect(deriveE2Fields(draft)).toEqual({
      entityType: "sole_prop",
      registrations: ["LHDN_TIN", "SSM_SOLE_PROP"],
      indirectTaxRegistered: false,
      eInvoicing: false,
      dutyRoute: "FORM_E",
      productApproval: "NONE",
      reserveBps: 500,
      licenceCostMinor: "6000",
    });
    expect(draft.manifest.countryPackVersion).toBe(MY_PACK.version);
  });

  it("the same E2 labels as the mock pack's compile", () => {
    expect(deriveE2Fields(draft)).toEqual(deriveE2Fields(compilePlan(RINA_COMPILE_INPUT)));
  });

  it("emits each compliance rule from the pack leaf it cites", () => {
    const byId = new Map(rules.map((r) => [r.ruleId, r]));
    const expected: [string, string, string][] = [
      ["registration.ssm_sole_prop.fee.6000", "/registrations/0/cost", "MYR 60.00"],
      ["registration.lhdn_tin.fee.0", "/registrations/2/cost", "MYR 0.00"],
      ["indirect-tax.not-registered", "/indirectTax/registrationThreshold", "MYR 500,000.00"],
      ["einvoicing.not-required", "/eInvoicing/threshold", "MYR 3,000,000.00"],
      ["duty.form_e", "/imports/ftaCertificates/0/dutyRateBps", "duty 0.00%"],
      ["import-tax.rate", "/indirectTax/rate", "10.00%"],
      ["approval.none", "/productApprovals/drinkware_food_contact/agency", "No product approval"],
      ["reserve.policy", "/reserveFloorBps", "5.00%"],
    ];
    for (const [ruleId, sourceRef, text] of expected) {
      const r = byId.get(ruleId);
      expect(r, ruleId).toBeDefined();
      expect(r!.sourceRef).toBe(sourceRef);
      expect(r!.text).toContain(text);
    }
  });

  it("every pack-derived rule cites a live https source except the labelled demo reserve", () => {
    const cited = rules.filter((r) => PACK_RULE.test(r.ruleId) && r.source);
    expect(cited.map((r) => r.ruleId)).toContain("approval.none");
    for (const r of cited) {
      expect(r.source!.sourceUrl, r.ruleId).toMatch(/^https:\/\//);
      expect(r.source!.sourceUrl, r.ruleId).not.toContain("example.invalid");
      expect(r.source!.sourceType, r.ruleId).toBe(r.ruleId === "reserve.policy" ? "mock" : "live");
    }
  });
});

describe("other MY scenarios on the researched pack", () => {
  it("a partnership compiles with the same SSM trade-name fee", () => {
    const fields = deriveE2Fields(compilePlan(withIntent({ entityType: "partnership" })));
    expect(fields.entityType).toBe("partnership");
    expect(fields.registrations).toEqual(["LHDN_TIN", "SSM_SOLE_PROP"]);
    expect(fields.licenceCostMinor).toBe("6000");
  });

  it("a foreign founder (compiled as Sdn Bhd) fails closed: the company TIN fact is not sourced yet", () => {
    let gap: unknown;
    try {
      compilePlan(withIntent({ residency: "foreigner" }));
    } catch (e) {
      gap = e;
    }
    expect(gap).toBeInstanceOf(PackFactMissingError);
    expect((gap as PackFactMissingError).leaves).toEqual(["registrations.LHDN_TIN[sdn_bhd].cost"]);
  });

  it("landed cost for CN goods: Form E duty 0 and 10% sales tax on CIF + duty", () => {
    const { dutyRoute, dutyRateBps, landedCost } = landedCostFromPack({
      countryPack: MY_PACK,
      origin: "CN",
      quantity: 100,
      fobUnitMinor: "1000",
      freightPerUnitMinor: "0",
      insuranceBps: 0,
      fx: TEST_FX_1,
    });
    expect([dutyRoute, dutyRateBps]).toEqual(["FORM_E", 0]);
    expect(landedCost).toMatchObject({ cifMinor: "100000", dutyMinor: "0", sstMinor: "10000", totalMinor: "110000" });
  });
});
