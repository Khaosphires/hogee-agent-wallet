"use client";

import { useState } from "react";
import { AlertTriangle, Check, ChevronRight, ExternalLink, OctagonAlert, ShieldCheck, Store } from "lucide-react";
import type { CandidateCard, DataCandidates, SupplierSearch } from "@hogee/core";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CardHead } from "./card-shell";
import { Pill, UnverifiedPill } from "@/components/ui/pill";
import { cn } from "@/lib/utils";
import { useSupplierSearch } from "@/lib/api/queries";
import { uuidv7 } from "@/lib/chat-session";
import { ACTION_LABEL } from "./order-copy";
import {
  coverage,
  excludedLines,
  failureCopy,
  leftOutCount,
  listingHref,
  omittedLine,
  orNotStated,
  perUnitBu,
  pickLabel,
  showUnverified,
  shownCandidateIds,
  togglePick,
  wholeBu,
} from "./search-view";
import type { CardProps } from "./types";

function Metric({ label, value, note, hint }: { label: string; value: string; note?: string | null; hint?: string }) {
  return (
    <div>
      <dt className="text-meta text-ink-3" title={hint}>
        {label}
      </dt>
      <dd className="text-ui font-medium tabular-nums">
        {value}
        {note && <small className="block text-meta font-normal text-ink-3">{note}</small>}
      </dd>
    </div>
  );
}

/** The listing host as a safe link (server-checked URL on that host only), else as plain text. */
export function ListingHost({ c }: { c: Pick<CandidateCard, "listingUrl" | "listingHost"> }) {
  const href = listingHref(c);
  if (!c.listingHost) return null;
  if (!href) return <span className="text-[0.78125rem] text-ink-3">{c.listingHost}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      referrerPolicy="no-referrer"
      className="relative inline-flex items-center gap-1 rounded-sm text-[0.78125rem] text-ink-3 underline decoration-line-2 underline-offset-[3px] outline-none after:absolute after:-inset-x-1 after:-inset-y-3 after:content-[''] hover:text-ink hover:decoration-ink focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      {c.listingHost}
      <ExternalLink aria-hidden className="size-3" />
      <span className="sr-only">(opens the seller&apos;s page in a new tab)</span>
    </a>
  );
}

