/**
 * core-terms `parseTermsHint` (VISION-DECISIONS §8): a deterministic reader (no LLM) for payment terms the founder
 * types in chat. The text reaches it AFTER the privacy redactor, so the table runs through the real `redact()` from
 * @hogee/privacy (imported by path: core cannot depend on privacy) and checks that the percentages survive and that
 * the `<ENTITY>` placeholders never read as amounts or triggers. Every regex is in privacy's linear-time subset
 * (`linearRegexProblem`) and a max-length adversarial input is parsed in well under a second.
 */
import { describe, expect, it } from "vitest";
import { linearRegexProblem, redact } from "../../privacy/src/index";
import type { MilestoneTrigger } from "../src/escrow-terms/constants";
import { parseTermsHint, type TermsHint } from "../src/escrow-terms/index";
import { HINT_REGEXES, MAX_HINT_CHARS } from "../src/escrow-terms/hint-lexer";

type Row = readonly [text: string, expected: TermsHint];

const NONE: TermsHint = { milestones: null, ambiguous: false, question: null };
const ASK: TermsHint = { milestones: null, ambiguous: true, question: "DEPOSIT_TRIGGER" };
const ok = (...parts: [number, MilestoneTrigger][]): TermsHint => ({
  milestones: parts.map(([bps, trigger]) => ({ bps, trigger })),
  ambiguous: false,
  question: null,
});
const P30_70 = ok([3000, "ON_ORDER"], [7000, "ON_DELIVERY_INSPECTED"]);
const P50_50 = ok([5000, "ON_ORDER"], [5000, "ON_DELIVERY_INSPECTED"]);
const P0_100 = ok([10000, "ON_DELIVERY_INSPECTED"]);
const P30_40_30 = ok([3000, "ON_ORDER"], [4000, "ON_SHIPMENT"], [3000, "ON_DELIVERY_INSPECTED"]);

const TABLE: readonly Row[] = [
  // The brief's own examples.
  ["30% deposit, 70% on delivery", P30_70],
  ["30% upfront and the rest after inspection", P30_70],
  ["50/50", P50_50],
  ["half now half on delivery", P50_50],
  ["full payment on delivery", P0_100],
  ["100% after inspection", P0_100],
  ["30 40 30", P30_40_30],
  ["30% on order, 40% on shipment, 30% on delivery", P30_40_30],
  ["30 percent first lah, balance upon delivery", P30_70],
  // Explicit percentages, other wordings and orders.
  ["Deposit 30%, balance 70%", P30_70],
  ["Deposit: 30%. Balance: 70% on delivery.", P30_70],
  ["deposit 30% balance 70% after inspection", P30_70],
  ["30% DEPOSIT, 70% ON DELIVERY", P30_70],
  ["３０％ deposit，７０％ on delivery", P30_70],
  ["30%deposit,70%delivery", P30_70],
  ["30 % deposit , 70 % on delivery", P30_70],
  ["30pct deposit 70pct delivery", P30_70],
  ["30 per cent upfront, 70 per cent upon receiving the goods", P30_70],
  ["70% on delivery, 30% deposit", P30_70],
  ["30% in advance, 70% when the goods arrive", P30_70],
  ["30% DP, 70% COD", P30_70],
  ["30% upon order confirmation, 70% after QC", P30_70],
  ["20% after sample approval, 80% after inspection", ok([2000, "ON_SAMPLE_OK"], [8000, "ON_DELIVERY_INSPECTED"])],
  ["40% sample 60% delivery", ok([4000, "ON_SAMPLE_OK"], [6000, "ON_DELIVERY_INSPECTED"])],
  ["30% deposit, 40% before loading, 30% after delivery", P30_40_30],
  ["30% on first shipment, 70% on delivery", ok([3000, "ON_SHIPMENT"], [7000, "ON_DELIVERY_INSPECTED"])],
  [
    "20% on order, 20% after sample, 30% when shipped, 30% on delivery",
    ok([2000, "ON_ORDER"], [2000, "ON_SAMPLE_OK"], [3000, "ON_SHIPMENT"], [3000, "ON_DELIVERY_INSPECTED"]),
  ],
  ["30% deposit, 30% upfront, 40% on delivery", ok([3000, "ON_ORDER"], [3000, "ON_ORDER"], [4000, "ON_DELIVERY_INSPECTED"])],
  ["pay in full upon delivery", P0_100],
  ["0% deposit, 100% on delivery", P0_100],
  ["30% deposit, 70% after the order arrives", P30_70],
  // Bare splits: 2 parts = deposit + balance, 3 parts = deposit + shipment + balance.
  ["30/70", P30_70],
  ["50-50", P50_50],
  ["30/40/30", P30_40_30],
  ["30 70", P30_70],
  ["can do 50/50 boss?", P50_50],
  ["50/50, deposit then balance on delivery", P50_50],
  ["0/100", P0_100],
  // Singlish and colloquial.
  ["half half lah", P50_50],
  ["half-half can?", P50_50],
  ["Boss, 30 percent first can? Balance after we check the goods lah", P30_70],
  ["Deposit 30 percent lor, balance COD", P30_70],
  ["pay 30 percent first, the rest upon delivery can or not?", P30_70],
  ["half now, half when delivered", P50_50],
  ["50 50 can", P50_50],
  // A percentage with no trigger: ask when the deposit is paid.
  ["30% and 70%", ASK],
  ["pay 30% then 70% on delivery", ASK],
  ["30% then the rest", ASK],
  ["100%", ASK],
  ["half and then half", ASK],
  // Refused: decimals, wrong sums, over 100, structure the escrow cannot hold, conflicts, nothing to read.
  ["30.5% deposit, 69.5% on delivery", NONE],
  ["12,5% deposit, 87,5% on delivery", NONE],
  // Whole parts that add up to 100 alone: the decimal itself must refuse the hint.
  ["30.5% deposit, 70% on delivery", NONE],
  ["50.0% deposit, 50% on delivery", NONE],
  ["100% on delivery, the rest on order", NONE],
  ["100% on delivery, the rest on order, the rest after sample", NONE],
  ["30.5/69.5", NONE],
  ["30% deposit, 60% on delivery", NONE],
  ["30% deposit, 80% on delivery", NONE],
  ["30% deposit", NONE],
  ["30 40 40", NONE],
  ["150% on delivery", NONE],
  ["100% upfront", NONE],
  ["50% deposit, 50% on shipment", NONE],
  ["30% deposit, balance before shipment", NONE],
  ["30% deposit, rest on delivery, rest after inspection", NONE],
  ["30% deposit before delivery, 70% after inspection", NONE],
  ["balance on delivery", NONE],
  ["the rest on delivery", NONE],
  ["50/50 on shipment and delivery", NONE],
  ["30 40 30 sample", NONE],
  ["25 25 25 25", NONE],
  ["50/50 or 30/70", NONE],
  ["10/19 delivery", NONE],
  ["1/3 deposit", NONE],
  ["all upon delivery", NONE],
  ["hello, I want 500 tumblers by 30 Nov", NONE],
  ["", NONE],
  ["   ", NONE],
];

