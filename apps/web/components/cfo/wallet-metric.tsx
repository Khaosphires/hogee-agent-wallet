"use client";

/**
 * The shape every Wallet number section shares (UX2 brief §4, UX round 3 on the ui primitives): a <Card> with the
 * section's one figure (<Stat>), one line, a few smaller <Stat>s, a coloured chart, and the exact table folded under
 * "Show figures" (a chart is a picture of its table, so the table is always one press away). Plus the Spending split
 * bar, the tax unit chart, the daily table they fold away, and the "before a plan" preview row.
 */
import type { ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { GroupedList, ListRow } from "@/components/ui/grouped-list";
import { IconTile } from "@/components/ui/icon-tile";
import { Stat } from "@/components/ui/stat";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Tone } from "@/components/ui/tones";
import { Money } from "@/components/ledger/money";
import { cn } from "@/lib/utils";
import { dayLabel, type SpendPart } from "./cfo-model";
import { pocketLook, slotVar } from "./pocket-look";

export interface MetricFigure {
  /** Money (minor units), or `value` for anything else ("About 12 days"). */
  readonly minor?: string;
  readonly value?: ReactNode;
  readonly testId?: string;
  /** Marks a loss (data-loss), so a loss is never read as a profit. */
  readonly loss?: boolean;
}

export interface MetricCardProps {
  readonly testId?: string;
  readonly icon: LucideIcon;
  readonly tone: Tone;
  readonly label: string;
  /** The "Sample" tag, when the figure is built on sample sales beside real records. */
  readonly tag?: ReactNode;
  readonly figure: MetricFigure;
  /** One line under the figure, at most. */
  readonly line?: ReactNode;
  /** A small picture that belongs to the figure itself (the forecast's runway bar), right under it. */
  readonly under?: ReactNode;
  /** Smaller figures (<Stat size="sm">s), laid out by <MetricFigures>. */
  readonly figures?: ReactNode;
  /** The coloured chart. */
  readonly chart?: ReactNode;
  /** Under both columns: a progress strip, then the folds. */
  readonly foot?: ReactNode;
  readonly className?: string;
}

export function MetricCard({ testId, icon, tone, label, tag, figure, line, under, figures, chart, foot, className }: MetricCardProps) {
  return (
    <Card
      data-testid={testId}
      className={cn("grid min-w-0 gap-6 p-4 sm:p-6", chart ? "@3xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] @3xl:gap-x-10" : null, className)}
    >
      <div className="grid min-w-0 content-start gap-6">
        <Stat
          label={
            <span className="inline-flex items-center gap-2">
              {label}
              {tag}
            </span>
          }
          leading={<IconTile icon={icon} tone={tone} size="sm" />}
          minor={figure.minor}
          value={figure.value}
          note={line}
          data-testid={figure.testId}
          data-loss={figure.loss || undefined}
          className="[&>p]:text-ink-2"
        />
        {under}
        {figures}
      </div>
      {chart ? <div className="grid min-w-0 content-start gap-3">{chart}</div> : null}
      {foot ? <div className={cn("grid min-w-0 gap-1", chart ? "@3xl:col-span-2" : null)}>{foot}</div> : null}
    </Card>
  );
}