function CandidateRow({ c, quantity, picked, disabled, hidden, onToggle }: { c: CandidateCard; quantity: number; picked: boolean; disabled: boolean; hidden: boolean; onToggle: () => void }) {
  return (
    <li
      data-testid="candidate"
      data-rank={c.rank ?? ""}
      data-supplier-id={c.supplierId}
      data-origin={c.origin}
      hidden={hidden}
      className="grid grid-cols-[24px_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-line py-4 first:border-t-0 first:pt-0 last:pb-0"
    >
      <span
        className={cn(
          "grid size-6 place-items-center rounded-full text-[0.8125rem] font-semibold tabular-nums transition-[background-color,color] duration-(--dur-state) ease-settle",
          picked ? "bg-chart-1 text-ink-on" : "bg-sunk text-ink-2",
        )}
      >
        {c.rank ?? "–"}
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <h4 className="mr-0.5 min-w-0 text-ui font-semibold tracking-[-0.01em] text-pretty">{c.displayName}</h4>
          {showUnverified(c) && <UnverifiedPill title="Found on the web. Nobody has checked who they are yet." />}
          {c.priceFlag && <Pill tone="blocked">Much cheaper than the rest</Pill>}
        </div>
        <ListingHost c={c} />
      </div>
      <dl className="col-start-2 mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-[1.2fr_0.8fr_0.8fr_1fr]">
        <Metric label="Delivered cost" hint="The price plus shipping, import tax and fees." value={c.landedCostMinor ? wholeBu(c.landedCostMinor) : "Not stated"} note={perUnitBu(c.landedCostMinor, quantity)} />
        <Metric label="Minimum order" value={orNotStated(c.moq, "")} />
        <Metric label="Delivery time" value={orNotStated(c.leadTimeDays, " days")} />
        <Metric label="Checked" hint="How much of what the page claims Hogee matched to evidence. A web supplier starts unchecked." value={coverage(c.evidenceCoverageBps)} />
      </dl>
      <div className="col-start-2 mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        {c.redFlagCount > 0 ? (
          <span className="inline-flex items-center gap-1.5 text-[0.8125rem] text-blocked">
            <AlertTriangle aria-hidden className="size-3.5" />
            {c.redFlagCount === 1 ? "1 red flag" : `${c.redFlagCount} red flags`}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-[0.8125rem] text-ink-3">
            <Check aria-hidden className="size-3.5" />
            No red flags found
          </span>
        )}
        {c.priceFlag && <span className="text-[0.8125rem] text-ink-2">Ask for proof before you pay. A price this low is often a trick.</span>}
        <label
          className={cn(
            "ml-auto inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-lg px-3 text-ui font-medium transition-[background-color,box-shadow,scale] duration-(--dur-state) ease-settle active:scale-(--press) active:duration-(--dur-press) has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50",
            picked ? "bg-chart-1/12 text-ink shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--chart-1)_35%,transparent)]" : "text-ink-2 shadow-[inset_0_0_0_1px_var(--line)]",
            disabled ? "cursor-not-allowed opacity-55" : "hover:bg-sunk",
          )}
        >
          <input type="checkbox" className="size-4 accent-[var(--ink)] outline-none" checked={picked} disabled={disabled || !c.canOrder} onChange={onToggle} aria-label={pickLabel(c)} />
          {picked ? "Picked" : "Pick"}
        </label>
      </div>
    </li>
  );
}

/** The pages left out, folded: "4 pages hidden for your safety" (the reasons, the attack first, stay inside). */
function LeftOut({ s }: { s: SupplierSearch }) {
  const lines = excludedLines(s.excludedByGate);
  const skipped = omittedLine(s.omitted);
  const n = leftOutCount(s);
  if (lines.length === 0 && !skipped) return null;
  return (
    <details data-testid="excluded-summary" className="group rounded-lg bg-sunk text-[0.8125rem] text-ink-2">
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2.5 rounded-lg px-3.5 py-2.5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ShieldCheck aria-hidden className="size-4 shrink-0 text-ink" />
        <span className="font-medium text-ink">
          {n === 1 ? "1 page" : `${n.toLocaleString("en-US")} pages`} hidden for your safety
        </span>
        <ChevronRight aria-hidden className="ml-auto size-4 text-ink-3 transition-transform duration-(--dur-state) group-open:rotate-90" />
      </summary>
      <div className="grid gap-1 px-3.5 pb-3 pl-[2.6rem]">
        {lines.map((l) => (
          <p key={l} className="font-medium text-ink">
            {l}
          </p>
        ))}
        {lines.length > 0 && <p>A separate AI read those pages and did nothing they asked.</p>}
        {skipped && <p>{skipped}</p>}
      </div>
    </details>
  );
}

/**
 * The candidates of a finished search (reads getSupplierSearch). Three show first, then "Show N more" (UX-PLAN D27).
 * Every web supplier carries the Unverified pill; the founder picks 1 to 5, which sends `pick` (the message follows).
 * Hogee never contacts a supplier.
 */
