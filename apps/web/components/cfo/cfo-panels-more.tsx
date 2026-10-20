"use client";

/**
 * The Wallet's Profit, Forecast and Tax money sections (UX2 brief §4, UX round 3), on the same report fields and rules
 * as before: profit or loss named as such (a loss gives its plain reason first, stock bought before it sold, and is
 * never drawn as a profit), the forecast states its method and sample size and shows nothing under 3 days of records
 * (core never projects from less), drawn as a runway bar under "About N days" (green, amber in the last two weeks), and
 * tax money says who it can go to. Each is one card; the longer words fold away.
 */
import { CalendarClock, Landmark, TrendingDown, TrendingUp } from "lucide-react";
import type { CfoReport } from "@hogee/core";
import { Card } from "@/components/ui/card";
import { IconTile } from "@/components/ui/icon-tile";
import { Stat } from "@/components/ui/stat";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Money } from "@/components/ledger/money";
import { dayLabel, forecastRows, isLoss, pctText, profitLabel, sectionNotes, taxCells, wholeMinor } from "./cfo-model";
import { SampleTag, useSampleScope } from "./cfo-parts";
import { lossReason, PnlBridge } from "./cfo-pnl";
import { runwayOf, RUNWAY_WARN_DAYS, type Runway } from "./forecast-runway";
import { Fold, MetricCard, MetricFigures, TaxCells } from "./wallet-metric";
import { NoteRows } from "./wallet-notes";

/** The tax office a payee id stands for (the id itself is an internal name). */
export function taxOfficeName(payeeId: string): string {
  if (payeeId.startsWith("iras")) return "IRAS (Singapore's tax office)";
  if (payeeId.startsWith("lhdn")) return "LHDN (Malaysia's tax office)";
  return "The tax office in your plan";
}

/** Fewer days of records than this and core makes no projection (core cfo/ledger.ts MIN_SAMPLE_DAYS). */
const MIN_SAMPLE_DAYS = 3;

const ratePct = (bps: number): string => `${(bps / 100).toFixed(1)}%`;

export function ProfitSection({ report }: { report: CfoReport }) {
  const p = report.pnl;
  const loss = isLoss(p);
  const scope = useSampleScope();
  // Profit mixes sample sales with real costs: tag the figures built on sales, not the costs.
  const tag = scope.figures && report.sales.count > 0 ? <SampleTag /> : null;
  const margin = loss ? null : pctText(BigInt(p.netMinor), BigInt(p.revenueMinor));
  return (
    <>
      <MetricCard
        testId="wallet-profit-card"
        icon={loss ? TrendingDown : TrendingUp}
        tone={loss ? "grey" : "paid"}
        label={profitLabel(p)}
        tag={tag}
        figure={{ minor: p.netMinor, testId: "cfo-net-hero", loss }}
        line={
          loss ? (
            <span data-testid="cfo-loss-reason">{lossReason(p)}</span>
          ) : margin ? (
            `${margin} of sales, counted when money moves.`
          ) : (
            "Counted when money moves."
          )
        }
        figures={
          <MetricFigures>
            <Stat size="sm" data-testid="wallet-fig-pnl-revenue" label={<span className="inline-flex items-center gap-1.5">Sales {tag}</span>} minor={p.revenueMinor} />
            <Stat size="sm" data-testid="wallet-fig-costs" label="Costs" minor={(BigInt(p.supplierCostMinor) + BigInt(p.operatingMinor)).toString()} />
            <Stat size="sm" data-testid="wallet-fig-kept" label="Kept for tax" minor={p.reserveSetAsideMinor} note="Set aside, not a cost." className="col-span-2" />
          </MetricFigures>
        }
        chart={<PnlBridge report={report} />}
      />
      <NoteRows notes={sectionNotes(report, "pnl")} label="Notes on profit" />
    </>
  );
}

