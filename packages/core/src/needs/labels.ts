/**
 * The checklist's own wording: names for codes the draft and the pack carry. Labels only; every fee, rate, duration and
 * requirement in a checklist comes from the draft or the pack. Every string passes scripts/lint-wording (needs.test.ts).
 *
 * Where a label mirrors another module (the agent's question labels, the API payee catalog), the source is named, so a
 * change there is easy to follow here.
 */
import type { CountryCode, LineKey, ProductApproval, ProductCategory, Registration, SellChannel } from "../schemas/enums";

/** Registration titles (the compiler's own REGISTRATION_LABEL in compiler/compliance.ts is not exported). */
export const REGISTRATION_TITLE: { readonly [R in Registration]: string } = {
  SSM_SOLE_PROP: "SSM business registration",
  SSM_SDN_BHD: "SSM incorporation",
  LHDN_TIN: "LHDN tax identification number",
  SST: "SST registration",
  MYINVOIS: "MyInvois e-invoicing",
  PBT_LICENCE: "Local council premises licence",
  NIB_OSS: "NIB business number (OSS)",
  NPWP_NIK: "NPWP tax number (NIK)",
  PKP: "PKP VAT registration",
  ACRA_BUSINESS: "Register your business (ACRA, Singapore's business registry)",
  ACRA_PTE_LTD: "ACRA incorporation",
  IRAS_GST: "Register for GST, Singapore's sales tax (IRAS)",
};

/**
 * Product-approval titles. SFA: for food-contact articles the SFA step is an importer registration (SG-DECISIONS,
 * "Correction from research", 22:50). The other agencies keep the compiler's neutral wording ("Product approval: X").
 */
export const APPROVAL_TITLE: { readonly [A in Exclude<ProductApproval, "NONE">]: string } = {
  NPRA: "NPRA product approval",
  ST_SIRIM: "ST / SIRIM product approval",
  JAKIM_HALAL: "JAKIM halal approval",
  BPOM: "BPOM product approval",
  BPJPH_HALAL: "BPJPH halal approval",
  KKM_FOOD: "KKM food product approval",
  SFA: "Register as an importer of food-contact items (SFA, Singapore's food agency)",
  HSA: "HSA product approval",
  CPSO_SAFETY_MARK: "CPSO Safety Mark approval",
};

/** Mirrors the agent planner's CATEGORY_LABEL (packages/agent/src/planner/questions.ts). */
export const CATEGORY_LABEL: { readonly [C in ProductCategory]: string } = {
  drinkware_food_contact: "Drinkware or food-contact items",
  cosmetics: "Cosmetics",
  electrical: "Electrical goods",
  apparel: "Clothing",
  food: "Food",
  other: "Other products",
};

/** Mirrors the agent planner's COUNTRY_LABEL. */
export const COUNTRY_LABEL: { readonly [C in CountryCode]: string } = { MY: "Malaysia", ID: "Indonesia", SG: "Singapore" };

/** Pocket titles; the names match every other map (UX-PLAN §5: Supplier, Packaging, Delivery, Ads, Marketplace fees, Licence fees, Safety buffer). */
export const LINE_TITLE: { readonly [K in LineKey]: string } = {
  SUPPLIER: "Supplier budget",
  PACKAGING: "Packaging budget",
  LOGISTICS: "Delivery budget",
  ADS: "Ads budget",
  PLATFORM_FEES: "Marketplace fees budget",
  LICENSING: "Licence fees budget",
  CONTINGENCY: "Safety buffer",
};

/** The pocket names used inside details ("from your Packaging pocket"). */
export const LINE_NAME: { readonly [K in LineKey]: string } = {
  SUPPLIER: "Supplier",
  PACKAGING: "Packaging",
  LOGISTICS: "Delivery",
  ADS: "Ads",
  PLATFORM_FEES: "Marketplace fees",
  LICENSING: "Licence fees",
  CONTINGENCY: "Safety buffer",
};

