/**
 * Re-check keccak LOW 3 / INFO: the live API computes the WEB_TERMS quoteHash and the payout channel with core
 * (webQuoteHash, WEB_PAYOUT_CHANNEL). terms-checks.ts still carries its own copies (owned elsewhere); they must stay
 * equal to core until they re-export it.
 */
import { describe, expect, it } from "vitest";
import { TERMS_PRESET_MILESTONES, WEB_PAYOUT_CHANNEL, webQuoteHash, type MilestoneInput } from "@hogee/core";
import { MOCK_ONLY_CHANNEL, payoutAccountOf, webQuoteHash as termsChecksQuoteHash } from "../src/services/terms-checks";

describe("WEB_TERMS quoteHash and payout channel: core is the one source", () => {
  const base = {
    termsId: "terms-0199f1aa-0000-7000-8000-000000000001",
    supplierId: "supplier-wabcdefghijkl",
    shortlistHash: `0x${"AB".repeat(32)}`,
    chosenIndex: 2,
    currency: "SGD",
    totalMinor: "400000",
    milestones: TERMS_PRESET_MILESTONES.P30_70 as readonly MilestoneInput[],
    payeeType: "company",
    payoutAccountHash: `0x${"Cd".repeat(32)}`,
  };

  it("terms-checks' copies equal core", () => {
    expect(termsChecksQuoteHash(base)).toBe(webQuoteHash(base));
    expect(MOCK_ONLY_CHANNEL).toBe(WEB_PAYOUT_CHANNEL);
    expect(payoutAccountOf({ accountNumber: "100200300400", holderName: "Example Co., Ltd." }).channel).toBe(WEB_PAYOUT_CHANNEL);
  });
});
