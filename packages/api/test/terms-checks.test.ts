/**
 * VISION-DECISIONS §9 pure checks of the terms path: the holder match (TERMS_HOLDER_MISMATCH), the MOCK_ONLY account
 * form, the WEB_TERMS quoteHash, and the schedule with its refusal codes and rounding (core termsToSchedule under the
 * server's limits). The DB-backed checks run in test/live/web-terms.live.test.ts.
 */
import { describe, expect, it } from "vitest";
import { TERMS_ERROR_CODES, TERMS_PRESET_MILESTONES, hashObject, jcs, payoutAccountHash, type MilestoneInput } from "@hogee/core";
import { ApiProblem } from "../src/http/problem";
import { PAYOUT_CHANNELS } from "@hogee/worker";
import {
  MOCK_ONLY_ACCOUNT_RE,
  MOCK_ONLY_CHANNEL,
  MOCK_ONLY_CURRENCIES,
  TERMS_ID_RE,
  accountFormatOk,
  autoLimitsProblem,
  autoWindowUsedMinor,
  payoutAccountOf,
  scheduleRowsOf,
  termsFailure,
  webQuoteHash,
  webSchedule,
  type AutoMilestoneUse,
} from "../src/services/terms-checks";
import { distinctiveWords, hasCompanyDesignator, holderMatchesSeller } from "../src/services/terms-names";
import { newId } from "../src/services/ids";

const SELLER = "Yongkang Corvane Drinkware Co., Ltd.";
/** Mei's SUPPLIER pocket (VISION-WAVE1-NOTES core-terms): perTx 1,250 BU; plenty free and in the window. */
const MEI = { freeMinor: 500_000n, perTxCapMinor: 125_000n, windowCapMinor: 250_000n };

const reasonOf = (fn: () => unknown): { code: string; reason: unknown; idx: unknown } => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiProblem) return { code: e.failure.code, reason: e.failure.details?.reason, idx: e.failure.details?.idx };
    throw e;
  }
  throw new Error("expected a refusal");
};

describe("holder match (TERMS_HOLDER_MISMATCH)", () => {
  it("accepts the seller name itself and a variant sharing its distinctive word", () => {
    expect(holderMatchesSeller(SELLER, SELLER)).toBe(true);
    expect(holderMatchesSeller("CORVANE DRINKWARE CO LTD", SELLER)).toBe(true);
    expect(holderMatchesSeller("Corvane (HK) Limited", SELLER)).toBe(true);
    expect(holderMatchesSeller("Ｃｏｒｖａｎｅ Pte. Ltd.", SELLER)).toBe(true); // NFKC folds full-width letters
  });

  it("refuses a holder without a company designator, even with the right name", () => {
    expect(hasCompanyDesignator("Corvane Drinkware")).toBe(false);
    expect(holderMatchesSeller("Corvane Drinkware", SELLER)).toBe(false);
    expect(holderMatchesSeller("Wang Wei", SELLER)).toBe(false);
  });

  it("never matches on a designator, a place name or an industry word alone", () => {
    expect(holderMatchesSeller("Yongkang Drinkware Co., Ltd.", SELLER)).toBe(false);
    expect(holderMatchesSeller("Brightpath Drinkware Co., Ltd.", SELLER)).toBe(false);
    expect(holderMatchesSeller("Ningbo Global Trading Co Ltd", "Ningbo Global Trading Co Ltd Branch")).toBe(false);
    expect([...distinctiveWords(SELLER)]).toEqual(["corvane"]);
  });

  it("refuses the red-team holders for a seller and accepts the seller verbatim (v-redteam WEB cases)", () => {
    const seller = "Zhejiang Tidelume Cup Industry Co., Ltd.";
    expect(holderMatchesSeller(seller, seller)).toBe(true);
    expect(holderMatchesSeller("Harbourline Trading Pte. Ltd.", seller)).toBe(false);
    expect(holderMatchesSeller("Li Wei", seller)).toBe(false);
    expect(holderMatchesSeller("Zhejiang Cup Industry Co., Ltd.", seller)).toBe(false);
  });

  it("matches Han names on the name without the company suffix", () => {
    expect(hasCompanyDesignator("永康市科瓦恩杯业有限公司")).toBe(true);
    expect(holderMatchesSeller("永康市科瓦恩杯业有限公司", "永康市科瓦恩杯业有限公司")).toBe(true);
    expect(holderMatchesSeller("永康市别的杯业有限公司", "永康市科瓦恩杯业有限公司")).toBe(false);
    expect(holderMatchesSeller("永康市科瓦恩杯业", "永康市科瓦恩杯业有限公司")).toBe(false); // no designator
  });

  it("never matches on a short syllable or word: a distinctive word has at least 4 letters (run-9)", () => {
    const seller = "Ningbo Xin Hua Houseware Co Ltd";
    expect(holderMatchesSeller("Hua Co", seller)).toBe(false);
    expect(holderMatchesSeller("Xin Hua Trading Co., Ltd.", seller)).toBe(false);
    expect(holderMatchesSeller("Sun Co Ltd", "Sun Star Cup Co Ltd")).toBe(false);
    expect([...distinctiveWords(seller)]).toEqual([]);
    expect([...distinctiveWords("Tai Jia Corvane Co")]).toEqual(["corvane"]);
    // The demo pairs still match on their long distinctive word.
    expect(holderMatchesSeller("Corvane Pte. Ltd.", SELLER)).toBe(true);
    expect(holderMatchesSeller("Tidelume Cup Co Ltd", "Zhejiang Tidelume Cup Industry Co., Ltd.")).toBe(true);
  });

  it("covers the Malaysian and Singapore designators", () => {
    expect(holderMatchesSeller("Corvane Sdn Bhd", SELLER)).toBe(true);
    expect(holderMatchesSeller("Corvane Pte Ltd", SELLER)).toBe(true);
  });
});

