"use client";

import { useState } from "react";
import type { LineKey } from "@hogee/core";
import { LINE_SLOT, SLOT_BG, type LineSlot } from "@/components/ledger/line-slots";
import { Money } from "@/components/ledger/money";
import { lineLabel, pctOf } from "@/lib/format";
import { cn } from "@/lib/utils";

/** The CSS colour of a chart slot, for the ring's SVG strokes (the same tokens as SLOT_BG). */
const SLOT_COLOR: { readonly [S in LineSlot]: string } = {
  1: "var(--chart-1)",
  2: "var(--chart-2)",
  3: "var(--chart-3)",
  4: "var(--chart-4)",
  5: "var(--chart-5)",
  neutral: "var(--chart-neutral)",
};

export interface DonutItem {
  readonly lineKey: LineKey;
  readonly minor: string;
}

/** The ring's geometry, in its own units (pathLength 100 around a 48-unit radius). */
const R = 48;
const STROKE = 13;
/** A 2 px surface gap between segments at the ring's rendered size (dataviz: fills never touch). */
const GAP = 0.7;

const pctWords = (pct: number): string => (pct > 0 && pct < 1 ? "<1%" : `${Math.round(pct)}%`);

/**
 * The budget split as a ring (dataviz: part-to-whole, few parts): one segment per pocket in its fixed chart slot,
 * starting at 12 o'clock in plan order, with the total in the middle. Hovering a segment or its legend row puts that
 * pocket in the middle instead and dims the rest. The legend states every name and share, so the ring itself is
 * decorative and never the only way to read a number.
 */
export function PocketDonut({ items, totalMinor, className }: { items: readonly DonutItem[]; totalMinor: string; className?: string }) {
  const [active, setActive] = useState<LineKey>();
  const shares = items.map((it) => ({ ...it, pct: pctOf(it.minor, totalMinor) }));
  let start = 0;
  const segments = shares.map((s) => {
    const seg = { ...s, start, len: Math.max(0, s.pct - (shares.length > 1 ? GAP : 0)) };
    start += s.pct;
    return seg;
  });
  const focus = shares.find((s) => s.lineKey === active);
  return (
    <div className={cn("@container", className)}>
      <div className="flex items-center gap-x-5 sm:gap-x-7" onPointerLeave={() => setActive(undefined)}>
        <div className="relative size-[8.25rem] shrink-0 sm:size-[10.5rem]">
          <svg viewBox="0 0 120 120" className="size-full -rotate-90" aria-hidden>
            <circle cx="60" cy="60" r={R} fill="none" stroke="var(--fill-strong)" strokeWidth={STROKE} />
            {segments.map((s) =>
              s.len > 0 ? (
                <circle
                  key={s.lineKey}
                  cx="60"
                  cy="60"
                  r={R}
                  fill="none"
                  pathLength={100}
                  stroke={SLOT_COLOR[LINE_SLOT[s.lineKey]]}
                  strokeWidth={STROKE}
                  strokeDasharray={`${s.len} ${100 - s.len}`}
                  strokeDashoffset={-s.start}
                  onPointerEnter={() => setActive(s.lineKey)}
                  className={cn("transition-[opacity,stroke-width] duration-(--dur-state) ease-settle", active && active !== s.lineKey && "opacity-30")}
                  style={active === s.lineKey ? { strokeWidth: STROKE + 3 } : undefined}
                />
              ) : null,
            )}
          </svg>
          <div className="pointer-events-none absolute inset-0 grid place-content-center text-center" aria-hidden>
            {focus ? (
              <>
                <span className="text-caption text-ink-2">{lineLabel(focus.lineKey)}</span>
                <Money minor={focus.minor} className="text-callout font-semibold tracking-[-0.02em] sm:text-headline" />
                <span className="text-caption text-ink-3">{pctWords(focus.pct)} of budget</span>
              </>
            ) : (
              <>
                <span className="text-caption text-ink-2">{items.length} pockets</span>
                <Money minor={totalMinor} className="text-callout font-semibold tracking-[-0.02em] sm:text-headline" />
              </>
            )}
          </div>
        </div>
        <ul className="grid min-w-0 flex-1 grid-cols-1 gap-x-5 gap-y-0 @lg:grid-cols-2 @lg:gap-x-8" aria-label="Budget split">
          {shares.map((s) => (
            <li
              key={s.lineKey}
              onPointerEnter={() => setActive(s.lineKey)}
              data-active={active === s.lineKey || undefined}
              className={cn(
                "-mx-2 grid grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-md px-2 py-1 text-footnote sm:py-1.5 sm:text-subhead transition-[background-color,opacity] duration-(--dur-state) ease-settle data-[active=true]:bg-fill",
                active && active !== s.lineKey && "opacity-55",
              )}
            >
              <span aria-hidden className={cn("size-2.5 rounded-[3px]", SLOT_BG[LINE_SLOT[s.lineKey]])} />
              <span className="truncate text-ink">{lineLabel(s.lineKey)}</span>
              <span className="text-ink-2 tabular-nums">{pctWords(s.pct)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