export function CandidatesCard({ data, answered, act }: CardProps<DataCandidates>) {
  const q = useSupplierSearch(data.searchId);
  const s = q.data;
  const [picked, setPicked] = useState<string[]>([]);
  const [sent, setSent] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const locked = answered || sent;

  if (!s) {
    return (
      <Card role="region" aria-label="Supplier list" aria-busy={!q.error} data-testid="card-candidates" data-search-id={data.searchId} className="min-w-0 gap-3 text-ui">
        {q.error ? (
          <>
            <CardHead icon={OctagonAlert} tone="blocked" title="Hogee couldn't load these suppliers" />
            <CardContent>
              <Button variant="secondary" className="w-fit" onClick={() => void q.refetch()}>
                Try again
              </Button>
            </CardContent>
          </>
        ) : (
          <>
            <CardHead icon={Store} tone="slot-1" title="Loading the suppliers" />
            <CardContent className="grid gap-2" role="status">
              <div className="h-2.5 w-2/3 rounded-full bg-sunk-2" />
              <div className="h-2.5 w-5/6 rounded-full bg-sunk-2" />
              <span className="sr-only">Loading the suppliers.</span>
            </CardContent>
          </>
        )}
      </Card>
    );
  }

  const ranked = s.candidates.map((c) => c.supplierId);
  const shown = shownCandidateIds(ranked, picked, expanded);
  const more = s.candidates.length - shown.size;
  const catalog = () => act({ type: "use_catalog", actionId: uuidv7() }, ACTION_LABEL.catalog);
  const n = s.candidates.length;
  return (
    <Card role="region" aria-labelledby={`cands-${s.searchId}`} data-testid="card-candidates" data-search-id={s.searchId} data-status={s.status} className="min-w-0 text-ui">
      <CardHead
        icon={Store}
        tone="slot-1"
        titleId={`cands-${s.searchId}`}
        title={
          s.status !== "READY"
            ? s.status === "PENDING"
              ? "Still searching"
              : failureCopy(s.failure).title
            : n === 0
              ? "No supplier fit your plan"
              : `${n} ${n === 1 ? "supplier" : "suppliers"} found on the web for ${s.quantity.toLocaleString("en-US")} units`
        }
        subtitle={
          <>
            {s.status === "READY" && n > 0
              ? "Ranked by delivered cost, delivery time and payment terms. Every number is the seller’s own claim until you see proof."
              : s.status === "FAILED"
                ? failureCopy(s.failure).body
                : s.status === "PENDING"
                  ? "The list appears here when the search finishes."
                  : "Nothing passed the checks. You can use Hogee's sample supplier list instead."}
            {s.provider === "recorded" && <span className="mt-1 block text-meta text-ink-3">Results from a recorded sample, not a live search.</span>}
          </>
        }
      />
      <CardContent className="grid min-w-0 gap-4">
        {s.status === "READY" && n > 0 && (
          <div className="grid gap-3">
            <ol className="grid">
              {s.candidates.map((c) => (
                <CandidateRow
                  key={c.supplierId}
                  c={c}
                  quantity={s.quantity}
                  picked={picked.includes(c.supplierId)}
                  disabled={locked}
                  hidden={!shown.has(c.supplierId)}
                  onToggle={() => setPicked((p) => togglePick(p, c.supplierId, ranked))}
                />
              ))}
            </ol>
            {more > 0 ? (
              <Button variant="ghost" className="w-fit" onClick={() => setExpanded(true)} data-testid="candidates-more">
                Show {more} more
              </Button>
            ) : null}
          </div>
        )}
        {s.status === "READY" && <LeftOut s={s} />}
        {s.status === "READY" && n > 0 && (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              data-testid="pick-submit"
              disabled={locked || picked.length === 0}
              onClick={() => {
                setSent(true);
                act({ type: "pick", actionId: uuidv7(), searchId: s.searchId, supplierIds: picked }, picked.length === 1 ? ACTION_LABEL.pickOne : ACTION_LABEL.pickMany(picked.length));
              }}
            >
              {picked.length > 1 ? `Write a message to ${picked.length} suppliers` : "Write a message to this supplier"}
            </Button>
            <p className="text-[0.8125rem] text-ink-2">Pick up to 5. Hogee writes the message, and you send it yourself.</p>
          </div>
        )}
        {(s.status === "FAILED" || (s.status === "READY" && n === 0)) && (
          <Button variant="secondary" className="w-fit" disabled={answered} onClick={catalog}>
            Use the sample list
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
