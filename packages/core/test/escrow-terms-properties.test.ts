/**
 * Property tests (fast-check) for core-terms:
 *   1. a valid split always pays out exactly the total, in whole BU, every part ≥ 1 BU;
 *   2. rounding never grows the auto-released part (each auto part ≤ its exact share; the remainder goes to the
 *      last milestone, which is never auto-released);
 *   3. termsToSchedule never returns TERMS_AUTO_NOT_FIRST (rule 2 makes it unreachable) and never throws on any
 *      milestone list, total or trigger it is given (it refuses with a code instead);
 *   4. a result's code is the first rule that fails: the earlier rules hold for that input;
 *   5. parseTermsHint never throws, and any schedule it returns passes rules 1–2 (count, range, sum, order, last).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MILESTONE_TRIGGERS, TERMS_ERROR_CODES, type MilestoneTrigger } from "../src/escrow-terms/constants";
import { parseTermsHint, termsToSchedule, type TermsLimits, type TermsMilestone } from "../src/escrow-terms/index";

const RUNS = { numRuns: 400 };
const WIDE: TermsLimits = { freeMinor: 10n ** 30n, perTxCapMinor: 10n ** 30n, windowCapMinor: 10n ** 30n };
const STRUCTURAL = new Set(["TERMS_COUNT", "TERMS_PCT_RANGE", "TERMS_PCT_SUM", "TERMS_TRIGGER_ORDER", "TERMS_LAST_NOT_INSPECTED"]);

/** k positive integers summing to 10,000. */
const bpsSplitArb = fc.integer({ min: 1, max: 8 }).chain((k) =>
  fc.uniqueArray(fc.integer({ min: 1, max: 9_999 }), { minLength: k - 1, maxLength: k - 1 }).map((cuts) => {
    const points = [0, ...cuts.sort((a, b) => a - b), 10_000];
    return points.slice(1).map((p, i) => p - (points[i] as number));
  }),
);

/** A structurally valid milestone list: non-decreasing triggers ending in ON_DELIVERY_INSPECTED. */
const validMilestonesArb = bpsSplitArb.chain((parts) =>
  fc
    .array(fc.integer({ min: 0, max: 3 }), { minLength: parts.length - 1, maxLength: parts.length - 1 })
    .map((ranks): TermsMilestone[] => {
      const sorted = [...ranks.sort((a, b) => a - b), 3];
      return parts.map((bps, i) => ({ bps, trigger: MILESTONE_TRIGGERS[sorted[i] as number] as MilestoneTrigger }));
    }),
);

const wholeBuArb = fc.bigInt({ min: 1n, max: 10n ** 12n }).map((bu) => bu * 100n);
const originArb = fc.constantFrom("web" as const, "catalog" as const);
const limitsArb = fc.record({
  freeMinor: fc.bigInt({ min: 0n, max: 10n ** 14n }),
  perTxCapMinor: fc.bigInt({ min: 0n, max: 10n ** 14n }),
  windowCapMinor: fc.bigInt({ min: 0n, max: 10n ** 14n }),
});

