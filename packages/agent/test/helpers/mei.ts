/**
 * Mei (SG) planner fixtures from @hogee/core's demo exports, with a TEST FIXTURE SG pack that mirrors core's
 * test/fixtures/pack-sg.ts (as ./pack.ts mirrors TEST_PACK_MY). Every leaf is mock/tier3 with an example.invalid URL:
 * it only follows the SG-DECISIONS import model and is never a verified fact. Never use it for the deck, demo or evals.
 */
import { CountryPack, MEI_COMMIT_AT, MEI_COMPILE_FACILITY, fakeAddress, fakeHex32, type CountryPack as CountryPackT } from "@hogee/core";
import type { PlannerContext } from "../../src/planner/planner";

const sg = <T>(path: string, value: T) => ({
  value,
  sourceUrl: `https://example.invalid/sg/fixture/${path}`,
  retrievedAt: "2026-10-18T02:00:00Z",
  snippetHash: fakeHex32(`test-pack:SG:${path}`),
  evidence: "tier3" as const,
  sourceType: "mock" as const,
});

export const TEST_PACK_SG: CountryPackT = CountryPack.parse({
  countryCode: "SG",
  version: "test-sg-2026.10.18",
  tier: "VERIFIED",
  currency: "SGD",
  reserveFloorBps: sg("reserve-floor", 300),
  entities: [
    { type: "sg_sole_prop", cost: sg("acra/sole", "11500"), eligibility: sg("acra/sole-elig", ["citizen", "pr"]), liability: sg("acra/sole-liab", "unlimited") },
    { type: "sg_partnership", cost: sg("acra/pship", "11500"), eligibility: sg("acra/pship-elig", ["citizen", "pr"]), liability: sg("acra/pship-liab", "unlimited") },
    { type: "pte_ltd", cost: sg("acra/pte", "31500"), eligibility: sg("acra/pte-elig", ["citizen", "pr", "foreigner"]), liability: sg("acra/pte-liab", "limited") },
  ],
  registrations: [
    { code: "ACRA_BUSINESS", entityTypes: ["sg_sole_prop", "sg_partnership"], requirement: sg("reg/acra-business", "FIXTURE: register the business name before trading"), cost: sg("reg/acra-business-cost", "11500") },
    { code: "ACRA_PTE_LTD", entityTypes: ["pte_ltd"], requirement: sg("reg/acra-pte", "FIXTURE: incorporate before trading"), cost: sg("reg/acra-pte-cost", "31500") },
    { code: "IRAS_GST", entityTypes: [], requirement: sg("reg/gst", "FIXTURE: register above the taxable turnover threshold"), cost: sg("reg/gst-cost", "0") },
  ],
  taxIds: [
    { code: "ACRA_BUSINESS", rule: sg("taxid/uen-business", "FIXTURE: the UEN is the business tax reference") },
    { code: "ACRA_PTE_LTD", rule: sg("taxid/uen-pte", "FIXTURE: the UEN is the company tax reference") },
  ],
  incomeTax: { summary: sg("income-tax", "FIXTURE: sole proprietor profits are taxed as personal income") },
  indirectTax: { rate: sg("gst/rate", 900), registrationThreshold: sg("gst/threshold", "100000000") },
  imports: {
    taxBase: sg("imports/base", "CIF"),
    dutySources: [sg("imports/tariff", "FIXTURE: customs duty list")],
    ftaCertificates: [],
    mfnDutyRateBps: {
      drinkware_food_contact: sg("imports/mfn-drinkware", 0),
      cosmetics: sg("imports/mfn-cosmetics", 0),
      electrical: sg("imports/mfn-electrical", 0),
      apparel: sg("imports/mfn-apparel", 0),
      food: sg("imports/mfn-food", 0),
    },
  },
  productApprovals: {
    drinkware_food_contact: { agency: sg("appr/drink-sfa", "SFA"), cost: sg("appr/drink-sfa-cost", "0"), time: sg("appr/drink-sfa-time", 1) },
    cosmetics: { agency: sg("appr/hsa", "HSA"), cost: sg("appr/hsa-cost", "2000"), time: sg("appr/hsa-time", 7) },
    electrical: { agency: sg("appr/cpso", "CPSO_SAFETY_MARK"), cost: sg("appr/cpso-cost", "50000"), time: sg("appr/cpso-time", 30) },
    food: { agency: sg("appr/sfa", "SFA"), cost: sg("appr/sfa-cost", "8000"), time: sg("appr/sfa-time", 14) },
    apparel: { agency: sg("appr/apparel", "NONE"), cost: sg("appr/apparel-cost", "0"), time: sg("appr/apparel-time", 0) },
    other: { agency: sg("appr/other", "NONE"), cost: sg("appr/other-cost", "0"), time: sg("appr/other-time", 0) },
  },
  paymentRails: [{ id: "PAYNOW", feeBps: sg("rails/paynow", 0) }],
  marketplaces: [
    { channel: "shopee", fees: [{ name: "commission fee", rateBps: sg("shopee/commission", 600) }, { name: "transaction fee", rateBps: sg("shopee/txn", 300) }] },
  ],
});

export const MEI_PLANNER_CONTEXT: PlannerContext = {
  facility: MEI_COMPILE_FACILITY,
  countryPack: TEST_PACK_SG,
  now: MEI_COMMIT_AT,
  ids: { draftId: "draft-mei-001", planId: fakeHex32("planId:mei"), agentAddress: fakeAddress("agent:mei:final-1") },
};