/**
 * Plain words for the compiler's pocket purposes (REWRITES A3.22). The compiler's own strings are inside the signed
 * plan (planHash), so they are never edited (UX-PLAN D19): this checklist shows these instead, keyed by the exact
 * compiler text, and falls back to that text for anything unmapped.
 */
export const PLAIN_PURPOSE: Readonly<Record<string, string>> = {
  "Goods from the chosen supplier (escrow milestones only)": "Your stock, from the supplier you choose. Paid in steps, held until delivery",
  "Custom printed packaging": "Custom printed packaging",
  "Inbound freight and last-mile delivery": "Shipping your stock to you, and delivery to your buyers",
  "Marketplace ads, paced daily": "Ads on the marketplace, spread out day by day",
  "Marketplace platform and transaction fees": "The fees the marketplace charges on each sale",
  "Mandatory product approval fees": "Fees for product approvals you must get",
  "Unplanned costs (owner-approved payees only)": "A safety buffer for surprise costs (only to people you approve)",
  "Online ads for the shop website, paced daily": "Ads for your shop website, spread out day by day",
};

/** Counterparties the founder finds for a line with no payee in the plan (VISION-DECISIONS §8: non-platform payee lines). */
export const COUNTERPARTY_TITLE = {
  SUPPLIER: "Find a product supplier",
  PACKAGING: "Find a packaging printer",
  LOGISTICS: "Find a delivery company",
} as const satisfies Partial<Record<LineKey, string>>;
export type CounterpartyLine = keyof typeof COUNTERPARTY_TITLE;
/** Fixed key order within the SUPPLIER group (LINE_KEYS order). */
export const COUNTERPARTY_LINES: readonly CounterpartyLine[] = ["SUPPLIER", "PACKAGING", "LOGISTICS"];

/** Mirrors the agent planner's sell-channel options. */
export const SELLER_ACCOUNT_TITLE: { readonly [S in SellChannel]: string } = {
  shopee: "Shopee seller account",
  tiktok_shop: "TikTok Shop seller account",
  lazada: "Lazada seller account",
  own_site: "Your own shop website",
};
export const CHANNEL_NAME: { readonly [S in SellChannel]: string } = {
  shopee: "Shopee",
  tiktok_shop: "TikTok Shop",
  lazada: "Lazada",
  own_site: "your own website",
};

/**
 * The pack rail each country's payees are paid on: the API payee catalog's channel per country
 * (packages/api/src/catalog/payees.ts PAYOUT_CHANNEL_BY_COUNTRY: MY_DUITNOW, SG_PAYNOW; SG-DECISIONS "Payments and
 * money"). ID has no payee set, so no rail.
 */
export const PAYOUT_RAIL_BY_COUNTRY: { readonly [C in CountryCode]: string | null } = { MY: "DUITNOW", ID: null, SG: "PAYNOW" };
export const RAIL_NAME: Readonly<Record<string, string>> = { DUITNOW: "DuitNow", PAYNOW: "PayNow" };
/** SG-DECISIONS (sg-research-b): SG payouts run on the worker's MockRail; never claim a real PayNow payout. */
export const SIMULATED_PAYOUT_RAILS: ReadonlySet<string> = new Set(["PAYNOW"]);

/**
 * The reserve's tax payee per country: the API payee catalog's static tax payee (lhdn-tax / iras-tax), the only
 * destination of WITHDRAW_RESERVE (catalog taxPayeeFor). ID has no payee set, so no payee is named.
 */
export const TAX_PAYEE_NAME: { readonly [C in CountryCode]: string | null } = { MY: "LHDN tax payment", ID: null, SG: "IRAS tax payment" };
/** The tax office the reserve pays, by name ("This money can only go to IRAS, to pay your tax"). */
export const TAX_OFFICE_NAME: { readonly [C in CountryCode]: string | null } = { MY: "LHDN", ID: null, SG: "IRAS" };
