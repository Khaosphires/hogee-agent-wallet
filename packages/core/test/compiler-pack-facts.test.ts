/**
 * The compiler never invents a country-pack fact. A fact the compile needs (each required registration's fee, the
 * thresholds launch scale is compared with, the category's product approval, the duty route and the import tax rate)
 * comes from the pack, or the compile fails closed: PackFactMissingError, code COMPILE_FAILED, no constitution
 * violation, message `PACK_FACT_MISSING:<leaf>`. A complete pack compiles exactly as before the rule was enforced.
 */
import { describe, expect, it } from "vitest";
import {
  ENTITY_TYPES_BY_COUNTRY,
  PRODUCT_CATEGORIES,
  RESIDENCIES,
  SELL_CHANNELS,
  CompileError,
  PackFactMissingError,
  compilePlan,
  deriveE2Fields,
  examplePlanIntent,
  hashObject,
  jcs,
  type CompileInput,
  type CountryPack,
  type PlanIntent,
} from "../src/index";
import { TEST_PACK_ID, TEST_PACK_MY } from "./fixtures/packs";
import { RINA_COMPILE_FACILITY, RINA_COMPILE_INPUT } from "./fixtures/rina-compile";

const MY = TEST_PACK_MY;
/** Partial copies of the complete pack are RESEARCHED (a VERIFIED pack must carry every core section). */
const MY_R: CountryPack = { ...MY, tier: "RESEARCHED" };
const withPack = (countryPack: CountryPack, patch: Partial<PlanIntent> = {}, base: CompileInput = RINA_COMPILE_INPUT): CompileInput => ({
  ...base,
  countryPack,
  intent: { ...base.intent, ...patch } as PlanIntent,
});
const draftHash = (input: CompileInput): string => hashObject(JSON.parse(jcs(compilePlan(input))));

/** The thrown PackFactMissingError (fails the test if the compile succeeds or throws anything else). */
function packGap(input: CompileInput): PackFactMissingError {
  try {
    compilePlan(input);
  } catch (e) {
    if (e instanceof PackFactMissingError) return e;
    throw e;
  }
  throw new Error("expected the compile to fail closed with PACK_FACT_MISSING");
}

const ID_INPUT: CompileInput = {
  ...RINA_COMPILE_INPUT,
  countryPack: TEST_PACK_ID,
  facility: { ...RINA_COMPILE_FACILITY, countryCode: "ID", currency: "IDR", capMinor: "1500000000", reserveFloorBps: 50, payees: [] },
  intent: { ...examplePlanIntent, countryCode: "ID", entityType: "perorangan", budgetCeilingMinor: "1500000000", sellChannel: "tiktok_shop" },
};

const { rate: _rate, ...myThresholdOnly } = MY.indirectTax!;
const { registrationThreshold: _threshold, ...myRateOnly } = MY.indirectTax!;
const { eInvoicing: _einv, ...myNoEInvoicing } = MY_R;
const { imports: _imports, ...myNoImports } = MY_R;
const { drinkware_food_contact: _drink, cosmetics: _cos, ...myApprovalsRest } = MY.productApprovals!;
const myWithout = (code: string): CountryPack => ({ ...MY_R, registrations: MY.registrations!.filter((r) => r.code !== code) });
const mySoleOnly: CountryPack = {
  ...MY_R,
  registrations: MY.registrations!.map((r) => (r.code === "SSM_SOLE_PROP" ? { ...r, entityTypes: ["sole_prop"] } : r)),
};
const { registrationThreshold: _idThreshold, ...idRateOnly } = TEST_PACK_ID.indirectTax!;

