/**
 * MA7 linear forecast (VISION §8): daily burn = operating spend over the last n = min(7, sampleDays) days ÷ n, daily
 * revenue likewise, both rounded down. With fewer than 3 days of data there is no projection: runwayDays and
 * stage2Date are null, points are empty and the reserve estimate is today's balance (never invent).
 *   - runwayDays = floor(cashAvailable / dailyBurn); null when nothing is being spent.
 *   - points: the next 30 days, cash = cashAvailable − dailyBurn × k (signed; revenue does not refill budget lines on
 *     chain, and a future stage release is not assumed).
 *   - stage2Date: the day of the sale that crossed the target if it is already met; else today + ceil(left / daily
 *     revenue), null when there is no revenue or that day is not before deadline + 30 days.
 *   - reserveIn30d = balance + floor(dailyRevenue × 30 × rateBps / 10,000).
 */
import { bpsFloor } from "../money/index";
import { MIN_SAMPLE_DAYS, SERIES_DAYS, epochDay, isoDay, maDays, sumDays, type Ledger } from "./ledger";
import type { CfoInputs, CfoReport } from "./types";

const DEADLINE_GRACE_DAYS = 30;
const RESERVE_HORIZON_DAYS = 30n;

export interface Projection {
  readonly forecast: CfoReport["forecast"];
  readonly stageGate: CfoReport["sales"]["stageGate"];
}

function dailyAverages(l: Ledger): { burn: bigint; revenue: bigint } {
  const n = maDays(l);
  if (n === 0) return { burn: 0n, revenue: 0n };
  const from = l.today - n + 1;
  return { burn: sumDays(l.operating, from, l.today) / BigInt(n), revenue: sumDays(l.sales, from, l.today) / BigInt(n) };
}

function crossingDay(l: Ledger, target: bigint): number | null {
  let total = 0n;
  for (const s of l.sales) {
    total += s.amount;
    if (total >= target) return s.day;
  }
  return null;
}

function stageDate(i: CfoInputs, l: Ledger, dailyRevenue: bigint, projecting: boolean): string | null {
  if (!i.stage || !projecting) return null;
  const met = crossingDay(l, i.stage.targetMinor);
  if (met !== null) return isoDay(met);
  if (dailyRevenue === 0n) return null;
  const soFar = l.sales.reduce((s, x) => s + x.amount, 0n);
  const days = (i.stage.targetMinor - soFar + dailyRevenue - 1n) / dailyRevenue;
  const limit = epochDay(i.stage.deadline.getTime()) + DEADLINE_GRACE_DAYS;
  if (days >= BigInt(limit - l.today)) return null;
  return isoDay(l.today + Number(days));
}

/** floor(cash / burn); null past Number's exact range (no meaningful runway to show). */
function runwayOf(cash: bigint, burn: bigint): number | null {
  const days = cash / burn;
  return days > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(days);
}

export function project(i: CfoInputs, l: Ledger, cashAvailable: bigint, reserveBalance: bigint): Projection {
  const { burn, revenue } = dailyAverages(l);
  const projecting = l.sampleDays >= MIN_SAMPLE_DAYS;
  const stage2Date = stageDate(i, l, revenue, projecting);
  const points = projecting
    ? Array.from({ length: SERIES_DAYS }, (_, k) => ({ date: isoDay(l.today + k + 1), cashMinor: cashAvailable - burn * BigInt(k + 1) }))
    : [];
  const forecast: CfoReport["forecast"] = {
    method: "MA7_LINEAR",
    sampleDays: l.sampleDays,
    dailyBurnMinor: burn,
    dailyRevenueMinor: revenue,
    runwayDays: projecting && burn > 0n ? runwayOf(cashAvailable, burn) : null,
    stage2Date,
    reserveIn30dMinor: reserveBalance + (projecting ? bpsFloor(revenue * RESERVE_HORIZON_DAYS, i.reserve.rateBps) : 0n),
    points,
  };
  const stageGate = i.stage
    ? {
        stageId: i.stage.stageId,
        targetMinor: i.stage.targetMinor,
        soFarMinor: l.sales.reduce((s, x) => s + x.amount, 0n),
        deadline: isoDay(epochDay(i.stage.deadline.getTime())),
        projectedDate: stage2Date,
      }
    : null;
  return { forecast, stageGate };
}
