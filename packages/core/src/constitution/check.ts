/**
 * TS mirror of the on-chain constitution (project.md §8.3; PlanRegistry.commitPlan reverts
 * PlanInvariantViolated(code) even with a valid signature). Codes and names are CONSTITUTION_CODES /
 * HogeeKinds.CONST_* (same uint8).
 *
 * Pure and integer-only: every amount is parsed from its digit string into a bigint; percentages are
 * compared by cross-multiplication in basis points, so there is no division and no rounding:
 *   perTxCap ≤ 25% of line   ⇔  perTxCap × 10,000 ≤ line × 2,500
 * (for integers this is the same as `perTxCap ≤ floor(line × 2,500 / 10,000)`, so a Solidity
 * implementation that divides first agrees).
 *
 * The report has one entry per code, in code order. `firstViolation(report)` is the code the contract reverts with:
 * PlanConstitution.check returns 13 (malformed, role separation included) first, then 12 (totals), then the lowest of
 * 1-10 (CONSTITUTION_PRECEDENCE). Code 11 is enforced by Treasury.bindPayee, so it comes after them here; code 14
 * REPLAN_LOOSENS (G0-AUDIT v-1) compares a re-commit with the current on-chain plan (./replan.ts) and only runs when
 * every other code passes. `commitPlanOutcome` adds the StalePlan sequencing.
 * Malformed input fails closed: a rule whose inputs cannot be read is reported as violated, and
 * MALFORMED_PLAN fails too.
 */
import { CONSTITUTION_CODES, type ConstitutionCode } from "../schemas/enums";
import type { ConstitutionCheck, PlanManifest } from "../schemas/plan";
import { stringToBytes32, type Address } from "../schemas/primitives";
import { BPS_DENOMINATOR, sumBig, tryParseMinor } from "../money/index";
import { checkPlanSequence, replanLoosenings } from "./replan";
import type { CommittedPlan, ConstitutionFacility, RegistryPayee } from "./types";

/** PlanConstitution.check shape limits (code 13): they keep commitPlan's gas bounded. */
export const MAX_PLAN_LINES = 16;
export const MAX_PLAN_STAGES = 8;
export const MAX_PAYEES_PER_LINE = 8;

/** The order PlanConstitution.check decides in: 13, then 12, then 1-10 ascending; then 11 (bindPayee) and 14 (replan). */
export const CONSTITUTION_PRECEDENCE: readonly ConstitutionCode[] = [
  "MALFORMED_PLAN",
  "TOTALS_MISMATCH",
  "LINES_EXCEED_FACILITY_CAP",
  "AGENT_EXPIRY_TOO_LATE",
  "AGENT_EXPIRY_TOO_EARLY",
  "PER_TX_CAP_OVER_25PCT",
  "WINDOW_CAP_OVER_50PCT",
  "LINE_VALIDITY_TOO_LONG",
  "RESERVE_BELOW_FLOOR",
  "STAGE1_OVER_40PCT",
  "PLAN_ADDS_PAYEE",
  "SUPPLIER_LINE_NOT_ESCROW",
  "PAYEE_CAP_OVER_SCHEDULE",
  "REPLAN_LOOSENS",
];

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS_RE = /^0x0{40}$/;
/** An unknown role key (ConstitutionFacility ownerEOA / lender / oracle), or a passkey-only owner's EOA. */
export const ZERO_ADDRESS: Address = `0x${"0".repeat(40)}`;

export const SECONDS_PER_DAY_BIG = 86_400n;
/** §8.3: agentExpiry and every line's validUntil ≤ now + 90 days. */
export const MAX_HORIZON_DAYS = 90;
export const MAX_HORIZON_SECONDS = BigInt(MAX_HORIZON_DAYS) * SECONDS_PER_DAY_BIG;
/** §8.3: perTxCap ≤ 25% of the line. */
export const PER_TX_CAP_MAX_BPS = 2_500n;
/** §8.3: rolling-window cap ≤ 50% of the line. */
export const WINDOW_CAP_MAX_BPS = 5_000n;
/** §8.3: stage 1 (index 0, released at commitPlan) ≤ 40% of the total. */
export const STAGE1_MAX_BPS = 4_000n;
/** The line that must be escrowOnly (HogeeKinds.LINE_SUPPLIER). */
export const SUPPLIER_LINE_KEY = "SUPPLIER";