describe("account form (TERMS_ACCOUNT_FORMAT) and the fixed channel", () => {
  it("takes the worker's MOCK_ONLY bank account form and refuses placeholders", () => {
    expect(accountFormatOk("0123456789")).toBe(true);
    expect(accountFormatOk("000000")).toBe(false);
    expect(accountFormatOk("9999999999")).toBe(false);
    expect(accountFormatOk("12-3456")).toBe(false);
    expect(accountFormatOk("123")).toBe(false);
  });

  it("matches the worker's MOCK_ONLY channel (its account form and currencies), so every stored account is payable", () => {
    expect(String(PAYOUT_CHANNELS.MOCK_ONLY?.accountNumber)).toBe(String(MOCK_ONLY_ACCOUNT_RE));
    expect(PAYOUT_CHANNELS.MOCK_ONLY?.currencies).toEqual(MOCK_ONLY_CURRENCIES);
    expect(PAYOUT_CHANNELS.MOCK_ONLY?.rail).toBe("mock");
  });

  it("fixes the channel server-side and hashes exactly {channel, accountNumber, holderName}", () => {
    const a = payoutAccountOf({ accountNumber: "0123456789", holderName: SELLER });
    expect(a.channel).toBe(MOCK_ONLY_CHANNEL);
    expect(jcs(a)).toBe(`{"accountNumber":"0123456789","channel":"MOCK_ONLY","holderName":"${SELLER}"}`);
    expect(payoutAccountHash(a)).toBe(hashObject({ channel: "MOCK_ONLY", accountNumber: "0123456789", holderName: SELLER }));
  });

  it("names terms ids terms-<uuidv7>", () => {
    expect(newId("terms")).toMatch(TERMS_ID_RE);
    expect(TERMS_ID_RE.test("terms-x")).toBe(false);
    expect(TERMS_ID_RE.test("order-a-001")).toBe(false);
  });
});

describe("WEB_TERMS quoteHash", () => {
  const base = {
    termsId: "terms-0199f1aa-0000-7000-8000-000000000001",
    supplierId: "supplier-wabcdefghijkl",
    shortlistHash: `0x${"ab".repeat(32)}`,
    chosenIndex: 0,
    currency: "SGD",
    totalMinor: "400000",
    milestones: TERMS_PRESET_MILESTONES.P30_70 as readonly MilestoneInput[],
    payeeType: "company",
    payoutAccountHash: `0x${"cd".repeat(32)}`,
  };

  it("is the hash of every confirmed fact under kind WEB_TERMS", () => {
    expect(webQuoteHash(base)).toBe(hashObject({ kind: "WEB_TERMS", ...base, milestones: [{ bps: 3000, trigger: "ON_ORDER" }, { bps: 7000, trigger: "ON_DELIVERY_INSPECTED" }] }));
  });

  it("changes when any fact changes (tampering is caught at prepare and finalize)", () => {
    const h = webQuoteHash(base);
    expect(webQuoteHash({ ...base, totalMinor: "400100" })).not.toBe(h);
    expect(webQuoteHash({ ...base, chosenIndex: 1 })).not.toBe(h);
    expect(webQuoteHash({ ...base, milestones: TERMS_PRESET_MILESTONES.P50_50 })).not.toBe(h);
    expect(webQuoteHash({ ...base, payoutAccountHash: `0x${"ce".repeat(32)}` })).not.toBe(h);
    expect(webQuoteHash({ ...base, termsId: "terms-0199f1aa-0000-7000-8000-000000000002" })).not.toBe(h);
  });
});