describe("termsToSchedule properties", () => {
  it("1. a valid split pays exactly the total, in whole BU, each part ≥ 1 BU", () => {
    fc.assert(
      fc.property(wholeBuArb, validMilestonesArb, (total, milestones) => {
        const r = termsToSchedule({ totalMinor: total, milestones, origin: "catalog" }, WIDE);
        if (!r.ok) {
          // With no caps, only the money rules can refuse a structurally valid split.
          expect(["TERMS_MILESTONE_ZERO", "TERMS_UPFRONT_OVER_HALF"]).toContain(r.code);
          return;
        }
        expect(r.amounts.reduce((a, b) => a + b, 0n)).toBe(total);
        for (const a of r.amounts) {
          expect(a % 100n).toBe(0n);
          expect(a >= 100n).toBe(true);
        }
        expect(r.amounts).toHaveLength(milestones.length);
        expect(r.autoRelease).toEqual(milestones.map((x) => x.trigger === "ON_ORDER"));
      }),
      RUNS,
    );
  });

  it("2. rounding never grows the auto part: each auto part ≤ its exact share, the last part ≥ its exact share", () => {
    fc.assert(
      fc.property(wholeBuArb, validMilestonesArb, originArb, limitsArb, (total, milestones, origin, limits) => {
        const r = termsToSchedule({ totalMinor: total, milestones, origin }, limits);
        if (!r.ok) return;
        let autoSum = 0n;
        let autoBps = 0n;
        r.amounts.forEach((amount, i) => {
          const exactTimes10k = total * BigInt((milestones[i] as TermsMilestone).bps);
          if (i < r.amounts.length - 1) expect(amount * 10_000n <= exactTimes10k).toBe(true);
          else expect(amount * 10_000n >= exactTimes10k).toBe(true);
          if (r.autoRelease[i]) {
            autoSum += amount;
            autoBps += BigInt((milestones[i] as TermsMilestone).bps);
          }
        });
        expect(r.autoRelease.at(-1)).toBe(false);
        expect(autoSum * 10_000n <= total * autoBps).toBe(true);
        expect(2n * autoSum <= total).toBe(true);
        expect(autoSum <= limits.windowCapMinor).toBe(true);
        expect(total <= limits.freeMinor).toBe(true);
        r.amounts.forEach((a, i) => {
          if (r.autoRelease[i]) expect(a <= limits.perTxCapMinor).toBe(true);
        });
        if (origin === "web") expect(r.autoRelease.filter(Boolean).length <= 1).toBe(true);
      }),
      RUNS,
    );
  });

  const anyMilestoneArb = fc.record({
    bps: fc.oneof(fc.integer({ min: -20_000, max: 20_000 }), fc.double(), fc.constant(Number.NaN)),
    trigger: fc.oneof(fc.constantFrom(...MILESTONE_TRIGGERS), fc.string({ maxLength: 12 })),
  }) as fc.Arbitrary<TermsMilestone>;

  it("3. never throws on any milestone list or total, and never returns TERMS_AUTO_NOT_FIRST", () => {
    fc.assert(
      fc.property(
        fc.oneof(wholeBuArb, fc.bigInt({ min: -(10n ** 9n), max: 10n ** 9n })),
        fc.oneof(validMilestonesArb, fc.array(anyMilestoneArb, { maxLength: 10 })),
        originArb,
        limitsArb,
        (total, milestones, origin, limits) => {
          const r = termsToSchedule({ totalMinor: total, milestones, origin }, limits);
          if (!r.ok) {
            expect(TERMS_ERROR_CODES.slice(0, 13)).toContain(r.code);
            expect(r.code).not.toBe("TERMS_AUTO_NOT_FIRST");
          }
        },
      ),
      RUNS,
    );
  });

  it("4. the code returned is the first failing rule: structural rules hold for any later code, and tighter limits never hide an earlier failure", () => {
    const totalArb = fc.oneof(wholeBuArb, fc.bigInt({ min: -1000n, max: 10n ** 9n }));
    const positionOf = (code: string) => TERMS_ERROR_CODES.indexOf(code as (typeof TERMS_ERROR_CODES)[number]);
    fc.assert(
      fc.property(totalArb, validMilestonesArb, originArb, limitsArb, (total, milestones, origin, limits) => {
        const r = termsToSchedule({ totalMinor: total, milestones, origin }, limits);
        if (!r.ok) expect(STRUCTURAL.has(r.code)).toBe(false);
        // Limits only add failures; whatever fails with no limits must fail with them at the same rule or earlier.
        const loose = termsToSchedule({ totalMinor: total, milestones, origin }, WIDE);
        if (!loose.ok) {
          expect(r.ok).toBe(false);
          if (!r.ok) expect(positionOf(r.code)).toBeLessThanOrEqual(positionOf(loose.code));
        }
      }),
      RUNS,
    );
  });

  it("is deterministic", () => {
    fc.assert(
      fc.property(wholeBuArb, validMilestonesArb, originArb, limitsArb, (total, milestones, origin, limits) => {
        const a = termsToSchedule({ totalMinor: total, milestones, origin }, limits);
        const b = termsToSchedule({ totalMinor: total, milestones: milestones.map((x) => ({ ...x })), origin }, { ...limits });
        expect(a).toEqual(b);
      }),
      RUNS,
    );
  });
});

describe("parseTermsHint properties", () => {
  const VOCAB = [
    "30", "40", "50", "70", "100", "0", "33", "30.5", "%", " percent", " per cent", "/", "-", ",", ".", ";", "?", "\n",
    " and ", " then ", "half", "full payment", "in full", "the rest", "balance", "deposit", "upfront", "on order",
    "first", "now", "sample", "shipment", "loading", "delivery", "inspection", "cod", "lah", "boss", "<SG_PHONE>",
    "<SG_NRIC>", " ", "  ", "pay", "can", "ok",
  ];
  const textArb = fc.oneof(
    fc.array(fc.constantFrom(...VOCAB), { maxLength: 30 }).map((xs) => xs.join("")),
    fc.array(fc.constantFrom(...VOCAB), { maxLength: 30 }).map((xs) => xs.join(" ")),
    fc.string({ maxLength: 200 }),
    fc.string({ unit: "grapheme", maxLength: 100 }),
  );

  it("5. never throws; any schedule it returns passes the structural rules; ambiguous ⇔ question", () => {
    fc.assert(
      fc.property(textArb, (text) => {
        const h = parseTermsHint(text);
        expect(h.ambiguous).toBe(h.question !== null);
        if (h.ambiguous) expect(h.milestones).toBeNull();
        if (h.milestones === null) return;
        expect(h.milestones.length).toBeGreaterThanOrEqual(1);
        expect(h.milestones.length).toBeLessThanOrEqual(8);
        const r = termsToSchedule({ totalMinor: 100_000_000n, milestones: h.milestones, origin: "catalog" }, WIDE);
        if (!r.ok) expect(STRUCTURAL.has(r.code)).toBe(false);
      }),
      { numRuns: 2000 },
    );
  });
});
