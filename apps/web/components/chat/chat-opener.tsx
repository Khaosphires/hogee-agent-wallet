"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowDownLeft, ArrowUpRight, Bot, ChartNoAxesColumnIncreasing, ChevronRight, Compass, Fingerprint, Landmark, MessageSquareOff, ShieldCheck, WalletCards, type LucideIcon } from "lucide-react";
import { newActionId } from "@/lib/journey-client";
import type { ChatAction } from "@hogee/core";
import { Money } from "@/components/ledger/money";
import { Seal, SealCode } from "@/components/ledger/seal";
import { signerName } from "@/components/sign/seal-time";
import { useSampleSales } from "@/components/cfo/cfo-parts";
import { GroupedList, ListRow } from "@/components/ui/grouped-list";
import { IconTile } from "@/components/ui/icon-tile";
import { Tag } from "@/components/ui/pill";
import { Stat } from "@/components/ui/stat";
import type { Tone } from "@/components/ui/tones";
import { useBalances, useCfoReport, useCurrentPlan } from "@/lib/api/queries";
import { useSession } from "@/lib/api/use-session";
import { walletSummary } from "@/lib/journey-client";
import { repeatsBar, type NextStep } from "@/lib/next-step";
import { cn } from "@/lib/utils";
import { SampleSealTag, useSampleBusiness } from "./sample-seal";

const PROMISES: readonly { Icon: LucideIcon; tone: Tone; text: string }[] = [
  { Icon: WalletCards, tone: "ink", text: "Your wallet only pays what your signed plan allows: who gets paid, what for, and how much." },
  { Icon: Fingerprint, tone: "seal", text: "Every payment either needs your OK with your passkey (like Touch ID), or comes with a public receipt you can check." },
  { Icon: MessageSquareOff, tone: "grey", text: "Hogee never sends messages for you. It writes them, and you send them." },
];

/** "How Hogee keeps your money safe": three static lines, folded (UX-PLAN WP1 P0 5), and the Plan's Safety limit. */
const SAFE = [
  "Your plan sets each pocket and its limit. Your wallet can't pay outside them, even if someone took over the AI.",
  "A new supplier waits through a short safety wait first. You or your loan officer can pause payments during it.",
  "The balance to a supplier waits until the goods arrive, you upload the delivery check, and you sign.",
] as const;

/**
 * Questions the chat already answers from templates, in any stage (core quickIntent: "safety" and "next"), so a
 * chip never reaches the planner and never brings up a signature.
 */
const QUICK: readonly { Icon: LucideIcon; text: string }[] = [
  { Icon: ShieldCheck, text: "Is my money safe?" },
  { Icon: Compass, text: "What do I do now?" },
];

/** Press feedback on pointer-down (DESIGN.md §11): chips scale to --press, and lift a little on hover. */
const CHIP =
  "group/chip inline-flex min-h-11 max-w-full items-center gap-2.5 rounded-2xl bg-raised px-3.5 py-2 text-left text-subhead font-medium text-ink shadow-card outline-none transition-[scale,box-shadow,background-color] duration-(--dur-state) ease-settle select-none hover:shadow-md focus-visible:ring-[3px] focus-visible:ring-ring/50 active:scale-(--press) active:duration-(--dur-press) disabled:pointer-events-none disabled:opacity-50";

/** The three promises as one grouped list, with "How Hogee keeps your money safe" folded as its last row. */
export function PromiseList({ label = "What Hogee promises" }: { label?: string }) {
  return (
    <div className="overflow-hidden rounded-group bg-raised shadow-card">
      <ul className="grid" aria-label={label}>
        {PROMISES.map(({ Icon, tone, text }) => (
          <li key={text} className="flex items-start gap-3 py-3 pl-4 text-footnote leading-[1.35rem] text-pretty text-ink-2">
            <IconTile icon={Icon} tone={tone} />
            <span className="min-w-0 flex-1 pt-1 pr-4 pb-3 -mb-3 shadow-[inset_0_-1px_0_var(--separator)]">{text}</span>
          </li>
        ))}
      </ul>
      <details className="group text-footnote text-ink-2" data-testid="opener-safety">
        <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-4 py-2 text-callout text-ink outline-none select-none hover:bg-fill active:bg-fill-strong focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset [&::-webkit-details-marker]:hidden">
          <IconTile icon={ShieldCheck} tone="paid" />
          <span className="flex-1">How Hogee keeps your money safe</span>
          <ChevronRight aria-hidden className="size-4 text-ink-4 transition-transform duration-(--dur-state) ease-settle group-open:rotate-90 motion-reduce:transition-none" />
        </summary>
        <ul className="grid list-disc gap-1.5 pr-4 pb-2 pl-[74px]">
          {SAFE.map((t) => (
            <li key={t} className="text-pretty">
              {t}
            </li>
          ))}
        </ul>
        <p className="pr-4 pb-3 pl-[58px]">
          <Link
            href="/plan#plan-safety"
            className="inline-flex min-h-10 items-center gap-1 rounded-lg px-2 font-medium text-ink underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            Your safety limit on the Plan <ArrowUpRight aria-hidden className="size-3.5" />
          </Link>
        </p>
      </details>
    </div>
  );
}