describe("schedule under the current limits", () => {
  it("the demo order: 2,500 BU at 30/70 → 750 BU paid by the agent, 1,750 BU after the delivery check", () => {
    const s = webSchedule(250_000n, TERMS_PRESET_MILESTONES.P30_70, MEI);
    expect(s.amounts).toEqual([75_000n, 175_000n]);
    expect(s.autoRelease).toEqual([true, false]);
    const rows = scheduleRowsOf(TERMS_PRESET_MILESTONES.P30_70, s);
    expect(rows.map((r) => [r.label, r.amountMinor, r.autoRelease, r.released, r.txHash])).toEqual([
      ["Deposit on order", "75000", true, false, null],
      ["Balance after delivery check", "175000", false, false, null],
    ]);
  });

  it("rounds every milestone but the last down to whole BU; the last takes the remainder", () => {
    const thirds: MilestoneInput[] = [
      { bps: 3333, trigger: "ON_ORDER" },
      { bps: 3333, trigger: "ON_SHIPMENT" },
      { bps: 3334, trigger: "ON_DELIVERY_INSPECTED" },
    ];
    const s = webSchedule(100_100n, thirds, MEI);
    expect(s.amounts).toEqual([33_300n, 33_300n, 33_500n]);
    expect(s.amounts.reduce((a, b) => a + b, 0n)).toBe(100_100n);
  });

  it("4,300 BU at 30/70 is over Mei's per-payment cap (core-terms demo note)", () => {
    expect(reasonOf(() => webSchedule(430_000n, TERMS_PRESET_MILESTONES.P30_70, MEI))).toEqual({ code: "CONFLICT", reason: "TERMS_AUTO_OVER_PER_TX", idx: 0 });
    expect(webSchedule(430_000n, TERMS_PRESET_MILESTONES.P0_100, MEI).amounts).toEqual([430_000n]);
  });

  it("maps every schedule refusal to its TERMS_* reason and HTTP family", () => {
    const at = (total: bigint, ms: MilestoneInput[], limits = MEI) => reasonOf(() => webSchedule(total, ms, limits));
    const o = (bps: number) => ({ bps, trigger: "ON_ORDER" as const });
    const d = (bps: number) => ({ bps, trigger: "ON_DELIVERY_INSPECTED" as const });
    expect(at(400_000n, [])).toMatchObject({ code: "VALIDATION", reason: "TERMS_COUNT" });
    expect(at(400_000n, [o(0), d(10_000)])).toMatchObject({ code: "VALIDATION", reason: "TERMS_PCT_RANGE", idx: 0 });
    expect(at(400_000n, [o(3000), d(6000)])).toMatchObject({ code: "VALIDATION", reason: "TERMS_PCT_SUM" });
    expect(at(400_000n, [d(5000), o(5000)])).toMatchObject({ code: "VALIDATION", reason: "TERMS_TRIGGER_ORDER", idx: 1 });
    expect(at(400_000n, [o(3000), { bps: 7000, trigger: "ON_SHIPMENT" }])).toMatchObject({ code: "VALIDATION", reason: "TERMS_LAST_NOT_INSPECTED" });
    expect(at(400_050n, [o(3000), d(7000)])).toMatchObject({ code: "VALIDATION", reason: "TERMS_TOTAL_INVALID" });
    expect(at(600_000n, [d(10_000)])).toMatchObject({ code: "CONFLICT", reason: "TERMS_OVER_POCKET" });
    expect(at(10_000n, [o(50), d(9950)])).toMatchObject({ code: "VALIDATION", reason: "TERMS_MILESTONE_ZERO", idx: 0 });
    expect(at(400_000n, [o(1000), o(1000), d(8000)])).toMatchObject({ code: "VALIDATION", reason: "TERMS_WEB_AUTO_COUNT", idx: 1 });
    expect(at(200_000n, [o(6000), d(4000)], { ...MEI, perTxCapMinor: 200_000n })).toMatchObject({ code: "VALIDATION", reason: "TERMS_UPFRONT_OVER_HALF" });
    expect(at(400_000n, [o(3000), d(7000)], { ...MEI, windowCapMinor: 100_000n })).toMatchObject({ code: "CONFLICT", reason: "TERMS_UPFRONT_OVER_WINDOW" });
  });

  it("gives every TERMS_* code an HTTP family and its reason", () => {
    for (const code of TERMS_ERROR_CODES) {
      const f = termsFailure(code, "x", 2).failure;
      expect(["VALIDATION", "CONFLICT", "FORBIDDEN"], code).toContain(f.code);
      expect(f.details).toEqual({ reason: code, idx: 2 });
    }
    expect(termsFailure("TERMS_SANCTIONS", "x").failure.code).toBe("FORBIDDEN");
    expect(termsFailure("TERMS_SUPERSEDED", "x").failure.details).toEqual({ reason: "TERMS_SUPERSEDED" });
  });
});

