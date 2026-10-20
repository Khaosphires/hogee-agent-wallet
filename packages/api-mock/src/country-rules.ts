/**
 * The country rules the mock shows: Mei's SG plan, and the off-chain country-switch previews (project.md §10.3).
 * The SG and MY texts and rule ids are the plan compiler's own output (core compilePlan: Mei on core's SG test pack,
 * Rina on data/country-packs/MY.json), so the mock never words a rule differently from the live API. Every source
 * here is labelled mock / tier3 with an example.invalid URL: the mock holds no country pack, so it claims no
 * retrieved source. ID stays "switch only" (spec), as before. Display order: the registration step first.
 */
import type { CountryCode, EntityType, PlanRule } from "@hogee/core";
import { mockHash } from "./mock-hash";

const RETRIEVED_AT = "2026-10-16T00:00:00Z";

/** A rule cited from the (mock) country pack at `pointer`. */
const packRule = (country: CountryCode, ruleId: string, text: string, pointer: string): PlanRule => ({
  ruleId,
  text,
  sourceRef: pointer,
  source: {
    sourceUrl: `https://example.invalid/mock/country-pack/${country}${pointer}`,
    retrievedAt: RETRIEVED_AT,
    snippetHash: mockHash(`snippet:${country}:${ruleId}`),
    evidence: "tier3",
    sourceType: "mock",
  },
});

/** A rule the compiler or the constitution states itself (no pack source), as compilePlan emits it. */
const ownRule = (ruleId: string, text: string, sourceRef: string): PlanRule => ({ ruleId, text, sourceRef });

const sg = (ruleId: string, text: string, pointer: string) => packRule("SG", ruleId, text, pointer);
const my = (ruleId: string, text: string, pointer: string) => packRule("MY", ruleId, text, pointer);
const id = (ruleId: string, text: string, pointer: string) => packRule("ID", ruleId, text, pointer);

const RESERVE_TEXT = "Sales reserve 5.00% of each sale (tax set-aside policy 5.00%; pack floor 3.00%; facility floor 3.00%).";

/** Mei (sg_sole_prop, drinkware from CN, Shopee SG). SG-DECISIONS 22:50: the free SFA importer registration is a step. */
const SG_RULES: readonly PlanRule[] = [
  sg("registration.acra_business.fee.11500", "Register: ACRA business registration, government fee SGD 115.00; paid by the founder before funding.", "/registrations/0/cost"),
  sg("entity.sg_sole_prop", "Business type: sole proprietorship.", "/entities/0/eligibility"),
  sg("indirect-tax.not-registered", "No GST registration at launch: a reseller below SGD 1,000,000.00 turnover.", "/indirectTax/registrationThreshold"),
  sg("einvoicing.not-required", "E-invoicing (InvoiceNow) not required: it is for GST-registered businesses, and there is no GST registration at launch.", "/indirectTax/registrationThreshold"),
  sg("duty.mfn", "Import from CN at the MFN tariff rate: duty 0.00% for drinkware_food_contact.", "/imports/mfnDutyRateBps/drinkware_food_contact"),
  sg("import-tax.rate", "Import GST 9.00% on CIF + duty.", "/indirectTax/rate"),
  sg("approval.sfa.fee.0", "Product approval: SFA, fee SGD 0.00 for 1 product.", "/productApprovals/drinkware_food_contact/cost"),
  sg("reserve.policy", RESERVE_TEXT, "/reserveFloorBps"),
  // SG-DECISIONS (sg-research-b): Shopee SG commission 1417 bps, transaction fee 327 bps.
  sg("marketplace.shopee.fees", "shopee fees: commission fee 14.17%, transaction fee 3.27%.", "/marketplaces/0/fees/0/rateBps"),
];

