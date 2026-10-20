"use client";

import * as React from "react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

// Keyboard (Radix): Tab enters the group at the checked item; arrow keys move and check.

function RadioGroup({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return <RadioGroupPrimitive.Root data-slot="radio-group" className={cn("grid gap-3", className)} {...props} />;
}

/** The dot (16 px, a 40 px hit area). Pair it with a <Label htmlFor> so the label text is part of the hit area too. */
function RadioGroupItem({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        "peer relative aspect-square size-4 shrink-0 rounded-full border border-input bg-raised text-ink transition-[border-color,box-shadow] duration-(--dur-state) ease-settle outline-none",
        "after:absolute after:-inset-3 after:rounded-full after:content-['']",
        "focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "aria-invalid:border-blocked aria-invalid:ring-[3px] aria-invalid:ring-blocked/20",
        "data-[state=checked]:border-ink disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator data-slot="radio-group-indicator" className="flex size-full items-center justify-center">
        <span className="size-2 rounded-full bg-ink" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
}

/**
 * A whole card as one radio option (e.g. a payment-terms preset: title plus a line of detail). The card is the
 * <button role="radio">, so children must be phrasing content: spans, not divs or paragraphs.
 */
function RadioGroupCard({ className, children, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-card"
      className={cn(
        "group/radio-card flex min-h-10 w-full items-start gap-3 rounded-lg bg-raised p-3 text-left text-ui shadow-sm transition-[background-color,box-shadow,scale] duration-(--dur-state) ease-settle outline-none",
        "hover:bg-canvas enabled:active:scale-(--press-row) enabled:active:bg-sunk enabled:active:duration-(--dur-press)",
        "focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "data-[state=checked]:bg-tint-ink data-[state=checked]:shadow-[0_0_0_1.5px_var(--ink)]",
        "aria-invalid:shadow-[0_0_0_1px_var(--blocked)]",
        "disabled:cursor-not-allowed disabled:bg-sunk disabled:text-ink-3 disabled:shadow-[0_0_0_1px_var(--line)] disabled:hover:bg-sunk",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-input bg-raised transition-[border-color] group-data-[state=checked]/radio-card:border-ink"
      >
        <span className="size-2 scale-0 rounded-full bg-ink transition-[scale] duration-150 ease-[cubic-bezier(0.2,0,0,1)] group-data-[state=checked]/radio-card:scale-100 motion-reduce:transition-none" />
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">{children}</span>
    </RadioGroupPrimitive.Item>
  );
}

/**
 * The radio group styled as a segment (DESIGN.md §7, the terms split): a sunk track, 2 columns on phones and 4 from
 * 640 px by default (override with className). Items are <RadioGroupSegmentItem>.
 */
function RadioGroupSegment({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group-segment"
      className={cn("grid grid-cols-2 gap-[3px] rounded-lg bg-fill-strong p-[3px] sm:grid-cols-4", className)}
      {...props}
    />
  );
}

/**
 * One segment. A disabled option (a preset that breaks a cap) is greyed and struck through; print its reason below the
 * group and point at it with `aria-describedby`, so the reason is read with the option.
 */
function RadioGroupSegmentItem({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-segment-item"
      className={cn(
        "relative h-9 min-w-0 rounded-[9px] px-3 text-[0.8125rem] font-medium whitespace-nowrap text-ink-2 transition-[color,background-color,box-shadow] duration-(--dur-state) ease-settle outline-none",
        "after:absolute after:inset-x-0 after:-inset-y-0.5 after:content-['']",
        "hover:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "data-[state=checked]:bg-raised data-[state=checked]:text-ink data-[state=checked]:shadow-sm",
        "disabled:cursor-not-allowed disabled:text-ink-4 disabled:line-through disabled:decoration-ink-4 disabled:hover:text-ink-4",
        className,
      )}
      {...props}
    />
  );
}

export { RadioGroup, RadioGroupCard, RadioGroupItem, RadioGroupSegment, RadioGroupSegmentItem };