/**
 * Re-check 9 item 1: escrow funding never moves the on-chain windowSpent, so the window a NEW order's automatic
 * milestones may use is windowCap − windowSpent − what open orders' automatic milestones still have to pay − what
 * automatic milestones paid within the last windowSeconds (chain time).
 */
describe("the SUPPLIER window left for automatic milestones", () => {
  const WEEK = 604_800n;
  const NOW = 1_800_000_000n;
  const at = { now: NOW, windowSeconds: WEEK };
  const auto = (over: Partial<AutoMilestoneUse> = {}): AutoMilestoneUse => ({ amountMinor: 125_000n, fundedMinor: 0n, landedMinor: 0n, landedAt: null, open: true, ...over });

  it("counts every open order's unpaid automatic milestone: N orders cannot each take the whole window", () => {
    expect(autoWindowUsedMinor([], at)).toBe(0n);
    expect(autoWindowUsedMinor([auto()], at)).toBe(125_000n);
    expect(autoWindowUsedMinor([auto(), auto()], at)).toBe(250_000n);
    // A cancelled order (its bind failed for good) can never be funded: it holds nothing.
    expect(autoWindowUsedMinor([auto({ open: false })], at)).toBe(0n);
  });

  it("counts what automatic milestones paid within the window, by the chain time of the block they landed in", () => {
    const paid = (landedAt: bigint | null, open = true) => auto({ fundedMinor: 125_000n, landedMinor: 125_000n, landedAt, open });
    expect(autoWindowUsedMinor([paid(NOW - 60n)], at)).toBe(125_000n);
    expect(autoWindowUsedMinor([paid(NOW - WEEK + 1n)], at)).toBe(125_000n);
    expect(autoWindowUsedMinor([paid(NOW - WEEK)], at)).toBe(0n); // the window has rolled past it
    // Paid, whatever the payee's state now; no recorded receipt yet (the mirror is ahead): counted as paid now.
    expect(autoWindowUsedMinor([paid(NOW - 60n, false)], at)).toBe(125_000n);
    expect(autoWindowUsedMinor([auto({ fundedMinor: 125_000n, landedAt: null })], at)).toBe(125_000n);
    // A receipt recorded before the mirror moved: the payment counts once, as paid.
    expect(autoWindowUsedMinor([auto({ landedMinor: 125_000n, landedAt: NOW - 60n })], at)).toBe(125_000n);
    expect(autoWindowUsedMinor([auto({ landedMinor: 125_000n, landedAt: NOW - WEEK - 1n })], at)).toBe(0n);
  });

  it("the demo numbers fit: Mei's web deposit (750 BU) next to the catalog sample and deposit (300 + 1,200 BU)", () => {
    const used = autoWindowUsedMinor([auto({ amountMinor: 30_000n }), auto({ amountMinor: 120_000n }), auto({ amountMinor: 75_000n })], at);
    expect(used).toBe(225_000n);
    expect(used <= MEI.windowCapMinor).toBe(true);
  });
});

describe("catalog orders: automatic milestones under the per-payment cap and the window (re-check 9 item 1)", () => {
  const AUTO = [true, true, false];
  it("accepts Rina's and Mei's order-a-001 (sample 300 BU + deposit 1,200 BU paid by the agent)", () => {
    expect(autoLimitsProblem([30_000n, 120_000n, 280_000n], AUTO, MEI)).toBeNull();
  });

  it("refuses an automatic milestone over the per-payment cap, or automatic milestones over what is left of the window", () => {
    expect(autoLimitsProblem([30_000n, 120_000n, 280_000n], AUTO, { ...MEI, perTxCapMinor: 100_000n })).toEqual({ code: "TERMS_AUTO_OVER_PER_TX", idx: 1 });
    expect(autoLimitsProblem([30_000n, 120_000n, 280_000n], AUTO, { ...MEI, windowCapMinor: 149_900n })).toEqual({ code: "TERMS_UPFRONT_OVER_WINDOW" });
    expect(autoLimitsProblem([30_000n, 120_000n, 280_000n], AUTO, { ...MEI, windowCapMinor: 150_000n })).toBeNull();
    // A held milestone is bounded by neither (the founder releases it).
    expect(autoLimitsProblem([30_000n, 120_000n, 280_000n], AUTO, { ...MEI, perTxCapMinor: 120_000n })).toBeNull();
  });
});
