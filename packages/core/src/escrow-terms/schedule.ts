/**
 * termsToSchedule (VISION-DECISIONS §8): turns the founder's confirmed split into the escrow schedule, or refuses with
 * the FIRST failing TERMS_* code in TERMS_ERROR_CODES order (plus the index of the offending milestone when there is
 * one). Pure and deterministic; money is bigint minor units, 1 BU = 100 minor.
 *
 *   1. TERMS_COUNT 1–8 milestones · TERMS_PCT_RANGE each bps an integer 1–10,000 · TERMS_PCT_SUM Σbps = 10,000
 *   2. TERMS_TRIGGER_ORDER triggers non-decreasing in MILESTONE_TRIGGERS order (an unknown trigger fails here too)
 *      · TERMS_LAST_NOT_INSPECTED the last is ON_DELIVERY_INSPECTED
 *   3. TERMS_TOTAL_INVALID total a bigint > 0, a whole number of BU, ≤ uint128 · TERMS_OVER_POCKET total ≤ freeMinor
 *   4. amounts: floorBu(total × bps / 10,000) for every milestone but the last, which takes the remainder
 *      · TERMS_MILESTONE_ZERO any part under 1 BU
 *   5. autoRelease = (trigger = ON_ORDER) · TERMS_AUTO_NOT_FIRST auto parts come first (defence in depth: rule 2
 *      already guarantees it, so termsToSchedule never returns this code)
 *   6. TERMS_WEB_AUTO_COUNT a web supplier has at most 1 auto part
 *   7. TERMS_AUTO_OVER_PER_TX each auto part ≤ perTxCapMinor
 *   8. TERMS_UPFRONT_OVER_HALF 2 × Σauto ≤ total
 *   9. TERMS_UPFRONT_OVER_WINDOW Σauto ≤ windowCapMinor
 *
 * Founder-controlled values (milestones, total) are refused with a code. Caller-controlled values (limits, origin)
 * that are malformed are a bug and throw a TypeError (fail closed).
 */
import { BPS_DENOMINATOR, UINT128_MAX, bpsFloor } from "../money/index";
import { MILESTONE_LABELS, MILESTONE_TRIGGERS, type MilestoneTrigger, type TermsErrorCode, type TermsMilestone } from "./constants";

/** 1 BU = 100 minor units. */
export const BU_MINOR = 100n;
export const MAX_MILESTONES = 8;
const FULL_BPS = Number(BPS_DENOMINATOR);
const LAST_TRIGGER: MilestoneTrigger = "ON_DELIVERY_INSPECTED";
const AUTO_TRIGGER: MilestoneTrigger = "ON_ORDER";

export type TermsOrigin = "web" | "catalog";

export interface TermsLimits {
  /** What is still free in the SUPPLIER pocket (allocated − spent − escrowed). */
  readonly freeMinor: bigint;
  /** The line's per-tx cap: bounds each auto-released milestone. */
  readonly perTxCapMinor: bigint;
  /** What is left of the line's rolling window: bounds the auto-released total. */
  readonly windowCapMinor: bigint;
}

export interface TermsInput {
  readonly totalMinor: bigint;
  readonly milestones: readonly TermsMilestone[];
  readonly origin: TermsOrigin;
}

export interface TermsFailure {
  readonly ok: false;
  readonly code: TermsErrorCode;
  /** Index (input order) of the offending milestone, when one milestone is at fault. */
  readonly idx?: number;
}

export type TermsScheduleResult =
  | { readonly ok: true; readonly amounts: bigint[]; readonly autoRelease: boolean[]; readonly labels: string[] }
  | TermsFailure;

const TRIGGER_RANK: ReadonlyMap<string, number> = new Map(MILESTONE_TRIGGERS.map((t, i) => [t, i]));

function failure(code: TermsErrorCode, idx?: number): TermsFailure {
  return idx === undefined ? { ok: false, code } : { ok: false, code, idx };
}

/** Round a non-negative minor amount down to a whole BU. */
export function floorBu(minor: bigint): bigint {
  if (minor < 0n) throw new RangeError(`floorBu of a negative amount: ${minor}`);
  return minor - (minor % BU_MINOR);
}

