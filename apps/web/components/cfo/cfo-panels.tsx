"use client";

/**
 * The Wallet's Spending and Sales sections (UX2 brief §4, UX round 3): the same report fields and rules as before (Paid
 * out, running costs and the supplier; sales, their number and average, the next budget release and its goal), each as
 * one card with a coloured chart and one line. Running costs are stacked by pocket from the first record (Steve #13);
 * the sales figure is the one rule every page shows (cfo-model salesFigure). A "Sample" tag only where sample sales sit
 * beside real records (useSampleScope); the exact daily figures fold under "Show figures".
 */
import { ArrowUpRight, ShoppingBag } from "lucide-react";
import type { CfoReport } from "@hogee/core";
import { Progress } from "@/components/ui/progress";
import { Stat } from "@/components/ui/stat";
import { Money } from "@/components/ledger/money";
import { useBalances, useCurrentPlan, usePayments } from "@/lib/api/queries";
import { bu } from "@/lib/format";
import { nextRelease } from "@/lib/money";
import { DailyBars, StackedDailyBars } from "./cfo-chart";
import { buNumber, dayLabel, salesFigure, salesRows, sectionNotes, spendSplit, wholeMinor, type SalesFigure } from "./cfo-model";
import { SampleTag, useSampleScope } from "./cfo-parts";
import { stackKeys, stackRows } from "./spend-stack";
import { ChartEmpty, DailyTable, Fold, MetricCard, MetricFigures, SplitBar } from "./wallet-metric";
import { NoteRows } from "./wallet-notes";

/** The stacked rows as the chart draws them: whole BU per part, the day's top part named (its rounded end). */
function chartRows(rows: ReturnType<typeof stackRows>, keys: readonly string[]) {
  return rows.map((r) => {
    const present = keys.filter((k) => r.parts[k] !== undefined);
    return {
      date: r.date,
      label: dayLabel(r.date),
      __top: present[present.length - 1] ?? "",
      ...Object.fromEntries(present.map((k) => [k, buNumber(r.parts[k] ?? "0")])),
    };
  });
}

function SpendingChart({ report }: { report: CfoReport }) {
  const payments = usePayments().data ?? [];
  const rows = stackRows(report, payments);
  const keys = stackKeys(rows);
  const since = rows[0] ? dayLabel(rows[0].date) : null;
  return (
    <>
      <p className="mt-1 text-caption text-ink-3">{since ? `Running costs per day, by pocket, since ${since}` : "Running costs per day, by pocket"}</p>
      {rows.some((r) => r.totalMinor !== "0") ? (
        <div className="h-36">
          <StackedDailyBars rows={chartRows(rows, keys)} keys={keys} title="Running costs per day, by pocket" />
        </div>
      ) : (
        <ChartEmpty className="h-36">No running costs yet.</ChartEmpty>
      )}
    </>
  );
}

export function SpendingSection({ report }: { report: CfoReport }) {
  const p = report.pnl;
  const parts = spendSplit(p);
  const daily = report.spending.daily.map((d) => ({ date: d.date, minor: d.spentMinor }));
  const top = parts[0];
  return (
    <>
      <MetricCard
        testId="wallet-spending-card"
        icon={ArrowUpRight}
        tone="ink"
        label="Paid out"
        figure={{ minor: report.overview.spentMinor }}
        line={top ? `Most went to ${top.label === "Supplier" ? "the supplier" : top.label}.` : "Nothing paid out yet."}
        figures={
          <MetricFigures>
            <Stat size="sm" data-testid="wallet-fig-operating" label="Running costs" minor={p.operatingMinor} />
            <Stat size="sm" data-testid="wallet-fig-supplier" label="Paid to the supplier" minor={p.supplierCostMinor} />
          </MetricFigures>
        }
        chart={
          <>
            {parts.length > 0 ? <SplitBar parts={parts} label="Paid out, by pocket" /> : null}
            <SpendingChart report={report} />
          </>
        }
        foot={
          <Fold label="Show figures" testId="spending-figures">
            <DailyTable caption="Running costs by day." rows={daily} amountHead="Paid out" />
          </Fold>
        }
      />
      <NoteRows notes={sectionNotes(report, "spending")} label="Notes on spending" />
    </>
  );
}

