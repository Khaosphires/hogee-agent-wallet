"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { ArrowUp, CircleCheck, RotateCcw, Square } from "lucide-react";
import { CHAT_DATA_PART_SCHEMAS, type ChatAction } from "@hogee/core";
import { PasskeySetupCard } from "@/components/sign/passkey-setup-card";
import { Seal } from "@/components/ledger/seal";
import { zoneCurrency } from "@/components/sign/seal-time";
import { Button } from "@/components/ui/button";
import { apiUrl } from "@/lib/api/client";
import { useCurrentPlan, useDisplayCurrency } from "@/lib/api/queries";
import { useSession } from "@/lib/api/use-session";
import {
  actionEventText,
  actionLabel,
  actionMessageParts,
  actionOf,
  announcementFor,
  cardKey,
  chatRequestBody,
  chosenActionIds,
  newActionId,
  optionLabels,
  partAnchor,
  partViews,
  signedKeys,
  threadFacts,
  userBubbleText,
  waitingSign,
  type PartView,
} from "@/lib/journey-client";
import { chatFailure } from "@/lib/live-errors";
import { founderPersonaOf, type FounderPersona } from "@/lib/persona";
import { storeShortlistId } from "@/lib/supplier-copy";
import { cn } from "@/lib/utils";
import { SignHost, type SignOpenRequest } from "./cards/sign-host";
import { ChatOpener, SignedPlanRow, Suggestions, WelcomeBack } from "./chat-opener";
import { ChatLayout } from "./chat-layout";
import { HogeeAvatar } from "./hogee-avatar";
import { messageTimes, stretchLabel, timeBreaks, zoneOfCurrency } from "./chat-time";
import { JourneyThreadProvider, MessageScope } from "./journey-context";
import { MessagePart, type HogeeUIMessage } from "./message-parts";
import { NextStepBar, useNextStep } from "./next-step";
import { pressesOf } from "./recent";
import { WalletRail, WalletStrip } from "./wallet-rail";

// Each demo founder's suggested first message, in her own currency. e2e matches the shared prefix.
const STARTER: Record<FounderPersona, string> = {
  "founder:mei": "I want to sell custom insulated tumblers on Shopee Singapore, budget S$10,000",
  "founder:rina": "I want to sell custom insulated tumblers on Shopee, Selangor, budget RM10,000",
};

/** How long an opened history stays pinned to its end while its cards load (any input by the founder ends it sooner). */
const PIN_MS = 4_000;
const reducedMotion = (): boolean => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const needsDraftIdsOf = (m: HogeeUIMessage): Set<string> => new Set(m.parts.flatMap((p) => (p.type === "data-needs" ? [p.data.draftId] : [])));
const FULL: PartView = { mode: "full" };
/** Room a card scrolled into view keeps clear of the dock: the 16 px under it, its 24 px fade, and 8 px of air. */
const DOCK_GAP_PX = 48;
/** A reply's top lands under the top bar and the strip (scroll-mt-24). */
const REPLY_TOP_PX = 96;
/** The button a card waits on: the one that must not end up under the dock (UX round 3, first-timer #2). */
const MAIN_BUTTON = "[data-testid=sign-open], [data-testid=terms-submit], [data-testid=pick-submit], [data-testid=goods-arrived], [data-testid=passkey-setup] button";

/**
 * Where to scroll when a reply lands: its top under the bars, unless that leaves its card's main button under the
 * dock; then just far enough that the button sits above the dock (the reply's top may go under the bars).
 */
function replyScrollTop(el: HTMLElement): number {
  const top = el.getBoundingClientRect().top + window.scrollY - REPLY_TOP_PX;
  const buttons = el.querySelectorAll<HTMLElement>(MAIN_BUTTON);
  const main = buttons[buttons.length - 1];
  if (!main) return top;
  const dock = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--chat-dock-h")) || 0;
  const room = window.innerHeight - dock - DOCK_GAP_PX;
  const bottom = main.getBoundingClientRect().bottom + window.scrollY;
  return bottom - top > room ? bottom - room : top;
}

