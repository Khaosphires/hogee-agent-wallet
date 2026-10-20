"use client";

import { useState } from "react";
import type { TraceEvent } from "@hogee/core";
import { Segmented } from "@/components/ui/segmented";
import { ErrorBlock, LoadingBlock } from "@/components/ledger/query-state";
import { useDisplayCurrency, useTraces } from "@/lib/api/queries";
import { TraceGroup } from "./trace-group";

type Filter = "all" | "payments" | "refusals" | "people";

const FILTERS: { value: Filter; label: string; test: (e: TraceEvent) => boolean }[] = [
  { value: "all", label: "Everything", test: () => true },
  { value: "payments", label: "Payments", test: (e) => e.kind === "TX" || e.kind === "PAYOUT" || e.kind === "PROPOSAL" },
  { value: "refusals", label: "Refusals", test: (e) => e.kind === "DENIAL" || e.verdict === "DENY" || e.kind === "ALERT" },
  { value: "people", label: "People's decisions", test: (e) => e.actor === "founder" || e.actor === "officer" },
];

/** Groups events by trace (one agent decision or human action), newest first. */
function groupByTrace(events: readonly TraceEvent[]): TraceEvent[][] {
  const groups = new Map<string, TraceEvent[]>();
  for (const e of events) groups.set(e.traceId, [...(groups.get(e.traceId) ?? []), e]);
  return [...groups.values()]
    .map((g) => [...g].sort((a, b) => a.seq - b.seq))
    .sort((a, b) => ((a.at(-1)?.ts ?? "") < (b.at(-1)?.ts ?? "") ? 1 : -1));
}

/**
 * Proof → Activity record: the whole record, newest first, with one filter. "Try an attack" moved to Proof's first page
 * (friction log #34), so the record has the full width.
 */
export function TimelineView() {
  const traces = useTraces("300");
  const currency = useDisplayCurrency();
  const [filter, setFilter] = useState<Filter>("all");
  const test = FILTERS.find((f) => f.value === filter)?.test ?? (() => true);
  const groups = traces.data ? groupByTrace(traces.data).filter((g) => g.some(test)) : [];
  return (
    <div className="bento grid min-w-0 gap-4">
      <div className="max-w-full overflow-x-auto [scrollbar-width:none]">
        <Segmented aria-label="Show" value={filter} onValueChange={setFilter} items={FILTERS.map((f) => ({ value: f.value, label: f.label }))} className="w-max min-w-full sm:min-w-0" />
      </div>
      {traces.isPending ? <LoadingBlock rows={6} label="Loading the activity record" /> : null}
      <ErrorBlock error={traces.error} what="the activity record" />
      {traces.data && groups.length === 0 ? <p className="text-footnote text-ink-2">Nothing to show for this filter yet.</p> : null}
      {/* Bento: two cards across from 56rem, three from 92rem, read row by row (newest first); each keeps its height. */}
      <ul className="bento-grid items-start gap-y-4" aria-label="Activity">
        {groups.map((g) => (
          <TraceGroup key={g[0]?.traceId} events={g} currency={currency} />
        ))}
      </ul>
    </div>
  );
}
