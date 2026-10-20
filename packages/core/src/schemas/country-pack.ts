/**
 * CountryPack (project.md §10.1, §26.5, §26.8). File: data/country-packs/<CC>.json.
 *
 * Every FACT is a `Sourced` leaf. Pack metadata (countryCode, version, tier, currency) and structural
 * keys (entity `type`, registration `code`, marketplace `channel`, ...) are plain values.
 *
 * G0-DECISION: money facts in a pack are `Minor` in the pack's own `currency` minor units
 * (D16: all money is integer minor units). RM3,000,000 is therefore "300000000", not "3000000"
 * as in the §26.8 illustration. Rates are integer basis points; durations are integer days.
 */
import { z } from "zod";
import {
  CountryCode,
  CountryPackTier,
  DutyRoute,
  ENTITY_TYPES_BY_COUNTRY,
  EntityType,
  PRODUCT_APPROVALS_BY_COUNTRY,
  PRODUCT_CATEGORIES,
  ProductApproval,
  REGISTRATIONS_BY_COUNTRY,
  Registration,
  Residency,
  SellChannel,
} from "./enums";
import { Bps, CurrencyCode, Iso2, Minor, partialKeyed, sourced } from "./primitives";

const Days = z.number().int().min(0).describe("Duration in days");
const Text = z.string().min(1).max(2000);

// G0-DECISION: §10.1 leaves entity/registration/tax structures vague; this is the minimal machine-usable
// shape the compiler needs. Additive fields can follow at a gate.
export const CountryPackEntity = z.strictObject({
  type: EntityType,
  cost: sourced(Minor).describe("Registration cost, pack-currency minor units"),
  eligibility: sourced(z.array(Residency).min(1)).describe("Residencies allowed to use this entity type"),
  liability: sourced(z.enum(["limited", "unlimited"])),
});
export type CountryPackEntity = z.infer<typeof CountryPackEntity>;

export const CountryPackRegistration = z.strictObject({
  code: Registration,
  entityTypes: z.array(EntityType).describe("Entity types this applies to; empty = all"),
  requirement: sourced(Text).describe("When it is required, e.g. 'register within 30 days'"),
  cost: sourced(Minor),
});
export type CountryPackRegistration = z.infer<typeof CountryPackRegistration>;

export const CountryPackTaxId = z.strictObject({
  code: Registration.describe("Registration code that assigns the tax id, e.g. LHDN_TIN, NPWP_NIK"),
  rule: sourced(Text),
});
export type CountryPackTaxId = z.infer<typeof CountryPackTaxId>;

export const CountryPackIncomeTax = z.strictObject({
  summary: sourced(Text),
  finalRateBps: sourced(Bps).optional().describe("Final/presumptive turnover tax rate, e.g. ID 0.5% = 50"),
  finalRateEntityTypes: z.array(EntityType).optional().describe("Entity types eligible for finalRateBps"),
  exemptTurnover: sourced(Minor).optional().describe("Turnover below which income tax is exempt"),
});
export type CountryPackIncomeTax = z.infer<typeof CountryPackIncomeTax>;

// rate/registrationThreshold are individually optional so a partial pack (e.g. ID: PKP threshold only)
// validates; VERIFIED packs must carry both (see CountryPack refinement).
export const CountryPackIndirectTax = z.strictObject({
  rate: sourced(Bps).optional(),
  registrationThreshold: sourced(Minor).optional(),
});
export type CountryPackIndirectTax = z.infer<typeof CountryPackIndirectTax>;

export const CountryPackEInvoicing = z.strictObject({
  threshold: sourced(Minor).describe("Turnover threshold, pack-currency minor units"),
});
export type CountryPackEInvoicing = z.infer<typeof CountryPackEInvoicing>;

export const CountryPackFtaCertificate = z.strictObject({
  route: DutyRoute,
  partnerCountry: Iso2,
  name: sourced(Text).describe("Certificate name, e.g. Form E (ACFTA)"),
  dutyRateBps: sourced(Bps),
});
export type CountryPackFtaCertificate = z.infer<typeof CountryPackFtaCertificate>;

export const CountryPackImports = z.strictObject({
  taxBase: sourced(z.enum(["CIF", "FOB"])),
  dutySources: z.array(sourced(Text)).describe("Where duty rates come from (tariff finder, gazette)"),
  ftaCertificates: z.array(CountryPackFtaCertificate),
  // SG-CORE (additive): the MFN duty rate per product category, for a country where one sourced rate covers the whole
  // category (SG levies customs duty only on a short list of goods). Missing category = unknown: landed cost then needs
  // the rate from the caller, never 0. MY and ID take MFN rates per tariff line from the caller instead.
  mfnDutyRateBps: partialKeyed(PRODUCT_CATEGORIES, sourced(Bps))
    .optional()
    .describe("MFN ad valorem duty per product category (only where one rate covers the category)"),
});
export type CountryPackImports = z.infer<typeof CountryPackImports>;

export const CountryPackProductApproval = z.strictObject({
  agency: sourced(ProductApproval),
  cost: sourced(Minor),
  time: sourced(Days).describe("Typical approval time in days"),
});
export type CountryPackProductApproval = z.infer<typeof CountryPackProductApproval>;

export const CountryPackPaymentRail = z.strictObject({
  id: z.string().regex(/^[A-Z][A-Z0-9_]{0,31}$/).describe("Rail id, e.g. DUITNOW, QRIS"),
  feeBps: sourced(Bps),
  feeCondition: sourced(Text).optional().describe("e.g. '0% up to Rp500k per transaction'"),
});
export type CountryPackPaymentRail = z.infer<typeof CountryPackPaymentRail>;

