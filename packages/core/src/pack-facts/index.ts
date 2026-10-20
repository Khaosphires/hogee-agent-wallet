/**
 * Missing country-pack facts fail closed. The compiler and the landed-cost code never put a default in place of a pack
 * fact they need: they refuse with `PACK_FACT_MISSING:<leaf>[,<leaf>...]`, where each <leaf> names what
 * data/country-packs/<CC>.json must add (a dotted path; list entries are named by their structural key):
 *
 *   registrations.<CODE>.cost             no registration with that code
 *   registrations.<CODE>[<entity>].cost   entries with that code exist, but none applies to that entity type
 *   indirectTax.registrationThreshold     launch-scale turnover is compared with it (LABELING §2.1, §3.3)
 *   eInvoicing.threshold                  the same comparison for MyInvois (MY; ID e-Faktur follows PKP and SG
 *                                         InvoiceNow follows GST, §3.4, so neither needs it)
 *   indirectTax.rate                      import sales tax / VAT / GST on CIF + duty, for any imported goods
 *   productApprovals.<category>           the approval agency (and its fee) for the product category
 *   imports.ftaCertificates               decides the CN route (Form E or MFN) and its duty rate
 *   imports.taxBase                       the duty base (CIF or FOB) in landed cost
 *   imports.mfnDutyRateBps.<category>     the MFN duty rate in landed cost when the caller passes none (code
 *                                         MFN_RATE_REQUIRED, not INVALID_INPUT)
 */
import type { CountryPack } from "../schemas/country-pack";
import type { EntityType, ProductCategory, Registration } from "../schemas/enums";

export const PACK_FACT_MISSING = "PACK_FACT_MISSING";

export const PackLeaf = {
  /** Pass `entity` when the pack lists the code for other entity types only. */
  registrationCost: (code: Registration, entity?: EntityType): string => (entity ? `registrations.${code}[${entity}].cost` : `registrations.${code}.cost`),
  indirectTaxThreshold: "indirectTax.registrationThreshold",
  eInvoicingThreshold: "eInvoicing.threshold",
  indirectTaxRate: "indirectTax.rate",
  productApproval: (category: ProductCategory): string => `productApprovals.${category}`,
  ftaCertificates: "imports.ftaCertificates",
  importsTaxBase: "imports.taxBase",
  mfnDutyRate: (category: ProductCategory): string => `imports.mfnDutyRateBps.${category}`,
} as const;

/** `PACK_FACT_MISSING:<leaf>[,<leaf>...] (<CC> pack <version>; <context>): ...` */
export function packFactMissingMessage(leaves: readonly string[], pack: Pick<CountryPack, "countryCode" | "version">, context: string): string {
  const these = leaves.length === 1 ? "this fact" : "these facts";
  return `${PACK_FACT_MISSING}:${leaves.join(",")} (${pack.countryCode} pack ${pack.version}; ${context}): the pack does not carry ${these}, and nothing is assumed in place of a missing fact`;
}
