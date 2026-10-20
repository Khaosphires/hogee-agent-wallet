"use client";

import { useEffect, useState } from "react";
import { ArrowDownLeft, BadgeCheck, ChevronRight, CircleCheck, CirclePause, Fingerprint, Info, MessageCircle, PenLine, Wallet, type LucideIcon } from "lucide-react";
import { errorCopy, type Pocket } from "@hogee/core";
import { TxHash } from "@/components/ledger/hash";
import { Money } from "@/components/ledger/money";
import { moneyParts } from "@/components/ledger/money-parts";
import { PocketRow } from "@/components/ledger/pocket-row";
import { Seal, SealCode } from "@/components/ledger/seal";
import { RefreshNote } from "@/components/ledger/query-state";
import { useSampleSales } from "@/components/cfo/cfo-parts";
import { BU_NOTE } from "@/components/shell/bu-note";
import { zoneCurrency } from "@/components/sign/seal-time";
import { Button } from "@/components/ui/button";
import { GroupedList, ListRow } from "@/components/ui/grouped-list";
import { IconTile } from "@/components/ui/icon-tile";
import { Tag } from "@/components/ui/pill";
import { Progress } from "@/components/ui/progress";
import { Stat } from "@/components/ui/stat";
import type { Tone } from "@/components/ui/tones";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useApiMutation } from "@/lib/api/hooks";
import { useBalances, useCfoReport, useCurrentPlan, useDisplayCurrency } from "@/lib/api/queries";
import { useSession } from "@/lib/api/use-session";
import { walletSummary } from "@/lib/journey-client";
import type { ChatAction } from "@hogee/core";
import type { NextStep, NextStepAction } from "@/lib/next-step";
import { useSignHost } from "./cards/sign-host";
import { relativeTime, zoneOfCurrency } from "./chat-time";
import { NextStepSection, NextStepStrip, useRunNextStep } from "./next-step";
import { recentThings, type RecentThing } from "./recent";
import { SampleSealTag, useSampleBusiness } from "./sample-seal";

/** A pocket's quiet line under its name: paused, what escrow holds for the supplier, else "of <total>" (PocketRow's). */
function pocketSubtitle(pocket: Pocket, heldMinor: string | null) {
  if (pocket.paused || pocket.circuitOpen) {
    return (
      <>
        <span className="font-medium text-waiting">Paused</span> · of <Money minor={pocket.allocated} />
      </>
    );
  }
  if (heldMinor && heldMinor !== "0") {
    return (
      <span data-testid="wallet-escrow">
        of <Money minor={pocket.allocated} /> · <Money minor={heldMinor} /> held
      </span>
    );
  }
  return undefined;
}

/**
 * Pause automatic payments (UX-PLAN D24): pausing is tighten-only, so it is instant once confirmed; turning them back
 * on needs the founder AND the loan officer, then a waiting time. Shown only once a plan is signed (nothing to pause
 * before). First-timer #23: "Pause", and the order stays.
 */
