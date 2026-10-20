/**
 * The Spending chart's bars, stacked by pocket (UX round 3, Steve #13), as pure functions so they are unit-tested.
 *
 * One source per number: each day's bar is the report's own figure (GET /api/cfo spending.daily, running costs: SPEND
 * and OWNER_SPEND by line, cash basis). The payments list (GET /api/payments) only colours it: each pocket's part of
 * the day, by core's counting rules (packages/core cfo/ledger.ts: a payment counts once it has a receipt, by UTC day,
 * none dated after the report's `asOf`). Whatever the payments don't account for (a row not loaded yet, or the two
 * reads a moment apart) stays in the bar as a neutral "Not split yet" part, so the bar's height is never changed by the
 * split. A day whose split comes to more than the report's figure is drawn whole in that neutral part.
 *
 * The chart starts at the first day with a record (pnl.from: the signing week, not 27 empty days), at most 30 days back.
 */
import { LINE_KEYS, type CfoReport, type Payment } from "@hogee/core";

/** A payment counts once it has a receipt (core cfo/ledger.ts COUNTED_STATES). */
const COUNTED: ReadonlySet<string> = new Set(["INCLUDED", "FINALIZED", "SETTLEMENT_REQUESTED", "SETTLED"]);
const RUNNING_COSTS: ReadonlySet<string> = new Set(["SPEND", "OWNER_SPEND"]);

/** The neutral part: running costs the payments list doesn't split (yet). */
export const UNSPLIT = "UNSPLIT";

export interface StackRow {
  readonly date: string;
  /** The report's figure for the day (minor units): the bar's height. */
  readonly totalMinor: string;
  /** Minor units per pocket (LINE_KEYS order) plus UNSPLIT; zero parts left out. */
  readonly parts: Readonly<Record<string, string>>;
}

type PaymentIn = Pick<Payment, "kind" | "lineKey" | "amountMinor" | "state" | "updatedAt">;

const isoDayOf = (iso: string): string | null => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
};

/** Each pocket's running costs per UTC day, from the payments the report would count (none after `asOf`). */
export function runningCostsByDay(payments: readonly PaymentIn[], asOf: string): Map<string, Map<string, bigint>> {
  const limit = Date.parse(asOf);
  const out = new Map<string, Map<string, bigint>>();
  for (const p of payments) {
    if (!RUNNING_COSTS.has(p.kind) || !COUNTED.has(p.state) || !p.lineKey) continue;
    const at = Date.parse(p.updatedAt);
    const day = isoDayOf(p.updatedAt);
    if (day === null || at > limit) continue;
    const byLine = out.get(day) ?? new Map<string, bigint>();
    byLine.set(p.lineKey, (byLine.get(p.lineKey) ?? 0n) + BigInt(p.amountMinor));
    out.set(day, byLine);
  }
  return out;
}

/** The days to draw: from the first record (pnl.from) to today, within the report's 30-day series. */
export function chartDays(report: Pick<CfoReport, "spending" | "pnl">): CfoReport["spending"]["daily"] {
  return report.spending.daily.filter((d) => d.date >= report.pnl.from);
}

/** The stacked rows: the report's daily figure, split by pocket where the payments say so, the rest UNSPLIT. */
export function stackRows(report: Pick<CfoReport, "spending" | "pnl" | "asOf">, payments: readonly PaymentIn[]): StackRow[] {
  const byDay = runningCostsByDay(payments, report.asOf);
  return chartDays(report).map((d) => {
    const total = BigInt(d.spentMinor);
    const split = byDay.get(d.date) ?? new Map<string, bigint>();
    const splitSum = [...split.values()].reduce((s, x) => s + x, 0n);
    const parts: Record<string, string> = {};
    if (splitSum > total) {
      if (total > 0n) parts[UNSPLIT] = total.toString();
      return { date: d.date, totalMinor: d.spentMinor, parts };
    }
    for (const key of LINE_KEYS) {
      const v = split.get(key) ?? 0n;
      if (v > 0n) parts[key] = v.toString();
    }
    if (total - splitSum > 0n) parts[UNSPLIT] = (total - splitSum).toString();
    return { date: d.date, totalMinor: d.spentMinor, parts };
  });
}

/** The parts drawn anywhere in the chart, in LINE_KEYS order then UNSPLIT: the stack order and the legend. */
export function stackKeys(rows: readonly StackRow[]): string[] {
  const seen = new Set(rows.flatMap((r) => Object.keys(r.parts)));
  return [...LINE_KEYS.filter((k) => seen.has(k)), ...(seen.has(UNSPLIT) ? [UNSPLIT] : [])];
}