const STAGE_GATE_METRICS_ALLOWED = new Set(["salesMinor", "orders"]);

/** `part ≤ bps/10,000 of whole`, by cross-multiplication. */
export function withinBps(part: bigint, whole: bigint, maxBps: bigint): boolean {
  return part * BPS_DENOMINATOR <= whole * maxBps;
}

/** Per-line cap bounds also re-checked by executeLoosen (G0-REVIEW H2) and MOVE_POCKETS. */
export function lineCapsWithinConstitution(amount: bigint, perTxCap: bigint, windowCap: bigint): boolean {
  return withinBps(perTxCap, amount, PER_TX_CAP_MAX_BPS) && withinBps(windowCap, amount, WINDOW_CAP_MAX_BPS);
}

function toBig(v: unknown): bigint | null {
  if (typeof v === "bigint") return v >= 0n ? v : null;
  return tryParseMinor(v);
}

/** Schedule total of a registry payee, or null when it has no schedule. */
export function scheduleTotal(payee: RegistryPayee): bigint | null {
  if (!payee.schedule) return null;
  const amounts = payee.schedule.map((m) => tryParseMinor(m.amountMinor));
  if (amounts.some((a) => a === null)) return null;
  return sumBig(amounts as bigint[]);
}

/** A mirrored lifetime cap or schedule amount that cannot be read. */
export const MALFORMED_CAP = "MALFORMED" as const;

/** Lifetime cap as mirrored: explicit cap, else the schedule total, else null (uncapped); MALFORMED_CAP if unreadable. */
export function lifetimeCapOf(payee: RegistryPayee): bigint | null | typeof MALFORMED_CAP {
  if (payee.lifetimeCapMinor !== undefined) return tryParseMinor(payee.lifetimeCapMinor) ?? MALFORMED_CAP;
  if (!payee.schedule) return null;
  return scheduleTotal(payee) ?? MALFORMED_CAP;
}

/**
 * Effective lifetime cap for paying: explicit cap, else the schedule total, else null (uncapped). An unreadable
 * mirrored value fails closed as 0 (pays nothing), never as uncapped.
 */
export function effectiveLifetimeCap(payee: RegistryPayee): bigint | null {
  const cap = lifetimeCapOf(payee);
  return cap === MALFORMED_CAP ? 0n : cap;
}

/** The registry entry that lets `payeeId` be paid from `lineKey`, if any. */
export function registryEntryFor(payees: readonly RegistryPayee[], payeeId: string, lineKey: string): RegistryPayee | undefined {
  return payees.find((p) => p.payeeId === payeeId && (p.lineKeys as readonly string[]).includes(lineKey));
}

type Lines = PlanManifest["lines"];
type Stages = PlanManifest["stages"];

function asArray<T>(v: unknown): readonly T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/**
 * Code 13 role separation: the agent key is never the owner's, the lender's, the oracle's or the observer's. A
 * required role that is missing, or any role that is not an address, fails closed (a cast or a JS caller cannot skip
 * the check). The observer is optional (absent = none, as Treasury.observer() == 0).
 */
function agentSharesRole(m: PlanManifest, facility: ConstitutionFacility): boolean {
  const agent = typeof m.agent?.address === "string" ? m.agent.address.toLowerCase() : null;
  const required: readonly unknown[] = [facility.ownerEOA, facility.lender, facility.oracle];
  const roles: readonly unknown[] = facility.observer === undefined ? required : [...required, facility.observer];
  if (agent === null || !roles.every((r) => typeof r === "string" && ADDRESS_RE.test(r))) return true;
  return roles.some((role) => (role as string).toLowerCase() === agent);
}