/**
 * The suggestions: the demo founder's first message (e2e presses it by its "I want to sell custom insulated tumblers"
 * prefix, so the button's name starts with it) and, with `quick`, the questions the chat answers from templates.
 */
export function Suggestions({ starter, quick, disabled, onStart }: { starter: string; quick: boolean; disabled: boolean; onStart: (text: string) => void }) {
  return (
    <div className="grid gap-2.5" data-testid="chat-suggestions">
      <p className="px-1 text-footnote font-medium text-ink-2">Try saying</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={cn(CHIP, "w-full sm:w-auto")} disabled={disabled} onClick={() => onStart(starter)}>
          <span className="min-w-0 flex-1 text-pretty">{starter}</span>
          <ArrowUpRight aria-hidden className="size-4 shrink-0 text-ink-3 transition-transform duration-(--dur-state) ease-settle group-hover/chip:-translate-y-px group-hover/chip:translate-x-px" />
        </button>
        {quick
          ? QUICK.map(({ Icon, text }) => (
              <button key={text} type="button" className={CHIP} disabled={disabled} onClick={() => onStart(text)}>
                <Icon aria-hidden className="size-4 shrink-0 text-ink-3" />
                {text}
              </button>
            ))
          : null}
      </div>
    </div>
  );
}

/** The greeting both homes lead with: (on a first visit) the brand mark, one large title and one line under it. */
function Greeting({ title, line, mark = true }: { title: string; line: ReactNode; mark?: boolean }) {
  return (
    // A div, not <header>: the page has one banner (the shell's top bar), and tests find it as "header".
    <div className="enter-rise grid justify-items-start gap-3.5 pt-1 sm:pt-3">
      {mark ? (
        <Seal tone="ink" letter="H" className="size-11 rounded-[13px] text-[1.1875rem] font-semibold shadow-[0_8px_20px_-8px_oklch(0.235_0.028_262/0.45)]" />
      ) : null}
      <div className="grid gap-1.5">
        <h2 className="text-large-title text-balance text-ink">{title}</h2>
        <p className="max-w-[36rem] text-body text-pretty text-ink-2">{line}</p>
      </div>
    </div>
  );
}

/**
 * A fresh conversation's welcome (ux2: an illustration-free hero): the brand mark, one large greeting and one sentence;
 * then the passkey set-up when it is still to do (the first thing waiting on Mei, right under the greeting so its
 * buttons sit above the dock at 1280×800), with a line for a founder who has no code yet; the suggestions; and the
 * three promises as one grouped list with the folded "How Hogee keeps your money safe" as its last row.
 */
export function ChatOpener({ starter, disabled, onStart, passkey }: { starter: string | undefined; disabled: boolean; onStart: (text: string) => void; passkey?: ReactNode }) {
  const name = signerName(useSession().data?.persona);
  const founder = name !== null && name !== "the loan officer";
  return (
    <li className="grid gap-6 pb-4" data-testid="chat-opener">
      <Greeting
        title={founder ? `Hi ${name}, I’m Hogee.` : "Hi, I’m Hogee."}
        line="Tell me what you want to sell, where, and your budget, and I’ll help you plan it, find suppliers and keep track of your money."
      />

      {passkey ? (
        <div className="grid gap-2 empty:hidden [&>[data-slot=card]]:bg-raised [&>[data-slot=card]]:before:opacity-100">
          {passkey}
          {/* Only under the card's form (data-state=form): once a passkey is made, or "Later" pressed, the line goes too. */}
          <p className="hidden px-1 text-footnote text-pretty text-ink-3 [[data-state=form]+&]:block" data-testid="passkey-no-code">
            No code yet? Press Later and tell Hogee about your business. You only need the passkey to sign.
          </p>
        </div>
      ) : null}

      {starter ? <Suggestions starter={starter} quick disabled={disabled} onStart={onStart} /> : null}

      <PromiseList />
    </li>
  );
}

/**
 * The thread head's history row (DESIGN.md §6): the plan already signed, folded into one line with its seal, so a
 * conversation still shows what the wallet runs on. A quiet "Sample" when the sample business made it.
 */
export function SignedPlanRow() {
  const plan = useCurrentPlan().data;
  if (plan?.status !== "COMMITTED" || !plan.txHash) return null;
  return (
    <GroupedList aria-label="Your plan">
      <PlanRow />
    </GroupedList>
  );
}

/** The signed plan as one row: its seal, "Your plan is signed", the total, pockets and stamp; it opens the Plan. */
function PlanRow() {
  const plan = useCurrentPlan().data;
  const sample = useSampleBusiness();
  if (plan?.status !== "COMMITTED" || !plan.txHash) return null;
  const lines = plan.manifest.lines.length;
  return (
    <ListRow
      data-testid="chat-signed-plan"
      href="/plan"
      leading={
        <span className="grid size-[30px] place-items-center rounded-[8px] bg-tint-seal">
          <Seal txHash={plan.txHash} size={20} />
        </span>
      }
      title={
        <span className="inline-flex flex-wrap items-center gap-1.5">
          Your plan is signed {sample ? <SampleSealTag /> : null}
        </span>
      }
      subtitle={
        <>
          <Money minor={plan.manifest.totalMinor} /> in {lines} {lines === 1 ? "pocket" : "pockets"} · <SealCode txHash={plan.txHash} />
        </>
      }
    />
  );
}