/** An older copy of a card that shows again further down (UX-PLAN D7): one quiet line that jumps to the shown copy. */
function MovedLine({ view }: { view: Extract<PartView, { mode: "moved" }> }) {
  return (
    <a
      href={`#${view.to}`}
      data-testid="card-moved"
      className="inline-flex min-h-10 w-fit items-center rounded-lg text-meta text-ink-3 underline-offset-4 outline-none hover:text-ink-2 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
      onClick={(e) => {
        const el = document.getElementById(view.to);
        if (!el) return;
        e.preventDefault();
        el.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
      }}
    >
      {view.below ? "Updated below ↓" : "Shown above ↑"}
    </a>
  );
}

/**
 * A button press, as what Mei did (UX-PLAN D4): a quiet past-tense chip on her side, never a bubble she didn't type.
 * A signature carries the small chop (cinnabar means Mei signed); any other press a tick.
 */
function ActionEvent({ id, text, signed, className }: { id: string; text: string; signed: boolean; className?: string }) {
  return (
    <li id={`msg-${id}`} tabIndex={-1} className={cn("flex scroll-mt-24 justify-end outline-none", className)} data-role="user" data-testid="action-event">
      <span
        className={cn(
          "inline-flex min-h-7 max-w-[84%] items-center gap-1.5 rounded-full px-3 py-1 text-meta font-medium text-pretty",
          signed ? "bg-seal-wash text-seal-ink" : "bg-ink/[0.055] text-ink-2",
        )}
      >
        {signed ? <Seal size={14} /> : <CircleCheck aria-hidden className="size-3.5 shrink-0" />}
        {text}
      </span>
    </li>
  );
}

/** A quiet centred time where a stretch of the conversation starts (chat-time timeBreaks; only real times). */
function TimeBreak({ at, now, timeZone, className }: { at: number; now: number; timeZone: string; className?: string }) {
  return (
    <li className={cn("flex justify-center", className)} data-testid="chat-time">
      <time dateTime={new Date(at).toISOString()} className="text-meta font-medium text-ink-3 tabular-nums">
        {stretchLabel(at, now, timeZone)}
      </time>
    </li>
  );
}

/** Three soft dots while Hogee writes (one loop, opacity only; still under reduced motion). */
function WritingDots() {
  return (
    <span aria-hidden className="inline-flex items-center gap-1">
      {[0, 1, 2].map((d) => (
        <span key={d} className="size-1.5 rounded-full bg-ink-3 motion-safe:animate-pulse" style={{ animationDelay: `${d * 150}ms` }} />
      ))}
    </span>
  );
}

/** Mei's typed words: a tinted bubble on her side (DESIGN.md §6, ux2), the tail corner toward her. */
const BUBBLE =
  "max-w-[84%] rounded-[20px_20px_6px_20px] bg-[oklch(0.925_0.032_262)] px-4 py-2.5 text-chat whitespace-pre-wrap text-pretty text-ink shadow-[inset_0_0_0_0.5px_oklch(0.235_0.028_262/0.08)]";

/** The gap above an item: tight inside one exchange (her turn, then Hogee's reply), wide between exchanges. */
type Side = "hogee" | "mei" | "time" | "intro";
function gapAbove(prev: Side | null, next: Side): string {
  if (prev === null) return "";
  if (next === "time") return "mt-7";
  if (prev === "time") return "mt-3";
  if (next === "mei") return prev === "mei" ? "mt-2" : "mt-8";
  if (next === "hogee") return prev === "mei" ? "mt-4" : "mt-7";
  return "mt-5";
}

/**
 * The one chat that runs the business. Typed text goes to the server as `{sessionId, message}`; a card's button
 * appends a user message (its label plus a data-action part) and goes as `{sessionId, action}` (no free text).
 * "Try again" re-sends the last message as it was, so a retried button re-sends the same action, never its label.
 * One SignHost above the messages owns the SignDialog, so replies and regenerate() never unmount a signature.
 */
