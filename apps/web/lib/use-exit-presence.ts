"use client";

import { useEffect, useState, type TransitionEvent } from "react";

/** A surface whose exit never fires transitionend (it was never painted) still unmounts after this long. */
const EXIT_FALLBACK_MS = 700;

/**
 * Keeps a hand-rolled surface (one Radix doesn't manage) mounted while its exit transition plays, so it leaves along
 * the path it came in on (apple-design, skill §7). `mounted` is true from the moment `open` turns true until the
 * surface's opacity transition ends after `open` turned false; reopening mid-exit just turns the transition around.
 * Give the surface `data-state={open ? "open" : "closed"}`, the `pop-surface` class and `onTransitionEnd`.
 */
export function useExitPresence(open: boolean): { mounted: boolean; onTransitionEnd: (e: TransitionEvent<HTMLElement>) => void } {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);

  useEffect(() => {
    if (open || !mounted) return;
    const t = setTimeout(() => setMounted(false), EXIT_FALLBACK_MS);
    return () => clearTimeout(t);
  }, [open, mounted]);

  return {
    mounted,
    onTransitionEnd: (e) => {
      if (!open && e.target === e.currentTarget && e.propertyName === "opacity") setMounted(false);
    },
  };
}
