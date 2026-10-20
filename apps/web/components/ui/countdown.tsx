"use client";

import * as React from "react";
import { CheckIcon } from "lucide-react";
import { countdownState, elapsedFraction, reachedZero as isReachedZero } from "@/components/ui/countdown-format";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

type CountdownProps = Omit<React.ComponentProps<"span">, "children"> & {
  /** When the period ends: a zoned ISO-8601 date-time ("2026-10-19T12:00:00Z"). Unreadable → "Time unavailable", never Ready. */
  to: string;
  /** When the period started; when given, a thin bar shows how much has passed. */
  from?: string;
  readyText?: string;
  /** Called once when the clock reaches zero while mounted (not when it was already over at mount). */
  onReady?: () => void;
};

/**
 * A ticking countdown (e.g. the payee cooling period) on the shared one-second clock. The ticking text is a
 * role="timer" (not announced every second); reaching zero is announced once, politely.
 *
 * Ledger and Seal: the clock is Geist Mono 12.5 beside a still cobalt dot (cooling is the agent's wait; the only loop
 * in the product is the passkey wait), and the 4 px cobalt bar shows the time left, shrinking on one linear scaleX
 * transition. Under prefers-reduced-motion the bar and Ready state change without transitions.
 */
function Countdown({ to, from, readyText = "Ready", onReady, className, ...props }: CountdownProps) {
  const now = useNow();
  const state = countdownState(to, now);
  const fraction = state.kind === "running" ? elapsedFraction(from, to, now) : null;

  // "Reached zero while watched" is derived from the previous render's state, so a period that was already over
  // when the page loaded neither announces Ready nor calls onReady.
  const [lastKind, setLastKind] = React.useState(state.kind);
  const [reachedZero, setReachedZero] = React.useState(false);
  if (lastKind !== state.kind) {
    setLastKind(state.kind);
    setReachedZero(isReachedZero(lastKind, state.kind));
  }

  const fireReady = React.useEffectEvent(() => onReady?.());
  React.useEffect(() => {
    if (reachedZero) fireReady();
  }, [reachedZero]);

  return (
    <span data-slot="countdown" data-state={state.kind} className={cn("inline-flex flex-col gap-1 align-middle", className)} {...props}>
      <span role="timer" className="inline-flex items-center gap-1.5 text-ui font-medium tabular-nums">
        {state.kind === "running" ? (
          <>
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-agent" />
            <time dateTime={state.iso} aria-hidden className="font-mono text-[0.78125rem] tracking-[-0.01em]">
              {state.text}
            </time>
            <span className="sr-only">{state.spoken} left</span>
          </>
        ) : state.kind === "ready" ? (
          <span className="inline-flex items-center gap-1 text-paid animate-in fade-in-0 motion-reduce:animate-none">
            <CheckIcon aria-hidden className="size-4" />
            {readyText}
          </span>
        ) : state.kind === "invalid" ? (
          <span className="text-ink-3">Time unavailable</span>
        ) : (
          // Before the client clock is known: hold the space, say nothing.
          <span aria-hidden className="font-mono text-[0.78125rem] text-ink-3">
            -:--
          </span>
        )}
      </span>
      {fraction !== null ? (
        <span aria-hidden className="block h-1 w-full min-w-16 overflow-hidden rounded-full bg-line">
          <span
            className="block h-full w-full origin-left rounded-full bg-agent transition-[scale] duration-1000 ease-linear motion-reduce:transition-none"
            style={{ scale: `${1 - fraction} 1` }}
          />
        </span>
      ) : null}
      <span role="status" aria-live="polite" className="sr-only">
        {reachedZero ? readyText : ""}
      </span>
    </span>
  );
}

export { Countdown };
export type { CountdownProps };
