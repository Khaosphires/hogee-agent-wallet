"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import {
  SECTION_JUMP_EVENT,
  applyIntersections,
  pickCurrentSection,
  sectionForHash,
  sectionIdFromHash,
  sectionsFor,
  type SectionIntersection,
} from "@/lib/sections";
import { jumpToSection, whenElement } from "./section-jump";

/** The top bar (h-14): sections under it are not "on screen". */
const BAR_PX = 56;
/** The reading band: from just under the bar down to 40 % of the screen. */
const BAND_MARGIN = `-${BAR_PX + 16}px 0px -60% 0px`;
const VIEW_MARGIN = `-${BAR_PX}px 0px 0px 0px`;
/** How long a page arrived at with a #section may take to draw that section before the jump is dropped. */
const ARRIVE_TIMEOUT_MS = 6000;
/** Keys that scroll the page: pressing one hands "you are here" back to the scroll-spy. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

interface SectionNav {
  /** The current page's section in view (the side nav marks it aria-current="location"). */
  readonly current?: string;
  /**
   * Go to a section on this page: scroll, focus, and highlight once it has landed (section-jump.ts). `arriving`: the
   * page has just opened and may still be growing. Does nothing if it isn't on the page.
   */
  readonly jump: (id: string, options?: { arriving?: boolean }) => void;
}

const SectionNavContext = createContext<SectionNav>({ current: undefined, jump: () => undefined });

export const useSectionNav = (): SectionNav => useContext(SectionNavContext);

const toIntersections = (entries: IntersectionObserverEntry[]): SectionIntersection[] =>
  entries.map((e) => ({ id: (e.target as HTMLElement).id, isIntersecting: e.isIntersecting }));

/**
 * The scroll-spy and the section jumps for the whole shell (one instance serves the sidebar and the phone drawer).
 * The spy is IntersectionObservers only, no scroll handler: one for the reading band, one for "on screen", one for the
 * end of the page (`[data-shell-end]`, shell-frame.tsx); the choice is lib/sections.ts `pickCurrentSection`. Sections a
 * page draws later (after its data loads) are picked up by a MutationObserver. A jump also arrives from a #section in
 * the URL (a direct visit or another page's section link), a `hashchange`, or SECTION_JUMP_EVENT.
 */
export function SectionNavProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const order = useMemo(() => sectionsFor(pathname).map((s) => s.id), [pathname]);
  const [current, setCurrent] = useState<string>();
  const pinned = useRef<string | undefined>(undefined);
  const recompute = useRef<() => void>(() => undefined);

  useEffect(() => {
    setCurrent(undefined);
    pinned.current = undefined;
    if (order.length === 0) return;
    let inBand: ReadonlySet<string> = new Set();
    let inView: ReadonlySet<string> = new Set();
    let atEnd = false;
    const pick = () => setCurrent(pickCurrentSection(order, { inBand, inView, atEnd, pinned: pinned.current }));
    recompute.current = pick;

    const band = new IntersectionObserver((entries) => {
      inBand = applyIntersections(inBand, toIntersections(entries));
      pick();
    }, { rootMargin: BAND_MARGIN });
    const view = new IntersectionObserver((entries) => {
      const before = inView;
      inView = applyIntersections(inView, toIntersections(entries));
      // The section jumped to has scrolled off: the spy decides again.
      if (pinned.current !== undefined && before.has(pinned.current) && !inView.has(pinned.current)) pinned.current = undefined;
      pick();
    }, { rootMargin: VIEW_MARGIN });
    const end = new IntersectionObserver(([entry]) => {
      atEnd = (entry?.isIntersecting ?? false) && window.scrollY > 0;
      pick();
    });

    const observed = new Map<string, HTMLElement>();
    const attach = () => {
      for (const id of order) {
        const el = document.getElementById(id) ?? undefined;
        const was = observed.get(id);
        if (el === was) continue;
        if (was) {
          band.unobserve(was);
          view.unobserve(was);
          inBand = applyIntersections(inBand, [{ id, isIntersecting: false }]);
          inView = applyIntersections(inView, [{ id, isIntersecting: false }]);
          observed.delete(id);
        }
        if (el) {
          band.observe(el);
          view.observe(el);
          observed.set(id, el);
        }
      }
    };
    attach();
    const endMark = document.querySelector("[data-shell-end]");
    if (endMark) end.observe(endMark);
    let frame = 0;
    const mutations = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(attach);
    });
    mutations.observe(document.querySelector("main") ?? document.body, { childList: true, subtree: true });

    // A person scrolling (wheel, touch, keys) takes "you are here" back from the jump. Input events, not scroll events.
    const release = () => {
      if (pinned.current === undefined) return;
      pinned.current = undefined;
      pick();
    };
    const onKey = (e: KeyboardEvent) => {
      if (SCROLL_KEYS.has(e.key)) release();
    };
    window.addEventListener("wheel", release, { passive: true });
    window.addEventListener("touchmove", release, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      band.disconnect();
      view.disconnect();
      end.disconnect();
      mutations.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("wheel", release);
      window.removeEventListener("touchmove", release);
      window.removeEventListener("keydown", onKey);
      recompute.current = () => undefined;
    };
  }, [order]);

  const jump = useCallback((id: string, options?: { arriving?: boolean }) => {
    if (!jumpToSection(id, options)) return;
    pinned.current = id;
    recompute.current();
  }, []);

  // Arriving with #section (a direct visit to /plan#plan-rules, or another page's section link): jump once the page
  // has drawn that section; give up quietly if it never does. The page may still be growing as its data and charts
  // land, so the jump waits for it to keep still and scrolls again if the section moved (section-settle.ts).
  useEffect(() => {
    const section = sectionForHash(pathname, window.location.hash);
    if (!section) return;
    let frame = 0;
    const cancel = whenElement(section.id, ARRIVE_TIMEOUT_MS, () => {
      // Two frames: the rest of the page drawn in the same pass has laid out, so the scroll lands where it should.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => jump(section.id, { arriving: true }));
      });
    });
    return () => {
      cancel();
      cancelAnimationFrame(frame);
    };
  }, [pathname, jump]);

  useEffect(() => {
    const onHash = () => {
      const section = sectionForHash(window.location.pathname, window.location.hash);
      if (section) jump(section.id);
    };
    const onRequest = (event: Event) => {
      const detail: unknown = (event as CustomEvent<unknown>).detail;
      const id = typeof detail === "object" && detail !== null && "id" in detail ? detail.id : undefined;
      if (typeof id === "string" && sectionIdFromHash(id) === id) jump(id);
    };
    window.addEventListener("hashchange", onHash);
    window.addEventListener(SECTION_JUMP_EVENT, onRequest);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener(SECTION_JUMP_EVENT, onRequest);
    };
  }, [jump]);

  const value = useMemo<SectionNav>(() => ({ current, jump }), [current, jump]);
  return <SectionNavContext.Provider value={value}>{children}</SectionNavContext.Provider>;
}