/** Rina (sole_prop, drinkware from CN, Shopee MY), compiled against MY.json. */
const MY_RULES: readonly PlanRule[] = [
  my("registration.ssm_sole_prop.fee.6000", "Register: SSM business registration, government fee MYR 60.00; paid by the founder before funding.", "/registrations/0/cost"),
  ownRule("entity.sole_prop", "Business type: sole proprietorship.", "compiler:entity"),
  my("registration.lhdn_tin.fee.0", "Register: LHDN tax identification number, government fee MYR 0.00; paid by the founder before funding.", "/registrations/2/cost"),
  my("indirect-tax.not-registered", "No SST registration at launch: a reseller below MYR 500,000.00 turnover.", "/indirectTax/registrationThreshold"),
  my("einvoicing.not-required", "E-invoicing not required below MYR 3,000,000.00 turnover.", "/eInvoicing/threshold"),
  my("duty.form_e", "Import from CN under Form E (ACFTA): duty 0.00%.", "/imports/ftaCertificates/0/dutyRateBps"),
  my("import-tax.rate", "Import sales tax 10.00% on CIF + duty.", "/indirectTax/rate"),
  my("approval.none", "No product approval needed for drinkware_food_contact.", "/productApprovals/drinkware_food_contact/agency"),
  my("reserve.policy", RESERVE_TEXT, "/reserveFloorBps"),
];

/** Indonesia is "switch only" in the spec: unchanged mock rules until an ID pack is verified. */
const ID_RULES: readonly PlanRule[] = [
  id("id.tax-id.nik", "Your NIK (national ID number) is also your tax ID (NPWP) since 1 July 2024.", "/taxIds/0"),
  id("id.income-tax.final-0-5", "A 0.5% final tax on turnover applies to individuals and one-person PTs; turnover up to Rp500m a year is exempt.", "/incomeTax/finalRate"),
  id("id.entity.cv-pt-loses-final", "A CV or a regular PT loses the 0.5% final tax, so the plan keeps you as an individual business (perorangan).", "/entities/2/eligibility"),
  id("id.vat.pkp-threshold", "VAT registration (PKP) is required above Rp4.8bn turnover a year.", "/indirectTax/registrationThreshold"),
  id("id.payments.qris-fee", "QRIS payments of up to Rp500k each carry a 0% merchant fee from 1 October 2026.", "/paymentRails/0"),
];

/** Rules compilePlan states without a pack, the same for every country (Mei's and Rina's numbers are equal). */
export const PLAN_OWN_RULES: readonly PlanRule[] = [
  ownRule("ads.pacing", "Ads paced at 75 BU/day: 8 daily slots fit the 600 BU cap of each 7-day window, one slot spare for timing.", "compiler:ads-pacing"),
  ownRule("stage.gate", "Stage 1 releases 4,000 BU at signing; stage 2 (6,000 BU) needs sales of 2,000 BU by 2026-11-15 and the loan officer's signature.", "compiler:stage-gate"),
  ownRule("constitution.caps", "Every line: at most 25% per payment and 50% per 7-day window.", "constitution:PER_TX_CAP_OVER_25PCT"),
  ownRule("constitution.supplier-escrow", "The supplier is paid only through escrow milestones; the balance needs your signature and inspection evidence.", "constitution:SUPPLIER_LINE_NOT_ESCROW"),
  ownRule("constitution.stage1", "At most 40% of the budget is released before the stage gate.", "constitution:STAGE1_OVER_40PCT"),
  ownRule("constitution.payees", "The plan adds no payees: only registered platform accounts and suppliers you approve can be paid.", "constitution:PLAN_ADDS_PAYEE"),
];

export interface CountryRules {
  readonly countryCode: CountryCode;
  /** The entity the founder's intent becomes in that country (a citizen's sole proprietorship). */
  readonly entityType: EntityType;
  readonly countryPackVersion: string;
  readonly rules: readonly PlanRule[];
}

/** Exhaustive: a new CountryCode is a compile error here until it has a preview. */
export const COUNTRY_RULES: { readonly [C in CountryCode]: CountryRules } = {
  SG: { countryCode: "SG", entityType: "sg_sole_prop", countryPackVersion: "SG-mock", rules: SG_RULES },
  MY: { countryCode: "MY", entityType: "sole_prop", countryPackVersion: "MY-switch-mock", rules: MY_RULES },
  ID: { countryCode: "ID", entityType: "perorangan", countryPackVersion: "ID-switch-mock", rules: ID_RULES },
};

/** The rules of `country`, or a thrown error for a country the mock has none for (never another country's). */
export function countryRulesOf(country: string): CountryRules {
  const found = Object.hasOwn(COUNTRY_RULES, country) ? COUNTRY_RULES[country as CountryCode] : undefined;
  if (!found) throw new Error(`api-mock: no country rules for "${country}"`);
  return found;
}

/** Mei's full plan rules: the SG pack rules, then what the compiler and the constitution state. */
export const MEI_PLAN_RULES: readonly PlanRule[] = [...SG_RULES, ...PLAN_OWN_RULES];
