import { cn } from "@/lib/utils";

/**
 * A loading block (DESIGN.md §9, §12): a sunk-2 shape with a soft light that sweeps across it every 1.6 s, so a page
 * that is still loading looks alive rather than broken. The sweep is a transformed layer (transform only); with reduced
 * motion the block stays still. Rounded-full suits text lines; pass `rounded-lg` (or the shape's own radius) for
 * blocks. Pair it with one status line that says what is happening.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "relative isolate overflow-hidden rounded-full bg-sunk-2",
        "after:absolute after:inset-0 after:animate-shimmer after:bg-[linear-gradient(90deg,transparent,oklch(1_0_0/0.6),transparent)] after:content-['']",
        "motion-reduce:after:hidden",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
