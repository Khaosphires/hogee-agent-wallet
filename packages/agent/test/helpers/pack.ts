/**
 * TEST FIXTURE ONLY: a complete mock MY country pack (same values as @hogee/core's test TEST_PACK_MY). The compiler
 * fails closed on a missing pack fact, so the 3-leaf `exampleCountryPack` example cannot compile a plan. Every source
 * is mock/tier3 and every URL is example.invalid; never use this for the deck or evals.
 */
import { CountryPack, fakeHex32, type CountryPack as CountryPackT } from "@hogee/core";

const my = <T>(path: string, value: T) => ({
  value,
  sourceUrl: `https://example.invalid/my/${path}`,
  retrievedAt: "2026-10-16T02:00:00Z",
  snippetHash: fakeHex32(`test-pack:MY:${path}`),
  evidence: "tier3" as const,
  sourceType: "mock" as const,
});

export const TEST_PACK_MY: CountryPackT = CountryPack.parse({
  countryCode: "MY",
  version: "test-2026.10.16",
  tier: "VERIFIED",
  currency: "MYR",
  reserveFloorBps: my("reserve-floor", 300),
  entities: [
    { type: "sole_prop", cost: my("ssm/sole", "6000"), eligibility: my("ssm/sole-elig", ["citizen", "pr"]), liability: my("ssm/sole-liab", "unlimited") },
    { type: "partnership", cost: my("ssm/pship", "6000"), eligibility: my("ssm/pship-elig", ["citizen", "pr"]), liability: my("ssm/pship-liab", "unlimited") },
    { type: "sdn_bhd", cost: my("ssm/sdn", "106000"), eligibility: my("ssm/sdn-elig", ["citizen", "pr", "foreigner"]), liability: my("ssm/sdn-liab", "limited") },
  ],
  registrations: [
    { code: "SSM_SOLE_PROP", entityTypes: ["sole_prop", "partnership"], requirement: my("reg/ssm-sole", "Register within 30 days"), cost: my("reg/ssm-sole-cost", "6000") },
    { code: "SSM_SDN_BHD", entityTypes: ["sdn_bhd"], requirement: my("reg/ssm-sdn", "Incorporate before trading"), cost: my("reg/ssm-sdn-cost", "106000") },
    { code: "LHDN_TIN", entityTypes: [], requirement: my("reg/tin", "Tax identification number"), cost: my("reg/tin-cost", "0") },
  ],
  taxIds: [{ code: "LHDN_TIN", rule: my("taxid", "Every taxpayer has a TIN") }],
  incomeTax: { summary: my("income-tax", "Resident individual progressive rates") },
  indirectTax: { rate: my("sst/rate", 1000), registrationThreshold: my("sst/threshold", "50000000") },
  eInvoicing: { threshold: my("einvoicing", "300000000") },
  imports: {
    taxBase: my("imports/base", "CIF"),
    dutySources: [my("imports/tariff", "Royal Malaysian Customs tariff finder")],
    ftaCertificates: [{ route: "FORM_E", partnerCountry: "CN", name: my("imports/form-e", "Form E (ACFTA)"), dutyRateBps: my("imports/form-e-rate", 0) }],
  },
  productApprovals: {
    drinkware_food_contact: { agency: my("appr/drink", "NONE"), cost: my("appr/drink-cost", "0"), time: my("appr/drink-time", 0) },
    cosmetics: { agency: my("appr/npra", "NPRA"), cost: my("appr/npra-cost", "5000"), time: my("appr/npra-time", 30) },
    electrical: { agency: my("appr/sirim", "ST_SIRIM"), cost: my("appr/sirim-cost", "50000"), time: my("appr/sirim-time", 45) },
    food: { agency: my("appr/kkm", "KKM_FOOD"), cost: my("appr/kkm-cost", "3000"), time: my("appr/kkm-time", 30) },
    apparel: { agency: my("appr/apparel", "NONE"), cost: my("appr/apparel-cost", "0"), time: my("appr/apparel-time", 0) },
    other: { agency: my("appr/other", "NONE"), cost: my("appr/other-cost", "0"), time: my("appr/other-time", 0) },
  },
  marketplaces: [
    { channel: "shopee", fees: [{ name: "platform support fee", rateBps: my("shopee/support", 500) }, { name: "transaction fee", rateBps: my("shopee/txn", 210) }] },
  ],
});
