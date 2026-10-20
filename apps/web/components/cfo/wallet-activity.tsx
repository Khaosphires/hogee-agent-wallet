"use client";

/**
 * Activity (UX2 brief §3, UX round 3 Steve #12): a live feed from what the page already reads (receipts, the report's
 * latest sales, what Hogee's AI changed by itself), newest first, kinds mixed by time and runs of the same thing folded
 * ("Ads · 5 payments", "3 sales"). Each row: an icon tile, one line, how long ago and who acted, the amount (green and
 * "+" for money in). A failed bank transfer is a "Needs a look" row in the waiting tone. The latest few show; "Show all"
 * opens the rest. Under it, one line on what the AI did by itself: what it paid inside her rules, and that it changed no
 * limit (first-timer #27). No request of its own: the receipts come from the same queries as Receipts
 * (use-receipts.ts), the sales and AI changes from the one CFO report.
 *
 * Colour jobs: green = money in, cobalt = the wallet or its AI acted alone, the seal (cinnabar) = Mei signed it, amber
 * = she should look.
 */
import { useState, useSyncExternalStore } from "react";
import { Bot, CircleAlert, Clock, Landmark, ShieldCheck, ShoppingBag } from "lucide-react";
import type { CfoReport } from "@hogee/core";
import { Button } from "@/components/ui/button";
import { GroupedList, ListRow } from "@/components/ui/grouped-list";
import { IconTile } from "@/components/ui/icon-tile";
import { Skeleton } from "@/components/ui/skeleton";
import { Money } from "@/components/ledger/money";
import { ErrorBlock, RefreshNote } from "@/components/ledger/query-state";
import type { QueryView } from "@/lib/api/query-policy";
import { lineLabel, localDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SampleTag } from "./cfo-parts";
import { pocketLook } from "./pocket-look";
import { useReceipts } from "./use-receipts";
import { activityOf, aiSummary, automaticPayments, foldRuns, relativeTime, STATUS_TEXT, type ActivityItem, type ActivityStatus, type FeedRow } from "./wallet-activity-model";

const FIRST_ROWS = 6;
const CLOCK_MS = 30_000;

/** "Now" for relative times, refreshed every 30 s so "2 min ago" keeps up; 0 on the server (rows render on the client). */
function subscribeClock(onChange: () => void): () => void {
  const id = window.setInterval(onChange, CLOCK_MS);
  return () => window.clearInterval(id);
}
const clockNow = (): number => Math.floor(Date.now() / CLOCK_MS) * CLOCK_MS;
const useNow = (): number => useSyncExternalStore(subscribeClock, clockNow, () => 0);

interface RowLook {
  readonly kind: ActivityItem["kind"];
  readonly lineKey: string | null;
  readonly status: ActivityStatus;
}

function tileOf(r: RowLook) {
  if (r.status === "failed") return <IconTile icon={CircleAlert} tone="waiting" />;
  if (r.kind === "sale") return <IconTile icon={ShoppingBag} tone="paid" />;
  if (r.kind === "ai") return <IconTile icon={ShieldCheck} tone="agent" />;
  if (r.status === "tax") return <IconTile icon={Landmark} tone="ink" />;
  const look = pocketLook(r.lineKey);
  return <IconTile icon={look.Icon} tone={look.tone} />;
}

/** The second line: how long ago, then who acted (cobalt alone, the seal for Mei) or the state. */
function StatusLine({ status, lineKey, at, ago, exact }: { status: ActivityStatus; lineKey: string | null; at: string | null; ago: string; exact: string | null }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
      <time dateTime={at ?? undefined} title={exact ?? undefined} className="shrink-0">
        {ago}
      </time>
      {status === "sale" ? null : (
        <>
          <span aria-hidden>·</span>
          <span
            className={cn(
              "inline-flex min-w-0 items-center gap-1",
              (status === "auto" || status === "ai") && "text-agent",
              status === "failed" && "font-medium text-waiting",
              status === "sending" && "text-ink-2",
            )}
          >
            {status === "auto" || status === "ai" ? <Bot aria-hidden className="size-3 shrink-0" /> : null}
            {status === "passkey" || status === "tax" ? <i aria-hidden className="chop" data-size="14" /> : null}
            {status === "sending" ? <Clock aria-hidden className="size-3 shrink-0" /> : null}
            {STATUS_TEXT[status]}
            {status === "failed" ? `: the bank transfer failed, the BU went back to ${lineKey ? lineLabel(lineKey) : "your wallet"}` : null}
          </span>
        </>
      )}
    </span>
  );
}