export function ChatThread({ sessionId, initial, head }: { sessionId: string; initial: HogeeUIMessage[]; head?: ReactNode }) {
  const [draft, setDraft] = useState("");
  /** When each message typed on this page was sent, in order (for the thread's quiet times). */
  const [typedAts, setTypedAts] = useState<readonly number[]>([]);
  const [actError, setActError] = useState<string>();
  const input = useRef<HTMLTextAreaElement>(null);
  const { data: session } = useSession();
  const founder = session ? founderPersonaOf(session) : undefined;
  const starter = founder ? STARTER[founder] : undefined;

  const transport = useMemo(
    () =>
      new DefaultChatTransport<HogeeUIMessage>({
        api: apiUrl("chat"),
        credentials: "same-origin",
        prepareSendMessagesRequest: ({ messages }) => ({ body: chatRequestBody(sessionId, messages.at(-1)) }),
      }),
    [sessionId],
  );
  const { messages, sendMessage, regenerate, stop, status, error } = useChat<HogeeUIMessage>({
    id: sessionId,
    messages: initial,
    transport,
    dataPartSchemas: CHAT_DATA_PART_SCHEMAS,
    onData: (part) => {
      if (part.type === "data-shortlist") storeShortlistId(part.data.requestId);
    },
  });
  const busy = status === "submitted" || status === "streaming";
  // Only a 5xx answer, or none, means the assistant is down (Try again); a 4xx refuses this turn (P1 review of #10).
  const failure = error ? chatFailure(error) : undefined;

  // ---- sending -------------------------------------------------------------------------------------------------
  const sendAction = useCallback(
    (action: ChatAction, label: string) => {
      try {
        const parts = actionMessageParts(action, label);
        setActError(undefined);
        void sendMessage({ parts });
      } catch (e) {
        setActError(e instanceof Error ? e.message : String(e));
      }
    },
    [sendMessage],
  );
  // A press while a reply is still streaming (e.g. a signature lands) waits for it, then goes in order.
  const busyRef = useRef(busy);
  const queued = useRef<[ChatAction, string][]>([]);
  useEffect(() => {
    busyRef.current = busy;
    if (busy) return;
    const next = queued.current.shift();
    if (next) sendAction(...next);
  }, [busy, sendAction]);
  // When each press happened on this page (by action id): a Next button's id was minted with the reply, not the press.
  const [pressedAt, setPressedAt] = useState<ReadonlyMap<string, number>>(() => new Map());
  const act = useCallback(
    (action: ChatAction, label: string) => {
      setPressedAt((prev) => new Map(prev).set(action.actionId, Date.now()));
      if (busyRef.current) queued.current.push([action, label]);
      else sendAction(action, label);
    },
    [sendAction],
  );
  // After a signature, once its dialog has closed, bring the newest message into view (first-timer S16).
  const scrollAfterDialog = useRef(false);
  const onSigned = useCallback(
    (req: SignOpenRequest) => {
      const action: ChatAction = { type: "signed", actionId: newActionId(), kind: req.kind, refId: req.refId };
      scrollAfterDialog.current = true;
      act(action, actionLabel(action));
    },
    [act],
  );

  function sendText(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    void sendMessage({ text: message });
    setTypedAts((at) => [...at, Date.now()]);
    setDraft("");
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    sendText(draft);
  }

  // ---- what the cards may know -----------------------------------------------------------------------------------
  const waiting = useMemo(() => waitingSign(messages), [messages]);
  const facts = useMemo(() => threadFacts(messages), [messages]);
  const step = useNextStep(messages, waiting);
  const thread = useMemo(
    () => ({
      chosenActionIds: chosenActionIds(messages),
      signedKeys: signedKeys(messages),
      waitingKey: waiting?.key ?? null,
      latestSearchId: facts.latestSearchId,
      pickedSupplierIds: facts.pickedSupplierIds,
      barAction: step?.action ?? null,
    }),
    [messages, waiting, facts, step?.action],
  );
  const views = useMemo(() => partViews(messages), [messages]);
  const labels = optionLabels(messages);
  // The passkey card sits at the head of the thread until a plan is signed (it hides itself once a passkey is here).
  const plan = useCurrentPlan();
  const planStatus = plan.data?.status;
  // Until the plan query first answers (a plan, or "none yet"), the empty thread shows neither home. Latched: a refetch
  // (its error cleared while it retries) must never unmount the opener and the passkey form being filled in it.
  const [planKnown, setPlanKnown] = useState(false);
  if (!planKnown && (plan.data !== undefined || plan.error != null)) setPlanKnown(true);
  const beforePlan = planStatus !== "COMMITTED" && planStatus !== "SUBMITTED";
  // "Try saying" stays until the intake starts (UX round 3, first-timer #3): a quick question first keeps all three.
  const intakeBegun = useMemo(() => messages.some((m) => m.parts.some((p) => p.type === "data-question")), [messages]);

  // ---- a reply landed: announce it, and move focus to it unless the founder is typing ------------------------------
  // The history loaded with the page is never announced; a reply is, once it has finished streaming.
  const [loadedLastId] = useState(() => initial.at(-1)?.id);
  // The history loaded with the page never animates; a message (and each card in it) that arrives live rises into
  // place on the default spring (apple-design: globals.css enter-rise, a cross-fade under reduced motion).
  const [historyIds] = useState(() => new Set(initial.map((m) => m.id)));
  const enter = (id: string): string | undefined => (historyIds.has(id) ? undefined : "enter-rise");
  // When each message typed on this page was sent (chat-time: history gets a time only from evidence, never a made-up
  // one; a press carries its own time in its UUIDv7 id, and a reply inherits the time of what it answers).
  const seen = useMemo(() => {
    const map = new Map<string, number>();
    let k = 0;
    for (const m of messages) {
      if (historyIds.has(m.id) || m.role !== "user" || actionOf(m)) continue;
      const at = typedAts[k];
      k += 1;
      if (at !== undefined) map.set(m.id, at);
    }
    return map;
  }, [messages, historyIds, typedAts]);
  const [openedAt] = useState(() => Date.now());
  const timeZone = zoneOfCurrency(zoneCurrency(useDisplayCurrency(), session?.persona));
  const times = useMemo(() => messageTimes(messages, seen, pressedAt), [messages, seen, pressedAt]);
  const breaks = useMemo(() => timeBreaks(messages, times, timeZone), [messages, times, timeZone]);
  const presses = useMemo(() => pressesOf(messages, pressedAt), [messages, pressedAt]);
  const lastMessage = messages.at(-1);
  const announcement = status === "ready" && lastMessage?.role === "assistant" && lastMessage.id !== loadedLastId ? announcementFor(lastMessage) : "";
  const prevStatus = useRef(status);
  useEffect(() => {
    const was = prevStatus.current;
    prevStatus.current = status;
    if (status !== "ready" || (was !== "streaming" && was !== "submitted")) return;
    const last = messages.at(-1);
    if (last?.role !== "assistant") return;
    const el = document.getElementById(`msg-${last.id}`);
    // Never pull focus out of the composer or out of an open dialog (the SignDialog stays open across its reply).
    const active = document.activeElement;
    if (!el || active === input.current || active?.closest('[role="dialog"]')) return;
    el.focus({ preventScroll: true });
    window.scrollTo({ top: replyScrollTop(el), behavior: reducedMotion() ? "auto" : "smooth" });
  }, [status, messages]);

  // A new message (the founder's own, or the start of a reply) comes into view. The history the page opened with is
  // handled by the pin below, not here.
  const count = messages.length;
  const openedCount = useRef(initial.length);
  useEffect(() => {
    if (count === 0 || count === openedCount.current) return;
    openedCount.current = -1;
    document.getElementById("chat-end")?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
  }, [count]);

  // Opening a conversation with history lands on its end and stays there while the cards above it load their own
  // records and grow (ux2-demo-data: one early scroll left the page on the first order card). Any wheel, touch, key or
  // press by the founder lets go at once, and the pin ends by itself after a few seconds.
  const threadBox = useRef<HTMLElement>(null);
  useEffect(() => {
    const end = document.getElementById("chat-end");
    const box = threadBox.current;
    if (initial.length === 0 || !end || !box) return;
    const pin = () => end.scrollIntoView({ block: "nearest", behavior: "auto" });
    const resized = new ResizeObserver(pin);
    const inputs = ["wheel", "touchmove", "keydown", "pointerdown"] as const;
    const release = () => {
      resized.disconnect();
      for (const e of inputs) window.removeEventListener(e, release);
    };
    pin();
    resized.observe(box);
    for (const e of inputs) window.addEventListener(e, release, { passive: true });
    const timer = window.setTimeout(release, PIN_MS);
    return () => {
      window.clearTimeout(timer);
      release();
    };
  }, [initial.length]);

  // The dock's height (bar + composer) pads the page's scroll box, so a card scrolled into view lands above it, and
  // the bar knows what of the thread is under it (--chat-dock-h; UX round 3 #11). A ResizeObserver, no scroll handler.
  const dock = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = dock.current;
    if (!el) return;
    const root = document.documentElement;
    const set = () => {
      const h = Math.ceil(el.getBoundingClientRect().height);
      root.style.setProperty("--chat-dock-h", `${h}px`);
      root.style.scrollPaddingBottom = `${h + DOCK_GAP_PX}px`;
    };
    const ro = new ResizeObserver(set);
    ro.observe(el);
    set();
    return () => {
      ro.disconnect();
      root.style.removeProperty("--chat-dock-h");
      root.style.scrollPaddingBottom = "";
    };
  }, []);

  // The composer's scroll edge: the thread is under it while the end of the column is below the screen.
  const bottom = useRef<HTMLDivElement>(null);
  const [threadUnder, setThreadUnder] = useState(false);
  useEffect(() => {
    const el = bottom.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setThreadUnder(entry ? !entry.isIntersecting : false), { rootMargin: "0px 0px 8px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // A signature's dialog closed: once no dialog is left on the page, scroll to the newest message.
  useEffect(() => {
    if (!scrollAfterDialog.current) return;
    let frame = 0;
    const started = performance.now();
    const tick = () => {
      if (document.querySelector('[data-slot="dialog-content"]') && performance.now() - started < 120_000) {
        frame = requestAnimationFrame(tick);
        return;
      }
      scrollAfterDialog.current = false;
      document.getElementById("chat-end")?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [count]);

  /** The thread, with the stretch times and the exchange spacing (gapAbove) worked out as it goes. */
  function renderMessages(): ReactNode[] {
    const out: ReactNode[] = [];
    let prev: Side | null = null;
    const push = (side: Side, node: (gap: string) => ReactNode) => {
      out.push(node(gapAbove(prev, side)));
      prev = side;
    };
    messages.forEach((m, i) => {
      const at = times.get(m.id);
      if (at !== undefined && breaks.has(m.id)) push("time", (gap) => <TimeBreak key={`t-${m.id}`} at={at} now={openedAt} timeZone={timeZone} className={gap} />);
      const answered = messages.slice(i + 1).some((later) => later.role === "user");
      if (m.role === "user") {
        const action = actionOf(m);
        if (action) {
          const text = actionEventText(action);
          if (text) push("mei", (gap) => <ActionEvent key={m.id} id={m.id} text={text} signed={action.type === "signed"} className={cn(gap, enter(m.id))} />);
          return;
        }
        push("mei", (gap) => (
          <li key={m.id} id={`msg-${m.id}`} tabIndex={-1} className={cn("flex scroll-mt-24 justify-end outline-none", gap, enter(m.id))} data-role="user" data-testid="chat-message">
            <p className={BUBBLE}>{userBubbleText(m, labels)}</p>
          </li>
        ));
        return;
      }
      const writing = busy && i === messages.length - 1;
      push("hogee", (gap) => (
        <li
          key={m.id}
          id={`msg-${m.id}`}
          tabIndex={-1}
          aria-labelledby={`msg-${m.id}-from`}
          className={cn(
            // The avatar sits in a 28 px gutter from 640 px; on a phone the content takes the full width under the byline.
            "grid min-w-0 scroll-mt-24 grid-cols-[28px_minmax(0,1fr)] gap-x-3 gap-y-2.5 rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:ring-offset-4 focus-visible:ring-offset-background",
            gap,
            enter(m.id),
          )}
          data-role={m.role}
          data-testid="chat-message"
        >
          <HogeeAvatar />
          <p className="flex min-h-7 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui">
            <span id={`msg-${m.id}-from`} className="font-semibold tracking-[-0.01em] text-ink">
              {m.parts.some((p) => p.type === "data-cfo") ? "Hogee · your wallet" : "Hogee"}
            </span>
            {/* AI-drafted is said once on screen (the header) and once per reply for screen readers (UX round 3 #14). */}
            <span className="sr-only">, AI-drafted</span>
            {writing ? (
              <span className="inline-flex items-center gap-1.5 text-meta text-ink-3">
                <WritingDots />
                <span className="sr-only">Hogee is writing…</span>
              </span>
            ) : null}
          </p>
          <div className="col-span-2 grid min-w-0 gap-3 sm:col-span-1 sm:col-start-2">
            <MessageScope needsDraftIds={needsDraftIdsOf(m)}>
              {m.parts.map((p, j) => {
                const view = views.get(`${i}:${j}`) ?? FULL;
                if (view.mode === "hidden") return null;
                if (view.mode === "moved") return <MovedLine key={j} view={view} />;
                const part = <MessagePart part={p} answered={answered} onAnswer={sendText} act={act} />;
                return cardKey(p) ? (
                  // A card that streams into a live reply arrives on its own spring, after the byline.
                  <div key={j} id={partAnchor(i, j)} className={cn("grid min-w-0 scroll-mt-28 has-[>[data-covered]]:hidden", enter(m.id))}>
                    {part}
                  </div>
                ) : (
                  <Fragment key={j}>{part}</Fragment>
                );
              })}
            </MessageScope>
          </div>
        </li>
      ));
    });
    return out;
  }

  return (
    <SignHost onSigned={onSigned}>
      <JourneyThreadProvider value={thread}>
        <ChatLayout
          head={
            <>
              {head}
              {messages.length > 0 ? <SignedPlanRow /> : null}
            </>
          }
          rail={<WalletRail step={step} act={act} presses={presses} />} strip={<WalletStrip step={step} act={act} presses={presses} />}>
          <section ref={threadBox} aria-labelledby="conversation-title" className="min-w-0">
            <h2 id="conversation-title" className="sr-only">
              Conversation
            </h2>
            <ol className="grid">
              {messages.length === 0 ? (
                !planKnown ? null : planStatus === "COMMITTED" ? (
                  // Welcome back (UX round 3 #1): the plan is signed, so the home starts where Mei is.
                  <WelcomeBack step={step} disabled={busy} onAsk={sendText} act={act} />
                ) : (
                  // The welcome: the passkey set-up sits inside the opener's hero (it hides itself once a passkey is here).
                  <ChatOpener starter={starter} disabled={busy} onStart={sendText} passkey={beforePlan ? <PasskeySetupCard /> : null} />
                )
              ) : beforePlan ? (
                <li className="mb-8 empty:hidden">
                  <PasskeySetupCard />
                </li>
              ) : null}
              {renderMessages()}
              {/* A quick question first (say "is my money safe?") keeps the three suggestions, until the intake begins. */}
              {starter && messages.length > 0 && beforePlan && !intakeBegun && !facts.latestDraftId && !busy ? (
                <li className="mt-8">
                  <Suggestions starter={starter} quick disabled={busy} onStart={sendText} />
                </li>
              ) : null}
              {busy && lastMessage?.role !== "assistant" ? (
                <li className={cn("enter-fade grid grid-cols-[28px_minmax(0,1fr)] items-center gap-x-3", messages.length > 0 && "mt-4")} role="status">
                  <HogeeAvatar />
                  <span className="inline-flex h-9 w-fit items-center gap-2.5 rounded-full bg-card px-3.5 text-meta text-ink-3 shadow-card">
                    <WritingDots />
                    Hogee is writing…
                  </span>
                </li>
              ) : null}
            </ol>
            <div id="chat-end" className="scroll-mb-40" />
          </section>

          {failure?.unavailable ? (
            <div className="grid gap-2 rounded-xl bg-card p-4 text-ui shadow-card" role="alert" data-testid="chat-unavailable">
              <p className="font-medium text-blocked">{failure.title}</p>
              <p className="text-muted-foreground">{failure.message}</p>
              <p className="text-muted-foreground">The other pages still work. You can try again in a moment.</p>
              <div>
                <Button variant="outline" className="h-10" disabled={busy} onClick={() => void regenerate()}>
                  <RotateCcw /> Try again
                </Button>
              </div>
            </div>
          ) : failure ? (
            <div className="grid gap-1 rounded-xl bg-card p-4 text-ui shadow-card" role="alert" data-testid="chat-error">
              <p className="font-medium text-blocked">{failure.title}</p>
              <p className="text-muted-foreground">{failure.message}</p>
            </div>
          ) : null}
          {actError ? (
            <p className="rounded-xl bg-card p-4 text-ui text-blocked shadow-card" role="alert" data-testid="chat-action-error">
              {actError}
            </p>
          ) : null}

          {/*
            The dock (UX round 3 #11): the Next step bar (from 1280 px) and the composer on one material surface, a
            hairline between, floating over the thread (DESIGN.md §5–6, apple-design). Docked at the bottom from the
            first message (mt-auto); the composer grows to 6 lines, and Send becomes Stop while streaming. While there is
            thread under it, the canvas fills around the dock and fades out over 24 px above it, so no text shows through.
          */}
          <div
            data-under={threadUnder || undefined}
            className="sticky bottom-0 z-10 -mx-2 mt-auto px-2 pt-6 pb-4 before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:bg-[linear-gradient(to_top,var(--color-background)_calc(100%-1.5rem),transparent)] before:opacity-0 before:transition-opacity before:duration-(--dur-state) before:ease-settle before:content-[''] data-[under=true]:before:opacity-100"
          >
            <div
              ref={dock}
              data-testid="chat-dock"
              className="material overflow-hidden rounded-[28px] shadow-[var(--elev-pop),inset_0_1px_0_var(--material-highlight)] ring-1 ring-line-2 transition-[box-shadow] duration-(--dur-state) ease-settle has-[textarea:focus-visible]:ring-2 has-[textarea:focus-visible]:ring-ink"
            >
              <NextStepBar step={step} act={act} />
              <form onSubmit={onSubmit} className="flex items-end gap-2 p-2 pl-2.5">
                <label htmlFor="chat-input" className="sr-only">
                  Message to Hogee
                </label>
                <textarea
                  ref={input}
                  id="chat-input"
                  rows={1}
                  value={draft}
                  maxLength={4000}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      sendText(draft);
                    }
                  }}
                  className="field-sizing-content max-h-[9.5rem] min-h-10 flex-1 resize-none bg-transparent px-3 py-2 text-base leading-6 outline-none placeholder:text-muted-foreground md:text-[0.9375rem]"
                  placeholder="Message Hogee"
                />
                {busy ? (
                  <Button type="button" size="icon" variant="outline" aria-label="Stop" title="Stop the reply" className="size-10 shrink-0 rounded-full" onClick={() => void stop()}>
                    <Square className="fill-current" />
                  </Button>
                ) : (
                  <Button type="submit" size="icon" aria-label="Send" title="Send (Enter)" className="size-10 shrink-0 rounded-full" disabled={draft.trim().length === 0}>
                    <ArrowUp />
                  </Button>
                )}
              </form>
            </div>
          </div>

          {/* At the very bottom: while it is on screen, no thread is under the composer (an IntersectionObserver, no scroll handler). */}
          <div ref={bottom} aria-hidden className="-mt-6 h-px shrink-0" />
          <p role="status" className="sr-only" data-testid="chat-announcer">
            {announcement}
          </p>
        </ChatLayout>
      </JourneyThreadProvider>
    </SignHost>
  );
}