/** The smaller figures under a card's one figure: two columns of <Stat size="sm"> (`wide`: four on a wide card). */
export function MetricFigures({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return <div className={cn("grid grid-cols-2 gap-x-4 gap-y-5", wide && "@3xl:grid-cols-4")}>{children}</div>;
}

/** A quiet fold ("Show figures", "How this works"): the chevron turns, the content follows. */
export function Fold({ label, children, className, testId }: { label: string; children: ReactNode; className?: string; testId?: string }) {
  return (
    <details className={cn("group", className)} data-testid={testId}>
      <summary className="-mx-2 flex h-10 w-fit cursor-pointer list-none items-center gap-1 rounded-lg px-2 text-footnote font-medium text-ink-2 outline-none transition-[color,background-color] duration-(--dur-state) ease-settle hover:bg-fill hover:text-ink active:bg-fill-strong focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-4 text-ink-3 transition-transform duration-(--dur-state) ease-settle group-open:rotate-90" />
        {label}
      </summary>
      <div className="pt-1">{children}</div>
    </details>
  );
}

/**
 * Where Paid out went: one bar split by pocket (each part its pocket's colour, a 2 px gap between parts), then a legend
 * row per part with its tile, name, exact amount and share, so colour never carries the identity alone. It is also the
 * legend of the daily bars under it (the same colours).
 */
export function SplitBar({ parts, label }: { parts: readonly SpendPart[]; label: string }) {
  if (parts.length === 0) return null;
  return (
    <figure className="grid gap-3" aria-label={label}>
      <div aria-hidden className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full">
        {parts.map((p) => (
          <span key={p.key} className="h-full min-w-1.5 first:rounded-l-full last:rounded-r-full" style={{ flexGrow: p.pct, flexBasis: 0, backgroundColor: slotVar(pocketLook(p.lineKey).slot) }} />
        ))}
      </div>
      <ul className="grid gap-1.5" aria-label={label}>
        {parts.map((p) => {
          const look = pocketLook(p.lineKey);
          return (
            <li key={p.key} data-testid={`spend-part-${p.key}`} className="flex items-center gap-2.5 text-footnote">
              <IconTile icon={look.Icon} tone={look.tone} size="sm" />
              <span className="min-w-0 flex-1 truncate text-ink">{p.label}</span>
              <Money minor={p.amountMinor} className="font-medium text-ink" />
              <span className="w-10 text-right text-caption text-ink-3 tabular-nums">{Math.round(p.pct)}%</span>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}

/** Of every 100 BU of sales, the BU kept for tax: a 10 × 10 unit chart, the kept cells green. */
export function TaxCells({ full, part }: { full: number; part: number }) {
  return (
    <div aria-hidden className="grid w-fit grid-cols-10 gap-1">
      {Array.from({ length: 100 }, (_, i) => {
        const fill = i < full ? 1 : i === full ? part : 0;
        return (
          <span key={i} className="relative size-3 overflow-hidden rounded-[3px] bg-fill-strong sm:size-3.5">
            {fill > 0 ? <span className="absolute inset-y-0 left-0 bg-paid" style={{ width: `${fill * 100}%` }} /> : null}
          </span>
        );
      })}
    </div>
  );
}

/** A chart's exact figures by day; days with nothing recorded are left out (and the caption says so). */
export function DailyTable({ caption, rows, amountHead, countHead }: { caption: string; rows: readonly { date: string; minor: string; count?: number }[]; amountHead: string; countHead?: string }) {
  const shown = rows.filter((r) => r.minor !== "0");
  return (
    <Table>
      <TableCaption>{shown.length === rows.length ? caption : `${caption} Days with nothing recorded are left out.`}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Day</TableHead>
          {countHead ? <TableHead className="text-right">{countHead}</TableHead> : null}
          <TableHead className="text-right">{amountHead}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {shown.length === 0 ? (
          <TableRow>
            <TableCell colSpan={countHead ? 3 : 2} className="text-ink-2">
              Nothing recorded in the last 30 days.
            </TableCell>
          </TableRow>
        ) : (
          shown.map((r) => (
            <TableRow key={r.date}>
              <TableCell>
                <time dateTime={r.date}>{dayLabel(r.date)}</time>
              </TableCell>
              {countHead ? <TableCell className="text-right tabular-nums">{r.count}</TableCell> : null}
              <TableCell className="text-right">
                <Money minor={r.minor} />
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

/** A chart's empty state inside its card: a still, quiet well with one line (no fake bars). */
export function ChartEmpty({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid h-44 place-items-center rounded-lg bg-fill px-6 text-center text-footnote text-pretty text-ink-3", className)}>{children}</div>;
}

/**
 * Before a plan exists: what a number section will show, in one row (its tile and one line), so a fresh wallet reads as
 * a page waiting to fill, not a wall of zeros. No figure is drawn: there is none yet.
 */
export function SectionPreview({ icon, tone, children, testId }: { icon: LucideIcon; tone: Tone; children: ReactNode; testId?: string }) {
  return (
    <GroupedList data-testid={testId} aria-label="What this section will show">
      <ListRow leading={<IconTile icon={icon} tone={tone} variant="tinted" />} title={<span className="text-ink-2">{children}</span>} />
    </GroupedList>
  );
}