/** Rule 1 (count, range, sum) and rule 2 (order, last). Shared with parseTermsHint so a hint is never malformed. */
export function structureProblem(milestones: readonly TermsMilestone[]): TermsFailure | null {
  if (!Array.isArray(milestones) || milestones.length < 1 || milestones.length > MAX_MILESTONES) return failure("TERMS_COUNT");
  for (const [i, x] of milestones.entries()) {
    const bps: unknown = x === null || typeof x !== "object" ? undefined : x.bps;
    if (typeof bps !== "number" || !Number.isInteger(bps) || bps < 1 || bps > FULL_BPS) return failure("TERMS_PCT_RANGE", i);
  }
  if (milestones.reduce((s, x) => s + x.bps, 0) !== FULL_BPS) return failure("TERMS_PCT_SUM");
  let previous = 0;
  for (const [i, x] of milestones.entries()) {
    const rank = typeof x.trigger === "string" ? TRIGGER_RANK.get(x.trigger) : undefined;
    if (rank === undefined || rank < previous) return failure("TERMS_TRIGGER_ORDER", i);
    previous = rank;
  }
  const last = milestones.length - 1;
  return (milestones[last] as TermsMilestone).trigger === LAST_TRIGGER ? null : failure("TERMS_LAST_NOT_INSPECTED", last);
}

/** Rule 3. */
function totalProblem(total: unknown, freeMinor: bigint): TermsFailure | null {
  if (typeof total !== "bigint" || total <= 0n || total > UINT128_MAX || total % BU_MINOR !== 0n) return failure("TERMS_TOTAL_INVALID");
  return total > freeMinor ? failure("TERMS_OVER_POCKET") : null;
}

/** Rule 4: each part but the last rounds down to whole BU; the last takes the remainder (so it is whole BU too). */
function splitAmounts(total: bigint, milestones: readonly TermsMilestone[]): bigint[] {
  const head = milestones.slice(0, -1).map((x) => floorBu(bpsFloor(total, x.bps)));
  return [...head, total - head.reduce((s, a) => s + a, 0n)];
}

/** Rule 5: no auto-released part after a held one. Exported for its own test (termsToSchedule cannot reach it). */
export function autoFirstProblem(autoRelease: readonly boolean[]): TermsFailure | null {
  const i = autoRelease.findIndex((auto, j) => auto && j > 0 && !autoRelease[j - 1]);
  return i < 0 ? null : failure("TERMS_AUTO_NOT_FIRST", i);
}

/** Rules 6–9. */
function autoProblem(total: bigint, amounts: readonly bigint[], autoRelease: readonly boolean[], origin: TermsOrigin, limits: TermsLimits): TermsFailure | null {
  const autoIdx = autoRelease.flatMap((auto, i) => (auto ? [i] : []));
  if (origin === "web" && autoIdx.length > 1) return failure("TERMS_WEB_AUTO_COUNT", autoIdx[1]);
  const over = autoIdx.find((i) => (amounts[i] as bigint) > limits.perTxCapMinor);
  if (over !== undefined) return failure("TERMS_AUTO_OVER_PER_TX", over);
  const autoSum = autoIdx.reduce((s, i) => s + (amounts[i] as bigint), 0n);
  if (2n * autoSum > total) return failure("TERMS_UPFRONT_OVER_HALF");
  return autoSum > limits.windowCapMinor ? failure("TERMS_UPFRONT_OVER_WINDOW") : null;
}

function assertCallerArgs(input: TermsInput, limits: TermsLimits): void {
  if (input === null || typeof input !== "object") throw new TypeError("termsToSchedule: input must be an object");
  if (input.origin !== "web" && input.origin !== "catalog") throw new TypeError("termsToSchedule: origin must be web or catalog");
  if (limits === null || typeof limits !== "object") throw new TypeError("termsToSchedule: limits must be an object");
  for (const key of ["freeMinor", "perTxCapMinor", "windowCapMinor"] as const) {
    const v: unknown = limits[key];
    if (typeof v !== "bigint" || v < 0n) throw new TypeError(`termsToSchedule: limits.${key} must be a non-negative bigint`);
  }
}

export function termsToSchedule(input: TermsInput, limits: TermsLimits): TermsScheduleResult {
  assertCallerArgs(input, limits);
  const { milestones, totalMinor: total, origin } = input;
  const structural = structureProblem(milestones) ?? totalProblem(total, limits.freeMinor);
  if (structural) return structural;

  const amounts = splitAmounts(total, milestones);
  const zero = amounts.findIndex((a) => a < BU_MINOR);
  if (zero >= 0) return failure("TERMS_MILESTONE_ZERO", zero);

  const autoRelease = milestones.map((x) => x.trigger === AUTO_TRIGGER);
  const problem = autoFirstProblem(autoRelease) ?? autoProblem(total, amounts, autoRelease, origin, limits);
  if (problem) return problem;

  return { ok: true, amounts, autoRelease, labels: milestones.map((x) => MILESTONE_LABELS[x.trigger]) };
}
