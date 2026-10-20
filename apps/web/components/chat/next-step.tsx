"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ArrowRight, CircleCheck, Eye, Fingerprint, Hourglass, KeyRound, Landmark, MessageCircle, PackageCheck, Search, type LucideIcon } from "lucide-react";
import type { ChatAction } from "@hogee/core";
import { PASSKEY_EVENT, focusPasskeySetup, passkeySetupDismissed, usePasskeyOnDevice } from "@/components/sign/passkey-setup-card";
import { Button } from "@/components/ui/button";
import { IconTile } from "@/components/ui/icon-tile";
import type { Tone } from "@/components/ui/tones";
import { useApiQuery } from "@/lib/api/hooks";
import { useBalances, useCurrentPlan, useOrderTerms, useSupplierSearch } from "@/lib/api/queries";
import { useSession } from "@/lib/api/use-session";
import { newActionId, threadFacts, walletSummary, type JourneyMessage, type WaitingSign } from "@/lib/journey-client";
import { nextStep, stepTarget, type NextStep, type NextStepAction, type ScrollTarget, type StepTarget } from "@/lib/next-step";
import { phaseOf, setGoodsArrived, useGoodsArrived } from "@/lib/order-phase";
import { founderPersonaOf } from "@/lib/persona";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { useSignHost } from "./cards/sign-host";

type Icon = LucideIcon;

