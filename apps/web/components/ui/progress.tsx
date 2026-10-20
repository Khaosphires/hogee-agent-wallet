"use client";

import * as React from "react";
import { Progress as ProgressPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import { clampPct, ringGeometry } from "./progress-math";
import { TONE, type Tone } from "./tones";

/**
 * A rounded bar on an ink-fill track (DESIGN.md §12). `tone` colours the fill by meaning (a pocket's slot, paid,
 * agent, waiting, blocked; ink by default). The fill moves on transform only. Pass `indicatorClassName` for anything
 * else (e.g. a hatch).
 */
function Progress({
  className,
  value,
  tone = "ink",
  indicatorClassName,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & { tone?: Tone; indicatorClassName?: string }) {
  const pct = clampPct(value);
  return (
    <ProgressPrimitive.Root data-slot="progress" data-tone={tone} value={value == null ? value : pct} className={cn("relative h-2 w-full overflow-hidden rounded-full bg-fill-strong", className)} {...props}>
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn("h-full w-full flex-1 rounded-full transition-transform duration-(--dur-seal) ease-settle", TONE[tone].solid, indicatorClassName)}
        style={{ transform: `translateX(-${100 - pct}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}

/**
 * A progress ring (Apple Fitness; DESIGN.md §12): how much of a pocket is used, a goal reached. A `size` px circle with
 * a `stroke` px line in the tone's colour over an ink-fill track, starting at 12 o'clock, round-capped; whatever you
 * pass as children sits in the middle (a percentage, an icon). It is a `role="meter"` named by `label`, so it states
 * its number; it never animates the amount.
 *
 *   <ProgressRing value={62} tone="slot-1" label="Supplier: 62% used" size={44}>62%</ProgressRing>
 */
function ProgressRing({
  value,
  tone = "ink",
  size = 40,
  stroke = 4,
  label,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "role"> & { value: number; tone?: Tone; size?: number; stroke?: number; label: string }) {
  const pct = clampPct(value);
  const g = ringGeometry(size, stroke, pct);
  const c = size / 2;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      data-slot="progress-ring"
      data-tone={tone}
      className={cn("relative inline-grid shrink-0 place-items-center", className)}
      style={{ width: size, height: size }}
      {...props}
    >
      <svg aria-hidden width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="absolute inset-0 -rotate-90">
        <circle cx={c} cy={c} r={g.r} fill="none" strokeWidth={stroke} className="stroke-fill-strong" />
        {pct > 0 ? (
          <circle
            cx={c}
            cy={c}
            r={g.r}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={g.circumference}
            strokeDashoffset={g.offset}
            className={TONE[tone].stroke}
          />
        ) : null}
      </svg>
      {children !== undefined ? <span className="relative text-caption-2 font-semibold text-ink tabular-nums">{children}</span> : null}
    </div>
  );
}

export { Progress, ProgressRing };