function malformed(m: PlanManifest): boolean {
  const lines = asArray<Lines[number]>(m.lines);
  const stages = asArray<Stages[number]>(m.stages);
  if (lines.length === 0 || lines.length > MAX_PLAN_LINES || stages.length === 0 || stages.length > MAX_PLAN_STAGES) return true;
  if (!Number.isInteger(m.reserveBps) || m.reserveBps < 0 || m.reserveBps > 10_000) return true;
  const total = toBig(m.totalMinor);
  if (total === null || total === 0n || toBig(m.agent?.expiresAt) === null) return true;
  const agent = m.agent?.address;
  if (typeof agent !== "string" || !ADDRESS_RE.test(agent) || ZERO_ADDRESS_RE.test(agent)) return true;
  const lineKeys = new Set<string>();
  for (const l of lines) {
    if (lineKeys.has(l.lineKey)) return true;
    lineKeys.add(l.lineKey);
    let lineId: string;
    try {
      lineId = stringToBytes32(l.lineKey);
    } catch {
      return true;
    }
    if (l.lineId !== lineId) return true;
    for (const v of [l.amountMinor, l.perTxCapMinor, l.windowCapMinor, l.validUntil]) if (toBig(v) === null) return true;
    const windowSeconds = toBig(l.windowSeconds);
    if (windowSeconds === null || windowSeconds === 0n) return true;
    if (l.pacing !== undefined) {
      const pacing = toBig(l.pacing.amountMinor);
      if (pacing === null || pacing === 0n) return true;
    }
    if (!Array.isArray(l.payeeIds) || l.payeeIds.length > MAX_PAYEES_PER_LINE || new Set(l.payeeIds).size !== l.payeeIds.length) return true;
    if (l.payeeIds.some((id) => typeof id !== "string" || id.length === 0)) return true;
  }
  const stageIds = new Set<string>();
  for (const [i, s] of stages.entries()) {
    if (typeof s.stageId !== "string" || s.stageId.length === 0 || stageIds.has(s.stageId)) return true;
    stageIds.add(s.stageId);
    if (toBig(s.releaseMinor) === null) return true;
    if (i === 0 ? s.gate !== null : s.gate === null) return true;
    if (s.gate && (!STAGE_GATE_METRICS_ALLOWED.has(s.gate.metric) || toBig(s.gate.target) === null || toBig(s.gate.deadline) === null)) {
      return true;
    }
  }
  return false;
}

/** Sum of a field over items; null if any value is unreadable. */
function sumOf<T>(items: readonly T[], get: (x: T) => unknown): bigint | null {
  let total = 0n;
  for (const it of items) {
    const v = toBig(get(it));
    if (v === null) return null;
    total += v;
  }
  return total;
}

function everyLine(lines: readonly Lines[number][], pred: (l: Lines[number]) => boolean | null): boolean {
  return lines.every((l) => pred(l) === true);
}

/**
 * Check a manifest against the §8.3 constitution. `now` is the commit time (unix seconds). `current` is the
 * on-chain plan a re-commit replaces (null/absent or version 0 = first commit: code 14 passes).
 * Returns one `{code, ok}` per CONSTITUTION_CODES entry, in code order.
 */