function ForecastTable({ rows }: { rows: ReturnType<typeof forecastRows> }) {
  return (
    <div className="max-h-72 overflow-y-auto rounded-md">
      <Table>
        <TableCaption>Money you can spend, by day (a guess).</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Day</TableHead>
            <TableHead className="text-right">You can spend</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.date}>
              <TableCell>
                <time dateTime={r.date}>{r.label}</time>
              </TableCell>
              <TableCell className="text-right">
                <Money minor={r.cashMinor} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * How long the money lasts at this pace, as one bar from today to the day it runs out: green while there is time, amber
 * for the last two weeks. It draws the report's runwayDays only; the dates under it say where each part ends.
 */
function RunwayBar({ runway }: { runway: Runway }) {
  const label = `About ${runway.days} days: ${runway.calmDays} with time to spare, then ${runway.warnDays} in the last two weeks`;
  return (
    <figure data-testid="forecast-runway" className="grid max-w-xl gap-2" aria-label={label}>
      <div aria-hidden className="flex h-3 w-full overflow-hidden rounded-full bg-fill-strong">
        <span className="flex h-full gap-0.5 overflow-hidden rounded-full" style={{ width: `${(runway.days / runway.trackDays) * 100}%` }}>
          {runway.calmDays > 0 ? <span className="h-full bg-paid" style={{ flexGrow: runway.calmDays, flexBasis: 0 }} /> : null}
          {runway.warnDays > 0 ? <span className="h-full bg-waiting-dot" style={{ flexGrow: runway.warnDays, flexBasis: 0 }} /> : null}
        </span>
      </div>
      <figcaption className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-caption text-ink-3 tabular-nums">
        <span>Today</span>
        <span className="inline-flex items-center gap-1.5">
          <i aria-hidden className="inline-block size-2 rounded-full bg-waiting-dot" />
          {runway.warnFrom ? `Last ${RUNWAY_WARN_DAYS} days from ${dayLabel(runway.warnFrom)}` : `Under ${RUNWAY_WARN_DAYS} days left`}
          <span aria-hidden>·</span>
          Runs out about {dayLabel(runway.endDate)}
        </span>
      </figcaption>
    </figure>
  );
}

export function ForecastSection({ report }: { report: CfoReport }) {
  const f = report.forecast;
  const scope = useSampleScope();
  const tag = scope.figures && report.sales.count > 0 ? <SampleTag /> : null;
  if (f.sampleDays < MIN_SAMPLE_DAYS) {
    return (
      <Card data-testid="forecast-too-early" className="flex-row items-start gap-3 px-4 sm:px-5">
        <IconTile icon={CalendarClock} tone="grey" variant="tinted" size="lg" />
        <div className="grid gap-0.5">
          <h3 className="text-headline text-ink">Not enough days yet to guess what&apos;s next</h3>
          <p className="text-footnote text-pretty text-ink-2">
            Hogee needs {MIN_SAMPLE_DAYS} days of your records; it has {f.sampleDays}. It never makes up the missing days.
          </p>
        </div>
      </Card>
    );
  }
  const rows = forecastRows(report);
  const last = rows[rows.length - 1];
  const runway = runwayOf(report);
  return (
    <>
      <MetricCard
        testId="wallet-forecast-card"
        icon={CalendarClock}
        tone="ink"
        label={f.runwayDays === null ? "In 30 days, you can spend" : "At this pace, money lasts"}
        figure={f.runwayDays === null ? { minor: last?.cashMinor, value: last ? undefined : "–" } : { value: <span data-value={f.runwayDays}>About {f.runwayDays} days</span> }}
        line={`A guess from your last 7 days (${f.sampleDays} days of records), not a promise.`}
        under={
          runway ? (
            <RunwayBar runway={runway} />
          ) : f.runwayDays === null ? (
            <p className="text-footnote text-pretty text-ink-2">Nothing was spent in the last 7 days, so there is no end date to guess.</p>
          ) : null
        }
        figures={
          <MetricFigures wide>
            <Stat size="sm" data-testid="wallet-fig-burn" label="Spending per day" minor={wholeMinor(f.dailyBurnMinor)} />
            <Stat size="sm" data-testid="wallet-fig-income" label={<span className="inline-flex items-center gap-1.5">Sales per day {tag}</span>} minor={wholeMinor(f.dailyRevenueMinor)} />
            <Stat size="sm" data-testid="wallet-fig-goal" label="Sales goal reached" value={f.stage2Date ? dayLabel(f.stage2Date) : "Not at this pace"} />
            <Stat size="sm" data-testid="wallet-fig-tax30" label="Tax money in 30 days" minor={f.reserveIn30dMinor} />
          </MetricFigures>
        }
        foot={
          <Fold label="How this is worked out" testId="forecast-how">
            <p className="max-w-[68ch] pb-2 text-footnote text-pretty text-ink-2">
              Hogee takes your average for the last 7 days and draws a straight line forward, from {f.sampleDays} days of records. Sales money doesn&apos;t go back
              into your pockets, so only spending moves this line.
            </p>
            <ForecastTable rows={rows} />
          </Fold>
        }
      />
      <NoteRows notes={sectionNotes(report, "forecast")} label="Notes on the forecast" />
    </>
  );
}

export function TaxSection({ report }: { report: CfoReport }) {
  const r = report.reserve;
  const scope = useSampleScope();
  const cells = taxCells(r.rateBps);
  return (
    <>
      <MetricCard
        testId="wallet-tax-card"
        icon={Landmark}
        tone="ink"
        label="Kept for tax now"
        tag={scope.figures && report.sales.count > 0 ? <SampleTag /> : null}
        figure={{ minor: r.balanceMinor }}
        line={`${ratePct(r.rateBps)} of every sale, kept by your wallet. Only a tax payment you both sign can use it.`}
        figures={
          <MetricFigures>
            <Stat size="sm" data-testid="wallet-fig-skimmed" label={`Kept from ${r.salesCount} ${r.salesCount === 1 ? "sale" : "sales"}`} minor={r.skimmedMinor} />
            <Stat size="sm" data-testid="wallet-fig-withdrawn" label="Paid as tax" minor={r.withdrawnMinor} />
            <Stat size="sm" data-testid="wallet-fig-payee" label="Paid only to" value={<span className="text-callout font-medium">{taxOfficeName(r.taxPayeeId)}</span>} className="col-span-2" />
          </MetricFigures>
        }
        chart={
          <figure className="grid gap-3" aria-label={`${ratePct(r.rateBps)} of every sale is kept for tax`}>
            <p className="text-caption text-ink-3">Of every 100 BU you sell</p>
            <TaxCells full={cells.full} part={cells.part} />
            <figcaption className="flex items-center gap-2 text-footnote text-ink-2">
              <i aria-hidden className="inline-block size-2.5 rounded-[3px] bg-paid" />
              {(r.rateBps / 100).toLocaleString("en-GB", { maximumFractionDigits: 2 })} BU kept for tax
            </figcaption>
          </figure>
        }
        foot={
          <Fold label="How tax money works" testId="tax-how">
            <p className="max-w-[68ch] pb-1 text-footnote text-pretty text-ink-2">
              Your wallet keeps {ratePct(r.rateBps)} of every sale for tax, by itself. The AI can&apos;t spend it. It can only leave as a tax payment that you and your
              loan officer both sign. The AI may raise the share, but never lower it.
            </p>
          </Fold>
        }
      />
      <NoteRows notes={sectionNotes(report, "reserve")} label="Notes on tax money" />
    </>
  );
}