function PausePayments({ paused }: { paused: boolean }) {
  const [open, setOpen] = useState(false);
  const pause = useApiMutation("pause");
  return (
    <div className="grid gap-1.5">
      <Button variant="secondary" className="w-full rounded-full" disabled={paused || pause.isPending} onClick={() => setOpen(true)} data-testid="wallet-pause">
        <CirclePause aria-hidden /> {paused ? "Automatic payments paused" : "Pause all automatic payments"}
      </Button>
      <p className="px-1 text-center text-footnote text-pretty text-ink-3">Your orders stay. You and your loan officer can turn them back on.</p>
      {pause.error ? (
        <p role="alert" className="text-footnote text-blocked">
          {errorCopy(pause.error.code).title}: {pause.error.message}
        </p>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Pause all automatic payments?</DialogTitle>
            <DialogDescription>
              Pauses every automatic payment right away. Your orders stay. To turn them back on, you and your loan officer must both agree, and then wait a
              short time.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Keep paying
            </Button>
            <Button variant="destructive" disabled={pause.isPending} onClick={() => pause.mutate(undefined, { onSuccess: () => setOpen(false) })}>
              Pause now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The relative times re-read every 30 s (not every second: nothing here counts down). */
function useCoarseNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

const RECENT_TILE: Readonly<Record<RecentThing["kind"], { icon: LucideIcon; tone: Tone }>> = {
  sale: { icon: ArrowDownLeft, tone: "paid" },
  signed: { icon: Fingerprint, tone: "seal" },
  press: { icon: CircleCheck, tone: "grey" },
};

/** "Recently": the last three things that happened, with how long ago (presses in this thread, recent sales). */
function Recently({ presses }: { presses: readonly RecentThing[] }) {
  const report = useCfoReport();
  const sample = useSampleSales();
  const now = useCoarseNow();
  const persona = useSession().data?.persona;
  const timeZone = zoneOfCurrency(zoneCurrency(useDisplayCurrency(), persona));
  const things = recentThings(presses, report.data?.sales.recent ?? []);
  if (things.length === 0) return null;
  return (
    <GroupedList header="Recently" data-testid="wallet-recent">
      {things.map((t) => {
        const tile = RECENT_TILE[t.kind];
        const when = (
          <time dateTime={new Date(t.at).toISOString()} className="tabular-nums">
            {relativeTime(t.at, now, timeZone)}
          </time>
        );
        return t.kind === "sale" && t.amountMinor ? (
          <ListRow
            key={t.key}
            leading={<IconTile icon={tile.icon} tone={tile.tone} size="sm" variant="tinted" />}
            title={
              <span className="inline-flex items-center gap-1.5">
                Sale {sample ? <Tag>Sample</Tag> : null}
              </span>
            }
            subtitle={when}
            value={<span className="font-medium text-paid">+{moneyParts(t.amountMinor).figure} BU</span>}
          />
        ) : (
          <ListRow key={t.key} leading={<IconTile icon={tile.icon} tone={tile.tone} size="sm" variant="tinted" />} title={t.text} subtitle={when} />
        );
      })}
    </GroupedList>
  );
}

interface SealRow {
  readonly key: string;
  readonly title: string;
  readonly txHash: string;
  /** Made by the sample business, not in this browser. */
  readonly sample: boolean;
}

interface RailProps {
  readonly step: NextStep | null;
  /** The thread's act (the Next step's button runs below the SignHost, here). */
  readonly act: (a: ChatAction, label: string) => void;
  /** The founder's presses in the thread, with their times (recent.ts pressesOf), for "Recently". */
  readonly presses?: readonly RecentThing[];
}

/** The BU disclosure (project.md D4, §14.4), shortened behind a press (ux2): every property stays one press away. */
function BuDisclosure() {
  const rest = BU_NOTE.replace(/^Amounts are in BU \(budget units\)\.\s*/, "");
  return (
    <details className="group/bu text-footnote text-ink-3" data-testid="wallet-bu-note">
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-lg px-1 outline-none select-none hover:text-ink-2 focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <Info aria-hidden className="size-3.5 shrink-0" />
        <span className="flex-1">Amounts are in BU (budget units)</span>
        <ChevronRight aria-hidden className="size-3.5 transition-transform duration-(--dur-state) ease-settle group-open/bu:rotate-90 motion-reduce:transition-none" />
      </summary>
      <p className="px-1 pt-1 pb-2 leading-[1.5] text-pretty text-ink-2">{rest}</p>
    </details>
  );
}

const OPENING: readonly { icon: LucideIcon; tone: Tone; title: string; line: string }[] = [
  { icon: MessageCircle, tone: "ink", title: "Tell Hogee what you sell", line: "A short chat builds your budget." },
  { icon: PenLine, tone: "seal", title: "Sign your plan", line: "One touch with your passkey." },
  { icon: BadgeCheck, tone: "paid", title: "Your loan officer adds the money", line: "Your pockets fill here." },
];

/**
 * Before a plan (UX round 3 #13): how the wallet opens, 1-2-3 (the Wallet page's words), the step Mei is on marked,
 * instead of four grey placeholders. The tiles of later steps stay quiet until their turn.
 */
function WalletOpening({ at }: { at: 0 | 1 | 2 }) {
  return (
    <GroupedList header="How your wallet opens" data-testid="wallet-opening">
      {OPENING.map((s, i) => (
        <ListRow
          key={s.title}
          selected={i === at}
          leading={<IconTile icon={s.icon} tone={i <= at ? s.tone : "grey"} variant={i === at ? "solid" : "tinted"} />}
          title={
            <>
              <span className="sr-only">Step {i + 1}{i === at ? ", now" : i < at ? ", done" : ""}: </span>
              {s.title}
            </>
          }
          subtitle={s.line}
          trailing={
            <span aria-hidden className="text-footnote font-semibold text-ink-4 tabular-nums">
              {i + 1}
            </span>
          }
        />
      ))}
    </GroupedList>
  );
}

/** Which of the three opening steps Mei is on: telling Hogee, signing (a plan waits), or the officer's turn. */
const openingAt = (step: NextStep | null): 0 | 1 | 2 =>
  step?.stage === "NEEDS_REVIEW" || step?.stage === "FOUNDER_KEY_PENDING" ? 1 : step?.stage === "PLAN_PENDING" || step?.stage === "PLAN_ACTIVE" ? 2 : 0;

/** The one hero figure: Ready to spend (it counts up once, `Stat tick`), then what is left of the plan, or the officer's turn. */
function ReadyToSpend({ freeMinor, leftMinor, totalMinor, funded }: { freeMinor: string; leftMinor: string; totalMinor: string; funded: boolean }) {
  const leftShare = totalMinor !== "0" ? Number((BigInt(leftMinor) * 1000n) / BigInt(totalMinor)) / 10 : 0;
  return (
    <div className="grid gap-3" data-testid="wallet-ready">
      <Stat label="Ready to spend" minor={freeMinor} size="hero" tick leading={<IconTile icon={Wallet} tone="ink" size="sm" />} />
      {funded ? (
        <div className="grid gap-1.5">
          <p className="text-footnote text-pretty text-ink-2">
            <Money minor={leftMinor} className="font-medium text-ink" /> left of your <Money minor={totalMinor} /> plan
          </p>
          <Progress value={leftShare} tone="ink" aria-label={`${Math.round(leftShare)}% of your plan left`} className="h-1" />
        </div>
      ) : (
        <p className="text-footnote text-pretty text-ink-2">Your loan officer is adding the money. It shows here when it lands.</p>
      )}
    </div>
  );
}

/**
 * The inspector beside the thread (UX-PLAN D24, ux2, UX round 3): Ready to spend (the hero), the pockets read the
 * Wallet's way (PocketRow: what is left, of what total, the ring filling as money goes out), the last three things
 * that happened, what she signed (folded), Pause, and the BU note behind a press. The Next step is the bar's alone from
 * 1280 px; the phone's sheet (`inSheet`) carries it, since the sheet covers the thread. Before a plan, the three steps
 * that open the wallet. Live data only; Ready to spend is core walletFigures(balances).freeMinor, the same number the
 * Next step and the Wallet page show.
 */
export function WalletPanel({
  step,
  onRun,
  presses = [],
  inSheet = false,
}: {
  step: NextStep | null;
  onRun: (a: NextStepAction) => void;
  presses?: readonly RecentThing[];
  inSheet?: boolean;
}) {
  const balances = useBalances();
  const plan = useCurrentPlan();
  // The shared CFO report (15 s); after a failed refresh its last supplier cost stays (TanStack keeps `data`).
  const report = useCfoReport();
  const host = useSignHost();
  const sampleBusiness = useSampleBusiness();
  const committed = plan.data?.status === "COMMITTED" ? plan.data : undefined;
  const summary = walletSummary(committed?.manifest.totalMinor, balances.data, report.data?.pnl.supplierCostMinor ?? null);
  const pockets = balances.data?.pockets ?? [];
  // The chain's escrow total belongs to the plan's one escrow-only line (the compiler makes only SUPPLIER escrow-only).
  const escrowLines = committed?.manifest.lines.filter((l) => l.escrowOnly) ?? [];
  const escrowLine = escrowLines.length === 1 ? escrowLines[0]?.lineKey : undefined;
  const seals: SealRow[] = [
    ...(committed?.txHash ? [{ key: "plan", title: "Your plan", txHash: committed.txHash, sample: sampleBusiness }] : []),
    ...(host?.all ?? [])
      .filter((r) => r.req.kind !== "PlanApproval" && r.action.txHash)
      .map((r) => ({ key: `${r.req.kind}:${r.req.refId}`, title: r.req.title, txHash: r.action.txHash as string, sample: false })),
  ];

  if (!committed) {
    return (
      <div className="grid gap-5">
        {balances.error && !balances.data && plan.error?.code !== "NOT_FOUND" ? (
          <p className="px-1 text-footnote text-pretty text-ink-2">Couldn’t load your wallet ({errorCopy(balances.error.code).title}). Trying again…</p>
        ) : null}
        {inSheet ? <NextStepSection step={step} onRun={onRun} /> : null}
        <WalletOpening at={openingAt(step)} />
        <BuDisclosure />
      </div>
    );
  }

  // From 1600 px (bento) the rail is two columns: the money (Ready to spend, the pockets) beside what happened (Recently,
  // what she signed, Pause, the BU note). Below that, and in the phone's sheet, one column in the same order.
  return (
    <div className="grid gap-5 min-[1600px]:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] min-[1600px]:items-start min-[1600px]:gap-5">
      <div className="grid min-w-0 content-start gap-5">
        <section aria-label="Ready to spend" className="grid gap-3 rounded-card bg-raised p-4 shadow-card" data-testid="wallet-summary">
          {summary?.leftMinor && summary.totalMinor ? (
            <>
              <ReadyToSpend freeMinor={summary.freeMinor} leftMinor={summary.leftMinor} totalMinor={summary.totalMinor} funded={balances.data?.fundedMinor !== "0"} />
              <RefreshNote error={balances.data ? balances.error : null} what="balances" />
            </>
          ) : balances.error && !balances.data ? (
            <p className="text-footnote text-pretty text-ink-2">Couldn’t load your wallet ({errorCopy(balances.error.code).title}). Trying again…</p>
          ) : (
            <Stat label="Ready to spend" value="…" leading={<IconTile icon={Wallet} tone="ink" size="sm" />} size="hero" aria-busy />
          )}
        </section>

        {inSheet ? <NextStepSection step={step} onRun={onRun} /> : null}

        {pockets.length > 0 ? (
          <GroupedList
            header={
              <>
                Pockets <span className="tabular-nums">· {pockets.length}</span>
              </>
            }
            footer={
              <>
                They make up your <Money minor={committed.manifest.totalMinor} /> plan. Your wallet pays only from these, up to their limits.
              </>
            }
            data-testid="wallet-pockets"
          >
            {pockets.map((p) => (
              <PocketRow
                key={p.lineKey}
                lineKey={p.lineKey}
                allocatedMinor={p.allocated}
                leftMinor={p.available}
                subtitle={pocketSubtitle(p, p.lineKey === escrowLine && summary ? (summary.escrowHeldMinor ?? null) : null)}
              />
            ))}
          </GroupedList>
        ) : null}

      </div>

      <div className="grid min-w-0 content-start gap-5">
        <Recently presses={presses} />

        <details className="group/signed overflow-hidden rounded-group bg-raised shadow-card" data-testid="wallet-signed">
          <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-4 py-2 text-callout text-ink outline-none select-none hover:bg-fill active:bg-fill-strong focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset [&::-webkit-details-marker]:hidden">
            <IconTile icon={Fingerprint} tone="seal" size="sm" />
            <span className="flex-1">
              What you’ve signed
              {seals.length > 0 ? <span className="text-ink-3 tabular-nums"> · {seals.length}</span> : null}
            </span>
            <ChevronRight aria-hidden className="size-4 text-ink-4 transition-transform duration-(--dur-state) ease-settle group-open/signed:rotate-90 motion-reduce:transition-none" />
          </summary>
          {seals.length > 0 ? (
            <ul className="grid shadow-[inset_0_1px_0_var(--separator)]">
              {seals.map((s) => (
                <li key={s.key} className="flex items-start gap-3 px-4 py-2.5 not-first:shadow-[inset_0_1px_0_var(--separator)]" data-testid="wallet-seal">
                  <span className="grid w-6 shrink-0 place-items-center pt-0.5">
                    <Seal txHash={s.txHash} size={20} />
                  </span>
                  <span className="grid min-w-0 gap-0.5">
                    <span className="flex flex-wrap items-center gap-1.5 text-callout text-ink">
                      {s.title}
                      {s.sample ? <SampleSealTag /> : null}
                    </span>
                    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-footnote text-ink-3">
                      <SealCode txHash={s.txHash} />
                      <TxHash hash={s.txHash} />
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 pb-3 text-footnote text-ink-3">Everything you sign shows here, with its receipt.</p>
          )}
        </details>

        {balances.data ? <PausePayments paused={balances.data.paused} /> : null}

        <BuDisclosure />
      </div>
    </div>
  );
}

/** From 1280 px: the sticky 340 px inspector beside the thread (and the side nav). */
export function WalletRail({ step, act, presses }: RailProps) {
  const onRun = useRunNextStep(act);
  return (
    <aside
      aria-label="Wallet"
      data-testid="wallet-rail"
      className="sticky top-14 hidden max-h-[calc(100dvh-3.5rem)] self-start overflow-y-auto overscroll-contain px-5 pt-6 pb-8 shadow-[inset_1px_0_0_var(--separator)] min-[1280px]:block min-[1600px]:px-6"
    >
      <WalletPanel step={step} onRun={onRun} presses={presses} />
    </aside>
  );
}

/**
 * Under 1280 px: a sticky strip with the Next step (a few words and its verb) and the Wallet button that opens the
 * wallet as a bottom sheet. Without a step (the loan officer) it shows what is left of the plan instead.
 */
export function WalletStrip({ step, act, presses }: RailProps) {
  const [open, setOpen] = useState(false);
  const onRun = useRunNextStep(act);
  const balances = useBalances();
  const plan = useCurrentPlan();
  const committed = plan.data?.status === "COMMITTED" ? plan.data : undefined;
  const summary = walletSummary(committed?.manifest.totalMinor, balances.data);
  return (
    <div
      // The same material as the top bar it sits under (DESIGN.md §5): content scrolls under both, and the scroll edge
      // shows under the strip, not between the two.
      className="material scroll-edge sticky top-14 z-20 -mx-4 flex min-h-14 items-center justify-between gap-2.5 px-4 py-2 text-subhead sm:-mx-6 sm:px-6 min-[1280px]:hidden"
      data-testid="wallet-strip"
      data-chrome="strip"
    >
      {step ? (
        <NextStepStrip step={step} onRun={onRun} />
      ) : (
        <p className="min-w-0 truncate">
          {summary?.leftMinor ? (
            <>
              <Money minor={summary.leftMinor} className="font-medium" /> left
            </>
          ) : (
            "No plan yet"
          )}
        </p>
      )}
      <Button variant="secondary" size={step ? "icon" : "default"} className="shrink-0 rounded-full" aria-label="Wallet" onClick={() => setOpen(true)}>
        <Wallet aria-hidden /> {step ? null : "Wallet"}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="max-h-[85dvh] bg-canvas">
          <SheetHeader className="sr-only">
            <SheetTitle>Wallet</SheetTitle>
            <SheetDescription>What you can spend, your next step, your pockets, what happened lately, and what you’ve signed.</SheetDescription>
          </SheetHeader>
          <WalletPanel
            step={step}
            inSheet
            presses={presses}
            onRun={(a) => {
              setOpen(false);
              // One frame later the sheet has let go of focus (it keeps playing its exit), so a step that focuses
              // something in the thread (the passkey card, a card to read) gets it, not the closing sheet.
              requestAnimationFrame(() => onRun(a));
            }}
          />
        </SheetContent>
      </Sheet>
    </div>
  );
}
