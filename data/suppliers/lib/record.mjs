/**
 * Builds one Supplier record (packages/core/src/schemas/supplier.ts, frozen) and its raw listing text from a compact
 * spec. Every listing fact the record carries is also a sentence in the raw text (price → fobUnit.snippetHash), and
 * every record is marked mock: listing.sourceType "mock", fobUnit sourceType "mock" (its tier is simulated: tier3 unless
 * the spec sets priceTier), example.invalid URLs and a "do not pay" test payout account.
 */
import { cny, lineOf, listingText, mockSourced } from "./text.mjs";

/** Fixed generation date for every Sourced leaf (no clock: reruns are byte-identical). */
export const RETRIEVED_AT = "2026-10-18T00:00:00Z";
export const PRODUCT_LINE = "350 ml double-wall insulated tumbler, BPA-free PP inner wall, screw lid with straw.";

/** Standard listing lines for an offer; `extra` lines follow the payment line and `tail` lines end the text. */
export function offerLines(s) {
  const lines = [
    { key: "marker", text: s.marker },
    { key: "product", text: s.product ?? PRODUCT_LINE },
    { key: "price", text: `Price: CNY ${cny(s.fobFen)} per piece ${s.incoterm} ${s.port}.` },
    { key: "moq", text: `MOQ: ${String(s.moq).replace(/\B(?=(\d{3})+$)/g, ",")} pieces.` },
    { key: "lead", text: `Lead time: ${s.leadTimeDays} days after the sample is approved.` },
    { key: "freight", text: `Sea freight to Singapore or Port Klang: about CNY ${cny(s.freightFen)} per piece.` },
    { key: "payment", text: s.paymentLine ?? "Payment: platform escrow, invoiced by our company." },
    ...(s.extra ?? []),
    ...s.certificates.map((c, i) => ({ key: `cert-${i}`, text: c.line })),
    ...(s.uscc ? [{ key: "uscc", text: `Business licence (USCC): ${s.uscc}.` }] : []),
    ...(s.tail ?? []),
  ];
  return lines;
}

/** { supplier, rawText, spans } for a compact supplier spec. */
export function buildSupplier(s) {
  const lines = offerLines(s);
  const { text, spans } = listingText(lines);
  const supplier = {
    supplierId: s.supplierId,
    displayName: s.displayName,
    country: "CN",
    ids: s.uscc ? { uscc: s.uscc } : {},
    listing: { url: s.url, sourceType: "mock", rawTextRef: s.rawTextRef },
    offer: {
      currency: "CNY",
      fobUnit: mockSourced(String(s.fobFen), `${s.url}#price`, lineOf(lines, "price"), RETRIEVED_AT, s.priceTier),
      moq: s.moq,
      leadTimeDays: s.leadTimeDays,
      freightPerUnit: String(s.freightFen),
      incoterm: s.incoterm,
    },
    terms: { escrow: s.escrow ?? true, offPlatformDiscount: s.offPlatformDiscount ?? false, payeeType: s.payeeType ?? "company" },
    certificates: s.certificates.map((c) => ({ type: c.type, issuer: c.issuer, ref: c.ref, tier: c.tier })),
    metrics: { rating: s.rating, responseRate: s.responseRate, yearsOnPlatform: s.yearsOnPlatform },
    xenditTest: { channel: "MOCK_ONLY", accountNumber: s.accountNumber, holderName: s.holderName },
  };
  return { supplier, rawText: text, spans };
}

/** A certificate claim and the listing sentence that states it. */
export function cert(type, issuer, ref, tier) {
  return { type, issuer, ref, tier, line: `${type}: ref ${ref}, issued by ${issuer}.` };
}
