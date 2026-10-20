/**
 * The web search query (VISION-DECISIONS §9): built ONLY from the committed plan's productCategory and buyFrom, two
 * enums, through fixed tables. Nothing the founder typed and nothing a listing said can reach it (T33): the value is
 * labelled trusted at its source (the committed plan) and leaves through outboundArgSink, which refuses anything else.
 */
import type { ProductCategory } from "../schemas/enums";
import type { PlanIntent } from "../schemas/plan";
import { outboundArgSink, trusted } from "../taint/labels";

/** Product words per category. `other` has none: a generic query would not find the founder's product. */
export const QUERY_BY_CATEGORY: { readonly [P in ProductCategory]: string | null } = {
  drinkware_food_contact: "insulated stainless steel tumbler manufacturer",
  cosmetics: "cosmetics OEM manufacturer",
  electrical: "small household electrical appliance manufacturer",
  apparel: "apparel garment manufacturer",
  food: "packaged food manufacturer",
  other: null,
};

/** Sourcing countries the query can name (ISO 3166-1 alpha-2 → English name). Anything else is not searched. */
export const COUNTRY_NAME: Readonly<Record<string, string>> = {
  CN: "China",
  VN: "Vietnam",
  TH: "Thailand",
  MY: "Malaysia",
  ID: "Indonesia",
  SG: "Singapore",
  IN: "India",
  TW: "Taiwan",
  KR: "South Korea",
  JP: "Japan",
  BD: "Bangladesh",
  TR: "Turkey",
};

/** The quantity a search assumes when the founder named none (Mei's 1,000 tumblers; the card shows it). */
export const DEFAULT_SEARCH_QUANTITY = 1000;

/** Provenance of the query value: the committed plan's intent (the founder signed it; no free text in it). */
export const QUERY_SOURCE = "db:plans:committed-intent";

/**
 * `QUERY_BY_CATEGORY[productCategory] + " " + COUNTRY_NAME[buyFrom]` through outboundArgSink(trusted(...)), or null
 * when the category or the country has no fixed words (the search is then refused, never improvised).
 */
export function supplierQuery(intent: Pick<PlanIntent, "productCategory" | "buyFrom">): string | null {
  const product = Object.hasOwn(QUERY_BY_CATEGORY, intent.productCategory) ? QUERY_BY_CATEGORY[intent.productCategory] : null;
  const country = Object.hasOwn(COUNTRY_NAME, intent.buyFrom) ? COUNTRY_NAME[intent.buyFrom] : undefined;
  if (!product || !country) return null;
  return outboundArgSink(trusted(`${product} ${country}`, QUERY_SOURCE));
}
