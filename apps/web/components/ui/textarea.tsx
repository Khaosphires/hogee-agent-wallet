import * as React from "react";
import { cn } from "@/lib/utils";
import { FIELD_STATES } from "./input";

/** A filled multi-line field, styled like <Input> (FIELD_STATES). */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        // field-sizing-content grows with the text where supported; elsewhere min-h-16 plus the native resize handle.
        "flex field-sizing-content min-h-16 w-full min-w-0 rounded-lg border border-transparent bg-fill px-3 py-2 text-base text-pretty text-ink shadow-[inset_0_0_0_1px_oklch(var(--ink-lch)/0.07)] transition-[border-color,box-shadow,background-color] duration-(--dur-state) ease-settle outline-none selection:bg-ink/15 placeholder:text-ink-3 hover:bg-fill-strong disabled:cursor-not-allowed disabled:opacity-55 md:text-ui",
        FIELD_STATES,
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