describe("parseTermsHint: the table (run through the real redactor first)", () => {
  it(`has at least 40 rows (${TABLE.length})`, () => {
    expect(TABLE.length).toBeGreaterThanOrEqual(40);
    expect(new Set(TABLE.map(([t]) => t)).size).toBe(TABLE.length);
  });

  it.each(TABLE)("%j", async (text, expected) => {
    expect(parseTermsHint(text)).toEqual(expected);
    // None of these rows holds an identifier, so redaction leaves them byte for byte.
    const r = await redact(text);
    expect(r.text).toBe(text);
    expect(parseTermsHint(r.text)).toEqual(expected);
  });
});

describe("parseTermsHint after redaction of real identifiers", () => {
  const CASES: readonly [raw: string, placeholders: readonly string[], expected: TermsHint][] = [
    ["My IC is S1234567D. 30% deposit, 70% on delivery. Call 9123 4567.", ["<SG_NRIC>", "<SG_PHONE>"], P30_70],
    ["NRIC T0123456G, phone +65 8123 4567, 50/50 lah", ["<SG_NRIC>", "<SG_PHONE>"], P50_50],
    ["MyKad 900101-14-5678, 30 40 30 boss", ["<MY_NRIC>"], P30_40_30],
    ["email mei@example.com, 30 percent first, balance upon delivery", ["<EMAIL_ADDRESS>"], P30_70],
    ["pay to account 1234567890 then 30% deposit, 70% after inspection", ["<MY_BANK_ACCOUNT>"], P30_70],
    ["card 4111 1111 1111 1111 and 100% after inspection", ["<CREDIT_CARD>"], P0_100],
    ["call 012-345 6789 30% upfront and the rest after inspection", ["<MY_PHONE>"], P30_70],
    ["reach me at +65 9123 4567 or mei@example.com", ["<SG_PHONE>", "<EMAIL_ADDRESS>"], NONE],
    ["IC S1234567D", ["<SG_NRIC>"], NONE],
  ];

  it.each(CASES)("%j", async (raw, placeholders, expected) => {
    const r = await redact(raw);
    for (const p of placeholders) expect(r.text).toContain(p);
    for (const pct of raw.match(/\d{1,3}%/g) ?? []) expect(r.text).toContain(pct);
    expect(parseTermsHint(r.text)).toEqual(expected);
  });

  it("placeholders alone, or wedged between the parts of a valid hint, change nothing", () => {
    const placeholders = ["<SG_NRIC>", "<SG_PHONE>", "<MY_NRIC>", "<MY_PHONE>", "<MY_BANK_ACCOUNT>", "<EMAIL_ADDRESS>",
      "<CREDIT_CARD>", "<ID_NIK>", "<ID_NPWP>", "<ID_PHONE>", "<PERSON>", "<LOCATION>"];
    for (const p of placeholders) {
      expect(parseTermsHint(p)).toEqual(NONE);
      expect(parseTermsHint(`${p} ${p}, ${p}. ${p}`)).toEqual(NONE);
      expect(parseTermsHint(`30% deposit ${p}, 70% ${p} on delivery ${p}`)).toEqual(P30_70);
      expect(parseTermsHint(`${p} half now ${p} half on delivery`)).toEqual(P50_50);
    }
  });

  it("a placeholder breaks a bare split instead of joining two numbers into one", () => {
    expect(parseTermsHint("30 <SG_PHONE> 70")).toEqual(NONE);
    expect(parseTermsHint("50/<SG_PHONE>50")).toEqual(NONE);
  });
});

