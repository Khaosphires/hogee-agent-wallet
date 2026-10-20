"use client";

import Link from "next/link";
import { ArrowUpRight, ChevronRight, ClipboardList, Landmark, ListChecks, Wallet } from "lucide-react";
import type { DataNeeds, LineKey, NeedsGroup, NeedsItem, NeedsStatus } from "@hogee/core";
import { AllocationBar } from "@/components/ledger/allocation-bar";
import { LINE_SLOT, SLOT_BG } from "@/components/ledger/line-slots";
import { Money } from "@/components/ledger/money";
import { budgetBar, buFigure, needsAmountText, needsGroups, percentOfBps } from "@/lib/journey-client";
import { SIGN_PLAN } from "@/lib/next-step";
import { cn } from "@/lib/utils";
import { CardShell } from "./card-shell";
import { SignPill, SignStub, useLifted, useSignProgress } from "./sign-host";
import type { CardProps } from "./types";

/** A pocket's chart slot (DESIGN.md §7: Supplier chart-1 … Platform fees 5; licensing and the buffer neutral). */
const slotOf = (lineKey: LineKey | null) => (lineKey ? LINE_SLOT[lineKey] : "neutral");

/** The plan card's own group headings and status words (REWRITES A3.5, A3.6; display only). */
const GROUP_HEADING: Record<NeedsGroup, string> = {
  REGISTRATION: "Register your business",
  BUDGET_LINE: "How your budget is split",
  SUPPLIER: "Suppliers to find",
  ACCOUNT: "Accounts to open",
  TAX_RESERVE: "Money kept for tax",
};
const STATUS_TEXT: Record<NeedsStatus, string> = { TODO: "To do", IN_PLAN: "Covered by your plan", DONE: "Done" };

/** "Supplier budget" → "Supplier": the legend's short pocket name. */
const pocketName = (title: string): string => title.replace(/ budget$/i, "");

/** One item in the folded list: a pocket swatch (budget rows only), the title, what it means, its status, the amount. */
function NeedsRow({ item, swatch }: { item: NeedsItem; swatch?: string }) {
  const amount = item.amountMinor === null ? null : item.amountMinor === "0" ? needsAmountText("0") : <Money minor={item.amountMinor} />;
  return (
    <li className={cn("grid items-start gap-x-3 py-2.5", swatch ? "grid-cols-[auto_minmax(0,1fr)_auto]" : "grid-cols-[minmax(0,1fr)_auto]")} data-testid="needs-item" data-status={item.status} data-group={item.group}>
      {swatch ? <span aria-hidden className={cn("mt-1.5 size-2.5 shrink-0 rounded-[3px]", swatch)} /> : null}
      <div className="min-w-0 space-y-0.5">
        <p className="text-ui leading-snug font-medium text-pretty">{item.title}</p>
        {item.detail ? <p className="text-[0.8125rem] text-pretty text-ink-2">{item.detail}</p> : null}
        <p className={cn("text-meta", item.status === "TODO" ? "font-medium text-waiting" : "text-ink-3")}>{STATUS_TEXT[item.status]}</p>
      </div>
      <span className="pt-px text-ui font-medium whitespace-nowrap tabular-nums">{amount ?? <span className="sr-only">No amount</span>}</span>
    </li>
  );
}

