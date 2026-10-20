"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * The top bar as a material (DESIGN.md §5, apple-design): translucent with a blur, a bright 1 px top edge, and content
 * scrolling under it. Instead of a permanent line, the scroll edge (a hairline and a soft shade, globals.css
 * `scroll-edge`) shows only while content is under the bar: an IntersectionObserver on a 1 px sentinel at the top of
 * the document sets `data-scrolled` on <html> (no scroll handler). The wallet strip under the bar on the phone chat
 * reads the same flag.
 */
export function TopBar({ children }: { children: ReactNode }) {
  const sentinel = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const root = document.documentElement;
    const io = new IntersectionObserver(([entry]) => {
      root.dataset.scrolled = String(entry ? !entry.isIntersecting : false);
    });
    io.observe(el);
    return () => {
      io.disconnect();
      delete root.dataset.scrolled;
    };
  }, []);
  return (
    <>
      <span ref={sentinel} aria-hidden className="pointer-events-none absolute top-0 left-0 h-px w-px" />
      <header className="material scroll-edge sticky top-0 z-40 shadow-[inset_0_1px_0_var(--material-highlight)]">{children}</header>
    </>
  );
}
