/**
 * core-terms (VISION-DECISIONS §2, §8): `termsToSchedule`, `presetAvailability`, the labels and the presets.
 * Every TERMS_* code that termsToSchedule can return is hit at least once, the first failing code (in
 * TERMS_ERROR_CODES order) wins, and Mei's SUPPLIER line (per-tx 125,000 minor, window 250,000, free 500,000) is used
 * for the cap cases. TERMS_AUTO_NOT_FIRST cannot be reached through termsToSchedule (rule 2 already puts every
 * ON_ORDER milestone first), so its rule is tested on its own here and the property file shows it never fires.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MILESTONE_LABELS,
  MILESTONE_TRIGGERS,
  TERMS_ERROR_CODES,
  TERMS_PRESET_MILESTONES,
  TERMS_PRESETS,
  type MilestoneTrigger,
  type TermsErrorCode,
} from "../src/escrow-terms/constants";
import { presetAvailability, termsToSchedule, type TermsLimits, type TermsMilestone } from "../src/escrow-terms/index";
import { autoFirstProblem, floorBu, MAX_MILESTONES } from "../src/escrow-terms/schedule";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Mei's SUPPLIER line (core demo/mei.ts): per-tx 1,250 BU, window 2,500 BU, 5,000 BU free. */
const MEI: TermsLimits = { freeMinor: 500_000n, perTxCapMinor: 125_000n, windowCapMinor: 250_000n };
const WIDE: TermsLimits = { freeMinor: 10n ** 30n, perTxCapMinor: 10n ** 30n, windowCapMinor: 10n ** 30n };

const m = (bps: number, trigger: MilestoneTrigger): TermsMilestone => ({ bps, trigger });
const O = (bps: number) => m(bps, "ON_ORDER");
const S = (bps: number) => m(bps, "ON_SAMPLE_OK");
const H = (bps: number) => m(bps, "ON_SHIPMENT");
const D = (bps: number) => m(bps, "ON_DELIVERY_INSPECTED");

function fail(code: TermsErrorCode, idx?: number) {
  return idx === undefined ? { ok: false, code } : { ok: false, code, idx };
}

describe("constants match VISION-DECISIONS §2 exactly", () => {
  it("enum values and order", () => {
    expect(MILESTONE_TRIGGERS).toEqual(["ON_ORDER", "ON_SAMPLE_OK", "ON_SHIPMENT", "ON_DELIVERY_INSPECTED"]);
    expect(TERMS_PRESETS).toEqual(["P30_70", "P50_50", "P0_100", "P30_40_30"]);
    expect(TERMS_ERROR_CODES).toEqual([
      "TERMS_COUNT", "TERMS_PCT_RANGE", "TERMS_PCT_SUM", "TERMS_TRIGGER_ORDER", "TERMS_LAST_NOT_INSPECTED",
      "TERMS_TOTAL_INVALID", "TERMS_OVER_POCKET", "TERMS_MILESTONE_ZERO", "TERMS_AUTO_NOT_FIRST", "TERMS_WEB_AUTO_COUNT",
      "TERMS_AUTO_OVER_PER_TX", "TERMS_UPFRONT_OVER_HALF", "TERMS_UPFRONT_OVER_WINDOW",
      "TERMS_CANDIDATE", "TERMS_CURRENCY", "TERMS_PAYEE_PERSONAL", "TERMS_ACCOUNT_FORMAT", "TERMS_HOLDER_MISMATCH",
      "TERMS_SANCTIONS", "TERMS_ALREADY_BOUND", "TERMS_SUPERSEDED",
    ]);
  });

  it("labels", () => {
    expect(MILESTONE_LABELS).toEqual({
      ON_ORDER: "Deposit on order",
      ON_SAMPLE_OK: "After sample approval",
      ON_SHIPMENT: "On shipment",
      ON_DELIVERY_INSPECTED: "Balance after delivery check",
    });
    expect(Object.isFrozen(MILESTONE_LABELS)).toBe(true);
  });

  it("presets", () => {
    expect(TERMS_PRESET_MILESTONES).toEqual({
      P30_70: [O(3000), D(7000)],
      P50_50: [O(5000), D(5000)],
      P0_100: [D(10000)],
      P30_40_30: [O(3000), H(4000), D(3000)],
    });
    expect(Object.keys(TERMS_PRESET_MILESTONES)).toEqual([...TERMS_PRESETS]);
    for (const p of TERMS_PRESETS) {
      expect(Object.isFrozen(TERMS_PRESET_MILESTONES[p])).toBe(true);
      for (const x of TERMS_PRESET_MILESTONES[p]) expect(Object.isFrozen(x)).toBe(true);
    }
  });

  it("every label passes the wording lint (scripts/lint-wording checkText) and fits ScheduleRow.label (≤ 60)", async () => {
    const lint = join(ROOT, "scripts/lint-wording/index.mjs");
    const { checkText } = (await import(lint)) as { checkText: (text: string) => readonly unknown[] };
    for (const t of MILESTONE_TRIGGERS) {
      const label = MILESTONE_LABELS[t];
      expect(checkText(label), label).toEqual([]);
      expect(label.length).toBeGreaterThan(0);
      expect(label.length).toBeLessThanOrEqual(60);
    }
    // The checker is live: a banned word in a label would be caught (built at runtime so this file stays clean).
    expect(checkText(`Deposit on order (${["to", "ken"].join("")})`).length).toBe(1);
  });
});

