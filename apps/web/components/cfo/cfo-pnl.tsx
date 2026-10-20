"use client";

/**
 * Profit as a bridge (DESIGN.md §8): a horizontal waterfall in plain HTML that is also the table (role="table"), so the
 * chart and the numbers can never disagree. Money in (sales, a profit) is green; each cost wears its pocket's colour
 * (the same as its tile everywhere else); a **loss is never drawn as a profit**: its bar is an outlined neutral bar
 * pointing left of zero, the row says "Loss", and no "% of sales" is shown once costs pass sales (Steve #18). Bars are
 * 14 px rounded on the value end, with hairlines at 0, 50 and 100%. The columns follow the card's width (a container
 * query), so the bar sits under the label in a narrow card.
 */
import type { CfoReport } from "@hogee/core";
import { cn } from "@/lib/utils";
import { bridgeRows, dayLabel, isLoss, signedBu, type BridgeRow } from "./cfo-model";
import { Money } from "@/components/ledger/money";
import { pocketLook, slotVar } from "./pocket-look";

/**
 * Why a loss, in one calm sentence that comes first (UX round 3): most often the stock was bought before it sold, which
 * is how a new shop starts, not a warning.
 */
export function lossReason(p: CfoReport["pnl"]): string {
  return BigInt(p.supplierCostMinor) > 0n
    ? `Stock comes first: ${signedBu(p.supplierCostMinor)} went to the supplier before the goods sold.`
    : "Your costs are more than your sales so far.";
}

const LOSS_BAR = "rounded-l-[4px] bg-card shadow-[inset_0_0_0_1.5px_var(--chart-neutral)]";
const pocketOfRow = (key: string): string => (key === "SUPPLIER_COST" ? "SUPPLIER" : key);

function barStyle(r: BridgeRow): { className: string; color?: string } {
  if (r.loss) return { className: LOSS_BAR };
  if (r.kind === "cost") return { className: "rounded-l-[4px]", color: slotVar(pocketLook(pocketOfRow(r.key)).slot) };
  return { className: "rounded-r-[4px] bg-paid" };
}

const TRACK = "relative h-5 bg-[linear-gradient(var(--separator),var(--separator)),linear-gradient(var(--separator),var(--separator)),linear-gradient(var(--separator),var(--separator))] bg-[length:1px_100%] bg-[position:0_0,50%_0,100%_0] bg-no-repeat";
const COLS = "grid-cols-[minmax(0,1fr)_auto] @[26rem]:grid-cols-[7.5rem_minmax(0,1fr)_5.5rem_3rem]";

export function PnlBridge({ report }: { report: CfoReport }) {
  const p = report.pnl;
  const rows = bridgeRows(p);
  const period = `${dayLabel(p.from)} – ${dayLabel(p.to)}`;
  return (
    <div className="@container grid gap-2">
      <div role="table" aria-label={`Profit or loss, ${period}`} className="grid">
        <div role="row" className={cn("grid gap-3 pb-1.5 text-caption text-ink-3 shadow-[inset_0_-1px_0_var(--separator)]", COLS)}>
          <span role="columnheader">{period}</span>
          <span role="columnheader" className="hidden @[26rem]:block">
            <span className="sr-only">Bar</span>
          </span>
          <span role="columnheader" className="text-right">
            Amount
          </span>
          <span role="columnheader" className="hidden text-right @[26rem]:block">
            Of sales
          </span>
        </div>
        {rows.map((r) => {
          const bar = barStyle(r);
          return (
            <div
              key={r.key}
              role="row"
              tabIndex={0}
              title={`${r.label}: ${signedBu(r.amountMinor)}${r.pctOfSales ? ` (${r.pctOfSales} of sales)` : ""}`}
              className={cn(
                "grid min-h-10 items-center gap-x-3 gap-y-1 py-1.5 text-footnote shadow-[inset_0_-1px_0_var(--separator)] outline-none transition-colors duration-(--dur-state) hover:bg-fill focus-visible:bg-fill focus-visible:ring-[3px] focus-visible:ring-ring/50 @[26rem]:py-0",
                COLS,
                r.kind !== "cost" && "font-semibold",
                r.kind === "net" && "shadow-none",
              )}
            >
              <span role="cell" className={cn("truncate", r.kind === "cost" ? "text-ink-2" : "text-ink")}>
                {r.label}
              </span>
              <span role="cell" aria-hidden className={cn(TRACK, "col-span-2 row-start-2 @[26rem]:col-span-1 @[26rem]:row-start-auto")}>
                <span data-loss={r.loss || undefined} className={cn("absolute top-0.5 h-3.5", bar.className)} style={{ left: `${r.left}%`, width: `${r.width}%`, backgroundColor: bar.color }} />
              </span>
              <span role="cell" className="text-right tabular-nums">
                <Money minor={r.amountMinor} />
              </span>
              <span role="cell" className="hidden text-right text-caption text-ink-3 tabular-nums @[26rem]:block">
                {r.pctOfSales ?? "–"}
              </span>
            </div>
          );
        })}
      </div>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-ink-3">
        <span className="inline-flex items-center gap-1.5">
          <i aria-hidden className="inline-block size-2.5 rounded-[3px] bg-paid" />
          {isLoss(p) ? "Sales" : "Sales and profit"}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i aria-hidden className="inline-block size-2.5 rounded-[3px] bg-[linear-gradient(90deg,var(--chart-1)_0_50%,var(--chart-4)_50%)]" />
          Costs, in their pocket&apos;s colour
        </span>
        {isLoss(p) ? (
          <span className="inline-flex items-center gap-1.5">
            <i aria-hidden className="inline-block size-2.5 rounded-[3px] shadow-[inset_0_0_0_1.5px_var(--chart-neutral)]" />
            Loss
          </span>
        ) : null}
      </p>
    </div>
  );
}
