/**
 * Lines, caps, pacing, stages and the agent key lifetime: pure functions of the budget, the intent's bounded
 * choices, the payee registry and the constants in ./constants.ts.
 */
import type { LineEmphasis, LineKey, SellChannel } from "../schemas/enums";
import type { PlanIntent, PlanLine, PlanStage } from "../schemas/plan";
import { lineIdOf } from "../schemas/plan";
import type { PayeeId } from "../schemas/primitives";
import { BPS_DENOMINATOR, bpsFloor, maxBig, minBig, mulDivCeil, mulDivFloor, toMinor } from "../money/index";
import { lifetimeCapOf, registryEntryFor, scheduleTotal } from "../constitution/check";
import type { RegistryPayee } from "../constitution/types";
import {
  ADS_PURPOSE_OWN_SITE,
  AGENT_EXPIRY_MARGIN_SECONDS,
  CONSERVATIVE_PACING_DIVISOR,
  DEFAULT_EMPHASIS,
  LINE_GRANULARITY_MINOR,
  LINE_ORDER,
  LINE_PURPOSES,
  LINE_SPLIT_WEIGHTS_BPS,
  MAX_AGENT_LIFETIME_SECONDS,
  PACING_JITTER_SLOTS,
  PACING_PERIOD_SECONDS,
  PER_TX_CAP_BPS,
  REMAINDER_LINE,
  STAGE1_RELEASE_BPS,
  STAGE2_DEADLINE_HORIZON_DIVISOR,
  STAGE2_SALES_TARGET_BPS,
  STAGE_IDS,
  WINDOW_CAP_BPS,
  WINDOW_SECONDS,
  type SplitLine,
} from "./constants";
import { CompileError } from "./errors";

const DAY = 86_400n;

/** Line amounts from the split table (see constants.ts), summing exactly to `budget`. */
export function splitBudget(budget: bigint, emphasis: PlanIntent["lineEmphasis"], licensingMinor: bigint): Map<LineKey, bigint> {
  const splitLines = LINE_ORDER.filter((k): k is SplitLine => k !== "LICENSING");
  const weightOf = (k: SplitLine): bigint => BigInt(LINE_SPLIT_WEIGHTS_BPS[k][(emphasis[k] as LineEmphasis | undefined) ?? DEFAULT_EMPHASIS]);
  const totalWeight = splitLines.reduce((s, k) => s + weightOf(k), 0n);
  const out = new Map<LineKey, bigint>();
  let allocated = 0n;
  for (const k of splitLines) {
    if (k === REMAINDER_LINE) continue;
    const amount = mulDivFloor(budget, weightOf(k), totalWeight * LINE_GRANULARITY_MINOR) * LINE_GRANULARITY_MINOR;
    out.set(k, amount);
    allocated += amount;
  }
  const remainder = budget - allocated - licensingMinor;
  if (remainder < 0n) {
    throw new CompileError("LICENSING_EXCEEDS_CONTINGENCY", `approval fees ${licensingMinor} exceed the contingency share of the budget`);
  }
  if (licensingMinor > 0n) out.set("LICENSING", licensingMinor);
  out.set(REMAINDER_LINE, remainder);
  return out;
}

/** LICENSING line amount: the approval fee rounded UP to whole budget units (0 = no line). */
export function licensingLineMinor(approvalFeeMinor: bigint): bigint {
  return mulDivCeil(approvalFeeMinor, 1n, LINE_GRANULARITY_MINOR) * LINE_GRANULARITY_MINOR;
}

/** Daily ADS pacing for a window cap (see constants.ts: 8 slots per 7-day window, conservative = half). */
export function adsPacingMinor(windowCap: bigint, perTxCap: bigint, mode: PlanIntent["adsPacing"]): bigint {
  const slots = mulDivCeil(WINDOW_SECONDS, 1n, PACING_PERIOD_SECONDS) + PACING_JITTER_SLOTS;
  const standard = windowCap / slots;
  const pacing = minBig(mode === "standard" ? standard : standard / CONSERVATIVE_PACING_DIVISOR, perTxCap);
  if (pacing <= 0n) throw new CompileError("BUDGET_TOO_SMALL", "the ads line is too small to pace daily");
  return pacing;
}

/**
 * Constitution code 11 for one payee on one line, exactly as checkConstitution reads it: a payee with a schedule
 * needs lifetime cap ≤ schedule total (on any line); an escrow line only takes payees with a schedule.
 */
