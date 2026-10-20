"use client";

import * as React from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { moneyParts } from "@/components/ledger/money-parts";
import { cn } from "@/lib/utils";
import { TICK_MS, deltaTone, tickMinor, tickNumber, type DeltaTone, type Trend } from "./stat-math";

/**
 * A figure with its label (Apple Wallet, Health; DESIGN.md §12): a quiet 13 px label, a big tabular number with a
 * smaller unit, and at most one line under it (a change, or a note). Hierarchy comes from scale, so the label stays
 * short ("Ready to spend", "Sales this week") and the explanation goes behind "Show details".
 *
 *   <Stat label="Ready to spend" minor="400000" size="hero" tick />
 *   <Stat label="Sales" minor="135600" delta={{ text: "+18% on last week", trend: "up", upIsGood: true }} />
 *   <Stat label="Orders" value={32} unit="orders" size="sm" leading={<IconTile icon={Package} tone="slot-1" size="sm" />} />
 *
 * - `minor` is money (a minor-unit string, shown as whole BU like <Money>); `value` anything else (a number, "7:42").
 * - `size`: `sm` 20 px, `md` 28 (default), `lg` 34, `hero` 44 (one per view).
 * - `tick`: the number counts up once, the first time it is on screen (900 ms, ease-out). Not with reduced motion; not
 *   for a value the person just changed. While it counts, the moving digits are hidden from assistive tech and the
 *   final figure is read instead.
 */
type StatSize = "sm" | "md" | "lg" | "hero";

const FIGURE: Record<StatSize, string> = {
  sm: "text-title-3",
  md: "text-title-1",
  lg: "text-large-title",
  hero: "text-hero",
};
/** The unit shrinks more as the figure grows, so "BU" never competes with the number. */
const UNIT: Record<StatSize, string> = {
  sm: "text-[0.7em]",
  md: "text-[0.6em]",
  lg: "text-[0.55em]",
  hero: "text-[0.48em]",
};

const DELTA: Record<DeltaTone, string> = {
  good: "text-paid",
  bad: "text-blocked",
  neutral: "text-ink-2",
};
const TREND_ICON: Record<Trend, typeof ArrowUpRight> = { up: ArrowUpRight, down: ArrowDownRight, flat: Minus };

export interface StatDelta {
  /** The change in words and figures: "+18% on last week". */
  text: string;
  trend: Trend;
  /** Whether up is good news for this figure (sales: true, spending: false); leave it out for a neutral colour. */
  upIsGood?: boolean;
}

type StatProps = Omit<React.ComponentProps<"div">, "children"> & {
  label: React.ReactNode;
  minor?: string;
  value?: React.ReactNode;
  unit?: string;
  size?: StatSize;
  delta?: StatDelta;
  note?: React.ReactNode;
  /** A small tile or mark before the label. */
  leading?: React.ReactNode;
  tick?: boolean;
};

const reducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The count-up's progress, 0..1: 1 (the final figure) unless `enabled`, then 0 until the element is first on screen,
 * then rising over TICK_MS on requestAnimationFrame. It runs once per mount; later value changes show at once.
 */
function useTickOnView(ref: React.RefObject<HTMLElement | null>, enabled: boolean): number {
  const [progress, setProgress] = React.useState(1);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || !el || reducedMotion() || typeof IntersectionObserver === "undefined") return;
    let raf = 0;
    let start = 0;
    const step = (now: number) => {
      start ||= now;
      const p = Math.min(1, (now - start) / TICK_MS);
      setProgress(p);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        raf = requestAnimationFrame(step);
      },
      { threshold: 0.4 },
    );
    // Hidden at 0 before the first paint of this mount, so the figure never flashes its final value first.
    setProgress(0);
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
      setProgress(1);
    };
    // Once per mount: the figure's later changes show at once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  return progress;
}

/** The figure as text at a given progress: money in whole BU (moneyParts), a number with locale grouping. */
function figureText(minor: string | undefined, value: React.ReactNode, progress: number): React.ReactNode {
  if (minor !== undefined) {
    const parts = moneyParts(progress >= 1 ? minor : tickMinor(minor, progress));
    return `${parts.negative ? "−" : ""}${parts.figure}`;
  }
  if (typeof value === "number") return (progress >= 1 ? value : tickNumber(value, progress)).toLocaleString("en-SG");
  return value;
}

function Stat({ label, minor, value, unit, size = "md", delta, note, leading, tick = false, className, ...props }: StatProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  const canTick = tick && (minor !== undefined || typeof value === "number");
  const progress = useTickOnView(ref, canTick);
  const ticking = progress < 1;
  const shownUnit = unit ?? (minor !== undefined ? "BU" : undefined);
  const tone = delta ? deltaTone(delta.trend, delta.upIsGood) : "neutral";
  const TrendIcon = delta ? TREND_ICON[delta.trend] : null;

  const figure = (
    <>
      {figureText(minor, value, progress)}
      {/* A real space, at the unit's smaller size (as <Money>): the text reads "384 BU", never "384BU". */}
      {shownUnit ? <span className={cn("font-medium tracking-[0.01em] text-ink-3", UNIT[size])}>{` ${shownUnit}`}</span> : null}
    </>
  );

  return (
    <div ref={ref} data-slot="stat" data-size={size} className={cn("grid min-w-0 content-start gap-1", className)} {...props}>
      <div className="flex min-w-0 items-center gap-2">
        {leading}
        <span className="truncate text-footnote font-medium text-ink-2">{label}</span>
      </div>
      <div
        data-slot="stat-value"
        data-minor={minor}
        className={cn("min-w-0 whitespace-nowrap text-ink tabular-nums [font-variant-numeric:tabular-nums_lining-nums]", FIGURE[size])}
      >
        {ticking ? (
          <>
            <span aria-hidden>{figure}</span>
            <span className="sr-only">
              {figureText(minor, value, 1)}
              {shownUnit ? ` ${shownUnit}` : null}
            </span>
          </>
        ) : (
          figure
        )}
      </div>
      {delta && TrendIcon ? (
        <span data-slot="stat-delta" data-tone={tone} className={cn("inline-flex items-center gap-1 text-footnote font-medium", DELTA[tone])}>
          <TrendIcon aria-hidden className="size-3.5 shrink-0" strokeWidth={2.4} />
          {delta.text}
        </span>
      ) : null}
      {note ? <p className="text-footnote text-pretty text-ink-3">{note}</p> : null}
    </div>
  );
}

export { Stat };
export type { StatProps, StatSize };
