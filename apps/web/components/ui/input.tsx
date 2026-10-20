import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Filled fields (DESIGN.md §12): an ink fill at low alpha with a faint inner edge, no box, so a form reads as part of
 * its card; on focus the field turns white with an ink edge and a soft ink halo, so where you are typing is never in
 * doubt. More contrast (globals.css) gives every field its 3:1 `line-control` edge back.
 */
const FIELD_STATES = [
  "focus-visible:border-ink focus-visible:bg-raised focus-visible:shadow-none focus-visible:ring-4 focus-visible:ring-ink/10",
  "aria-invalid:border-blocked aria-invalid:bg-blocked-wash aria-invalid:ring-4 aria-invalid:ring-blocked/15",
  "contrast-more:border-input",
].join(" ");

/** A 40 px filled field (see FIELD_STATES); `type="file"` keeps the native picker inside it. */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-10 w-full min-w-0 rounded-lg border border-transparent bg-fill px-3 py-1 text-base text-ink shadow-[inset_0_0_0_1px_oklch(var(--ink-lch)/0.07)] transition-[border-color,box-shadow,background-color] duration-(--dur-state) ease-settle outline-none selection:bg-ink/15 file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-ink-3 hover:bg-fill-strong disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-55 md:text-ui",
        FIELD_STATES,
        className,
      )}
      {...props}
    />
  );
}

export { FIELD_STATES, Input };
