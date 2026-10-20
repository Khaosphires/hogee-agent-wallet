"use client";

/**
 * The Wallet's Overview (UX2 brief §2, Apple Wallet; UX round 3 on the ui primitives): one dark card with the big
 * "Ready to spend" (the wallet's own figure, useReadyToSpend: the same number as the chat's wallet rail) and, under it,
 * what opens next ("6,000 BU more after 2,000 BU in sales", from the signed plan's stages, never hard-coded); three
 * smaller figures from the report (Paid out · Sales · Kept for tax; "Sample" only where sample sales sit beside real
 * records); the pockets as PocketRows (left, of, a ring that fills as money goes out; GET /api/balances, the same
 * answer Ready to spend comes from), headed "of your 10,000 BU plan"; then the notes, one line each.
 *
 * Before a plan exists (no pockets yet) the pockets give way to the three steps that open the wallet, with the way to
 * Chat, so a fresh start looks intended, not empty. The four figures keep their test ids (cfo-tile-cash, -spent,
 * -revenue, -reserve) and their exact [data-minor].
 */
import Link from "next/link";
import { ArrowRight, BadgeCheck, MessageCircle, PenLine, Wallet } from "lucide-react";
import type { Balances, CfoReport, Minor } from "@hogee/core";
import { buttonVariants } from "@/components/ui/button";
import { GroupedList, ListRow } from "@/components/ui/grouped-list";
import { IconTile } from "@/components/ui/icon-tile";
import { Skeleton } from "@/components/ui/skeleton";
import { Stat } from "@/components/ui/stat";
import { ErrorBlock } from "@/components/ledger/query-state";
import { Money } from "@/components/ledger/money";
import { PocketRow } from "@/components/ledger/pocket-row";
import type { QueryView } from "@/lib/api/query-policy";
import { cn } from "@/lib/utils";
import { insightsFor, pocketLine, salesFigure } from "./cfo-model";
import { PocketSubtitle } from "./cfo-parts";
import { NoteRows } from "./wallet-notes";

/** <Stat> on the dark card: the same figure, label and note, in the card's on-ink colours. */
const ON_INK =
  "[&>div:first-child>span]:text-ink-on/70 [&_[data-slot=stat-value]]:text-ink-on [&_[data-slot=stat-value]_span]:text-ink-on/55 [&>p]:text-ink-on/65";

/** "Sample" on the dark card, under its figure (a narrow card never truncates it): the light tag's test id and word. */
function HeroSampleTag() {
  return (
    <span data-testid="cfo-sample-tag" className="inline-flex h-[1.125rem] items-center rounded-full px-1.5 text-caption-2 font-medium text-ink-on/85 shadow-[inset_0_0_0_1px_oklch(1_0_0/0.28)]">
      Sample
    </span>
  );
}

function HeroFigure({ testId, label, minor, tagged }: { testId: string; label: string; minor: string | null; tagged: boolean }) {
  return (
    <Stat
      data-testid={testId}
      size="sm"
      tick={minor !== null}
      label={label}
      note={tagged ? <HeroSampleTag /> : undefined}
      minor={minor ?? undefined}
      value={minor === null ? <span className="text-ink-on/40">…</span> : undefined}
      className={ON_INK}
    />
  );
}

/**
 * On the dark card, the way to the next release: the one sales figure (salesFigure, as on the Plan and the loan
 * officer's page) against the goal, as a slim bar. Nothing when no release waits on sales.
 */
function ReleaseProgress({ report, tagged }: { report: CfoReport; tagged: boolean }) {
  const s = salesFigure(report);
  if (s.targetMinor === null) return null;
  return (
    <div data-testid="hero-release-progress" className="grid max-w-sm gap-2">
      <div role="meter" aria-label="Sales toward the next release" aria-valuenow={Math.round(s.pct)} aria-valuemin={0} aria-valuemax={100} className="h-1.5 overflow-hidden rounded-full bg-white/12">
        <div className="h-full rounded-full bg-paid" style={{ width: `${Math.max(s.pct > 0 ? 2 : 0, s.pct)}%` }} />
      </div>
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-footnote text-ink-on/65 tabular-nums">
        <span>
          <Money minor={s.soFarMinor} className="text-ink-on [&>span]:text-ink-on/55" /> of <Money minor={s.targetMinor} className="[&>span]:text-ink-on/55" /> in sales so far
        </span>
        {tagged ? <HeroSampleTag /> : null}
      </p>
    </div>
  );
}

