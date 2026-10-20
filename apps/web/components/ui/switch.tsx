"use client";

import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * An iOS-style switch on Radix Switch (a `button role="switch"` with aria-checked; Space and Enter toggle it). 51×31
 * like iOS, with a hit area of at least 44 px (`after:`). The thumb moves on the critically damped spring
 * (`--ease-spring`, response 0.3); while pressed it stretches toward the side it would go to, as iOS does. The stretch
 * is a `clip-path` on a wider pill (no width animation), and its shadow is a `drop-shadow` on the wrapper so it follows
 * the clipped shape. Transitions are held off until the first frame after mount, so a value that hydrates (recording
 * mode, a stored setting) never animates on load. Reduced motion: the tokens make the move a short ease, and there is
 * no stretch (a dim instead). Ink when on: green means money in (DESIGN.md §3), so it is not used here.
 */
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    const frame = window.requestAnimationFrame(() => setReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-ready={ready || undefined}
      className={cn(
        "group/switch peer relative inline-flex h-[31px] w-[51px] shrink-0 cursor-pointer items-center rounded-full outline-none select-none",
        "bg-line-2 shadow-[inset_0_0_0_0.5px_oklch(0.235_0.028_262/0.06)] data-[state=checked]:bg-ink",
        "data-ready:transition-[background-color,opacity] data-ready:duration-(--dur-spring-fast) data-ready:ease-(--ease-spring)",
        "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-raised",
        "disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:active:opacity-80",
        // 44 px to hit, 31 px to see.
        "after:absolute after:-inset-x-1 after:-inset-y-1.5 after:content-['']",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none absolute top-[2px] left-[2px] block h-[27px] w-[34px]",
          "[filter:drop-shadow(0_3px_4px_oklch(0_0_0/0.12))_drop-shadow(0_1px_1px_oklch(0_0_0/0.08))]",
          // Unchecked: the pill's left 27 px show at x 0; checked: its right 27 px show at x 20 (51 − 27 − 2 − 2).
          "translate-x-0 data-[state=checked]:translate-x-[13px]",
          "group-data-ready/switch:transition-[translate] group-data-ready/switch:duration-(--dur-spring-fast) group-data-ready/switch:ease-(--ease-spring)",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "block size-full rounded-full bg-raised",
            "[clip-path:inset(0_7px_0_0_round_13.5px)] group-data-[state=checked]/switch:[clip-path:inset(0_0_0_7px_round_13.5px)]",
            // The press: the thumb widens toward the other side (iOS), from pointer-down. Important, so it wins over the
            // checked clip whatever order the variants are emitted in.
            "motion-safe:group-enabled/switch:group-active/switch:[clip-path:inset(0_0_0_0_round_13.5px)]!",
            "group-data-ready/switch:transition-[clip-path] group-data-ready/switch:duration-(--dur-spring-fast) group-data-ready/switch:ease-(--ease-spring)",
          )}
        />
      </SwitchPrimitive.Thumb>
    </SwitchPrimitive.Root>
  );
}

export { Switch };