/**
 * The next budget release and its goal, as one progress strip: "Next release: 6,000 BU" over the sales so far against
 * the goal (salesFigure, the same figure the Plan and the loan officer's page show; the card's own tag says when it is a
 * sample). The amount comes from the signed plan's stages (GET /api/plans/current) and the chain's released total.
 */
function NextRelease({ sales }: { sales: SalesFigure & { targetMinor: string; deadline: string } }) {
  const plan = useCurrentPlan().data;
  const released = useBalances().data?.releasedMinor;
  const next = plan?.status === "COMMITTED" && released !== undefined ? nextRelease(plan.manifest.stages, released) : null;
  const pace = sales.projectedDate ? `On pace for ${dayLabel(sales.projectedDate)}.` : "Not on pace yet.";
  return (
    <div data-testid="next-release" className="grid gap-2.5 rounded-lg bg-tint-paid p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="flex flex-wrap items-center gap-2 text-callout font-semibold text-ink">
          {next ? `Next release: ${bu(next.releaseMinor)}` : "Next budget release"}
        </p>
        <p className="text-footnote text-ink-2 tabular-nums">
          <Money minor={sales.soFarMinor} /> of <Money minor={sales.targetMinor} />
        </p>
      </div>
      <Progress value={sales.pct} tone="paid" aria-label="Sales so far, compared with the goal" />
      <p className="text-footnote text-pretty text-ink-2">
        Your loan officer can release it when sales reach {bu(sales.targetMinor)} by {dayLabel(sales.deadline)}. {pace}
      </p>
    </div>
  );
}

export function SalesSection({ report }: { report: CfoReport }) {
  const s = report.sales;
  const sales = salesFigure(report);
  const scope = useSampleScope();
  const rows = salesRows(report);
  const daily = rows.map((r) => ({ date: r.date, minor: r.revenueMinor, count: r.count }));
  const gate = sales.targetMinor !== null && sales.deadline !== null ? { ...sales, targetMinor: sales.targetMinor, deadline: sales.deadline } : null;
  return (
    <>
      <MetricCard
        testId="wallet-sales-card"
        icon={ShoppingBag}
        tone="paid"
        label="Sales so far"
        tag={scope.figures && report.sales.count > 0 ? <SampleTag /> : null}
        figure={{ minor: sales.soFarMinor }}
        line={s.count === 0 ? "No sales recorded yet." : "Each one is counted once its payment is checked."}
        figures={
          <MetricFigures>
            <Stat size="sm" data-testid="wallet-fig-count" label="Number of sales" value={s.count} />
            <Stat size="sm" data-testid="wallet-fig-average" label="Average sale" minor={wholeMinor(s.averageMinor)} />
          </MetricFigures>
        }
        chart={
          <>
            <p className="text-caption text-ink-3">Sales per day, last 30 days</p>
            {daily.some((r) => r.minor !== "0") ? (
              <div className="h-44">
                <DailyBars rows={rows} dataKey="revenue" label="Sales" title="Sales per day, last 30 days" />
              </div>
            ) : (
              <ChartEmpty>Sales show here as they come in.</ChartEmpty>
            )}
          </>
        }
        foot={
          <>
            {gate ? <NextRelease sales={gate} /> : null}
            <Fold label="Show figures" testId="sales-figures">
              <DailyTable caption="Sales by day. Amounts are rounded down to whole BU in the chart." rows={daily} amountHead="Sales" countHead="Number" />
            </Fold>
          </>
        }
      />
      <NoteRows notes={sectionNotes(report, "sales")} label="Notes on sales" />
    </>
  );
}
