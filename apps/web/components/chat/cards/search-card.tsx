"use client";

import { useEffect, useRef } from "react";
import { Check, ChevronRight, Circle, OctagonAlert, Search } from "lucide-react";
import type { DataSearch } from "@hogee/core";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { CardHead } from "./card-shell";
import { useSupplierSearch } from "@/lib/api/queries";
import { uuidv7 } from "@/lib/chat-session";
import { ACTION_LABEL } from "./order-copy";
import { failureCopy, finishedSummary, searchSteps, type StepState } from "./search-view";
import type { CardProps } from "./types";

/** Searches whose show_candidates was already sent from this page (a re-mounted card never sends it twice). */
const shown = new Set<string>();

function StepIcon({ state }: { state: StepState }) {
  if (state === "done") return <Check aria-hidden className="size-3.5 text-paid" />;
  if (state === "current") return <Search aria-hidden className="size-3.5 text-ink motion-safe:animate-pulse" />;
  return <Circle aria-hidden className="size-3 text-ink-4" />;
}

/** "Results from a recorded sample, not a live search." whenever the provider is the recorded one. */
function RecordedNote() {
  return <p className="text-meta text-ink-3">Results from a recorded sample, not a live search.</p>;
}

/**
 * A web supplier search in progress. Polls getSupplierSearch every 1.5 s until READY or FAILED; on READY it sends
 * show_candidates once (never from history). A failure says what didn't happen and offers the catalog list.
 */
export function SearchCard({ data, answered, act }: CardProps<DataSearch>) {
  const q = useSupplierSearch(data.searchId);
  const s = q.data;
  const sent = useRef(false);

  useEffect(() => {
    if (!s || s.status !== "READY" || answered || sent.current || shown.has(s.searchId)) return;
    sent.current = true;
    shown.add(s.searchId);
    act({ type: "show_candidates", actionId: uuidv7(), searchId: s.searchId }, ACTION_LABEL.showCandidates);
  }, [s, answered, act]);

  const status = s?.status ?? "PENDING";
  return (
    <Card
      role="region"
      aria-label="Supplier search"
      aria-busy={status === "PENDING"}
      data-testid="card-search"
      data-search-id={data.searchId}
      data-status={status}
      data-stage={s?.stage ?? "SEARCHING"}
      data-provider={s?.provider ?? ""}
      className="min-w-0 gap-3 text-ui"
    >
      {!s && !q.error && (
        <>
          <CardHead icon={Search} tone="slot-1" title="Starting the search" subtitle="Usually under a minute." />
          <CardContent className="grid gap-2" role="status">
            <div className="h-2.5 w-3/4 rounded-full bg-sunk-2" />
            <div className="h-2.5 w-1/2 rounded-full bg-sunk-2" />
            <span className="sr-only">Starting the search. Usually under a minute.</span>
          </CardContent>
        </>
      )}
      {!s && q.error && (
        <>
          <CardHead icon={OctagonAlert} tone="blocked" title="Hogee couldn't load this search" subtitle="Nothing was paid or changed." />
          <CardContent>
            <Button variant="secondary" className="w-fit" onClick={() => void q.refetch()}>
              Try again
            </Button>
          </CardContent>
        </>
      )}
      {s && s.status === "PENDING" && (
        <>
          <CardHead icon={Search} tone="slot-1" title="Looking for suppliers" subtitle="A separate AI reads each page, and Hogee’s code checks and ranks them." />
          <CardContent className="grid gap-2.5">
            <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-2" aria-label="Search steps">
              {searchSteps(s).map((step, i) => (
                <li key={step.stage} className="inline-flex items-center gap-1.5" aria-current={step.state === "current" ? "step" : undefined}>
                  {i > 0 ? <ChevronRight aria-hidden className="size-3.5 text-ink-4" /> : null}
                  <span
                    className={cn(
                      "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[0.8125rem]",
                      step.state === "current" ? "bg-chart-1/12 font-medium text-ink" : step.state === "done" ? "bg-paid-wash text-paid" : "bg-sunk text-ink-3",
                    )}
                  >
                    <StepIcon state={step.state} />
                    {step.label}
                  </span>
                </li>
              ))}
            </ol>
            <p className="sr-only" role="status">
              {searchSteps(s).find((x) => x.state === "current")?.label ?? "Searching"}
            </p>
            {s.provider === "recorded" && <RecordedNote />}
          </CardContent>
        </>
      )}
      {s && s.status === "READY" && (
        <CardHead
          icon={Check}
          tone="paid"
          title={<span role="status">{finishedSummary(s)[0]}</span>}
          subtitle={
            <>
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {finishedSummary(s)
                  .slice(1)
                  .map((part, i) => (
                    <span key={part} className="inline-flex items-center gap-2">
                      {i > 0 && <span aria-hidden className="size-[3px] rounded-full bg-ink-4" />}
                      {part}
                    </span>
                  ))}
              </span>
              {s.provider === "recorded" && <RecordedNote />}
            </>
          }
        />
      )}
      {s && s.status === "FAILED" && (
        <CardContent>
          <SearchFailed search={s} answered={answered} act={act} />
        </CardContent>
      )}
    </Card>
  );
}

function SearchFailed({ search, answered, act }: { search: NonNullable<ReturnType<typeof useSupplierSearch>["data"]>; answered: boolean; act: CardProps<DataSearch>["act"] }) {
  const copy = failureCopy(search.failure);
  return (
    <div className="grid gap-3" role="alert">
      <div className="flex items-start gap-2.5">
        <OctagonAlert aria-hidden className="mt-0.5 size-4 text-blocked" />
        <div>
          <h3 className="text-title">{copy.title}</h3>
          <p className="mt-0.5 text-[0.8125rem] text-ink-2">{copy.body}</p>
        </div>
      </div>
      {search.provider === "recorded" && <RecordedNote />}
      <div className="flex flex-wrap gap-2">
        <Button disabled={answered} onClick={() => act({ type: "start_search", actionId: uuidv7(), quantity: search.quantity }, ACTION_LABEL.retrySearch)}>
          Try again
        </Button>
        <Button variant="secondary" disabled={answered} onClick={() => act({ type: "use_catalog", actionId: uuidv7() }, ACTION_LABEL.catalog)}>
          Use the sample list
        </Button>
      </div>
    </div>
  );
}
