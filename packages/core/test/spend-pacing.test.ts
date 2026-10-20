/**
 * SPEND on a pacing line (security audit run-2, fix 4). Treasury.spend reads a pacing line's slot from the invoice
 * hash (`uint(invoiceHash) == lineSequence`), so a pacing spend must carry bytes32(uint256(slot)) and an invoice spend
 * has no place on a pacing line.
 */
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluateProposal, fakeHex32, sequenceInvoiceHash, spendIntentId, stringToBytes32, trusted, type PolicyDecision, type PolicyProposal } from "../src/index";
import { ctxDay1, pacingSpend, spend, withLineState } from "./fixtures/policy-ctx";

const decide = (p: PolicyProposal, ctx = ctxDay1()): PolicyDecision => evaluateProposal(p, ctx);
const adsInvoice = (): PolicyProposal =>
  spend({ lineKey: trusted("ADS", "plan"), payeeId: trusted("shopee-ads", "registry:platform"), amountMinor: trusted("7500", "db:invoice") });

describe("sequenceInvoiceHash (Treasury / packages/chain: bytes32(uint256(slot)))", () => {
  it("left-pads the slot to 32 bytes of lowercase hex", () => {
    expect(sequenceInvoiceHash(0)).toBe(`0x${"0".repeat(64)}`);
    expect(sequenceInvoiceHash(1)).toBe(`0x${"0".repeat(63)}1`);
    expect(sequenceInvoiceHash(255n)).toBe(`0x${"0".repeat(62)}ff`);
    expect(sequenceInvoiceHash(2n ** 256n - 1n)).toBe(`0x${"f".repeat(64)}`);
  });

  it.each([-1, 1.5, Number.NaN, 2 ** 53])("rejects %s", (slot) => {
    expect(() => sequenceInvoiceHash(slot)).toThrow(RangeError);
  });
});

describe("SPEND on a pacing line", () => {
  it("an invoice spend on a pacing line → DENY INVOICE_ON_PACING_LINE (policy code, no matching revert)", () => {
    expect(decide(adsInvoice())).toEqual({ verdict: "DENY", reasonCode: "INVOICE_ON_PACING_LINE", mirrorsRevert: false });
  });

  it("an invoice spend on an invoice line is unaffected", () => {
    expect(decide(spend()).verdict).toBe("AUTO");
  });

  it("a pacing spend must carry its slot's sequence invoice hash", () => {
    expect(decide(pacingSpend(1)).verdict).toBe("AUTO");
    expect(pacingSpend(1).invoiceHash).toBe(sequenceInvoiceHash(1));
    for (const invoiceHash of [fakeHex32("test:not-a-slot"), sequenceInvoiceHash(2), sequenceInvoiceHash(0)]) {
      expect(decide({ ...pacingSpend(1), invoiceHash } as PolicyProposal)).toEqual({ verdict: "DENY", reasonCode: "PACING_HASH_MISMATCH", mirrorsRevert: false });
    }
  });

  it("property: on a pacing line only (slot, bytes32(slot)) at the next sequence is AUTO", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), fc.integer({ min: 0, max: 45 }), fc.integer({ min: 0, max: 45 }), (next, slot, hashSlot) => {
        const ctx = withLineState(ctxDay1(), "ADS", { nextSequence: next });
        const d = decide({ ...pacingSpend(slot), invoiceHash: sequenceInvoiceHash(hashSlot) } as PolicyProposal, ctx);
        expect(d.verdict === "AUTO").toBe(slot === next && hashSlot === slot);
        if (hashSlot !== slot) expect(d.reasonCode).toBe("PACING_HASH_MISMATCH");
      }),
      { numRuns: 300 },
    );
  });
});

describe("spendIntentId (Treasury / packages/chain intentId = keccak256(abi.encode(planId, lineId, payeeId, invoiceHash, uint128 amount)))", () => {
  /** A 0x-prefixed 32-byte value assigned to `name` in a packages/chain test file (read at run time: no literal here). */
  const chainGolden = (file: string, name: string): string => {
    const text = readFileSync(new URL(`../../chain/test/${file}`, import.meta.url), "utf8");
    const m = new RegExp(`${name}[^'"]*['"](0x[0-9a-f]{64})['"]`).exec(text);
    if (!m?.[1]) throw new Error(`${name} not found in packages/chain/test/${file}`);
    return m[1];
  };

  it("matches the chain golden (Rina, ADS, shopee-ads, slot 1, 10,000)", () => {
    const id = spendIntentId({
      planId: chainGolden("fixtures/rina.ts", "PLAN_ID: Hex ="),
      lineId: stringToBytes32("ADS"),
      payeeId: stringToBytes32("shopee-ads"),
      invoiceHash: sequenceInvoiceHash(1),
      amountMinor: 10_000n,
    });
    expect(id).toBe(chainGolden("eip712.test.ts", "intentId:"));
  });

  it("rejects malformed words and amounts outside uint128", () => {
    const ok = { planId: sequenceInvoiceHash(7), lineId: stringToBytes32("ADS"), payeeId: stringToBytes32("shopee-ads"), invoiceHash: sequenceInvoiceHash(1), amountMinor: 1n };
    expect(() => spendIntentId({ ...ok, planId: "0x1234" })).toThrow(RangeError);
    expect(() => spendIntentId({ ...ok, amountMinor: -1n })).toThrow(RangeError);
    expect(() => spendIntentId({ ...ok, amountMinor: 2n ** 128n })).toThrow(RangeError);
    expect(spendIntentId({ ...ok, amountMinor: 2n ** 128n - 1n })).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
