"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { BuDisclosure } from "./bu-note";
import { MAIN_ID, PROOF_HREF, isFullBleed } from "./routes";

/**
 * The page frame (UX round 3): the one place a page's width and its left edge are set, so every page's title starts on
 * the same line. Pages add no max-width, centring or side padding of their own. The width is `--page-max` in
 * app/shell.css (`:root`), `none`: the frame runs from the side nav to the right edge (the user chose the bento
 * layout: pages fill the width as a grid of cards, app/bento.css); it stays anchored to the side nav if a cap is ever
 * set, so the left edge never moves.
 */
export const PAGE_FRAME = "w-full max-w-(--page-max) px-4 sm:px-6 lg:px-8";

/**
 * Everything under the top bar. Pages get the frame and the footer: one BU line with the rest behind "What's a BU?",
 * and the reviewers' way into Proof (UX-PLAN D9). The chat owns the whole canvas (thread plus wallet rail) and shows
 * the BU line in its rail foot instead (DESIGN.md §5–6).
 */
export function ShellFrame({ children }: { children: ReactNode }) {
  const fullBleed = isFullBleed(usePathname());
  if (fullBleed) {
    return (
      <main id={MAIN_ID} tabIndex={-1} className="flex min-h-0 flex-1 flex-col outline-none">
        {children}
      </main>
    );
  }
  return (
    <>
      <main id={MAIN_ID} tabIndex={-1} data-shell-frame className={cn(PAGE_FRAME, "flex flex-1 flex-col gap-6 py-6 outline-none sm:gap-7 sm:py-8")}>
        {children}
      </main>
      {/* The end of the page's content, for the side nav's scroll-spy (section-nav.tsx). */}
      <div data-shell-end aria-hidden className="pointer-events-none -mt-px h-px" />
      <footer className="shadow-[inset_0_1px_0_var(--separator)]">
        <div data-shell-frame className={cn(PAGE_FRAME, "flex flex-wrap items-start justify-between gap-x-8 py-2")}>
          <BuDisclosure className="flex-1 basis-80" />
          <Link
            href={PROOF_HREF}
            data-testid="footer-proof"
            className={cn(
              "inline-flex min-h-11 shrink-0 items-center rounded-lg text-footnote font-medium text-ink-2 underline decoration-line-2 underline-offset-[3px] outline-none",
              "transition-[color,text-decoration-color] duration-(--dur-state) ease-settle hover:text-ink hover:decoration-ink focus-visible:ring-[3px] focus-visible:ring-ring/50",
            )}
          >
            Proof (for reviewers)
          </Link>
        </div>
      </footer>
    </>
  );
}
