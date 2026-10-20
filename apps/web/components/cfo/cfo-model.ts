/**
 * The Wallet page (/dashboard) and the chat's money card, as pure functions of the report (GET /api/cfo), so they are
 * unit-tested without JSX: the views and the old ?tab= links (each lands on its section of the one scrolling page),
 * signed BU text, the profit bridge geometry, chart rows, sentences for what Hogee's AI changed, the card's slice per
 * view and the sample labels. Money stays minor-unit strings; numbers are made only for chart geometry.
 *
 * One source per number (UX-PLAN D8): "Ready to spend" is the wallet's own figure (lib/money.ts useReadyToSpend, core
 * walletFigures over GET /api/balances), passed in as `ready`; paid out, sales, kept for tax and profit come from the
 * report only.
 */
import { CFO_VIEWS, formatBu, type CfoAgentAction, type CfoInsight, type CfoReport, type CfoView, type Session } from "@hogee/core";
import { lineLabel } from "../../lib/format";

export const CFO_TABS: readonly { readonly view: CfoView; readonly label: string }[] = [
  { view: "overview", label: "Overview" },
  { view: "spending", label: "Spending" },
  { view: "sales", label: "Sales" },
  { view: "pnl", label: "Profit" },
  { view: "forecast", label: "Forecast" },
  { view: "reserve", label: "Tax money" },
];

/** ?tab=<view>; anything else is the overview. */
export function tabOf(param: string | null | undefined): CfoView {
  return (CFO_VIEWS as readonly string[]).includes(param ?? "") ? (param as CfoView) : "overview";
}

export const cfoHref = (view: CfoView): string => `/dashboard?tab=${view}`;

/**
 * The Wallet page's section for each view (lib/sections.ts ids; UX2 P1 decision 6): the page is one scroll, and an old
 * `?tab=<view>` link still lands on its section.
 */
export const SECTION_OF_VIEW: Readonly<Record<CfoView, string>> = {
  overview: "wallet-overview",
  spending: "wallet-spending",
  sales: "wallet-sales",
  pnl: "wallet-profit",
  forecast: "wallet-forecast",
  reserve: "wallet-tax",
};

/** The section a `?tab=` link scrolls to on load: null for none, an unknown view, or the overview (the page's top). */
export function landingSection(param: string | null | undefined): string | null {
  const view = tabOf(param);
  return view === "overview" ? null : SECTION_OF_VIEW[view];
}

const MINUS = "−";

/** "1,200 BU" or "−1,200 BU" (true minus) from a SignedMinor string. */
export function signedBu(minor: string): string {
  return minor.startsWith("-") ? `${MINUS}${formatBu(minor.slice(1))}` : formatBu(minor);
}

/** Whole BU as a number, for chart geometry and axes only (never shown as the exact figure). */
export const buNumber = (minor: string): number => Number(BigInt(minor) / 100n);

/** "12.5%" (one decimal) of part / whole, or null when whole is 0. */
export function pctText(part: bigint, whole: bigint): string | null {
  if (whole === 0n) return null;
  const tenths = (part * 1000n) / whole;
  const sign = tenths < 0n ? MINUS : "";
  const abs = tenths < 0n ? -tenths : tenths;
  return `${sign}${abs / 10n}.${abs % 10n}%`;
}

const DAY_LABEL = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
/** "2026-10-19" → "19 Oct". */
export const dayLabel = (isoDate: string): string => DAY_LABEL.format(new Date(`${isoDate}T00:00:00Z`));

/** One plain name per pocket, the same as every other page (lib/format.ts lineLabel). */
export const lineName = lineLabel;

/** An estimate (a per-day average) rounded to whole BU in minor units, half up: "12214" → "12200" (122 BU). */
export function wholeMinor(minor: string): string {
  const v = BigInt(minor);
  const abs = v < 0n ? -v : v;
  const rounded = ((abs + 50n) / 100n) * 100n;
  return (v < 0n && rounded !== 0n ? -rounded : rounded).toString();
}

/** True when costs are more than sales so far (a loss is never drawn or worded as a profit). */
export const isLoss = (p: Pick<CfoReport["pnl"], "netMinor">): boolean => p.netMinor.startsWith("-");