describe("every fact the compile needs comes from the pack: a missing one fails closed with its leaf", () => {
  it.each([
    ["import sales tax rate (goods from CN)", "indirectTax.rate", withPack({ ...MY_R, indirectTax: myThresholdOnly })],
    ["import sales tax rate (goods from the US, MFN)", "indirectTax.rate", withPack({ ...MY_R, indirectTax: myThresholdOnly }, { buyFrom: "US" })],
    ["SST threshold (launch scale is compared with it)", "indirectTax.registrationThreshold", withPack({ ...MY_R, indirectTax: myRateOnly })],
    ["MyInvois threshold", "eInvoicing.threshold", withPack(myNoEInvoicing)],
    ["the duty route for CN (no imports section)", "imports.ftaCertificates", withPack(myNoImports)],
    ["the category's product approval (drinkware)", "productApprovals.drinkware_food_contact", withPack({ ...MY_R, productApprovals: { ...myApprovalsRest, cosmetics: MY.productApprovals!.cosmetics } })],
    ["the category's product approval (cosmetics: NPRA, not 'none')", "productApprovals.cosmetics", withPack({ ...MY_R, productApprovals: { ...myApprovalsRest, drinkware_food_contact: MY.productApprovals!.drinkware_food_contact } }, { productCategory: "cosmetics" })],
    ["the sole proprietorship's registration fee", "registrations.SSM_SOLE_PROP.cost", withPack(myWithout("SSM_SOLE_PROP"))],
    ["the TIN registration fee", "registrations.LHDN_TIN.cost", withPack(myWithout("LHDN_TIN"))],
    ["the Sdn Bhd fee for a foreigner (entity overridden to sdn_bhd)", "registrations.SSM_SDN_BHD.cost", withPack(myWithout("SSM_SDN_BHD"), { residency: "foreigner" })],
    ["a partnership's SSM fee when the pack lists it for sole_prop only", "registrations.SSM_SOLE_PROP[partnership].cost", withPack(mySoleOnly, { entityType: "partnership" })],
    ["ID: the NPWP (NIK) registration fee", "registrations.NPWP_NIK.cost", withPack({ ...TEST_PACK_ID, registrations: TEST_PACK_ID.registrations!.filter((r) => r.code !== "NPWP_NIK") }, {}, ID_INPUT)],
    ["ID: the PKP threshold (e-Faktur follows it, so it is the only leaf)", "indirectTax.registrationThreshold", withPack({ ...TEST_PACK_ID, indirectTax: idRateOnly }, {}, ID_INPUT)],
    ["ID: the electrical approval (not in the pack)", "productApprovals.electrical", withPack(TEST_PACK_ID, { productCategory: "electrical" }, ID_INPUT)],
  ] as const)("%s → PACK_FACT_MISSING:%s", (_name, leaf, input) => {
    const e = packGap(input);
    expect(e.code).toBe("COMPILE_FAILED");
    expect(e.violations).toEqual([]);
    expect(e.leaves).toEqual([leaf]);
    expect(e.message.startsWith(`PACK_FACT_MISSING:${leaf} (${input.countryPack.countryCode} pack ${input.countryPack.version}; `)).toBe(true);
  });

  it("names every missing leaf in one error (P3's partial MY pack shape: one sole-prop registration + MyInvois)", () => {
    const partial: CountryPack = {
      countryCode: "MY",
      version: "test-partial",
      tier: "RESEARCHED",
      currency: "MYR",
      reserveFloorBps: MY.reserveFloorBps,
      registrations: [{ ...MY.registrations![0]!, entityTypes: ["sole_prop"] }],
      eInvoicing: MY.eInvoicing!,
    };
    expect(packGap(withPack(partial)).leaves).toEqual([
      "registrations.LHDN_TIN.cost",
      "indirectTax.registrationThreshold",
      "imports.ftaCertificates",
      "indirectTax.rate",
      "productApprovals.drinkware_food_contact",
    ]);
    expect(packGap(withPack(partial, { entityType: "partnership" })).leaves[0]).toBe("registrations.SSM_SOLE_PROP[partnership].cost");
  });
});

