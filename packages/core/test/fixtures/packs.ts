/**
 * TEST FIXTURES ONLY. Mock country packs shaped like data/country-packs/<CC>.json (P3 delivers the real,
 * verified packs). Values follow project.md §10.2/§10.3 and LABELING.md; every source is mock/tier3 and
 * every URL is example.invalid. Never use these for the deck or evals.
 */
import { CountryPack, fakeHex32, type CountryPack as CountryPackT } from "../../src/index";

const src = (cc: string, path: string) => ({
  sourceUrl: `https://example.invalid/${cc.toLowerCase()}/${path}`,
  retrievedAt: "2026-10-16T02:00:00Z",
  snippetHash: fakeHex32(`test-pack:${cc}:${path}`),
  evidence: "tier3" as const,
  sourceType: "mock" as const,
});
const my = <T>(path: string, value: T) => ({ value, ...src("MY", path) });
const id = <T>(path: string, value: T) => ({ value, ...src("ID", path) });

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
    { code: "SST", entityTypes: [], requirement: my("reg/sst", "Manufacturers above RM500k"), cost: my("reg/sst-cost", "0") },
    { code: "MYINVOIS", entityTypes: [], requirement: my("reg/myinvois", "Turnover at or above RM3M"), cost: my("reg/myinvois-cost", "0") },
    { code: "PBT_LICENCE", entityTypes: [], requirement: my("reg/pbt", "Physical premises only"), cost: my("reg/pbt-cost", "20000") },
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
  paymentRails: [{ id: "DUITNOW", feeBps: my("rails/duitnow", 0) }],
  marketplaces: [
    { channel: "shopee", fees: [{ name: "platform support fee", rateBps: my("shopee/support", 500) }, { name: "transaction fee", rateBps: my("shopee/txn", 210) }] },
  ],
});

/**
 * Partial ID pack (RESEARCHED): the §10.3 facts plus the mock facts an ID compile reads (approvals for drinkware,
 * apparel and other; the import VAT rate). No entity table (the compiler applies LABELING §3.1), no e-invoicing
 * threshold (e-Faktur follows PKP) and no electrical approval (LABELING §3.6: not in the enum for ID), so an ID
 * electrical intent fails closed with PACK_FACT_MISSING:productApprovals.electrical.
 */
export const TEST_PACK_ID: CountryPackT = CountryPack.parse({
  countryCode: "ID",
  version: "test-2026.10.16",
  tier: "RESEARCHED",
  currency: "IDR",
  reserveFloorBps: id("reserve-floor", 50),
  registrations: [
    { code: "NIB_OSS", entityTypes: [], requirement: id("reg/nib", "Business identification number via OSS"), cost: id("reg/nib-cost", "0") },
    { code: "NPWP_NIK", entityTypes: [], requirement: id("reg/npwp", "NIK is the tax ID since 1 Jul 2024"), cost: id("reg/npwp-cost", "0") },
    { code: "PKP", entityTypes: [], requirement: id("reg/pkp", "VAT above Rp4.8bn"), cost: id("reg/pkp-cost", "0") },
  ],
  incomeTax: {
    summary: id("pph", "0.5% final tax for individuals and one-person PTs (PP 20/2026)"),
    finalRateBps: id("pph/rate", 50),
    finalRateEntityTypes: ["perorangan", "pt_perorangan"],
  },
  indirectTax: { rate: id("ppn/rate", 1100), registrationThreshold: id("pkp/threshold", "480000000000") },
  imports: {
    taxBase: id("imports/base", "CIF"),
    dutySources: [id("imports/tariff", "BTKI")],
    ftaCertificates: [{ route: "FORM_E", partnerCountry: "CN", name: id("imports/form-e", "Form E (ACFTA)"), dutyRateBps: id("imports/form-e-rate", 0) }],
  },
  productApprovals: {
    drinkware_food_contact: { agency: id("appr/drink", "NONE"), cost: id("appr/drink-cost", "0"), time: id("appr/drink-time", 0) },
    cosmetics: { agency: id("appr/bpom", "BPOM"), cost: id("appr/bpom-cost", "0"), time: id("appr/bpom-time", 60) },
    food: { agency: id("appr/halal", "BPJPH_HALAL"), cost: id("appr/halal-cost", "0"), time: id("appr/halal-time", 30) },
    apparel: { agency: id("appr/apparel", "NONE"), cost: id("appr/apparel-cost", "0"), time: id("appr/apparel-time", 0) },
    other: { agency: id("appr/other", "NONE"), cost: id("appr/other-cost", "0"), time: id("appr/other-time", 0) },
  },
});

/** A tier-RESEARCHED MY pack with nothing but the floor (the compiler and landed cost must fail closed on it). */
export const TEST_PACK_MY_MINIMAL: CountryPackT = CountryPack.parse({
  countryCode: "MY",
  version: "test-minimal",
  tier: "RESEARCHED",
  currency: "MYR",
  reserveFloorBps: my("reserve-floor-min", 300),
});