// ---- P&L bridge (a horizontal waterfall that is also the table) ----------------------------------------------------
export interface BridgeRow {
  readonly key: string;
  readonly label: string;
  /** Signed minor: sales and net as they are, costs negative. */
  readonly amountMinor: string;
  readonly kind: "total" | "cost" | "net";
  /** Bar position in % of the track (0..100). */
  readonly left: number;
  readonly width: number;
  /** "% of sales", null when there were no sales, or when costs passed sales (a −184% helps nobody). */
  readonly pctOfSales: string | null;
  /** The net row of a loss: drawn neutral, pointing left of zero, and named "Loss". */
  readonly loss: boolean;
}

/** Sales, then supplier cost and each operating line (non-zero), then profit or loss; bars run from the running total. */
export function bridgeRows(p: CfoReport["pnl"]): BridgeRow[] {
  const revenue = BigInt(p.revenueMinor);
  const costs = [
    { key: "SUPPLIER_COST", label: "Paid to the supplier", amount: BigInt(p.supplierCostMinor) },
    ...p.operatingByLine.map((l) => ({ key: l.lineKey, label: lineName(l.lineKey), amount: BigInt(l.amountMinor) })),
  ].filter((c) => c.amount > 0n);
  const steps: { key: string; label: string; from: bigint; to: bigint; kind: BridgeRow["kind"]; signed: bigint }[] = [{ key: "SALES", label: "Sales", from: 0n, to: revenue, kind: "total", signed: revenue }];
  let running = revenue;
  for (const c of costs) {
    steps.push({ key: c.key, label: c.label, from: running, to: running - c.amount, kind: "cost", signed: -c.amount });
    running -= c.amount;
  }
  const net = BigInt(p.netMinor);
  const loss = net < 0n;
  steps.push({ key: "NET", label: loss ? "Loss" : "Profit", from: 0n, to: net, kind: "net", signed: net });
  const lo = steps.reduce((m, s) => (s.to < m ? s.to : s.from < m ? s.from : m), 0n);
  const hi = steps.reduce((m, s) => (s.to > m ? s.to : s.from > m ? s.from : m), 0n);
  const span = hi - lo;
  const pct = (v: bigint): number => (span === 0n ? 0 : Number(((v - lo) * 10_000n) / span) / 100);
  return steps.map((s) => {
    const a = s.from < s.to ? s.from : s.to;
    const b = s.from < s.to ? s.to : s.from;
    return {
      key: s.key,
      label: s.label,
      amountMinor: s.signed.toString(),
      kind: s.kind,
      left: pct(a),
      width: pct(b) - pct(a),
      pctOfSales: loss ? null : pctText(s.signed, revenue),
      loss: loss && s.kind === "net",
    };
  });
}

// ---- Where the money went (the Spending card's split) -------------------------------------------------------------
export interface SpendPart {
  readonly key: string;
  readonly label: string;
  /** The pocket it left from (its colour and icon). */
  readonly lineKey: string;
  readonly amountMinor: string;
  /** Share of everything paid out, 0..100 with two decimals (bar geometry; the amount is the exact figure). */
  readonly pct: number;
}

/**
 * Paid out, split by where it went: the supplier, then each running-cost pocket, largest first, zero parts left out.
 * The parts add up to Paid out exactly (core: overview.spentMinor = supplier cost + operating spend).
 */
export function spendSplit(p: Pick<CfoReport["pnl"], "supplierCostMinor" | "operatingByLine">): SpendPart[] {
  const parts = [
    { key: "SUPPLIER_COST", label: "Supplier", lineKey: "SUPPLIER", amount: BigInt(p.supplierCostMinor) },
    ...p.operatingByLine.map((l) => ({ key: l.lineKey, label: lineName(l.lineKey), lineKey: l.lineKey, amount: BigInt(l.amountMinor) })),
  ].filter((x) => x.amount > 0n);
  const total = parts.reduce((a, x) => a + x.amount, 0n);
  return parts
    .sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1))
    .map((x) => ({ key: x.key, label: x.label, lineKey: x.lineKey, amountMinor: x.amount.toString(), pct: total === 0n ? 0 : Number((x.amount * 10_000n) / total) / 100 }));
}

