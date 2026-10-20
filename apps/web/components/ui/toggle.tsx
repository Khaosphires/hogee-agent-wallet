"use client";

import * as React from "react";
import { Toggle as TogglePrimitive } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const toggleVariants = cva(
  [
    "relative inline-flex items-center justify-center gap-2 rounded-lg text-ui font-medium whitespace-nowrap text-ink-2 outline-none",
    "transition-[color,background-color,box-shadow,scale] duration-(--dur-state) ease-settle active:scale-(--press) active:duration-(--dur-press)",
    "hover:bg-fill hover:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
    "data-[state=on]:bg-raised data-[state=on]:text-ink data-[state=on]:shadow-sm",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "bg-raised shadow-sm",
      },
      size: {
        default: "h-10 min-w-10 px-2.5",
        // 32 px to see, 40 px to hit.
        sm: "h-8 min-w-8 rounded-md px-2 text-[0.8125rem] after:absolute after:inset-x-0 after:-inset-y-1 after:content-['']",
        lg: "h-11 min-w-11 px-3",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Toggle({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof TogglePrimitive.Root> & VariantProps<typeof toggleVariants>) {
  return <TogglePrimitive.Root data-slot="toggle" className={cn(toggleVariants({ variant, size, className }))} {...props} />;
}

export { Toggle, toggleVariants };
