/**
 * When a section jump has landed (UX round 3, pure so it can be tested): the side nav scrolls to a section, waits for
 * the scroll to end (`scrollend`, or 700 ms with no word from the browser), checks the section really sits under the
 * top bar (a page that grows while it loads pushes it down; a scroll can be cut short), scrolls again if not, and only
 * then highlights it. When the page grows under a scroll on its way, the scroll turns toward the section's new place at
 * once (a smooth scroll re-aims from where it is), instead of finishing short and starting over. After the highlight it keeps the section in place until the cap, so data that lands late doesn't
 * carry it off. section-jump.ts runs this once per animation frame.
 */

/** The highlight: in quickly, held, then faded (app/shell.css `section-flash` uses the same numbers). */
export const FLASH_IN_MS = 150;
export const FLASH_HOLD_MS = 900;
export const FLASH_OUT_MS = 400;
export const FLASH_TOTAL_MS = FLASH_IN_MS + FLASH_HOLD_MS + FLASH_OUT_MS;

/** A browser without `scrollend` (older Safari): a scroll counts as over this long after it was asked for. */
export const SCROLL_END_FALLBACK_MS = 700;
/** How long a jump may keep correcting itself, from the click. */
export const SETTLE_CAP_MS = 1500;
/** Past this, the highlight shows wherever the section is, even if the page never stops moving. */
const HARD_STOP_MS = 2 * SETTLE_CAP_MS;
/** How still the page must be before the jump counts as landed: a page on screen, and one that has just opened. */
export const QUIET_SAME_PAGE_MS = 100;
export const QUIET_ARRIVING_MS = 200;
/** How close to its place the section's top must be. */
export const PLACE_TOLERANCE_PX = 4;
const MAX_RESCROLLS = 6;
/** The section moved this far in the page (data landed above it): the scroll turns toward its new place at once. */
const GROWTH_PX = 24;
/** At most one turn this often, so a page that keeps shifting can't restart the scroll every frame. */
const RETARGET_GAP_MS = 120;
/** Smaller moves than this are rounding, not motion. */
const MOTION_PX = 0.5;

/** One frame's reading of the page and the section. */
export interface SettleSample {
  readonly now: number;
  readonly scrollY: number;
  /** The furthest the page can scroll down. */
  readonly maxScrollY: number;
  /** The section's top, from the top of the viewport. */
  readonly top: number;
  /** Where a jump puts that top (the section's scroll-margin-top, clear of the top bar). */
  readonly marginTop: number;
  /** The browser said the last scroll ended (`scrollend`) since the jump last scrolled. */
  readonly scrollEnded: boolean;
}

export interface SettleState {
  readonly startedAt: number;
  /** When the jump last asked for a scroll. */
  readonly scrolledAt: number;
  readonly lastScrollY: number;
  /** The section's top in the document (moves when the page above it grows or shrinks). */
  readonly lastDocTop: number;
  /** Since when neither the page nor the section has moved. */
  readonly stillSince: number;
  readonly retries: number;
  readonly flashedAt?: number;
}

/** What to do this frame: keep watching, scroll to the section again, start the highlight, or stop watching. */
export type SettleAction = "wait" | "rescroll" | "flash" | "done";

/** The section sits where a jump puts it, or as close as the page can scroll (its end below it, its top above it). */
export function isInPlace(s: Pick<SettleSample, "top" | "marginTop" | "scrollY" | "maxScrollY">, tolerance = PLACE_TOLERANCE_PX): boolean {
  const off = s.top - s.marginTop;
  if (Math.abs(off) <= tolerance) return true;
  if (off > 0 && s.scrollY >= s.maxScrollY - 1) return true;
  return off < 0 && s.scrollY <= 0;
}

export function settleStart(now: number, s: Pick<SettleSample, "top" | "scrollY">): SettleState {
  return { startedAt: now, scrolledAt: now, lastScrollY: s.scrollY, lastDocTop: s.top + s.scrollY, stillSince: now, retries: 0 };
}

/** One frame of the jump. The returned state already records a rescroll or the highlight's start. */
export function settleStep(state: SettleState, s: SettleSample, quietMs: number): { state: SettleState; action: SettleAction } {
  const docTop = s.top + s.scrollY;
  const moving = Math.abs(s.scrollY - state.lastScrollY) > MOTION_PX || Math.abs(docTop - state.lastDocTop) > MOTION_PX;
  const stillSince = moving ? s.now : state.stillSince;
  const next: SettleState = { ...state, lastScrollY: s.scrollY, lastDocTop: docTop, stillSince };
  const elapsed = s.now - state.startedAt;
  const quiet = s.now - stillSince >= quietMs;
  const inPlace = isInPlace(s);
  const scrollOver = s.scrollEnded || s.now - state.scrolledAt >= SCROLL_END_FALLBACK_MS;
  const mayRescroll = elapsed < SETTLE_CAP_MS && state.retries < MAX_RESCROLLS;
  const rescroll = { state: { ...next, scrolledAt: s.now, retries: state.retries + 1, stillSince: s.now }, action: "rescroll" as const };

  if (state.flashedAt !== undefined) {
    if (elapsed >= SETTLE_CAP_MS) return { state: next, action: "done" };
    if (quiet && !inPlace && scrollOver && mayRescroll) return rescroll;
    return { state: next, action: "wait" };
  }

  const flash = { state: { ...next, flashedAt: s.now }, action: "flash" as const };
  if (elapsed >= HARD_STOP_MS) return flash;
  const grew = Math.abs(docTop - state.lastDocTop) > GROWTH_PX;
  if (grew && !inPlace && mayRescroll && s.now - state.scrolledAt >= RETARGET_GAP_MS) return rescroll;
  if (!quiet) return { state: next, action: "wait" };
  if (inPlace) return flash;
  if (!scrollOver) return { state: next, action: "wait" };
  return mayRescroll ? rescroll : flash;
}