/** Of every 100 BU of sales, how many are kept for tax: whole cells and the part of the next one (the unit chart). */
export function taxCells(rateBps: number): { readonly full: number; readonly part: number } {
  const per100 = Math.max(0, Math.min(10_000, rateBps)) / 100;
  const full = Math.floor(per100);
  return { full, part: Math.round((per100 - full) * 100) / 100 };
}

// ---- Chart rows --------------------------------------------------------------------------------------------------
export const spendingRows = (r: CfoReport) => r.spending.daily.map((d) => ({ date: d.date, label: dayLabel(d.date), spent: buNumber(d.spentMinor), spentMinor: d.spentMinor }));
export const salesRows = (r: CfoReport) => r.sales.daily.map((d) => ({ date: d.date, label: dayLabel(d.date), revenue: buNumber(d.revenueMinor), revenueMinor: d.revenueMinor, count: d.count }));
export const forecastRows = (r: CfoReport) => r.forecast.points.map((p) => ({ date: p.date, label: dayLabel(p.date), cash: Number(BigInt(p.cashMinor) / 100n), cashMinor: p.cashMinor }));

// ---- What Hogee's AI changed (tighten only) ------------------------------------------------------------------------
const LIMIT_NAME = { LOWER_PER_TX_CAP: "per-payment limit", LOWER_WINDOW_CAP: "weekly limit" } as const;

/** "Hogee's AI lowered the Ads weekly limit to 525 BU" (newValue is minor units, or bps for the tax share). */
export function agentActionText(a: Pick<CfoAgentAction, "action" | "lineKey" | "newValue">): string {
  switch (a.action) {
    case "LOWER_PER_TX_CAP":
    case "LOWER_WINDOW_CAP":
      return `Hogee's AI lowered the ${lineName(a.lineKey ?? "")} ${LIMIT_NAME[a.action]} to ${formatBu(a.newValue)}`;
    case "RAISE_RESERVE_BPS":
      return `Hogee's AI raised the share kept for tax to ${(Number(a.newValue) / 100).toFixed(1)}% of each sale`;
    case "PAUSE_LINE":
      return `Hogee's AI paused the ${lineName(a.lineKey ?? "")} pocket`;
    case "PAUSE":
      return "Hogee's AI paused all spending";
    case "REVOKE_AGENT":
      return "Hogee's AI switched off its own paying key";
  }
}

// ---- The chat card's slice and the page's tiles ------------------------------------------------------------------------
export interface CfoTile {
  readonly key: string;
  readonly label: string;
  /** Minor units (signed for profit), or a plain count / number of days when `unit` is set; null while not loaded. */
  readonly value: string | null;
  readonly unit?: "count" | "days" | "pct";
  /** Built on the report's sales, which are a labelled sample in mock and replay mode: the tile then carries "Sample". */
  readonly sample?: boolean;
}

const INSIGHTS_BY_VIEW: Readonly<Record<CfoView, readonly CfoInsight["kind"][] | null>> = {
  overview: null,
  spending: ["BURN_ALERT", "MOVE_BUDGET"],
  sales: ["STAGE2_ON_TRACK", "STAGE2_AT_RISK"],
  pnl: ["BURN_ALERT", "MOVE_BUDGET"],
  forecast: ["RUNWAY_SHORT", "STAGE2_ON_TRACK", "STAGE2_AT_RISK"],
  reserve: ["RESERVE_STATUS"],
};

/** Up to `max` insights for a view, warnings first (the report's own order otherwise). */
export function insightsFor(r: CfoReport, view: CfoView, max = 2): CfoInsight[] {
  const kinds = INSIGHTS_BY_VIEW[view];
  const fit = r.insights.filter((i) => kinds === null || kinds.includes(i.kind));
  return [...fit.filter((i) => i.severity === "warn"), ...fit.filter((i) => i.severity !== "warn")].slice(0, max);
}

/**
 * A section's own notes on the one-page Wallet: its view's notes less the ones the Overview already shows, so a note is
 * never said twice on the page.
 */