describe("a fact the intent does not need is not required", () => {
  it("a domestic supplier needs no import tax rate and no imports section (identical plan apart from the pack hash)", () => {
    const { indirectTax: _it, imports: _im, ...rest } = MY_R;
    const lean: CountryPack = { ...rest, indirectTax: { registrationThreshold: MY.indirectTax!.registrationThreshold! } };
    const a = compilePlan(withPack(lean, { buyFrom: "MY" }));
    const b = compilePlan(withPack(MY, { buyFrom: "MY" }));
    expect({ ...a.manifest, countryPackHash: b.manifest.countryPackHash }).toEqual(b.manifest);
    expect(deriveE2Fields(a)).toEqual(deriveE2Fields(b));
  });

  it("a sole proprietorship needs no Sdn Bhd fee", () => {
    expect(deriveE2Fields(compilePlan(withPack(myWithout("SSM_SDN_BHD"))))).toEqual(deriveE2Fields(compilePlan(RINA_COMPILE_INPUT)));
  });
});

describe("a complete pack compiles exactly as before (golden hashes taken before fail-closed was enforced)", () => {
  // Regenerate only for an intended output change, and say why in the commit.
  // G2: regenerated for schemaVersion 2.0.0 only. With manifest.schemaVersion set back to "1.0.0" the drafts hash to
  // the previous goldens (Rina 0xaad27df6…62f3, matrix 0x1f7d487c…3773), so nothing else in the output moved.
  const RINA_DRAFT_HASH = "0x112b6d467933c53bec1ad15685fb5fe5bf9ef6705a9c07611f71882b4655b2eb";
  const MY_MATRIX_DIGEST = "0xb1cfd937f5fe953d5ef0abc6b395b42768cf9e1406b4639116ccceedac4b2a85";

  it("Rina's draft, byte for byte", () => {
    expect(draftHash(RINA_COMPILE_INPUT)).toBe(RINA_DRAFT_HASH);
  });

  it("every MY residency × entity × category × origin × channel on TEST_PACK_MY (864 drafts)", () => {
    const hashes: string[] = [];
    for (const residency of RESIDENCIES)
      for (const entityType of ENTITY_TYPES_BY_COUNTRY.MY)
        for (const productCategory of PRODUCT_CATEGORIES)
          for (const buyFrom of ["CN", "MY", "TH", "US"])
            for (const sellChannel of SELL_CHANNELS) hashes.push(draftHash(withPack(MY, { residency, entityType, productCategory, buyFrom, sellChannel })));
    expect(hashes).toHaveLength(864);
    expect(hashObject(hashes)).toBe(MY_MATRIX_DIGEST);
  });

  // SG-CORE: taken from the tree BEFORE SG was added (fork point f0d981b) and unchanged after it, so adding SG moved no
  // ID draft and no ID refusal. Each entry is the draft hash, or `<code> <message>` when the compile fails closed.
  const ID_MATRIX_DIGEST = "0x70936eb8f9e30600d4f4960e33b2121ab614820a3c756f03eb9cdb80dab88129";

  it("every ID residency × entity × category × origin × channel on TEST_PACK_ID (1152 outcomes)", () => {
    const outcomes: string[] = [];
    for (const residency of RESIDENCIES)
      for (const entityType of ENTITY_TYPES_BY_COUNTRY.ID)
        for (const productCategory of PRODUCT_CATEGORIES)
          for (const buyFrom of ["CN", "ID", "TH", "US"])
            for (const sellChannel of SELL_CHANNELS) {
              const input = withPack(TEST_PACK_ID, { residency, entityType, productCategory, buyFrom, sellChannel }, ID_INPUT);
              try {
                outcomes.push(draftHash(input));
              } catch (e) {
                if (!(e instanceof CompileError)) throw e;
                outcomes.push(`${e.code} ${e.message}`);
              }
            }
    expect(outcomes).toHaveLength(1152);
    expect(hashObject(outcomes)).toBe(ID_MATRIX_DIGEST);
  });
});
