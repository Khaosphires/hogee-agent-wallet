"use client";

/**
 * One view of the money figures in the chat (VISION-DECISIONS §4 data-cfo; DESIGN.md §7; UX-PLAN D8, D13): the sample
 * sentence first whenever the sales are a sample, the title (the finding with its figure), the view's tiles (the
 * overview's are the Money page's four numbers, Ready to spend from the wallet itself), at most 2 notes, "See all your
 * numbers" to /dashboard?tab=<view>, the data label and the disclaimer every time. It reads GET /api/cfo and the
 * balances (the part carries only the view) and acts on nothing itself.
 */
import Link from "next/link";
import { BarChart3, ChartNoAxesColumnIncreasing } from "lucide-react";
import type { DataCfo } from "@hogee/core";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CardHead } from "./card-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorBlock, RefreshNote } from "@/components/ledger/query-state";
import { queryView } from "@/lib/api/query-policy";
import { useCfoReport } from "@/lib/api/queries";
import { useReadyToSpend } from "@/lib/money";
import { cn } from "@/lib/utils";
import { cardTitle, cfoHref, CFO_TABS, insightsFor, tilesFor } from "@/components/cfo/cfo-model";
import { CfoDataLabel, CfoDisclaimer, CfoInsights, CfoTiles, SampleSentence, useSampleSales } from "@/components/cfo/cfo-parts";
import type { CardProps } from "./types";

export function CfoCard({ data }: CardProps<DataCfo>) {
  // A failed refresh keeps the last report in the card (a quiet note); the red error only when there is none.
  const report = queryView(useCfoReport());
  const readyView = useReadyToSpend();
  const ready = readyView.kind === "data" ? readyView.data : null;
  const sample = useSampleSales();
  const view = data.view;
  const tabName = CFO_TABS.find((t) => t.view === view)?.label ?? "Overview";
  return (
    <Card role="region" aria-label={`Wallet: ${tabName}`} aria-busy={report.kind === "loading"} data-testid="card-cfo" data-view={view} className="min-w-0 text-ui">
      {report.kind === "loading" ? (
        <CardContent className="grid gap-3" aria-label="Reading your records">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-16 w-full" />
        </CardContent>
      ) : report.kind === "error" ? (
        <CardContent>
          <ErrorBlock error={report.error} what="your money figures (nothing was paid or changed)" />
        </CardContent>
      ) : (
        <>
          {sample ? (
            <CardContent>
              <SampleSentence />
            </CardContent>
          ) : null}
          <CardHead icon={ChartNoAxesColumnIncreasing} tone="paid" title={cardTitle(report.data, view, ready)} badge={<CfoDataLabel />} />
          <CardContent className="grid min-w-0 gap-4">
            <CfoTiles tiles={tilesFor(report.data, view, ready)} compact />
            <CfoInsights insights={insightsFor(report.data, view)} />
            <RefreshNote error={report.refreshFailed} what="report" />
            <Link href={cfoHref(view)} className={cn(buttonVariants({ variant: "outline" }), "w-fit rounded-full bg-card")}>
              <BarChart3 aria-hidden className="size-4" />
              See all your numbers
              <span className="sr-only">: {tabName}</span>
            </Link>
          </CardContent>
        </>
      )}
      <CardContent>
        <CfoDisclaimer />
      </CardContent>
    </Card>
  );
}