function subscribePasskey(onChange: () => void): () => void {
  window.addEventListener(PASSKEY_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(PASSKEY_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
const usePasskeyCardDismissed = (): boolean => useSyncExternalStore(subscribePasskey, passkeySetupDismissed, () => false);

/**
 * The founder's Next step (UX-PLAN §3) from the thread and what the browser already reads (plan, balances, the latest
 * search, the saved order and its escrow; the passkey on this device, "Later", "goods arrived"). Null for the loan
 * officer (the console has its own checklist). The figures are the rail's: Ready to spend is core walletFigures over
 * the same balances (one source).
 */
export function useNextStep(messages: readonly JourneyMessage[], waiting: WaitingSign | null): NextStep | null {
  const { data: session } = useSession();
  const thread = useMemo(() => threadFacts(messages), [messages]);
  const plan = useCurrentPlan();
  const balances = useBalances();
  const search = useSupplierSearch(thread.latestSearchId ?? undefined);
  const terms = useOrderTerms(thread.savedTermsId ?? undefined).data;
  const orderId = terms?.status === "USED" ? (terms.orderId ?? undefined) : undefined;
  const escrow = useApiQuery("getEscrow", orderId ? { params: { orderId } } : undefined, { enabled: Boolean(orderId) });
  const goodsArrived = useGoodsArrived(orderId);
  const passkeyOnDevice = usePasskeyOnDevice();
  const dismissed = usePasskeyCardDismissed();
  const now = useNow();
  const nowMs = now > 0 ? now : null;

  if (!session || !founderPersonaOf(session)) return null;
  const committed = plan.data?.status === "COMMITTED" ? plan.data : undefined;
  const figures = walletSummary(committed?.manifest.totalMinor, balances.data);
  const pending = escrow.data?.find((m) => !m.released && !m.autoRelease);
  // The Goods arrived gate only stands before a payment due on delivery (ux-order: a shipment payment has its own gate).
  const gated = pending !== undefined && terms?.schedule[pending.idx]?.trigger === "ON_DELIVERY_INSPECTED";
  return nextStep({
    thread,
    waiting: waiting ? { kind: waiting.kind, refId: waiting.refId } : null,
    passkeyOnDevice,
    passkeyCardDismissed: dismissed,
    planStatus: plan.data?.status ?? null,
    searchStatus: search.data?.status ?? null,
    order:
      terms && orderId
        ? {
            orderId,
            phase: phaseOf(terms, nowMs),
            coolingEndsAt: terms.coolingEndsAt,
            goodsArrived: goodsArrived || !gated,
            balance: pending ? { amountMinor: pending.amountMinor, evidenceHash: pending.evidenceHash ?? null } : null,
          }
        : null,
    fundedMinor: balances.data?.fundedMinor ?? null,
    readyMinor: figures?.freeMinor ?? null,
    paused: balances.data?.paused === true,
    nowMs,
  });
}

const reducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const SCROLL_TARGETS: { readonly [T in ScrollTarget]: string } = {
  question: "[data-testid=question]",
  candidates: "[data-testid=card-candidates]",
  enquiry: "[data-testid=card-enquiry]",
  terms: "[data-testid=card-terms]",
  // ux-order's drop zone; until it lands, the order card's own file input.
  evidence: "[data-testid=evidence-drop], [data-testid=card-order] input[type=file]",
};

/** Brings the newest matching card into view and puts focus on it (or on the field inside it). */
export function scrollToTarget(target: ScrollTarget): void {
  const all = document.querySelectorAll<HTMLElement>(SCROLL_TARGETS[target]);
  const el = all[all.length - 1];
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
  if (!el.matches("input, button, textarea, select, [tabindex]")) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
}

/**
 * Runs the bar's one button. A signature opens the same SignHost dialog the cards open (never by itself: only this
 * press); a chat action goes through the thread's `act`, with a fresh single-use id, exactly like a card's button.
 */
export function useRunNextStep(act: (a: ChatAction, label: string) => void): (a: NextStepAction) => void {
  const host = useSignHost();
  return useCallback(
    (a: NextStepAction) => {
      switch (a.kind) {
        case "focus-passkey":
          focusPasskeySetup();
          return;
        case "scroll":
          scrollToTarget(a.target);
          return;
        case "sign":
          host?.open(a.request);
          return;
        case "send":
          act({ ...a.action, actionId: newActionId() } as ChatAction, a.label);
          return;
        case "goods-arrived":
          setGoodsArrived(a.orderId);
          requestAnimationFrame(() => scrollToTarget("evidence"));
          return;
      }
    },
    [act, host],
  );
}

/** The banner's icon tile (ux2): what kind of step this is, in a colour that means something. */
function tileOf(step: NextStep): { icon: Icon; tone: Tone; label?: string } {
  if (step.who === "officer") return { icon: Landmark, tone: "grey", label: "Waiting for your loan officer" };
  if (step.who === "hogee") return { icon: Hourglass, tone: "agent", label: "Waiting for Hogee" };
  if (step.key === "done") return { icon: CircleCheck, tone: "paid" };
  switch (step.action?.kind) {
    case "focus-passkey":
      return { icon: KeyRound, tone: "waiting" };
    case "sign":
      return { icon: Fingerprint, tone: "waiting" };
    case "goods-arrived":
      return { icon: PackageCheck, tone: "slot-1" };
    case "scroll":
      return { icon: Eye, tone: "ink" };
    case "send":
      return { icon: step.action.action.type === "start_search" ? Search : ArrowRight, tone: "ink" };
    default:
      return { icon: MessageCircle, tone: "ink" };
  }
}

/** The step's tile; a step that isn't Mei's names who we wait for (for screen readers). */
function StepTile({ step, size = "md" }: { step: NextStep; size?: "sm" | "md" }) {
  const t = tileOf(step);
  return <IconTile icon={t.icon} tone={t.tone} size={size} label={t.label} />;
}

/** The element a step's button acts on (the card's own button or block), newest first in the thread. */
function targetSelector(t: StepTarget): string {
  const id = (v: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : v);
  switch (t.kind) {
    case "scroll":
      return SCROLL_TARGETS[t.target];
    case "passkey":
      return "[data-testid=passkey-setup]";
    case "sign":
      return t.signKind === "PlanApproval"
        ? `[data-testid=card-needs][data-draft-id="${id(t.refId)}"] [data-testid=sign-open], [data-testid=card-sign][data-ref-id="${id(t.refId)}"] [data-testid=sign-open]`
        : `[data-testid=card-sign][data-ref-id="${id(t.refId)}"] [data-testid=sign-open], [data-testid=card-terms] [data-testid=terms-submit]`;
    case "order":
      return `[data-testid=card-order][data-order-id="${id(t.orderId)}"] [data-testid=balance-block]`;
  }
}

const REQUERY_MS = 800;
/** The top bar (56 px) and the dock below: what is under them is not on screen. */
const TOP_CHROME_PX = 56;

/**
 * True while the card the step's button acts on is on screen (UX round 3): the newest matching element, re-found as
 * cards load, watched by an IntersectionObserver whose box leaves out the top bar and the chat dock (no scroll
 * handler). "On screen" means half of it, or for a tall card, a good part of the screen.
 */
function useTargetOnScreen(target: StepTarget | null): boolean {
  const selector = target ? targetSelector(target) : null;
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    setOnScreen(false);
    if (!selector || typeof IntersectionObserver === "undefined") return;
    let watched: Element | null = null;
    let io: IntersectionObserver | null = null;
    const watch = () => {
      const all = document.querySelectorAll(selector);
      const el = all[all.length - 1] ?? null;
      if (el === watched) return;
      io?.disconnect();
      watched = el;
      if (!el) {
        setOnScreen(false);
        return;
      }
      const dock = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--chat-dock-h")) || 0;
      io = new IntersectionObserver(
        ([e]) => {
          if (!e) return;
          const room = e.rootBounds?.height ?? window.innerHeight;
          setOnScreen(e.isIntersecting && (e.intersectionRatio >= 0.5 || e.intersectionRect.height >= room * 0.4));
        },
        { rootMargin: `-${TOP_CHROME_PX}px 0px -${Math.round(dock)}px 0px`, threshold: [0, 0.25, 0.5, 0.75, 1] },
      );
      io.observe(el);
    };
    watch();
    const timer = window.setInterval(watch, REQUERY_MS);
    return () => {
      window.clearInterval(timer);
      io?.disconnect();
    };
  }, [selector]);
  return onScreen;
}

/**
 * The step's one button. While the card it acts on is on screen, the card's own button is the one to press: the bar's
 * goes tinted, or hides when all it would do is scroll to that card (UX round 3: one filled button per action).
 */
function StepButton({ step, onRun, follow = true, className }: { step: NextStep; onRun: (a: NextStepAction) => void; follow?: boolean; className?: string }) {
  const a = step.action;
  // In the phone's wallet sheet the thread is covered, so the sheet's button stays filled (follow={false}).
  const onScreen = useTargetOnScreen(follow ? stepTarget(a) : null);
  if (!a) return null;
  if (onScreen && a.kind === "scroll") return null;
  const quiet = (a.kind === "send" && a.secondary === true) || onScreen;
  return (
    <Button
      variant={quiet ? "tinted" : "default"}
      className={cn("h-10 shrink-0 rounded-full px-4", className)}
      data-testid="next-step-action"
      data-quiet={quiet || undefined}
      onClick={() => onRun(a)}
    >
      {a.label}
    </Button>
  );
}

/**
 * The Next step bar, the top half of the chat dock from 1280 px (UX-PLAN §3; UX round 3: one material surface with
 * the composer, a hairline between): the step's icon tile, one line, at most one button. A new step's tile and line
 * rise where the old ones were; the composer below never moves (the dock is anchored at the bottom, so a taller bar
 * grows upward). It is the polite live region for step changes (the region itself stays put, so it still announces).
 */
export function NextStepBar({ step, act }: { step: NextStep | null; act: (a: ChatAction, label: string) => void }) {
  // The runner reads the SignHost, so it must live below it (the thread renders the host around the layout).
  const onRun = useRunNextStep(act);
  if (!step) return null;
  return (
    <div
      data-testid="next-step"
      data-step={step.key}
      data-stage={step.stage}
      className="hidden min-h-14 items-center gap-3 py-2 pr-2 pl-3 shadow-[inset_0_-1px_0_var(--separator)] min-[1280px]:flex"
    >
      <span key={step.key} className="enter-rise flex">
        <StepTile step={step} />
      </span>
      <p className="min-w-0 flex-1 text-callout text-pretty" aria-live="polite">
        <span className="sr-only">Next step: </span>
        <span key={step.key} className="enter-rise inline-block">
          {step.text}
        </span>
      </p>
      <StepButton step={step} onRun={onRun} />
    </div>
  );
}

/**
 * The phone wallet sheet's next-step card: the same step as its tile, line and button (the sheet covers the thread, so
 * nothing else on screen says it). From 1280 px the bar says it, and the rail doesn't repeat it.
 */
export function NextStepSection({ step, onRun }: { step: NextStep | null; onRun: (a: NextStepAction) => void }) {
  if (!step) return null;
  return (
    <section aria-label="Next step" className="grid gap-3 rounded-group bg-raised p-3.5 shadow-card" data-testid="wallet-next-step" data-step={step.key}>
      <div className="flex items-start gap-3">
        <StepTile step={step} size="sm" />
        <div className="grid min-w-0 gap-0.5">
          <h3 className="text-footnote font-medium text-ink-2">Next step</h3>
          <p className="text-subhead text-pretty text-ink">{step.text}</p>
        </div>
      </div>
      <StepButton step={step} onRun={onRun} follow={false} className="w-full" />
    </section>
  );
}

/**
 * Under 1280 px: the step in the sticky strip as a few words (STRIP_TEXT; the full sentence is its title and what a
 * screen reader hears) and the button's verb, so it never truncates on a phone (UX round 3).
 */
export function NextStepStrip({ step, onRun }: { step: NextStep | null; onRun: (a: NextStepAction) => void }) {
  if (!step) return null;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5" data-testid="next-step-strip" data-step={step.key} data-stage={step.stage}>
      <span key={step.key} className="enter-rise flex">
        <StepTile step={step} size="sm" />
      </span>
      <p className="min-w-0 flex-1 truncate text-footnote font-medium text-ink" title={step.text} aria-live="polite">
        <span className="sr-only">Next step: {step.text}</span>
        <span key={step.key} aria-hidden className="enter-fade">
          {step.short}
        </span>
      </p>
      <StepButton step={step} onRun={onRun} className="h-9 px-3.5" />
    </div>
  );
}
