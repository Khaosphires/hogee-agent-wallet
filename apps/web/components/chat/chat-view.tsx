"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, Ellipsis, RotateCcw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ErrorBlock, LoadingBlock } from "@/components/ledger/query-state";
import { useApiQuery } from "@/lib/api/hooks";
import { threadLatch, type ThreadLatch } from "@/lib/journey-client";
import { getChatSessionId, resetChatSessionId } from "@/lib/chat-session";
import { useRecording } from "@/lib/presentation";
import { useExitPresence } from "@/lib/use-exit-presence";
import { ChatLayout } from "./chat-layout";
import { IconTile } from "@/components/ui/icon-tile";
import { PromiseList } from "./chat-opener";
import { ChatThread } from "./chat-thread";
import type { HogeeUIMessage } from "./message-parts";

const noop = () => () => {};

/**
 * The AI disclosure (project.md §14.4; NFRA 二十一) as one open line (UX round 3, first-timer #4): that Hogee is an AI,
 * that its replies are AI-drafted, and what it can't do, always shown. The three promises and the safety lines sit
 * behind its "More" (the welcome-back home keeps the thread for what changed). The only "AI-drafted" on the chat
 * screen besides the plan card; each reply carries it for screen readers.
 */
function TrustLine() {
  return (
    <details className="group/trust min-w-0 flex-1" data-testid="chat-trust-line">
      <summary className="flex min-h-10 w-fit max-w-full cursor-pointer list-none items-start gap-2.5 rounded-xl py-1.5 pr-2 text-footnote text-ink-2 outline-none select-none hover:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <IconTile icon={Sparkles} tone="ink" size="sm" variant="tinted" />
        <span className="min-w-0 pt-0.5 text-pretty">
          <span className="font-medium text-ink">Hogee is an AI, so its replies are AI-drafted.</span> It can’t change your rules, who gets paid, or how much.{" "}
          <span className="inline-flex items-center gap-0.5 font-medium whitespace-nowrap text-ink">
            More
            <ChevronDown aria-hidden className="size-3.5 transition-transform duration-(--dur-state) ease-settle group-open/trust:rotate-180 motion-reduce:transition-none" />
          </span>
        </span>
      </summary>
      <div className="pt-2 pb-1">
        <PromiseList label="What Hogee can’t do" />
      </div>
    </details>
  );
}

/**
 * "Clear this chat" in a small ⋯ menu (UX-PLAN D15), behind a confirm that says what stays: it only starts a new
 * conversation in this browser; the plan, the order and the money are on the server and the chain. Hidden while
 * recording (D14).
 */
function ChatMenu() {
  const recording = useRecording();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  // The menu grows out of the ⋯ button and shrinks back into it (apple-design), so it stays mounted while it leaves.
  const presence = useExitPresence(open);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !menu.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  if (recording) return null;
  return (
    <div ref={menu} className="relative shrink-0">
      <Button variant="ghost" size="icon" aria-label="More options" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="chat-menu">
        <Ellipsis aria-hidden />
      </Button>
      {presence.mounted ? (
        <div
          role="menu"
          data-state={open ? "open" : "closed"}
          inert={!open}
          onTransitionEnd={presence.onTransitionEnd}
          className="pop-surface absolute top-11 right-0 z-30 grid min-w-48 origin-top-right rounded-xl bg-raised p-1 shadow-pop ring-1 ring-line-2"
        >
          <button
            type="button"
            role="menuitem"
            autoFocus
            className="flex min-h-10 items-center gap-2 rounded-lg px-3 text-left text-ui outline-none transition-[background-color] duration-(--dur-state) ease-settle hover:bg-sunk focus-visible:bg-sunk active:bg-sunk-2 active:duration-(--dur-press)"
            onClick={() => {
              setOpen(false);
              setConfirm(true);
            }}
          >
            <RotateCcw aria-hidden className="size-4 text-ink-3" /> Clear this chat
          </button>
        </div>
      ) : null}
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Clear this chat?</DialogTitle>
            <DialogDescription>This only clears the messages on this screen. Your plan, order and money stay.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              Keep the chat
            </Button>
            <Button
              onClick={() => {
                resetChatSessionId();
                window.location.reload();
              }}
            >
              Clear this chat
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * The chat home: the trust line at the thread head (Hogee is an AI, and what the wallet can't do), then the
 * conversation of this browser's session, loaded from the server's history (a 404 is a new conversation).
 */
export function ChatView() {
  const sessionId = useSyncExternalStore(noop, getChatSessionId, () => undefined);
  const history = useApiQuery("getChat", sessionId ? { params: { sessionId } } : undefined, { poll: false, enabled: Boolean(sessionId) });
  // 404 = a new conversation (no history yet).
  const fresh = history.error?.code === "NOT_FOUND";
  // Once the thread has mounted for this session it stays mounted (threadLatch): a refetch of the history after any
  // mutation must never unmount the SignDialog or the reply in flight.
  const [latch, setLatch] = useState<ThreadLatch<HogeeUIMessage> | null>(null);
  const nextLatch = threadLatch(latch, sessionId, history.data as unknown as HogeeUIMessage[] | undefined, fresh);
  if (nextLatch !== latch) setLatch(nextLatch);

  const head = (
    <div className="flex items-start justify-between gap-3">
      <TrustLine />
      <ChatMenu />
    </div>
  );

  if (nextLatch) {
    return <ChatThread key={nextLatch.sessionId} sessionId={nextLatch.sessionId} initial={nextLatch.initial} head={head} />;
  }
  return (
    <ChatLayout head={head}>
      {history.error && !fresh ? <ErrorBlock error={history.error} what="the conversation" /> : <LoadingBlock rows={3} label="Loading the conversation" />}
    </ChatLayout>
  );
}