interface AskChip {
  readonly Icon: LucideIcon;
  readonly text: string;
  /** A chat action instead of typed text (a template answer either way). */
  readonly action?: Omit<Extract<ChatAction, { type: "show_cfo" }>, "actionId">;
}

/** This stage's questions, each answered from templates: how the business is doing (the CFO card), is the money safe, what the AI paid by itself. */
const ASK: readonly AskChip[] = [
  { Icon: ChartNoAxesColumnIncreasing, text: "How are we doing?", action: { type: "show_cfo", view: "overview" } },
  { Icon: ShieldCheck, text: "Is my money safe?" },
  { Icon: Bot, text: "What did the AI pay by itself?" },
];

/** What changed, from the CFO report the rail already reads: sales in, paid out under her plan, kept for tax. */
function BusinessRows() {
  const report = useCfoReport().data;
  const sample = useSampleSales();
  if (!report) return null;
  const rows: { key: string; icon: LucideIcon; tone: Tone; title: ReactNode; subtitle: ReactNode; minor: string; sign: string; href: string }[] = [
    {
      key: "sales",
      icon: ArrowDownLeft,
      tone: "paid",
      title: <span className="inline-flex items-center gap-1.5">Sales {sample ? <Tag>Sample</Tag> : null}</span>,
      subtitle: `${report.sales.count} ${report.sales.count === 1 ? "sale" : "sales"} so far`,
      minor: report.sales.revenueMinor,
      sign: "+",
      href: "/dashboard#wallet-sales",
    },
    {
      key: "paid",
      icon: Bot,
      tone: "agent",
      title: "Paid from your pockets",
      subtitle: "Only what your plan allows",
      minor: report.overview.spentMinor,
      sign: "",
      href: "/dashboard#wallet-spending",
    },
    {
      key: "tax",
      icon: Landmark,
      tone: "grey",
      title: "Kept for tax",
      subtitle: "Set aside from each sale",
      minor: report.reserve.balanceMinor,
      sign: "",
      href: "/dashboard#wallet-tax",
    },
  ];
  return (
    <GroupedList header="Your business" data-testid="welcome-business">
      <PlanRow />
      {rows.map((r) => (
        <ListRow
          key={r.key}
          href={r.href}
          leading={<IconTile icon={r.icon} tone={r.tone} />}
          title={r.title}
          subtitle={r.subtitle}
          value={
            <span className={cn(r.tone === "paid" && "font-medium text-paid")}>
              {r.sign}
              <Money minor={r.minor} />
            </span>
          }
        />
      ))}
    </GroupedList>
  );
}

/**
 * The welcome-back home (UX round 3 #1): the plan is signed and this conversation is empty, so it starts where Mei is,
 * not at "tell me what you sell". The greeting; Ready to spend as the one hero figure under 1280 px (from 1280 the
 * rail beside it already leads with it); the plan's row; what changed (sales, paid out, kept for tax); and this
 * stage's questions, minus any the Next step bar already offers. The promises sit behind the header's "More".
 */
export function WelcomeBack({ step, disabled, onAsk, act }: { step: NextStep | null; disabled: boolean; onAsk: (text: string) => void; act: (a: ChatAction, label: string) => void }) {
  const name = signerName(useSession().data?.persona);
  const founder = name !== null && name !== "the loan officer";
  const plan = useCurrentPlan().data;
  const balances = useBalances().data;
  const committed = plan?.status === "COMMITTED" ? plan : undefined;
  const summary = walletSummary(committed?.manifest.totalMinor, balances);
  const chips = ASK.filter((c) => !(c.action && repeatsBar(step?.action ?? null, c.action)));
  return (
    <li className="grid gap-6 pb-4" data-testid="chat-opener" data-home="welcome-back">
      <Greeting mark={false} title={founder ? `Welcome back, ${name}.` : "Welcome back."} line="Your plan is signed and your wallet is running. Here’s where things stand." />

      {summary ? (
        <div className="rounded-card bg-raised p-4 shadow-card min-[1280px]:hidden">
          <Stat label="Ready to spend" minor={summary.freeMinor} size="hero" tick />
        </div>
      ) : null}

      <BusinessRows />

      <div className="grid gap-2.5" data-testid="chat-suggestions">
        <p className="px-1 text-footnote font-medium text-ink-2">Try asking</p>
        <div className="flex flex-wrap gap-2">
          {chips.map(({ Icon, text, action }) => (
            <button
              key={text}
              type="button"
              className={CHIP}
              disabled={disabled}
              onClick={() => (action ? act({ ...action, actionId: newActionId() } as ChatAction, text) : onAsk(text))}
            >
              <Icon aria-hidden className="size-4 shrink-0 text-ink-3" />
              {text}
            </button>
          ))}
        </div>
      </div>
    </li>
  );
}