describe("parseTermsHint: input handling and ReDoS safety", () => {
  it("every regex is in privacy's linear-time subset", () => {
    expect(HINT_REGEXES.length).toBeGreaterThan(0);
    for (const re of HINT_REGEXES) expect(linearRegexProblem(re.source), re.source).toBeNull();
  });

  it("refuses (no prefill) over MAX_HINT_CHARS, and non-strings", () => {
    expect(MAX_HINT_CHARS).toBe(16_000);
    const valid = "30% deposit, 70% on delivery";
    expect(parseTermsHint(valid + " ".repeat(MAX_HINT_CHARS - valid.length))).toEqual(P30_70);
    expect(parseTermsHint(valid + " ".repeat(MAX_HINT_CHARS - valid.length + 1))).toEqual(NONE);
    for (const bad of [undefined, null, 30, {}, ["30% deposit"]]) expect(parseTermsHint(bad as unknown as string)).toEqual(NONE);
  });

  it("more than 8 parts is refused", () => {
    expect(parseTermsHint(`${"10% on shipment, ".repeat(9)}10% on delivery`)).toEqual(NONE);
  });

  const ADVERSARIAL: readonly [string, string][] = [
    ["digits", "3".repeat(MAX_HINT_CHARS)],
    ["digit-dot", "3.".repeat(MAX_HINT_CHARS / 2)],
    ["digit-comma", "3,".repeat(MAX_HINT_CHARS / 2)],
    ["percents", "30% ".repeat(MAX_HINT_CHARS / 4)],
    ["slashes", "5/".repeat(MAX_HINT_CHARS / 2)],
    ["spaced numbers", "30 ".repeat(MAX_HINT_CHARS / 3)],
    ["letters", "a".repeat(MAX_HINT_CHARS)],
    ["half", "half ".repeat(MAX_HINT_CHARS / 5)],
    ["triggers", "deposit delivery ".repeat(MAX_HINT_CHARS / 17)],
    ["placeholders", "<SG_PHONE>".repeat(MAX_HINT_CHARS / 10)],
    ["angle brackets", "<".repeat(MAX_HINT_CHARS)],
    ["per cent", "30 per ".repeat(MAX_HINT_CHARS / 7)],
    ["mixed", "30% deposit, 70% on delivery; 50/50 half-half ".repeat(MAX_HINT_CHARS / 46)],
  ];

  it.each(ADVERSARIAL)("a max-length %s input is read in under 250 ms", (_name, text) => {
    expect(text.length).toBeLessThanOrEqual(MAX_HINT_CHARS);
    const t0 = performance.now();
    const r = parseTermsHint(text);
    expect(performance.now() - t0).toBeLessThan(250);
    expect(r.milestones === null || r.milestones.length <= 8).toBe(true);
  });

  it("a 1 MB input is refused at once", () => {
    const t0 = performance.now();
    expect(parseTermsHint("30% deposit, 70% on delivery ".repeat(40_000))).toEqual(NONE);
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it("the result is fresh each call (callers may keep it)", () => {
    const a = parseTermsHint("50/50");
    const b = parseTermsHint("50/50");
    expect(a).toEqual(b);
    expect(a.milestones).not.toBe(b.milestones);
  });
});