export const CountryPackMarketplace = z.strictObject({
  channel: SellChannel,
  fees: z.array(
    z.strictObject({
      name: z.string().min(1).max(80).describe("e.g. platform support fee, transaction fee"),
      rateBps: sourced(Bps),
    }),
  ),
});
export type CountryPackMarketplace = z.infer<typeof CountryPackMarketplace>;

// G0-DECISION: §10.2 lists PDPA facts but §10.1 has no slot for them; added as an optional block.
export const CountryPackDataProtection = z.strictObject({
  summary: sourced(Text),
  breachNotificationHours: sourced(z.number().int().min(0)).optional(),
});
export type CountryPackDataProtection = z.infer<typeof CountryPackDataProtection>;

// G0-DECISION: only metadata + reserveFloorBps are always required. Every fact section is optional so a
// RESEARCHED/UNKNOWN pack (e.g. ID with only the §10.3 facts) validates; a VERIFIED pack must contain all
// core sections (enforced below).
export const VERIFIED_PACK_REQUIRED_SECTIONS = [
  "entities",
  "registrations",
  "taxIds",
  "incomeTax",
  "indirectTax",
  "eInvoicing",
  "imports",
  "productApprovals",
  "marketplaces",
] as const;
export type VerifiedPackSection = (typeof VERIFIED_PACK_REQUIRED_SECTIONS)[number];

/**
 * SG-CORE: sections a country's pack must NOT carry because the country has no such rule. SG e-invoicing (InvoiceNow)
 * follows GST registration, not a turnover threshold, so an SG pack has no `eInvoicing.threshold`; a VERIFIED SG pack
 * is complete without it. MY and ID are unchanged (a VERIFIED pack still needs eInvoicing).
 */
export const PACK_SECTIONS_NOT_APPLICABLE: { readonly [C in CountryCode]: readonly VerifiedPackSection[] } = {
  MY: [],
  ID: [],
  SG: ["eInvoicing"],
};

export const CountryPack = z
  .strictObject({
    countryCode: CountryCode,
    version: z.string().min(1).max(64),
    tier: CountryPackTier,
    currency: CurrencyCode,
    // G0-DECISION: reserveFloorBps is a fact, so it is Sourced (the MY 300 bps is a labelled demo assumption, tier3).
    reserveFloorBps: sourced(Bps),
    entities: z.array(CountryPackEntity).min(1).optional(),
    registrations: z.array(CountryPackRegistration).optional(),
    taxIds: z.array(CountryPackTaxId).optional(),
    incomeTax: CountryPackIncomeTax.optional(),
    indirectTax: CountryPackIndirectTax.optional(),
    eInvoicing: CountryPackEInvoicing.optional(),
    imports: CountryPackImports.optional(),
    // G0-DECISION: keyed by productCategory but partial (a missing category = unknown; the compiler flags it).
    productApprovals: partialKeyed(PRODUCT_CATEGORIES, CountryPackProductApproval).optional(),
    paymentRails: z.array(CountryPackPaymentRail).optional(),
    marketplaces: z.array(CountryPackMarketplace).optional(),
    dataProtection: CountryPackDataProtection.optional(),
  })
  .superRefine((pack, ctx) => {
    const allowed = ENTITY_TYPES_BY_COUNTRY[pack.countryCode];
    const check = (type: EntityType, path: (string | number)[]) => {
      if (!allowed.includes(type)) {
        ctx.addIssue({ code: "custom", path, message: `entity type ${type} is not valid for ${pack.countryCode}` });
      }
    };
    pack.entities?.forEach((e, i) => check(e.type, ["entities", i, "type"]));
    pack.registrations?.forEach((r, i) => r.entityTypes.forEach((t, j) => check(t, ["registrations", i, "entityTypes", j])));
    pack.incomeTax?.finalRateEntityTypes?.forEach((t, i) => check(t, ["incomeTax", "finalRateEntityTypes", i]));
    const codes = REGISTRATIONS_BY_COUNTRY[pack.countryCode];
    const checkCode = (code: Registration, path: (string | number)[]) => {
      if (!codes.includes(code)) ctx.addIssue({ code: "custom", path, message: `registration ${code} is not valid for ${pack.countryCode}` });
    };
    pack.registrations?.forEach((r, i) => checkCode(r.code, ["registrations", i, "code"]));
    pack.taxIds?.forEach((t, i) => checkCode(t.code, ["taxIds", i, "code"]));
    const agencies = PRODUCT_APPROVALS_BY_COUNTRY[pack.countryCode];
    for (const category of PRODUCT_CATEGORIES) {
      const agency = pack.productApprovals?.[category]?.agency.value;
      if (agency !== undefined && !agencies.includes(agency)) {
        ctx.addIssue({ code: "custom", path: ["productApprovals", category, "agency", "value"], message: `approval ${agency} is not valid for ${pack.countryCode}` });
      }
    }
    const notApplicable = PACK_SECTIONS_NOT_APPLICABLE[pack.countryCode];
    for (const section of notApplicable) {
      if (pack[section] !== undefined) {
        ctx.addIssue({ code: "custom", path: [section], message: `${pack.countryCode} has no ${section} rule of this shape; leave the section out` });
      }
    }
    if (pack.tier !== "VERIFIED") return;
    for (const section of VERIFIED_PACK_REQUIRED_SECTIONS) {
      if (notApplicable.includes(section)) continue;
      if (pack[section] === undefined) {
        ctx.addIssue({ code: "custom", path: [section], message: `VERIFIED packs must include ${section}` });
      }
    }
    if (pack.indirectTax && (!pack.indirectTax.rate || !pack.indirectTax.registrationThreshold)) {
      ctx.addIssue({ code: "custom", path: ["indirectTax"], message: "VERIFIED packs need indirectTax.rate and registrationThreshold" });
    }
  });
export type CountryPack = z.infer<typeof CountryPack>;
