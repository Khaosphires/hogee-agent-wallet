import {
  FLASH_TOTAL_MS,
  QUIET_ARRIVING_MS,
  QUIET_SAME_PAGE_MS,
  settleStart,
  settleStep,
  type SettleSample,
  type SettleState,
} from "./section-settle";

/**
 * Going to a section (the side nav, a #section in the address, or SECTION_JUMP_EVENT): scroll it into view clear of
 * the top bar (`scroll-margin-top`, app/shell.css), move focus into it as a skip link would, and once it has landed
 * (section-settle.ts: the scroll has ended, the page has stopped growing, a short scroll is made good) mark it with
 * `data-section-flash` for FLASH_TOTAL_MS so app/shell.css draws the highlight. Smooth scrolling, except instant under
 * reduced motion. One jump at a time: a new one replaces the last mid-way. Browser-only; nothing here throws when the
 * section isn't on the page.
 */

const flashTimers = new WeakMap<HTMLElement, number>();
/** Wheel events this soon after the click are the trackpad's momentum from before it, not a new scroll. */
const WHEEL_GRACE_MS = 600;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

const reducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Marks `el` for FLASH_TOTAL_MS. Picking the same section again mid-glow starts the glow over. */
export function flashSection(el: HTMLElement): void {
  const pending = flashTimers.get(el);
  if (pending !== undefined) window.clearTimeout(pending);
  el.removeAttribute("data-section-flash");
  // Read layout once so the CSS animation restarts from its first frame instead of carrying on.
  void el.offsetWidth;
  el.setAttribute("data-section-flash", "");
  const timer = window.setTimeout(() => {
    el.removeAttribute("data-section-flash");
    flashTimers.delete(el);
  }, FLASH_TOTAL_MS);
  flashTimers.set(el, timer);
}

/** A section isn't focusable; -1 lets focus land in it without adding it to the tab order (app/shell.css hides the ring). */
function focusSection(el: HTMLElement): void {
  if (!el.hasAttribute("tabindex")) {
    el.setAttribute("tabindex", "-1");
    el.setAttribute("data-section-target", "");
  }
  el.focus({ preventScroll: true });
}

function sample(el: HTMLElement, scrollEnded: boolean): SettleSample {
  const root = document.documentElement;
  return {
    now: performance.now(),
    scrollY: window.scrollY,
    maxScrollY: Math.max(0, root.scrollHeight - window.innerHeight),
    top: el.getBoundingClientRect().top,
    marginTop: Number.parseFloat(getComputedStyle(el).scrollMarginTop) || 0,
    scrollEnded,
  };
}

let cancelActive: (() => void) | undefined;

/**
 * Scrolls to, focuses and (once landed) flashes the element with this id. `arriving`: the page has just opened and may
 * still be drawing, so it must be still for longer before the jump counts as landed. False (and nothing done) when
 * the id isn't on the page.
 */
export function jumpToSection(id: string, { arriving = false }: { arriving?: boolean } = {}): boolean {
  const first = document.getElementById(id);
  if (!first) return false;
  cancelActive?.();

  // A page may draw the section again (a skeleton replaced by the real one): always work on the one on the page now.
  const current = (): HTMLElement => {
    const el = document.getElementById(id);
    return el && el.isConnected ? el : first;
  };
  const behavior: ScrollBehavior = reducedMotion() ? "instant" : "smooth";
  const scroll = () => current().scrollIntoView({ behavior, block: "start" });
  const quietMs = arriving ? QUIET_ARRIVING_MS : QUIET_SAME_PAGE_MS;

  focusSection(first);
  scroll();
  const started = performance.now();
  let state: SettleState = settleStart(started, sample(first, false));
  let scrollEnded = false;
  let frame = 0;
  let flashed = false;

  const flashNow = () => {
    if (flashed) return;
    flashed = true;
    const el = current();
    // Focus followed the old element out of the page: put it back where the jump went.
    if (!first.isConnected || document.activeElement === document.body) focusSection(el);
    flashSection(el);
  };
  const stop = () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("scrollend", onScrollEnd);
    window.removeEventListener("wheel", onWheel);
    window.removeEventListener("touchstart", onTakeOver);
    window.removeEventListener("keydown", onKey);
    if (cancelActive === stop) cancelActive = undefined;
  };
  // The person scrolls on their own: stop steering the page, and show where the jump went if it hasn't yet.
  function onTakeOver() {
    stop();
    flashNow();
  }
  function onWheel() {
    if (performance.now() - started > WHEEL_GRACE_MS) onTakeOver();
  }
  function onKey(e: KeyboardEvent) {
    if (SCROLL_KEYS.has(e.key)) onTakeOver();
  }
  function onScrollEnd() {
    scrollEnded = true;
  }
  const tick = () => {
    const step = settleStep(state, sample(current(), scrollEnded), quietMs);
    state = step.state;
    if (step.action === "rescroll") {
      scrollEnded = false;
      scroll();
    } else if (step.action === "flash") {
      flashNow();
    } else if (step.action === "done") {
      stop();
      return;
    }
    frame = requestAnimationFrame(tick);
  };

  window.addEventListener("scrollend", onScrollEnd, { passive: true });
  window.addEventListener("wheel", onWheel, { passive: true });
  window.addEventListener("touchstart", onTakeOver, { passive: true });
  window.addEventListener("keydown", onKey);
  cancelActive = stop;
  frame = requestAnimationFrame(tick);
  return true;
}

/**
 * Calls `found` with the element once it is on the page (a page may draw its sections after its data loads), or never
 * if it doesn't appear within `timeoutMs`. Returns a cancel function.
 */
export function whenElement(id: string, timeoutMs: number, found: (el: HTMLElement) => void): () => void {
  const now = document.getElementById(id);
  if (now) {
    found(now);
    return () => undefined;
  }
  let done = false;
  const observer = new MutationObserver(() => {
    const el = document.getElementById(id);
    if (!el) return;
    stop();
    found(el);
  });
  const timer = window.setTimeout(stop, timeoutMs);
  function stop() {
    if (done) return;
    done = true;
    observer.disconnect();
    window.clearTimeout(timer);
  }
  observer.observe(document.body, { childList: true, subtree: true });
  return stop;
}