function scheduleConsistent(p: RegistryPayee, escrowOnly: boolean): boolean {
  if (p.schedule === undefined) return !escrowOnly;
  const scheduled = scheduleTotal(p);
  const lifetime = lifetimeCapOf(p);
  return scheduled !== null && typeof lifetime === "bigint" && lifetime <= scheduled;
}

/**
 * Payees from the registry eligible for a line (sorted). Each payee is judged by the same entry the constitution
 * reads (registryEntryFor: first entry for that payee and line); escrow lines only take scheduled, schedule-capped
 * payees; platform payees must match the sell channel when they name channels.
 */
export function payeesForLine(registry: readonly RegistryPayee[], lineKey: LineKey, escrowOnly: boolean, channel: SellChannel): PayeeId[] {
  const ids = [...new Set(registry.filter((p) => p.lineKeys.includes(lineKey)).map((p) => p.payeeId))];
  return ids
    .filter((id) => {
      const p = registryEntryFor(registry, id, lineKey);
      if (!p) return false;
      if (p.source === "platform" && p.channels !== undefined && !p.channels.includes(channel)) return false;
      return scheduleConsistent(p, escrowOnly);
    })
    .sort();
}

export interface LineBuildInput {
  readonly amounts: ReadonlyMap<LineKey, bigint>;
  readonly intent: PlanIntent;
  readonly registry: readonly RegistryPayee[];
  readonly validUntil: bigint;
}

export function buildLines({ amounts, intent, registry, validUntil }: LineBuildInput): PlanLine[] {
  return LINE_ORDER.filter((k) => amounts.has(k)).map((lineKey) => {
    const amount = amounts.get(lineKey) ?? 0n;
    const perTx = bpsFloor(amount, PER_TX_CAP_BPS);
    const window = bpsFloor(amount, WINDOW_CAP_BPS);
    const escrowOnly = lineKey === "SUPPLIER";
    const purpose = lineKey === "ADS" && intent.sellChannel === "own_site" ? ADS_PURPOSE_OWN_SITE : LINE_PURPOSES[lineKey];
    const line: PlanLine = {
      lineKey,
      lineId: lineIdOf(lineKey),
      purpose,
      amountMinor: toMinor(amount),
      perTxCapMinor: toMinor(perTx),
      windowCapMinor: toMinor(window),
      windowSeconds: WINDOW_SECONDS.toString(),
      validUntil: validUntil.toString(),
      payeeIds: payeesForLine(registry, lineKey, escrowOnly, intent.sellChannel),
      escrowOnly,
    };
    if (lineKey !== "ADS") return line;
    return { ...line, pacing: { period: "day" as const, amountMinor: toMinor(adsPacingMinor(window, perTx, intent.adsPacing)) } };
  });
}

/** Stage 1 = 40% (released at commitPlan); stage 2 = the rest, gated on sales ≥ 20% by half the horizon. */
export function buildStages(total: bigint, now: bigint, horizonDays: number): PlanStage[] {
  const stage1 = mulDivFloor(total, STAGE1_RELEASE_BPS, BPS_DENOMINATOR);
  const deadline = now + (BigInt(horizonDays) * DAY) / STAGE2_DEADLINE_HORIZON_DIVISOR;
  return [
    { stageId: STAGE_IDS[0], releaseMinor: toMinor(stage1), gate: null },
    {
      stageId: STAGE_IDS[1],
      releaseMinor: toMinor(total - stage1),
      gate: { metric: "salesMinor", target: toMinor(bpsFloor(total, STAGE2_SALES_TARGET_BPS)), deadline: deadline.toString() },
    },
  ];
}

/** Agent expiry: the horizon end, pushed past the judging window (+ margin), never beyond now + 90 days. */
export function agentExpiry(now: bigint, horizonDays: number, judgingWindowEnd: bigint): bigint {
  const latest = now + MAX_AGENT_LIFETIME_SECONDS;
  const wanted = maxBig(now + BigInt(horizonDays) * DAY, judgingWindowEnd + AGENT_EXPIRY_MARGIN_SECONDS);
  const expiry = minBig(wanted, latest);
  if (expiry <= judgingWindowEnd) {
    throw new CompileError("AGENT_EXPIRY_INFEASIBLE", "now + 90 days does not reach past the judging window");
  }
  return expiry;
}
