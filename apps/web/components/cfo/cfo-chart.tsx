"use client";

/**
 * The CFO charts behind next/dynamic (no SSR). Each chart and its skeleton fill the sized box the caller gives them
 * (`<div className="h-44">`), so the layout never shifts when they load and a jump to a section lands where it should.
 */
import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";

function ChartSkeleton() {
  return <Skeleton className="h-full w-full rounded-lg" aria-hidden />;
}

export const DailyBars = dynamic(() => import("./cfo-charts").then((m) => m.DailyBars), { ssr: false, loading: ChartSkeleton });
export const StackedDailyBars = dynamic(() => import("./cfo-charts").then((m) => m.StackedDailyBars), { ssr: false, loading: ChartSkeleton });
