"use client";

import * as React from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

// Keyboard (Radix): Tab moves into the list and out to the panel; ←/→ move between triggers, Home/End jump.

/**
 * Two looks (DESIGN.md §8, §12), chosen on the list:
 * - `segment` (default, ux2): a segmented control. An ink-fill track (radius 12, 2 px inset) holds 36 px triggers; the
 *   active one is a white thumb (radius 10, concentric) on `shadow-sm`, and each hit area reaches 40 px. Triggers keep
 *   their own widths, so the thumb cross-fades between them; for equal segments with a thumb that slides, use
 *   <Segmented> (./segmented) when the choice does not switch panels.
 * - `underline`: 44 px triggers over a 1 px rule, the active one marked by a 2 px ink bar that grows on scaleX.
 */
type TabsVariant = "underline" | "segment";
const TabsVariantContext = React.createContext<TabsVariant>("segment");

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col gap-4", className)} {...props} />;
}

const LIST: Record<TabsVariant, string> = {
  underline: "flex w-full max-w-full items-end gap-0.5 shadow-[inset_0_-1px_0_var(--line)]",
  segment: "inline-flex w-fit max-w-full items-center gap-0.5 rounded-lg bg-fill-strong p-0.5",
};

function TabsList({ className, variant = "segment", ...props }: React.ComponentProps<typeof TabsPrimitive.List> & { variant?: TabsVariant }) {
  return (
    <TabsVariantContext.Provider value={variant}>
      <TabsPrimitive.List
        data-slot="tabs-list"
        data-variant={variant}
        className={cn(
          // Scrolls sideways rather than wrapping when the triggers outgrow a narrow screen: no scrollbar (it would eat
          // the track's height); the clipped last trigger shows there is more, and arrow-key focus scrolls it into view.
          "overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          LIST[variant],
          className,
        )}
        {...props}
      />
    </TabsVariantContext.Provider>
  );
}

const TRIGGER: Record<TabsVariant, string> = {
  underline: [
    "relative h-11 px-3 text-ui text-ink-2 hover:text-ink data-[state=active]:text-ink",
    "after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:origin-center after:scale-x-0 after:rounded-full after:bg-ink after:transition-transform after:duration-(--dur-state) after:ease-settle after:content-['']",
    "data-[state=active]:after:scale-x-100",
    "focus-visible:ring-inset",
  ].join(" "),
  segment: [
    "relative h-9 rounded-[10px] px-3.5 text-[0.8125rem] text-ink-2 hover:text-ink",
    "after:absolute after:inset-x-0 after:-inset-y-0.5 after:content-['']",
    "data-[state=active]:bg-raised data-[state=active]:text-ink data-[state=active]:shadow-sm",
  ].join(" "),
};

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  const variant = React.useContext(TabsVariantContext);
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 font-medium whitespace-nowrap outline-none",
        "transition-[color,background-color,box-shadow,scale] duration-(--dur-state) ease-settle active:scale-(--press) active:duration-(--dur-press)",
        "focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "disabled:pointer-events-none disabled:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        TRIGGER[variant],
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 rounded-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50", className)}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
export type { TabsVariant };
