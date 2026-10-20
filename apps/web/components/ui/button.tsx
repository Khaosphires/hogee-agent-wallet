import * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Buttons (DESIGN.md §3, §12). Ink is the one accent, so the styles differ by weight, never by hue:
 *
 * | variant       | looks like                                | use for                                      |
 * |---------------|-------------------------------------------|----------------------------------------------|
 * | `default`     | filled ink (alias `filled`)               | the one main action in a view                |
 * | `tinted`      | ink at 7 % with ink text                  | a second action that still matters           |
 * | `secondary`   | white with a hairline ring and a shadow   | actions on a card (alias `outline`)          |
 * | `plain`       | ink text, a fill only on hover and press  | toolbars, "Show details", rows of actions    |
 * | `ghost`       | ink-2 text, a fill on hover               | quiet icon buttons                           |
 * | `destructive` | blocked text on a blocked tint            | stop, pause, reject (the word says the risk) |
 * | `link`        | underlined text                           | inline links                                 |
 *
 * Sizes: `sm` 32 px (its hit area extends to 40), `default` 40, `lg` 44 (the stub's "Sign with passkey"), `xl` 50 (a
 * page's one big call to action), `icon` 40 × 40, `icon-sm` 32 × 32 (hit area 40). The press shows on pointer-down:
 * scale to --press (0.96) on a transform-only transition; with reduced motion a dim instead.
 */
const SURFACE = "bg-raised text-ink shadow-sm hover:bg-canvas active:bg-sunk";

const buttonVariants = cva(
  [
    "relative inline-flex shrink-0 items-center justify-center gap-2 rounded-lg text-ui font-medium whitespace-nowrap select-none outline-none",
    // The press shows on pointer-down (apple-design): scale to --press (0.96); with reduced motion a dim instead.
    "transition-[scale,background-color,box-shadow,color,opacity] duration-(--dur-state) ease-settle active:scale-(--press) active:duration-(--dur-press) motion-reduce:active:opacity-80",
    "focus-visible:ring-[3px] focus-visible:ring-ring/50",
    "disabled:pointer-events-none disabled:opacity-45 aria-disabled:pointer-events-none aria-disabled:opacity-45",
    "aria-invalid:ring-[3px] aria-invalid:ring-blocked/25",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-[inset_0_1px_0_oklch(1_0_0/0.14),0_0_0_1px_oklch(0.235_0.028_262/0.9),0_1px_2px_oklch(0.235_0.028_262/0.2),0_4px_10px_-4px_oklch(0.235_0.028_262/0.35)] hover:bg-primary-hover",
        filled:
          "bg-primary text-primary-foreground shadow-[inset_0_1px_0_oklch(1_0_0/0.14),0_0_0_1px_oklch(0.235_0.028_262/0.9),0_1px_2px_oklch(0.235_0.028_262/0.2),0_4px_10px_-4px_oklch(0.235_0.028_262/0.35)] hover:bg-primary-hover",
        tinted: "bg-tint-ink text-ink hover:bg-fill-strong active:bg-fill-strong",
        // Refusals carry their danger in the word and a blocked tint, never a solid red block.
        destructive: "bg-tint-blocked text-blocked hover:bg-blocked/15 active:bg-blocked/20",
        outline: SURFACE,
        secondary: SURFACE,
        plain: "text-ink hover:bg-fill active:bg-fill-strong",
        ghost: "text-ink-2 hover:bg-fill hover:text-ink active:bg-fill-strong",
        link: "h-auto px-0 text-ink underline decoration-line-2 underline-offset-[3px] hover:decoration-ink active:scale-100",
      },
      size: {
        default: "h-10 px-4 has-[>svg]:px-3.5",
        sm: "h-8 gap-1.5 rounded-md px-3 text-[0.8125rem] has-[>svg]:px-2.5 after:absolute after:inset-x-0 after:-inset-y-1 after:content-['']",
        lg: "h-11 rounded-[13px] px-[18px] text-[0.9375rem] font-semibold has-[>svg]:px-4",
        xl: "h-[50px] rounded-[14px] px-6 text-headline font-semibold has-[>svg]:px-5 [&_svg:not([class*='size-'])]:size-5",
        icon: "size-10",
        "icon-sm": "size-8 rounded-md after:absolute after:-inset-1 after:content-['']",
      },
    },
    compoundVariants: [{ variant: "link", size: ["default", "sm", "lg", "xl"], className: "h-auto px-0 has-[>svg]:px-0" }],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "button";
  return <Comp data-slot="button" data-variant={variant ?? "default"} className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