function Amount({ minor, muted = false }: { minor: string; muted?: boolean }) {
  const moneyIn = !minor.startsWith("-");
  return (
    <span className={cn("font-semibold", muted ? "text-ink-3" : moneyIn ? "text-paid [&_[data-minor]>span]:text-paid/70" : "text-ink")}>
      {moneyIn && !muted ? "+" : null}
      <Money minor={minor} />
    </span>
  );
}

function FeedItemRow({ row, now, currency, tagged }: { row: FeedRow; now: number; currency: string | undefined; tagged: boolean }) {
  const first = row.fold ? row.items[0] : row.item;
  if (!first) return null;
  const look: RowLook = row.fold ? row : first;
  const ago = now === 0 ? "" : relativeTime(first.at, now, currency);
  const exact = first.at ? localDateTime(first.at, currency) : null;
  const amount = row.fold ? row.totalMinor : first.amountMinor;
  const title = row.fold ? row.title : first.title;
  return (
    <ListRow
      data-testid={look.kind === "ai" ? "agent-action" : "activity-row"}
      data-kind={look.kind}
      data-status={look.status}
      data-folded={row.fold ? row.items.length : undefined}
      leading={tileOf(look)}
      title={
        <span className={cn("inline-flex min-w-0 flex-wrap items-center gap-x-1.5", look.kind === "ai" && "text-agent")}>
          {title}
          {look.kind === "sale" && tagged ? <SampleTag /> : null}
        </span>
      }
      subtitle={<StatusLine status={look.status} lineKey={look.lineKey} at={first.at} ago={ago} exact={exact} />}
      value={amount !== null ? <Amount minor={amount} muted={look.status === "failed"} /> : undefined}
    />
  );
}

/** The feed. `report` is the page's one CFO report view; receipts come from useReceipts (shared cache). */
export function WalletActivity({ report, currency, tagged }: { report: QueryView<CfoReport>; currency: string | undefined; tagged: boolean }) {
  const { view, names } = useReceipts();
  const now = useNow();
  const [showAll, setShowAll] = useState(false);
  const receipts = view.kind === "data" ? view.data : [];
  const rows = foldRuns(activityOf({ receipts, names, report: report.kind === "data" ? report.data : null }));
  const loading = view.kind === "loading" && report.kind === "loading";
  const noAi = report.kind === "data" && report.data.agentActions.length === 0;
  const shown = showAll ? rows : rows.slice(0, FIRST_ROWS);

  if (loading) {
    return (
      <GroupedList aria-busy="true" aria-label="Loading activity">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <li key={i} className="flex h-15 items-center gap-3 px-4">
            <Skeleton className="size-[30px] rounded-[8px]" />
            <Skeleton className="h-2.5 w-2/5" />
          </li>
        ))}
      </GroupedList>
    );
  }
  return (
    <div className="grid gap-2">
      {view.kind === "error" && rows.length === 0 ? <ErrorBlock error={view.error} what="your activity (nothing was paid or changed)" /> : null}
      {view.kind === "data" ? <RefreshNote error={view.refreshFailed} what="activity" /> : null}
      <GroupedList aria-label="Activity" data-testid="wallet-activity-list">
        {rows.length === 0 ? (
          <ListRow
            data-testid="activity-empty"
            leading={<IconTile icon={Clock} tone="grey" variant="tinted" />}
            title="Nothing yet"
            subtitle="Payments, sales and what Hogee's AI does show here as they happen."
          />
        ) : (
          shown.map((row) => <FeedItemRow key={row.key} row={row} now={now} currency={currency} tagged={tagged} />)
        )}
        {noAi ? (
          <li data-slot="list-row" data-testid="agent-actions-none" className="group/item bg-tint-agent">
            <div className="flex min-h-12 items-center gap-3 px-4 py-2.5">
              <IconTile icon={ShieldCheck} tone="agent" size="sm" className="mx-[3px]" />
              <p className="min-w-0 text-footnote text-pretty text-agent">{aiSummary(automaticPayments(receipts))}</p>
            </div>
          </li>
        ) : null}
      </GroupedList>
      {rows.length > FIRST_ROWS ? (
        <Button variant="plain" className="w-fit rounded-full" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)} data-testid="activity-show-all">
          {showAll ? "Show fewer" : `Show all ${rows.length}`}
        </Button>
      ) : null}
    </div>
  );
}
