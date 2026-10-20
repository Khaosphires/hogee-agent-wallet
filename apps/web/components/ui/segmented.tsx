"use client";

import * as React from "react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { segmentIndex, thumbTranslate, thumbWidth } from "./segmented-math";

/**
 * A segmented control (iOS UISegmentedControl; DESIGN.md §12): equal segments on an ink-fill track, and a white thumb
 * that slides to the chosen one on the fast spring. Use it for a small choice that filters or changes what is on
 * screen ("4 weeks / Since the loan", "All / Paid / Waiting"); for a choice that swaps whole panels use <Tabs>.
 *
 *   <Segmented aria-label="Period" value={period} onValueChange={setPeriod}
 *     items={[{ value: "4w", label: "4 weeks" }, { value: "loan", label: "Since the loan" }]} />
 *
 * It is a Radix radio group: Tab enters at the chosen segment, the arrow keys move and choose. The thumb moves on
 * `translate` only (an interruptible transition, so a quick second choice turns it around from where it is); with
 * reduced motion it jumps. Each segment's hit area is 40 px tall.
 */
export interface SegmentedOption<V extends string = string> {
  value: V;
  label: React.ReactNode;
  icon?: LucideIcon;
  disabled?: boolean;
}

type SegmentedProps<V extends string> = {
  items: readonly SegmentedOption<V>[];
  value?: V;
  defaultValue?: V;
  onValueChange?: (value: V) => void;
  "aria-label": string;
  size?: "sm" | "md";
  disabled?: boolean;
  name?: string;
  className?: string;
  id?: string;
  "data-testid"?: string;
};

const ITEM: Record<"sm" | "md", string> = {
  // 28 px to see, 40 to hit.
  sm: "h-7 px-2.5 text-[0.78125rem] after:-inset-y-1.5 [&_svg]:size-3.5",
  // 36 px to see, 40 to hit.
  md: "h-9 px-3 text-[0.8125rem] after:-inset-y-0.5 [&_svg]:size-4",
};

function Segmented<V extends string>({
  items,
  value,
  defaultValue,
  onValueChange,
  size = "md",
  disabled,
  className,
  ...props
}: SegmentedProps<V>) {
  const [inner, setInner] = React.useState<V | undefined>(defaultValue);
  const current = value ?? inner;
  const index = segmentIndex(
    items.map((it) => it.value),
    current,
  );

  return (
    <RadioGroupPrimitive.Root
      data-slot="segmented"
      data-size={size}
      orientation="horizontal"
      value={current ?? ""}
      disabled={disabled}
      onValueChange={(v) => {
        const next = v as V;
        if (value === undefined) setInner(next);
        onValueChange?.(next);
      }}
      className={cn("relative isolate grid w-full auto-cols-fr grid-flow-col gap-0.5 rounded-lg bg-fill-strong p-0.5", className)}
      {...props}
    >
      <span
        aria-hidden
        data-slot="segmented-thumb"
        className={cn(
          "absolute top-0.5 bottom-0.5 left-0.5 -z-10 rounded-[10px] bg-raised shadow-sm",
          "transition-[translate,opacity] duration-(--dur-spring-fast) ease-(--ease-spring) motion-reduce:transition-[opacity]",
          index < 0 && "opacity-0",
        )}
        style={{ width: thumbWidth(items.length), translate: thumbTranslate(index) }}
      />
      {items.map(({ value: v, label, icon: Icon, disabled: itemDisabled }) => (
        <RadioGroupPrimitive.Item
          key={v}
          value={v}
          disabled={itemDisabled}
          data-slot="segmented-item"
          className={cn(
            "relative inline-flex min-w-0 items-center justify-center gap-1.5 rounded-[10px] font-medium whitespace-nowrap text-ink-2 outline-none select-none",
            "after:absolute after:inset-x-0 after:content-['']",
            "transition-[color,scale] duration-(--dur-state) ease-settle hover:text-ink active:scale-(--press) active:duration-(--dur-press)",
            "focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=checked]:text-ink",
            "disabled:pointer-events-none disabled:text-ink-4",
            "[&_svg]:pointer-events-none [&_svg]:shrink-0",
            ITEM[size],
          )}
        >
          {Icon ? <Icon aria-hidden /> : null}
          <span className="truncate">{label}</span>
        </RadioGroupPrimitive.Item>
      ))}
    </RadioGroupPrimitive.Root>
  );
}

export { Segmented };
export type { SegmentedProps };
