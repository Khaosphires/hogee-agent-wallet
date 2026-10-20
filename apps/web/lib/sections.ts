/**
 * The sections the side nav lists under each page (P1, UX round 2, 19 Oct). Each page renders an element with each
 * `id` below (a `<section id=…>` in practice); the nav scrolls to it and briefly highlights it. The ids are fixed:
 * pages, the nav, the tests and the demo recorder all use them. Pages not listed here have no section list.
 */
export type PageSection = { readonly id: string; readonly label: string };

export const PAGE_SECTIONS: Readonly<Record<string, readonly PageSection[]>> = {
  "/dashboard": [
    { id: "wallet-overview", label: "Overview" },
    { id: "wallet-activity", label: "Activity" },
    { id: "wallet-spending", label: "Spending" },
    { id: "wallet-sales", label: "Sales" },
    { id: "wallet-profit", label: "Profit" },
    { id: "wallet-forecast", label: "Forecast" },
    { id: "wallet-tax", label: "Tax money" },
    { id: "wallet-receipts", label: "Receipts" },
  ],
  "/plan": [
    { id: "plan-summary", label: "Summary" },
    { id: "plan-safety", label: "Safety limit" },
    { id: "plan-releases", label: "Releases" },
    { id: "plan-pockets", label: "Pockets" },
    { id: "plan-rules", label: "Rules" },
    { id: "plan-signature", label: "Signature" },
  ],
  "/settings": [
    { id: "settings-profile", label: "Profile" },
    { id: "settings-business", label: "Business" },
    { id: "settings-display", label: "Display" },
    { id: "settings-demo", label: "Demo" },
    { id: "settings-security", label: "Security" },
  ],
};

export function sectionsFor(href: string): readonly PageSection[] {
  return PAGE_SECTIONS[href] ?? [];
}

// ---- helpers for the side nav (ux2-nav): links, hashes, and the scroll-spy's choice ---------------------------------

/**
 * Ask the shell to go to a section on the current page: it scrolls there (smooth, instant under reduced motion) and
 * briefly highlights it, exactly as a side-nav click does. Pages dispatch it without importing the shell:
 *   window.dispatchEvent(new CustomEvent(SECTION_JUMP_EVENT, { detail: { id: "wallet-spending" } }))
 * Nothing happens if the id isn't on the page.
 */
export const SECTION_JUMP_EVENT = "hogee:jump-to-section";

/**
 * How long the target carries `data-section-flash` once the jump has landed (app/shell.css draws the highlight): in
 * 150 ms, held 900 ms, faded over 400 ms (components/shell/section-settle.ts FLASH_*; UX round 3).
 */
export const SECTION_FLASH_MS = 1450;

/** A section id as the pages write them: a letter, then letters, digits and dashes. Anything else is not ours. */
const SECTION_ID = /^[A-Za-z][A-Za-z0-9-]{0,79}$/;

/** The id in a location hash ("#plan-rules" → "plan-rules"), or undefined for an empty, malformed or odd one. */
export function sectionIdFromHash(hash: string): string | undefined {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw === "") return undefined;
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  return SECTION_ID.test(id) ? id : undefined;
}

/** The page's own section the hash names, if any (another page's section or any other anchor is not a jump). */
export function sectionForHash(pathname: string, hash: string): PageSection | undefined {
  const id = sectionIdFromHash(hash);
  return id === undefined ? undefined : sectionsFor(pathname).find((s) => s.id === id);
}

export function sectionHref(pageHref: string, id: string): string {
  return `${pageHref}#${id}`;
}

/** One IntersectionObserver entry, reduced to what the spy needs. */
export type SectionIntersection = { readonly id: string; readonly isIntersecting: boolean };

/** The set of ids inside an observer's area after `entries` (a new set; the same one when nothing changed). */
export function applyIntersections(previous: ReadonlySet<string>, entries: readonly SectionIntersection[]): ReadonlySet<string> {
  const changed = entries.some((e) => e.isIntersecting !== previous.has(e.id));
  if (!changed) return previous;
  const next = new Set(previous);
  for (const e of entries) {
    if (e.isIntersecting) next.add(e.id);
    else next.delete(e.id);
  }
  return next;
}

export type SpyState = {
  /** Sections crossing the reading band (under the top bar, the upper part of the screen). */
  readonly inBand: ReadonlySet<string>;
  /** Sections with any part on screen. */
  readonly inView: ReadonlySet<string>;
  /** The end of the page is on screen after a scroll. */
  readonly atEnd: boolean;
  /**
   * The section just jumped to from the nav. It is current at once (while the page is still scrolling to it) and
   * stays current until the person scrolls on their own or it leaves the screen; the caller unpins it then.
   */
  readonly pinned?: string;
};

/**
 * The section the side nav marks as "you are here" (aria-current="location"): the one just jumped to; else, at the end
 * of the page, the last one on screen; else the first, in page order, crossing the reading band; else the first on
 * screen. Nothing on screen marks nothing. Ids not in `order` never count.
 */
export function pickCurrentSection(order: readonly string[], state: SpyState): string | undefined {
  if (state.pinned !== undefined && order.includes(state.pinned)) return state.pinned;
  const onScreen = order.filter((id) => state.inView.has(id));
  if (onScreen.length === 0) return undefined;
  if (state.atEnd) return onScreen[onScreen.length - 1];
  return order.find((id) => state.inBand.has(id) && state.inView.has(id)) ?? onScreen[0];
}