export function sectionNotes(r: CfoReport, view: Exclude<CfoView, "overview">, max = 2): CfoInsight[] {
  const shown = new Set(insightsFor(r, "overview", 2).map((i) => i.insightId));
  return insightsFor(r, view, max + shown.size)
    .filter((i) => !shown.has(i.insightId))
    .slice(0, max);
}

/** "Profit so far" or "Loss so far" (the figure itself carries the minus). */
export const profitLabel = (p: Pick<CfoReport["pnl"], "netMinor">): string => (isLoss(p) ? "Loss so far" : "Profit so far");

/**
 * The four numbers (Ready to spend · Paid out · Sales · Kept for tax) and each view's own figures. `ready` is the
 * wallet's Ready to spend (useReadyToSpend); null while balances load, never the report's copy of it.
 */
export function tilesFor(r: CfoReport, view: CfoView, ready: string | null = null): CfoTile[] {
  const o = r.overview;
  switch (view) {
    case "overview":
      return [
        { key: "cash", label: "Ready to spend", value: ready },
        { key: "spent", label: "Paid out", value: o.spentMinor },
        { key: "revenue", label: "Sales", value: o.revenueMinor, sample: true },
        { key: "reserve", label: "Kept for tax", value: o.reserveMinor, sample: true },
      ];
    case "spending":
      return [
        { key: "spent", label: "Paid out", value: o.spentMinor },
        { key: "operating", label: "Running costs", value: r.pnl.operatingMinor },
        { key: "supplier", label: "Paid to the supplier", value: r.pnl.supplierCostMinor },
      ];
    case "sales":
      return [
        { key: "revenue", label: "Sales", value: r.sales.revenueMinor, sample: true },
        { key: "count", label: "Number of sales", value: String(r.sales.count), unit: "count", sample: true },
        { key: "average", label: "Average sale", value: wholeMinor(r.sales.averageMinor), sample: true },
      ];
    case "pnl":
      return [
        { key: "revenue", label: "Sales", value: r.pnl.revenueMinor, sample: true },
        { key: "costs", label: "Costs", value: (BigInt(r.pnl.supplierCostMinor) + BigInt(r.pnl.operatingMinor)).toString() },
        { key: "net", label: profitLabel(r.pnl), value: r.pnl.netMinor, sample: true },
      ];
    case "forecast":
      return [
        { key: "burn", label: "Spending per day (last 7 days)", value: wholeMinor(r.forecast.dailyBurnMinor) },
        { key: "income", label: "Sales per day (last 7 days)", value: wholeMinor(r.forecast.dailyRevenueMinor), sample: true },
        ...(r.forecast.runwayDays === null ? [] : [{ key: "runway", label: "Money lasts", value: String(r.forecast.runwayDays), unit: "days" as const }]),
      ];
    case "reserve":
      return [
        { key: "balance", label: "Kept for tax now", value: r.reserve.balanceMinor, sample: true },
        { key: "skimmed", label: "Kept so far", value: r.reserve.skimmedMinor, sample: true },
        { key: "rate", label: "Of each sale", value: String(r.reserve.rateBps), unit: "pct" },
      ];
  }
}

/** The card's title: the finding with its figure. */
export function cardTitle(r: CfoReport, view: CfoView, ready: string | null = null): string {
  const top = insightsFor(r, view, 1)[0];
  switch (view) {
    case "overview":
      // The number Mei asks about first; the notes follow in the card, so the title never repeats one of them.
      return ready !== null ? `You can spend ${formatBu(ready)} now` : (top?.title ?? "Wallet");
    case "spending":
      return `Paid out ${formatBu(r.overview.spentMinor)} so far`;
    case "sales":
      return r.sales.count === 0 ? "No sales recorded yet" : `${r.sales.count} sales, ${formatBu(r.sales.revenueMinor)}`;
    case "pnl":
      return `${profitLabel(r.pnl)}: ${signedBu(r.pnl.netMinor)}`;
    case "forecast":
      return r.forecast.runwayDays === null ? "Not enough days yet to guess what's next" : `At this pace, your money lasts about ${r.forecast.runwayDays} days`;
    case "reserve":
      return `${formatBu(r.reserve.balanceMinor)} kept for tax`;
  }
}