/** The allocation bar (ledger/allocation-bar, bar only) and a one-line legend: swatch, pocket, amount. */
function NeedsAllocation({ data }: { data: DataNeeds }) {
  const bar = budgetBar(data);
  if (bar.length === 0) return null;
  const total = bar.reduce((sum, b) => sum + BigInt(b.amountMinor), 0n).toString();
  const items = bar.map((b) => ({ key: b.lineKey, label: b.title, minor: b.amountMinor, slot: slotOf(b.lineKey as LineKey) }));
  return (
    <div className="grid gap-2.5" data-testid="needs-allocation">
      <AllocationBar items={items} totalMinor={total} rows={false} />
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-[0.8125rem] text-ink-2" aria-label="Your pockets">
        {bar.map((b) => (
          <li key={b.lineKey} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={cn("size-2.5 shrink-0 rounded-[3px]", SLOT_BG[slotOf(b.lineKey as LineKey)])} />
            <span>{pocketName(b.title)}</span>
            <Money minor={b.amountMinor} className="font-medium text-ink tabular-nums" />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "Register your business and 4 more": the first thing to do, and how many follow. */
function todoLine(todo: readonly NeedsItem[]): string {
  const [first] = todo;
  if (!first) return "Nothing to do before you start.";
  const more = todo.length - 1;
  return `${todo.length} ${todo.length === 1 ? "thing" : "things"} to do first: ${first.title}${more > 0 ? `, and ${more} more` : ""}.`;
}

/**
 * The plan card (UX-PLAN D17): the total, the colour bar with its pockets, three plain lines (pockets, what to do
 * first, kept for tax) and every item folded under "See all". A money card: it ends in the plan's signature, whose
 * "Sign the plan" (the bar's word too) opens the thread's SignDialog for PlanApproval on this draft. No source chips here (sources live
 * on the Plan page), no tick-box circles.
 */
export function NeedsCard({ data }: CardProps<DataNeeds>) {
  const groups = needsGroups(data);
  const pockets = data.items.filter((i) => i.group === "BUDGET_LINE").length;
  const todo = data.items.filter((i) => i.status === "TODO" && i.group !== "BUDGET_LINE" && i.group !== "TAX_RESERVE");
  const reserve = percentOfBps(data.reserveBps);
  const lifted = useLifted("PlanApproval", data.draftId);
  // Once signed it no longer asks to be checked (UX round 3): the stub's seal says it is signed.
  const signState = useSignProgress("PlanApproval", data.draftId).state;
  const signed = signState === "submitted" || signState === "confirmed" || signState === "superseded";
  const { figure } = buFigure(data.totalMinor);
  const summary = `a plan of ${figure} BU split into ${pockets} ${pockets === 1 ? "pocket" : "pockets"}. ${reserve} of each sale is kept for tax. Your wallet can only pay from these pockets, up to their limits.`;

  return (
    <CardShell
      testId="card-needs"
      icon={ClipboardList}
      tone="ink"
      data-draft-id={data.draftId}
      lifted={lifted}
      title="Your plan"
      subtitle={signed ? "AI-drafted from your answers · your wallet follows it" : "AI-drafted from your answers, with the numbers set by fixed rules · check before you sign"}
      badge={<SignPill kind="PlanApproval" refId={data.draftId} />}
      stub={
        <SignStub
          kind="PlanApproval"
          refId={data.draftId}
          title="Sign your plan"
          summary={summary}
          cta={SIGN_PLAN}
          secondary={
            <Link
              href="/plan"
              className="relative inline-flex h-10 items-center gap-1 rounded-lg px-2 text-ui font-medium text-ink-2 underline-offset-4 outline-none hover:text-ink hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              See every rule <ArrowUpRight aria-hidden className="size-3.5" />
            </Link>
          }
        />
      }
    >
      <p data-testid="needs-total">
        <Money minor={data.totalMinor} figure="amount" />
      </p>
      <NeedsAllocation data={data} />
      <ul className="grid gap-2 text-ui text-pretty" data-testid="needs-lines">
        <li className="flex items-start gap-2.5">
          <Wallet aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-3" />
          <span>
            Split into {pockets} {pockets === 1 ? "pocket" : "pockets"}. Your wallet can only pay from them, up to their limits.
          </span>
        </li>
        <li className="flex items-start gap-2.5">
          <ListChecks aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-3" />
          <span>{todoLine(todo)}</span>
        </li>
        <li className="flex items-start gap-2.5">
          <Landmark aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-3" />
          <span>{reserve} of each sale is kept for tax.</span>
        </li>
      </ul>
      <details className="group/all -mx-1" data-testid="needs-all">
        <summary className="flex h-10 cursor-pointer list-none items-center gap-1.5 rounded-lg px-1 text-ui font-medium text-ink-2 outline-none select-none hover:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
          <ChevronRight aria-hidden className="size-4 transition-transform duration-(--dur-state) ease-settle group-open/all:rotate-90" />
          See all {data.items.length} items
        </summary>
        <div className="grid gap-4 px-1 pt-2">
          {groups.map((g) => (
            <section key={g.group} aria-label={GROUP_HEADING[g.group]} className="grid min-w-0 gap-1">
              <h4 className="text-meta font-medium text-ink-3">{GROUP_HEADING[g.group]}</h4>
              <ul className="divide-y divide-line">
                {g.items.map((item) => (
                  <NeedsRow key={item.itemId} item={item} swatch={g.group === "BUDGET_LINE" ? SLOT_BG[slotOf(item.lineKey)] : undefined} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      </details>
    </CardShell>
  );
}
