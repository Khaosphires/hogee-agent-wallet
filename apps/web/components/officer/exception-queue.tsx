"use client";

import { ChevronRight } from "lucide-react";
import type { Exception } from "@hogee/core";
import { GroupedList } from "@/components/ui/grouped-list";
import { PageSection } from "@/components/ui/page-section";
import { ErrorBlock } from "@/components/ledger/query-state";
import { useDisplayCurrency, useExceptions } from "@/lib/api/queries";
import { STATUS_GROUP, WAIT_NOTE, type QueueGroup } from "@/lib/exception-copy";
import { ExceptionRow } from "./exception-row";

/** The loan officer's requests, split by group: anything the plan doesn't allow the AI to do alone (§4 step 10). */
export function useQueue() {
  const exceptions = useExceptions();
  const currency = useDisplayCurrency();
  const by = (g: QueueGroup): Exception[] => (exceptions.data ?? []).filter((e) => STATUS_GROUP[e.status] === g);
  return { exceptions, currency, by };
}

export type Queue = ReturnType<typeof useQueue>;

/**
 * Requests that need the officer now: only when there are some (or the list could not be read). The first request's
 * Approve is the page's one filled button; the others are tinted.
 */
export function NeedsDecision({ queue }: { queue: Queue }) {
  const { exceptions, currency, by } = queue;
  const items = by("needs-decision");
  if (!exceptions.error && items.length === 0) return null;
  return (
    <div data-testid="queue-needs-decision" data-loaded={exceptions.data ? "true" : "false"} className="grid">
      <PageSection
        id="officer-decisions"
        title="Needs your decision"
        aside={items.length > 0 ? <span className="text-footnote font-medium text-waiting tabular-nums">{items.length} waiting</span> : null}
      >
        {exceptions.error ? <ErrorBlock error={exceptions.error} what="requests" /> : null}
        {items.length > 0 ? (
          <GroupedList aria-label="Requests that need your decision">
            {items.map((e, i) => (
              <ExceptionRow key={e.exceptionId} exception={e} currency={currency} primary={i === 0} />
            ))}
          </GroupedList>
        ) : null}
      </PageSection>
    </div>
  );
}

/** Changes waiting out their wait before they happen: only when there are some. */
export function WaitingChanges({ queue }: { queue: Queue }) {
  const items = queue.by("timelock");
  if (items.length === 0) return null;
  return (
    <section data-testid="queue-timelock">
      <GroupedList header="In their safety wait" footer={WAIT_NOTE}>
        {items.map((e) => (
          <ExceptionRow key={e.exceptionId} exception={e} currency={queue.currency} />
        ))}
      </GroupedList>
    </section>
  );
}

/** Closed requests, folded: only once the list has loaded and has some. */
export function QueueHistory({ queue }: { queue: Queue }) {
  const items = queue.by("closed");
  if (!queue.exceptions.data || items.length === 0) return null;
  return (
    <details className="group/history rounded-group bg-raised shadow-card" data-testid="officer-history">
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 rounded-group px-4 text-callout font-medium text-ink outline-none select-none hover:bg-fill focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-4 text-ink-3 transition-[rotate] duration-(--dur-state) ease-settle group-open/history:rotate-90" />
        Past requests
        <span className="ml-auto text-footnote text-ink-3 tabular-nums">{items.length}</span>
      </summary>
      <div className="pb-1" data-testid="queue-closed">
        <GroupedList inset={false} aria-label="Past requests" className="[&>ul]:mx-0">
          {items.map((e) => (
            <ExceptionRow key={e.exceptionId} exception={e} currency={queue.currency} />
          ))}
        </GroupedList>
      </div>
    </details>
  );
}