/** The dark wallet card: Ready to spend, then Paid out, Sales and Kept for tax (testid money-tiles, four cfo-tile-*). */
export function WalletHero({ report, ready, line, tagged }: { report: QueryView<CfoReport>; ready: QueryView<Minor>; line: string; tagged: boolean }) {
  const o = report.kind === "data" ? report.data.overview : null;
  const cash = ready.kind === "data" ? ready.data : null;
  return (
    <div className="flex flex-col gap-3">
      <section
        aria-label="Your wallet in four numbers"
        data-testid="money-tiles"
        className={cn(
          "relative isolate flex flex-col overflow-hidden rounded-sheet bg-ink p-5 text-ink-on sm:p-6",
          "shadow-[inset_0_1px_0_oklch(1_0_0/0.14),0_1px_2px_oklch(0.235_0.028_262/0.2),0_18px_40px_-18px_oklch(0.235_0.028_262/0.55)]",
          // A faint cobalt light from the top corner and a teal one from below: depth, never a pattern behind text.
          "before:absolute before:inset-0 before:-z-10 before:bg-[radial-gradient(90%_70%_at_100%_0%,oklch(0.48_0.15_262/0.5),transparent_65%),radial-gradient(70%_60%_at_0%_110%,oklch(0.59_0.11_190/0.28),transparent_70%)] before:content-['']",
        )}
      >
        <div className="flex items-start justify-between gap-3">
          {cash === null ? (
            <div className="grid gap-1">
              <p className="text-footnote font-medium text-ink-on/70">Ready to spend</p>
              <p data-testid="cfo-tile-cash" className="text-hero text-ink-on/40" aria-label="Loading">
                …
              </p>
            </div>
          ) : (
            <Stat
              data-testid="cfo-tile-cash"
              size="hero"
              tick
              label="Ready to spend"
              minor={cash}
              note={line}
              className={cn(ON_INK, "gap-1.5 [&>p]:text-subhead @3xl:[&_[data-slot=stat-value]]:text-[3.5rem]")}
            />
          )}
          <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-white/10 shadow-[inset_0_1px_0_oklch(1_0_0/0.18)]">
            <Wallet className="size-5 text-ink-on" strokeWidth={2} />
          </span>
        </div>
        {report.kind === "data" ? (
          <div className="mt-5">
            <ReleaseProgress report={report.data} tagged={tagged} />
          </div>
        ) : null}
        <div className="mt-6 grid grid-cols-3 gap-3 border-t border-white/12 pt-4">
          <HeroFigure testId="cfo-tile-spent" label="Paid out" minor={o?.spentMinor ?? null} tagged={false} />
          <HeroFigure testId="cfo-tile-revenue" label="Sales" minor={o?.revenueMinor ?? null} tagged={tagged} />
          <HeroFigure testId="cfo-tile-reserve" label="Kept for tax" minor={o?.reserveMinor ?? null} tagged={tagged} />
        </div>
      </section>
      {report.kind === "error" ? <ErrorBlock error={report.error} what="your money figures (nothing was paid or changed)" /> : null}
      {ready.kind === "error" ? <ErrorBlock error={ready.error} what="Ready to spend (nothing was paid or changed)" /> : null}
    </div>
  );
}

/** Where a pocket's rules live (the Plan page's pockets section, lib/sections.ts). */
const PLAN_POCKETS_HREF = "/plan#plan-pockets";

/**
 * The pockets as the wallet counts them (PocketRow: "X BU left", "of Y", the ring fills as money goes out), with what
 * was paid and set aside in the subtitle (cfo-model pocketLine), headed "of your 10,000 BU plan" so Ready to spend
 * (what is open now) and the pockets (the whole plan) never read as one number.
 */
export function PocketList({ balances, supplierPaidMinor }: { balances: Balances | null; supplierPaidMinor: string | null }) {
  const pockets = balances?.pockets ?? null;
  const planMinor = pockets ? pockets.reduce((s, p) => s + BigInt(p.allocated), 0n).toString() : null;
  const header = (
    <span className="grid">
      <span>Pockets</span>
      {planMinor ? (
        <span className="font-normal text-ink-3">
          Left of your <Money minor={planMinor} /> plan
        </span>
      ) : null}
    </span>
  );
  if (pockets === null) {
    return (
      <GroupedList header="Pockets" aria-busy="true">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <li key={i} className="flex h-14 items-center gap-3 px-4">
            <Skeleton className="size-[30px] rounded-[8px]" />
            <Skeleton className="h-2.5 w-1/3" />
          </li>
        ))}
      </GroupedList>
    );
  }
  return (
    <GroupedList header={header} data-testid="wallet-pockets">
      {pockets.map((p) => (
        <PocketRow
          key={p.lineKey}
          lineKey={p.lineKey}
          allocatedMinor={p.allocated}
          leftMinor={p.available}
          href={PLAN_POCKETS_HREF}
          subtitle={<PocketSubtitle line={pocketLine(p, { escrowMinor: balances?.escrowMinor ?? "0", supplierPaidMinor })} paused={p.paused || p.circuitOpen} />}
        />
      ))}
    </GroupedList>
  );
}

const OPENING_STEPS = [
  { icon: MessageCircle, tone: "ink" as const, title: "Tell Hogee what you sell", line: "A short chat builds your budget." },
  { icon: PenLine, tone: "grey" as const, title: "Sign your plan", line: "One touch with your passkey." },
  { icon: BadgeCheck, tone: "paid" as const, title: "Your loan officer adds the money", line: "Your pockets fill here." },
];

/** Before a plan: the three steps that open the wallet, and the way there. */
export function WalletOpening() {
  return (
    <div className="grid content-start gap-3" data-testid="wallet-opening">
      <GroupedList header="How your wallet opens">
        {OPENING_STEPS.map((s, i) => (
          <ListRow
            key={s.title}
            leading={<IconTile icon={s.icon} tone={s.tone} />}
            title={
              <>
                <span className="sr-only">Step {i + 1}: </span>
                {s.title}
              </>
            }
            subtitle={s.line}
            value={<span aria-hidden className="text-footnote font-semibold text-ink-4">{i + 1}</span>}
          />
        ))}
      </GroupedList>
      <Link href="/chat" className={cn(buttonVariants({ size: "lg" }), "w-fit rounded-full")}>
        Start in Chat
        <ArrowRight aria-hidden />
      </Link>
    </div>
  );
}

/** Up to two notes from the report, one line each; a calm "all clear" row when there are none. */
export function OverviewNotes({ report }: { report: CfoReport }) {
  const notes = insightsFor(report, "overview", 2);
  if (notes.length > 0) return <NoteRows notes={notes} header="What Hogee noticed" />;
  return (
    <GroupedList header="What Hogee noticed">
      <ListRow leading={<IconTile icon={BadgeCheck} tone="paid" />} title="Nothing needs you right now." />
    </GroupedList>
  );
}