describe("termsToSchedule: success", () => {
  it("P30_70 on Mei's line: deposit auto-released, balance held", () => {
    expect(termsToSchedule({ totalMinor: 400_000n, milestones: [O(3000), D(7000)], origin: "web" }, MEI)).toEqual({
      ok: true,
      amounts: [120_000n, 280_000n],
      autoRelease: [true, false],
      labels: ["Deposit on order", "Balance after delivery check"],
    });
  });

  it("3333 / 3333 / 3334 rounds each part down to whole BU and gives the remainder to the last", () => {
    const r = termsToSchedule({ totalMinor: 100_000n, milestones: [O(3333), H(3333), D(3334)], origin: "web" }, MEI);
    expect(r).toEqual({
      ok: true,
      amounts: [33_300n, 33_300n, 33_400n],
      autoRelease: [true, false, false],
      labels: ["Deposit on order", "On shipment", "Balance after delivery check"],
    });
  });

  it("the remainder always goes to the last milestone (P30_40_30 on an odd total)", () => {
    const r = termsToSchedule({ totalMinor: 123_400n, milestones: TERMS_PRESET_MILESTONES.P30_40_30, origin: "catalog" }, MEI);
    // 37,020 → 37,000; 49,360 → 49,300; last = 123,400 − 86,300 = 37,100.
    expect(r).toMatchObject({ ok: true, amounts: [37_000n, 49_300n, 37_100n] });
  });

  it("P0_100 has no auto-release at all", () => {
    expect(termsToSchedule({ totalMinor: 500_000n, milestones: [D(10000)], origin: "web" }, MEI)).toEqual({
      ok: true,
      amounts: [500_000n],
      autoRelease: [false],
      labels: ["Balance after delivery check"],
    });
  });

  it("all four triggers, repeated non-auto triggers allowed, labels per trigger", () => {
    const r = termsToSchedule({ totalMinor: 200_000n, milestones: [O(1000), S(1000), H(2000), H(2000), D(4000)], origin: "web" }, MEI);
    expect(r).toEqual({
      ok: true,
      amounts: [20_000n, 20_000n, 40_000n, 40_000n, 80_000n],
      autoRelease: [true, false, false, false, false],
      labels: ["Deposit on order", "After sample approval", "On shipment", "On shipment", "Balance after delivery check"],
    });
  });

  it("a catalog supplier may have two auto milestones (the old sample + deposit shape)", () => {
    const r = termsToSchedule({ totalMinor: 430_000n, milestones: [O(698), O(2790), D(6512)], origin: "catalog" }, MEI);
    expect(r).toMatchObject({ ok: true, autoRelease: [true, true, false] });
    if (r.ok) expect(r.amounts.reduce((a, b) => a + b, 0n)).toBe(430_000n);
  });

  it("is pure: the input is not changed and repeated calls agree", () => {
    const milestones = Object.freeze([Object.freeze(O(3000)), Object.freeze(D(7000))]);
    const input = Object.freeze({ totalMinor: 250_000n, milestones, origin: "web" as const });
    const a = termsToSchedule(input, MEI);
    const b = termsToSchedule(input, MEI);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it("floorBu rounds down to a whole budget unit", () => {
    expect([floorBu(0n), floorBu(99n), floorBu(100n), floorBu(12_345n)]).toEqual([0n, 0n, 100n, 12_300n]);
    expect(() => floorBu(-1n)).toThrow();
  });
});

describe("termsToSchedule: every rule, in TERMS_ERROR_CODES order", () => {
  const web = (totalMinor: bigint, milestones: readonly TermsMilestone[], limits = MEI) =>
    termsToSchedule({ totalMinor, milestones, origin: "web" }, limits);
  const catalog = (totalMinor: bigint, milestones: readonly TermsMilestone[], limits = MEI) =>
    termsToSchedule({ totalMinor, milestones, origin: "catalog" }, limits);

  it("TERMS_COUNT: 0 or more than 8 milestones, or not a list", () => {
    expect(MAX_MILESTONES).toBe(8);
    expect(web(100_000n, [])).toEqual(fail("TERMS_COUNT"));
    expect(web(100_000n, [...Array(8).fill(H(1000)), D(2000)])).toEqual(fail("TERMS_COUNT"));
    expect(web(100_000n, [...Array(7).fill(H(1000)), D(3000)])).toMatchObject({ ok: true });
    expect(web(100_000n, null as unknown as TermsMilestone[])).toEqual(fail("TERMS_COUNT"));
  });

  it("TERMS_PCT_RANGE: each bps is an integer 1..10,000 (idx of the first bad one)", () => {
    expect(web(100_000n, [O(0), D(10000)])).toEqual(fail("TERMS_PCT_RANGE", 0));
    expect(web(100_000n, [O(3000), D(10001)])).toEqual(fail("TERMS_PCT_RANGE", 1));
    expect(web(100_000n, [O(-3000), D(13000)])).toEqual(fail("TERMS_PCT_RANGE", 0));
    expect(web(100_000n, [O(2999.5), D(7000.5)])).toEqual(fail("TERMS_PCT_RANGE", 0));
    expect(web(100_000n, [O(Number.NaN), D(7000)])).toEqual(fail("TERMS_PCT_RANGE", 0));
    expect(web(100_000n, [O(3000), null as unknown as TermsMilestone])).toEqual(fail("TERMS_PCT_RANGE", 1));
    expect(web(100_000n, [{ bps: "3000", trigger: "ON_ORDER" } as unknown as TermsMilestone, D(7000)])).toEqual(
      fail("TERMS_PCT_RANGE", 0),
    );
  });

  it("TERMS_PCT_SUM: the parts add up to exactly 10,000 bps", () => {
    expect(web(100_000n, [O(3000), D(6999)])).toEqual(fail("TERMS_PCT_SUM"));
    expect(web(100_000n, [O(3000), D(7001)])).toEqual(fail("TERMS_PCT_SUM"));
  });

  it("TERMS_TRIGGER_ORDER: triggers never go backwards (an unknown trigger also fails here)", () => {
    expect(web(100_000n, [D(3000), O(7000)])).toEqual(fail("TERMS_TRIGGER_ORDER", 1));
    expect(web(100_000n, [O(2000), H(2000), S(2000), D(4000)])).toEqual(fail("TERMS_TRIGGER_ORDER", 2));
    expect(web(100_000n, [O(3000), m(7000, "ON_PAYDAY" as MilestoneTrigger)])).toEqual(fail("TERMS_TRIGGER_ORDER", 1));
    expect(web(100_000n, [m(3000, "__proto__" as MilestoneTrigger), D(7000)])).toEqual(fail("TERMS_TRIGGER_ORDER", 0));
  });

  it("TERMS_LAST_NOT_INSPECTED: the last milestone is the balance after the delivery check", () => {
    expect(web(100_000n, [O(3000), H(7000)])).toEqual(fail("TERMS_LAST_NOT_INSPECTED", 1));
    expect(web(100_000n, [O(10000)])).toEqual(fail("TERMS_LAST_NOT_INSPECTED", 0));
  });

  it("TERMS_TOTAL_INVALID: > 0, a whole number of BU, a bigint within uint128", () => {
    expect(web(400_050n, [O(3000), D(7000)])).toEqual(fail("TERMS_TOTAL_INVALID"));
    expect(web(0n, [O(3000), D(7000)])).toEqual(fail("TERMS_TOTAL_INVALID"));
    expect(web(-100n, [O(3000), D(7000)])).toEqual(fail("TERMS_TOTAL_INVALID"));
    expect(web(400_000 as unknown as bigint, [O(3000), D(7000)])).toEqual(fail("TERMS_TOTAL_INVALID"));
    expect(web(1n << 128n, [O(3000), D(7000)], WIDE)).toEqual(fail("TERMS_TOTAL_INVALID"));
  });

  it("TERMS_OVER_POCKET: the total fits the free part of the pocket", () => {
    expect(web(500_100n, [D(10000)])).toEqual(fail("TERMS_OVER_POCKET"));
    expect(web(500_000n, [D(10000)])).toMatchObject({ ok: true });
    // Exact boundary, with a free amount that is not a whole BU.
    expect(web(500_100n, [D(10000)], { ...MEI, freeMinor: 500_099n })).toEqual(fail("TERMS_OVER_POCKET"));
    expect(web(500_100n, [D(10000)], { ...MEI, freeMinor: 500_100n })).toMatchObject({ ok: true });
  });

  it("TERMS_MILESTONE_ZERO: a part under 1 BU after rounding down", () => {
    expect(web(10_000n, [O(50), D(9950)])).toEqual(fail("TERMS_MILESTONE_ZERO", 0));
    expect(web(10_000n, [O(3000), H(99), D(6901)])).toEqual(fail("TERMS_MILESTONE_ZERO", 1));
    expect(web(10_000n, [O(3000), H(100), D(6900)])).toMatchObject({ ok: true, amounts: [3_000n, 100n, 6_900n] });
  });

  it("TERMS_AUTO_NOT_FIRST: the rule on its own (unreachable after TERMS_TRIGGER_ORDER)", () => {
    expect(autoFirstProblem([true, true, false])).toBeNull();
    expect(autoFirstProblem([false, false])).toBeNull();
    expect(autoFirstProblem([false, true])).toEqual(fail("TERMS_AUTO_NOT_FIRST", 1));
    expect(autoFirstProblem([true, false, false, true])).toEqual(fail("TERMS_AUTO_NOT_FIRST", 3));
  });

  it("TERMS_WEB_AUTO_COUNT: a web supplier gets at most one auto-released milestone", () => {
    expect(web(400_000n, [O(1000), O(2000), D(7000)])).toEqual(fail("TERMS_WEB_AUTO_COUNT", 1));
    expect(catalog(400_000n, [O(1000), O(2000), D(7000)])).toMatchObject({ ok: true });
  });

  it("TERMS_AUTO_OVER_PER_TX: each auto-released part fits the line's per-tx cap", () => {
    // 50/50 on 2,600 BU: the 1,300 BU deposit is over the 1,250 BU cap.
    expect(web(260_000n, TERMS_PRESET_MILESTONES.P50_50)).toEqual(fail("TERMS_AUTO_OVER_PER_TX", 0));
    expect(catalog(400_000n, [O(1000), O(3200), D(5800)])).toEqual(fail("TERMS_AUTO_OVER_PER_TX", 1));
    // A held (non-auto) part may be larger than the per-tx cap.
    expect(web(400_000n, [O(1000), H(4000), D(5000)])).toMatchObject({ ok: true, amounts: [40_000n, 160_000n, 200_000n] });
  });

  it("TERMS_UPFRONT_OVER_HALF: 2 × Σauto ≤ total", () => {
    expect(web(200_000n, [O(6000), D(4000)])).toEqual(fail("TERMS_UPFRONT_OVER_HALF"));
    expect(web(200_000n, [O(5000), D(5000)])).toMatchObject({ ok: true });
  });

  it("TERMS_UPFRONT_OVER_WINDOW: Σauto fits what is left of the line's window", () => {
    const tight = { ...MEI, windowCapMinor: 150_000n };
    expect(catalog(500_000n, [O(2000), O(2000), D(6000)], tight)).toEqual(fail("TERMS_UPFRONT_OVER_WINDOW"));
    expect(catalog(500_000n, [O(1500), O(1500), D(7000)], tight)).toMatchObject({ ok: true });
    expect(web(400_000n, TERMS_PRESET_MILESTONES.P30_70, { ...MEI, windowCapMinor: 119_900n })).toEqual(
      fail("TERMS_UPFRONT_OVER_WINDOW"),
    );
  });

  it("the FIRST failing code wins when several rules fail", () => {
    const cases: [bigint, TermsMilestone[], TermsErrorCode, number?][] = [
      [400_050n, [...Array(9).fill(O(5000))], "TERMS_COUNT"],
      [400_050n, [D(0), O(20000)], "TERMS_PCT_RANGE", 0],
      [400_050n, [D(4000), O(5000)], "TERMS_PCT_SUM"],
      [400_050n, [D(4000), O(6000)], "TERMS_TRIGGER_ORDER", 1],
      [400_050n, [O(6000), H(4000)], "TERMS_LAST_NOT_INSPECTED", 1],
      [999_950n, [O(9950), D(50)], "TERMS_TOTAL_INVALID"],
      [10_000_000n, [O(1), O(9000), D(999)], "TERMS_OVER_POCKET"],
      [10_000n, [O(50), O(9000), D(950)], "TERMS_MILESTONE_ZERO", 0],
      [400_000n, [O(4000), O(4000), D(2000)], "TERMS_WEB_AUTO_COUNT", 1],
      [400_000n, [O(8000), D(2000)], "TERMS_AUTO_OVER_PER_TX", 0],
    ];
    for (const [total, ms, code, idx] of cases) expect(web(total, ms), code).toEqual(fail(code, idx));
    // Over half AND over the window: half wins.
    expect(web(200_000n, [O(6000), D(4000)], { ...MEI, windowCapMinor: 1n })).toEqual(fail("TERMS_UPFRONT_OVER_HALF"));
  });

  it("bad limits or origin are a caller bug and throw (fail closed)", () => {
    const ok = { totalMinor: 100_000n, milestones: [O(3000), D(7000)], origin: "web" as const };
    expect(() => termsToSchedule(ok, { ...MEI, perTxCapMinor: -1n })).toThrow(TypeError);
    expect(() => termsToSchedule(ok, { ...MEI, freeMinor: 5 as unknown as bigint })).toThrow(TypeError);
    expect(() => termsToSchedule(ok, null as unknown as TermsLimits)).toThrow(TypeError);
    expect(() => termsToSchedule({ ...ok, origin: "partner" as "web" }, MEI)).toThrow(TypeError);
    expect(() => termsToSchedule(null as unknown as typeof ok, MEI)).toThrow(TypeError);
  });
});

describe("Mei's SUPPLIER line (per-tx 125,000, window 250,000, free 500,000)", () => {
  it("50/50 up to 2,500 BU passes; over 2,500 BU it fails (2,501 BU still passes: the deposit rounds down to 1,250)", () => {
    expect(termsToSchedule({ totalMinor: 250_000n, milestones: TERMS_PRESET_MILESTONES.P50_50, origin: "web" }, MEI)).toMatchObject({
      ok: true,
      amounts: [125_000n, 125_000n],
    });
    expect(termsToSchedule({ totalMinor: 250_100n, milestones: TERMS_PRESET_MILESTONES.P50_50, origin: "web" }, MEI)).toMatchObject({
      ok: true,
      amounts: [125_000n, 125_100n],
    });
    for (const total of [250_200n, 300_000n, 500_000n]) {
      expect(termsToSchedule({ totalMinor: total, milestones: TERMS_PRESET_MILESTONES.P50_50, origin: "web" }, MEI)).toEqual(
        fail("TERMS_AUTO_OVER_PER_TX", 0),
      );
    }
  });

  it("presetAvailability at 4,000 BU: 30/70 and 30/40/30 fit, 50/50 is over the per-tx cap, 0/100 always fits", () => {
    expect(presetAvailability(400_000n, MEI, "web")).toEqual([
      { preset: "P30_70", ok: true, code: null },
      { preset: "P50_50", ok: false, code: "TERMS_AUTO_OVER_PER_TX" },
      { preset: "P0_100", ok: true, code: null },
      { preset: "P30_40_30", ok: true, code: null },
    ]);
  });

  it("presetAvailability at Mei's 4,300 BU supplier quote: only 0/100 fits (a 1,290 BU deposit is over the cap)", () => {
    expect(presetAvailability(430_000n, MEI, "web").map((p) => [p.preset, p.code])).toEqual([
      ["P30_70", "TERMS_AUTO_OVER_PER_TX"],
      ["P50_50", "TERMS_AUTO_OVER_PER_TX"],
      ["P0_100", null],
      ["P30_40_30", "TERMS_AUTO_OVER_PER_TX"],
    ]);
  });

  it("presetAvailability: over the free pocket, or not a whole BU, every preset fails the same way", () => {
    for (const p of presetAvailability(600_000n, MEI, "web")) expect(p).toMatchObject({ ok: false, code: "TERMS_OVER_POCKET" });
    for (const p of presetAvailability(400_050n, MEI, "catalog")) expect(p).toMatchObject({ ok: false, code: "TERMS_TOTAL_INVALID" });
  });

  it("presetAvailability: a spent window blocks every preset with a deposit", () => {
    expect(presetAvailability(200_000n, { ...MEI, windowCapMinor: 0n }, "web").map((p) => p.code)).toEqual([
      "TERMS_UPFRONT_OVER_WINDOW",
      "TERMS_UPFRONT_OVER_WINDOW",
      null,
      "TERMS_UPFRONT_OVER_WINDOW",
    ]);
  });

  it("presetAvailability agrees with termsToSchedule preset by preset", () => {
    for (const total of [100n, 10_000n, 99_900n, 250_000n, 400_000n, 430_000n, 500_000n]) {
      for (const origin of ["web", "catalog"] as const) {
        const rows = presetAvailability(total, MEI, origin);
        expect(rows.map((r) => r.preset)).toEqual([...TERMS_PRESETS]);
        for (const row of rows) {
          const r = termsToSchedule({ totalMinor: total, milestones: TERMS_PRESET_MILESTONES[row.preset], origin }, MEI);
          expect(row).toEqual({ preset: row.preset, ok: r.ok, code: r.ok ? null : r.code });
        }
      }
    }
  });
});