export function checkConstitution(
  manifest: PlanManifest,
  facility: ConstitutionFacility,
  now: string | bigint,
  current: CommittedPlan | null = null,
): ConstitutionCheck[] {
  const lines = asArray<Lines[number]>(manifest.lines);
  const stages = asArray<Stages[number]>(manifest.stages);
  const nowBig = toBig(now);
  const latest = nowBig === null ? null : nowBig + MAX_HORIZON_SECONDS;
  const cap = toBig(facility.capMinor);
  const judgingEnd = toBig(facility.judgingWindowEnd);
  const total = toBig(manifest.totalMinor);
  const agentExpiry = toBig(manifest.agent?.expiresAt);
  const linesSum = sumOf(lines, (l) => l.amountMinor);
  const stagesSum = sumOf(stages, (s) => s.releaseMinor);
  const stage1 = stages.length > 0 ? toBig(stages[0]?.releaseMinor) : null;

  const capRule = (maxBps: bigint, get: (l: Lines[number]) => unknown) =>
    everyLine(lines, (l) => {
      const amount = toBig(l.amountMinor);
      const part = toBig(get(l));
      return amount !== null && part !== null && withinBps(part, amount, maxBps);
    });

  const payeeRefs = lines.flatMap((l) => asArray<string>(l.payeeIds).map((payeeId) => ({ line: l, payeeId })));

  const results: { readonly [C in ConstitutionCode]: boolean } = {
    LINES_EXCEED_FACILITY_CAP: linesSum !== null && cap !== null && linesSum <= cap,
    AGENT_EXPIRY_TOO_LATE: agentExpiry !== null && latest !== null && agentExpiry <= latest,
    AGENT_EXPIRY_TOO_EARLY: agentExpiry !== null && judgingEnd !== null && agentExpiry > judgingEnd,
    PER_TX_CAP_OVER_25PCT: capRule(PER_TX_CAP_MAX_BPS, (l) => l.perTxCapMinor),
    WINDOW_CAP_OVER_50PCT: capRule(WINDOW_CAP_MAX_BPS, (l) => l.windowCapMinor),
    LINE_VALIDITY_TOO_LONG: everyLine(lines, (l) => {
      const until = toBig(l.validUntil);
      return until !== null && latest !== null && until <= latest;
    }),
    RESERVE_BELOW_FLOOR:
      Number.isInteger(manifest.reserveBps) && Number.isInteger(facility.reserveFloorBps) && manifest.reserveBps >= facility.reserveFloorBps,
    STAGE1_OVER_40PCT: stage1 !== null && total !== null && withinBps(stage1, total, STAGE1_MAX_BPS),
    PLAN_ADDS_PAYEE: payeeRefs.every(({ line, payeeId }) => registryEntryFor(facility.payees, payeeId, line.lineKey) !== undefined),
    SUPPLIER_LINE_NOT_ESCROW: lines.every((l) => l.lineKey !== SUPPLIER_LINE_KEY || l.escrowOnly === true),
    PAYEE_CAP_OVER_SCHEDULE: payeeRefs.every(({ line, payeeId }) => {
      const entry = registryEntryFor(facility.payees, payeeId, line.lineKey);
      if (!entry) return true; // unknown payee: PLAN_ADDS_PAYEE reports it
      if (entry.schedule === undefined) return line.escrowOnly !== true; // an escrow line pays only scheduled payees
      const scheduled = scheduleTotal(entry);
      const lifetime = lifetimeCapOf(entry);
      return scheduled !== null && typeof lifetime === "bigint" && lifetime <= scheduled;
    }),
    TOTALS_MISMATCH: total !== null && linesSum === total && stagesSum === total,
    MALFORMED_PLAN: !malformed(manifest) && !agentSharesRole(manifest, facility),
    REPLAN_LOOSENS: replanLoosenings(manifest, current).length === 0,
  };
  return CONSTITUTION_CODES.map((code) => ({ code, ok: results[code] }));
}

/** Codes that failed, in code order. */
export function constitutionViolations(report: readonly ConstitutionCheck[]): ConstitutionCode[] {
  return report.filter((c) => !c.ok).map((c) => c.code);
}

/** The code the contract would revert with (first failing code in CONSTITUTION_PRECEDENCE), or null if the plan passes. */
export function firstViolation(report: readonly ConstitutionCheck[]): ConstitutionCode | null {
  const failed = new Set(constitutionViolations(report));
  return CONSTITUTION_PRECEDENCE.find((code) => failed.has(code)) ?? null;
}

export function constitutionOk(report: readonly ConstitutionCheck[]): boolean {
  return report.length === CONSTITUTION_CODES.length && report.every((c) => c.ok);
}

/** What PlanRegistry.commitPlan does with a validly signed approval of `manifest` (signature checks aside). */
export type CommitPlanOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: "StalePlan" }
  | { readonly ok: false; readonly error: "PlanInvariantViolated"; readonly code: ConstitutionCode };

/** Sequencing first (StalePlan), then the constitution in code order (1-13, then 14). */
export function commitPlanOutcome(
  manifest: PlanManifest,
  facility: ConstitutionFacility,
  now: string | bigint,
  current: CommittedPlan | null,
): CommitPlanOutcome {
  if (checkPlanSequence(manifest, current)) return { ok: false, error: "StalePlan" };
  const code = firstViolation(checkConstitution(manifest, facility, now, current));
  return code ? { ok: false, error: "PlanInvariantViolated", code } : { ok: true };
}