/**
 * Says where the numbers come from when they are not a real chain's records: the mock's sample series (served in
 * mock and replay mode alike), or a local chain whose history may have been time-shifted (dev:live --seed-sales).
 * Null for a public chain.
 */
export function dataLabel(session: Pick<Session, "mode" | "chainId"> | undefined): string | null {
  if (!session) return null;
  if (session.mode === "mock" || session.mode === "replay") return "Sample data";
  if (session.chainId === 31337) return "Test blockchain: some sales are demo history";
  return null;
}

/** True when the report's sales are the mock's sample (mock and replay mode): sales-built figures say "Sample". */
export const isSample = (session: Pick<Session, "mode" | "chainId"> | undefined): boolean => dataLabel(session) !== null;

/** The money card's first line whenever the sales are a sample (UX-PLAN D13). */
export const SAMPLE_SENTENCE = "These are sample sales for the demo, not real orders.";

// ---- One rule for sales (UX round 3, Steve #6) ---------------------------------------------------------------------
/**
 * The one sales figure every page shows (Wallet, Plan › Releases, the loan officer's page), from the CFO report only
 * (useCfoReport()): every recorded sale so far. In core it is the same number three times (sales.revenueMinor =
 * sales.stageGate.soFarMinor = overview.revenueMinor), so a page that shows "X of the goal" and a page that shows
 * "Sales X" can never disagree. Whether it is a sample is the session's (isSample / useSampleSales), never this figure's.
 */
export interface SalesFigure {
  readonly soFarMinor: string;
  readonly count: number;
  /** The next budget release's sales goal (BU), or null when no release waits on sales. */
  readonly targetMinor: string | null;
  /** The goal's deadline (YYYY-MM-DD), or null. */
  readonly deadline: string | null;
  /** The day the pace reaches the goal (YYYY-MM-DD), or null when it doesn't. */
  readonly projectedDate: string | null;
  /** Toward the goal, 0..100 (0 without one). */
  readonly pct: number;
}

export function salesFigure(r: Pick<CfoReport, "sales">): SalesFigure {
  const gate = r.sales.stageGate;
  const soFar = BigInt(r.sales.revenueMinor);
  const target = gate ? BigInt(gate.targetMinor) : 0n;
  const pct = target === 0n ? 0 : Math.min(100, Number((soFar * 10_000n) / target) / 100);
  return {
    soFarMinor: r.sales.revenueMinor,
    count: r.sales.count,
    targetMinor: gate?.targetMinor ?? null,
    deadline: gate?.deadline ?? null,
    projectedDate: gate?.projectedDate ?? null,
    pct,
  };
}

// ---- One pocket line (UX round 3; first-timer #24) -----------------------------------------------------------------
/**
 * A pocket as every page reads it: what was paid from it, what is set aside in the held box for a later supplier
 * payment, and what is left (pocket.available, PocketRow's value). On the chain a supplier payment from the held box
 * never enters the pocket's `spent` (core money/wallet.ts), so for the supplier: paid = the report's
 * pnl.supplierCostMinor, set aside = balances.escrowMinor − that. While the two sources disagree (paid above what was
 * ever set aside, or not loaded) the supplier's split is null: only "left" and "of" are shown, never a wrong number.
 */
export interface PocketLine {
  readonly allocatedMinor: string;
  readonly leftMinor: string;
  readonly paidMinor: string | null;
  readonly setAsideMinor: string | null;
}

export function pocketLine(
  p: { readonly lineKey: string; readonly allocated: string; readonly spent: string; readonly available: string },
  supplier: { readonly escrowMinor: string; readonly supplierPaidMinor: string | null },
): PocketLine {
  const base = { allocatedMinor: p.allocated, leftMinor: p.available };
  if (p.lineKey !== "SUPPLIER") return { ...base, paidMinor: p.spent, setAsideMinor: "0" };
  const committed = BigInt(supplier.escrowMinor);
  const paid = supplier.supplierPaidMinor === null ? null : BigInt(supplier.supplierPaidMinor);
  if (paid === null || paid > committed) return { ...base, paidMinor: null, setAsideMinor: null };
  return { ...base, paidMinor: (BigInt(p.spent) + paid).toString(), setAsideMinor: (committed - paid).toString() };
}
