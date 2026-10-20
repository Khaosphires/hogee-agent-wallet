/**
 * buildCfoReport (VISION §8 core-cfo): pure, cash basis, from the founder's own records only.
 *
 *   - cashAvailable: the lines' available BU, capped (when given) by releasedMinor / fundedMinor minus total outflow
 *     (Σ spent + Σ escrowed): spend and escrow funding revert CapExceeded past either.
 *   - P&L over [first record, today]: recorded sales − supplier cost − operating spend by line (./ledger.ts rules); the
 *     reserve is shown as set aside, not as an expense. overview.spentMinor = supplier cost + operating spend.
 *   - Daily series: the last 30 UTC days ending today, zero-filled; spending.daily is operating spend.
 *   - Forecast: ./forecast.ts. Insights: ./insights.ts. Agent actions: the 10 most recent, newest first.
 */
import { LINE_KEYS, type LineKey } from "../schemas/enums";
import { minBig } from "../money/index";
import { burnsOf } from "./burn";
import { project } from "./forecast";
import { buildInsights } from "./insights";
import { SERIES_DAYS, isoDay, readLedger, sumDays, type Ledger, type LedgerOutflow } from "./ledger";
import { CFO_DISCLAIMER, type CfoAgentAction, type CfoInputs, type CfoLineIn, type CfoReport } from "./types";

const MAX_RECENT_SALES = 20;
const MAX_AGENT_ACTIONS = 10;

const byLineOrder = <T extends { readonly lineKey: LineKey }>(xs: readonly T[]): T[] =>
  [...xs].sort((a, b) => LINE_KEYS.indexOf(a.lineKey) - LINE_KEYS.indexOf(b.lineKey));

const sum = (xs: readonly bigint[]): bigint => xs.reduce((s, x) => s + x, 0n);

function cashAvailableOf(i: CfoInputs): bigint {
  const available = sum(i.lines.map((l) => l.availableMinor));
  const outflow = sum(i.lines.map((l) => l.spentMinor + l.escrowedMinor));
  const ceilings = [i.releasedMinor, i.fundedMinor].filter((c): c is bigint => c !== undefined).map((c) => (c > outflow ? c - outflow : 0n));
  return minBig(available, ...ceilings);
}

const seriesDays = (l: Ledger): number[] => Array.from({ length: SERIES_DAYS }, (_, k) => l.today - SERIES_DAYS + 1 + k);

function spending(i: CfoInputs, l: Ledger): CfoReport["spending"] {
  return {
    byLine: byLineOrder(i.lines).map((x: CfoLineIn) => ({
      lineKey: x.lineKey,
      allocatedMinor: x.allocatedMinor,
      spentMinor: x.spentMinor,
      escrowedMinor: x.escrowedMinor,
      availableMinor: x.availableMinor,
    })),
    daily: seriesDays(l).map((d) => ({ date: isoDay(d), spentMinor: sumDays(l.operating, d, d) })),
  };
}

function sales(l: Ledger, stageGate: CfoReport["sales"]["stageGate"]): CfoReport["sales"] {
  const revenue = sum(l.sales.map((s) => s.amount));
  const count = l.sales.length;
  return {
    count,
    revenueMinor: revenue,
    averageMinor: count === 0 ? 0n : revenue / BigInt(count),
    daily: seriesDays(l).map((d) => {
      const day = l.sales.filter((s) => s.day === d);
      return { date: isoDay(d), revenueMinor: sum(day.map((s) => s.amount)), count: day.length };
    }),
    recent: [...l.sales]
      .reverse()
      .slice(0, MAX_RECENT_SALES)
      .map((s) => ({ saleId: s.saleId, amountMinor: s.amount, at: new Date(s.atMs).toISOString(), txHash: s.txHash })),
    stageGate,
  };
}

function pnl(i: CfoInputs, l: Ledger): CfoReport["pnl"] {
  const keys = new Set<LineKey>([...i.lines.map((x) => x.lineKey), ...l.operating.map((x) => x.lineKey)]);
  const operatingByLine = byLineOrder([...keys].map((lineKey) => ({ lineKey, amountMinor: sum(l.operating.filter((x) => x.lineKey === lineKey).map((x) => x.amount)) })));
  const revenue = sum(l.sales.map((s) => s.amount));
  const supplierCost = sum(l.supplierCost.map((x: LedgerOutflow) => x.amount));
  const operating = sum(operatingByLine.map((x) => x.amountMinor));
  return {
    from: isoDay(l.firstDay ?? l.today),
    to: isoDay(l.today),
    revenueMinor: revenue,
    supplierCostMinor: supplierCost,
    operatingByLine,
    operatingMinor: operating,
    netMinor: revenue - supplierCost - operating,
    reserveSetAsideMinor: i.reserve.skimmedMinor,
    basis: "cash",
  };
}

const actionKey = (a: CfoAgentAction): string => `${a.action}|${a.lineKey ?? ""}|${a.newValue}|${a.txHash ?? ""}`;

/** Newest first; ties broken by content so the order never depends on the input order. */
function recentActions(actions: readonly CfoAgentAction[]): CfoAgentAction[] {
  return [...actions]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (actionKey(a) < actionKey(b) ? -1 : actionKey(a) > actionKey(b) ? 1 : 0))
    .slice(0, MAX_AGENT_ACTIONS);
}

export function buildCfoReport(i: CfoInputs): CfoReport {
  const l = readLedger(i);
  const cashAvailable = cashAvailableOf(i);
  const reserve: CfoReport["reserve"] = {
    rateBps: i.reserve.rateBps,
    skimmedMinor: i.reserve.skimmedMinor,
    withdrawnMinor: i.reserve.withdrawnMinor,
    balanceMinor: i.reserve.skimmedMinor - i.reserve.withdrawnMinor,
    taxPayeeId: i.reserve.taxPayeeId,
    salesCount: l.sales.length,
  };
  const { forecast, stageGate } = project(i, l, cashAvailable, reserve.balanceMinor);
  const p = pnl(i, l);
  const insights = buildInsights({ inputs: i, ledger: l, burns: burnsOf(i, l), cashAvailable, forecast, stageGate, reserve });
  return {
    asOf: new Date(l.nowMs).toISOString(),
    currency: i.currency,
    facilityId: i.facilityId,
    overview: {
      cashAvailableMinor: cashAvailable,
      spentMinor: p.supplierCostMinor + p.operatingMinor,
      revenueMinor: p.revenueMinor,
      reserveMinor: reserve.balanceMinor,
      netMinor: p.netMinor,
    },
    spending: spending(i, l),
    sales: sales(l, stageGate),
    pnl: p,
    forecast,
    reserve,
    insights,
    agentActions: recentActions(i.agentActions),
    disclaimer: CFO_DISCLAIMER,
  };
}
