/**
 * The templated enquiry the founder copies and sends herself (Hogee never sends it). Built from enums and the quantity
 * only: no listing text, no seller name, no budget, no founder details. It asks for the facts the terms step needs:
 * unit price at the quantity, MOQ, lead time, the product's test reports, milestone payments (a deposit, then the
 * balance after a delivery check) and payment to a company bank account. Every string passes the wording lint
 * (core/test/search-enquiry.test.ts).
 */
import type { CurrencyCode, ProductCategory, SupplierId } from "../schemas";
import { DataEnquiry } from "../schemas/chat";

export interface EnquiryInput {
  readonly supplierIds: readonly SupplierId[];
  readonly productCategory: ProductCategory;
  readonly quantity: number;
  readonly currency: CurrencyCode;
}

/** What the enquiry calls the product (plural), per category. */
const PRODUCT: { readonly [P in ProductCategory]: string } = {
  drinkware_food_contact: "insulated stainless steel tumblers",
  cosmetics: "cosmetic products",
  electrical: "household electrical appliances",
  apparel: "apparel items",
  food: "packaged food products",
  other: "units of the product in your listing",
};

/** Which test reports to ask for, per category. */
const REPORTS: { readonly [P in ProductCategory]: string } = {
  drinkware_food_contact: "food-contact test reports for this product (for example LFGB, FDA or GB 4806) from a third-party lab",
  cosmetics: "product safety and ingredient test reports from a third-party lab",
  electrical: "electrical safety test reports for this product from a third-party lab",
  apparel: "fabric composition and safety test reports, if you have them",
  food: "food safety test reports and the manufacturing licence for this product",
  other: "any third-party test reports for this product",
};

const MAX_QUANTITY = 100_000;
const grouped = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function buildEnquiry(input: EnquiryInput): DataEnquiry {
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > MAX_QUANTITY) throw new RangeError("buildEnquiry: quantity must be 1-100,000");
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new RangeError("buildEnquiry: currency must be an ISO 4217 code");
  const product = PRODUCT[input.productCategory];
  const qty = grouped(input.quantity);
  const body = [
    "Hello,",
    "",
    `I would like a quote for ${qty} ${product}. Please reply with:`,
    `1. Your unit price at ${qty} pieces, and the currency (${input.currency} or USD).`,
    "2. Your minimum order quantity (MOQ).",
    "3. Your production lead time after the order and after sample approval.",
    `4. ${REPORTS[input.productCategory].charAt(0).toUpperCase()}${REPORTS[input.productCategory].slice(1)}.`,
    "5. Whether you accept milestone payments: a deposit when the order is placed, and the balance after the goods are delivered and checked.",
    "6. Confirmation that payment goes to a company bank account in your registered company name.",
    "",
    "Thank you.",
  ].join("\n");
  return DataEnquiry.parse({ supplierIds: [...input.supplierIds], subject: `Quote request: ${qty} ${product}`, body });
}
