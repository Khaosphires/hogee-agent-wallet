import * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * A 24 px capsule (DESIGN.md §9, §12): 12 px semibold on an alpha fill, so it sits the same on white and on the canvas. For a state, prefer <Pill tone> from ./pill, which always adds the icon or dot that
 * keeps the state readable without colour; Badge stays for labels (origin, tier, kind) and older call sites.
 */
const badgeVariants = cva(
  "inline-flex h-6 w-fit shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-full px-2.5 text-meta font-semibold whitespace-nowrap transition-[color,background-color,box-shadow] focus-visible:ring-[3px] focus-visible:ring-ring/50 [&>svg]:pointer-events-none [&>svg]:size-[13px]",
  {
    variants: {
      variant: {
        default: "bg-fill-strong text-ink [a&]:hover:bg-sunk-2",
        secondary: "bg-fill text-ink-2 [a&]:hover:bg-fill-strong",
        destructive: "bg-tint-blocked text-blocked",
        outline: "font-medium text-ink-2 shadow-[inset_0_0_0_1px_var(--line-2)] [a&]:hover:bg-fill",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";
  return <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
