/**
 * The WEB_TERMS quoteHash (re-check keccak LOW 3): one pure preimage builder in core for the live API and the mock.
 */
import { describe, expect, it } from "vitest";
import { TERMS_PRESET_MILESTONES, hashObject, webQuoteHash, webQuotePreimage } from "../src/index";

const BASE = {
  termsId: "terms-0199f1aa-0000-7000-8000-000000000001",
  supplierId: "supplier-wabcdefghijkl",
  shortlistHash: `0x${"AB".repeat(32)}`,
  chosenIndex: 0,
  currency: "SGD",
  totalMinor: "400000",
  milestones: TERMS_PRESET_MILESTONES.P30_70,
  payeeType: "company",
  payoutAccountHash: `0x${"CD".repeat(32)}`,
};

describe("webQuoteHash", () => {
  it("hashes every confirmed fact under kind WEB_TERMS, hashes lowercased, milestones as {bps, trigger}", () => {
    const pre = webQuotePreimage({ ...BASE, milestones: BASE.milestones.map((m) => ({ ...m, label: "ignored" })) as never });
    expect(pre).toEqual({
      kind: "WEB_TERMS",
      termsId: BASE.termsId,
      supplierId: BASE.supplierId,
      shortlistHash: `0x${"ab".repeat(32)}`,
      chosenIndex: 0,
      currency: "SGD",
      totalMinor: "400000",
      milestones: [
        { bps: 3000, trigger: "ON_ORDER" },
        { bps: 7000, trigger: "ON_DELIVERY_INSPECTED" },
      ],
      payeeType: "company",
      payoutAccountHash: `0x${"cd".repeat(32)}`,
    });
    expect(webQuoteHash(BASE)).toBe(hashObject(pre));
  });

  it("commits to the shortlist hash and every other fact", () => {
    const h = webQuoteHash(BASE);
    expect(webQuoteHash({ ...BASE, shortlistHash: `0x${"ac".repeat(32)}` })).not.toBe(h);
    expect(webQuoteHash({ ...BASE, totalMinor: "400100" })).not.toBe(h);
    expect(webQuoteHash({ ...BASE, chosenIndex: 1 })).not.toBe(h);
    expect(webQuoteHash({ ...BASE, milestones: TERMS_PRESET_MILESTONES.P50_50 })).not.toBe(h);
    expect(webQuoteHash({ ...BASE, payoutAccountHash: `0x${"ce".repeat(32)}` })).not.toBe(h);
  });
});
