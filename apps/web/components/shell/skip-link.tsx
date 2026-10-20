import { MAIN_ID } from "./routes";

/**
 * "Skip to content" (UX round 3): the first thing Tab reaches on every page, hidden until it has focus. It jumps past
 * the side nav and the top bar to the page's <main> (shell-frame.tsx), which takes focus (tabindex -1).
 */
export function SkipLink() {
  return (
    <a
      href={`#${MAIN_ID}`}
      className="sr-only rounded-full bg-ink px-4 py-2.5 text-subhead font-medium text-ink-on shadow-pop outline-none focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      Skip to content
    </a>
  );
}
