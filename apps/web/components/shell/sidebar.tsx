"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type MouseEvent, type RefObject } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, Landmark, MessageCircle, ScrollText, Settings, ShieldCheck, Wallet, type LucideIcon } from "lucide-react";
import { IconTile } from "@/components/ui/icon-tile";
import type { Tone } from "@/components/ui/tones";
import { useSession } from "@/lib/api/use-session";
import { sectionHref, sectionsFor } from "@/lib/sections";
import { cn } from "@/lib/utils";
import { BrandLink } from "./brand-link";
import { useSectionNav } from "./section-nav";
import { PROOF_HREF, PROOF_TABS, SETTINGS_ROUTE, isActiveRoute, isNavActive, navRoutesFor, type NavRoute } from "./routes";

/**
 * The side nav (P1, UX round 2): a macOS-style sidebar from 900 px, the same list in the phone drawer under it. Each
 * page is a link with an iOS-Settings icon tile, plus its own disclosure button that drops down the page's sections
 * (lib/sections.ts; Proof drops down its two sub-pages). The current page's list starts open; opening another page's
 * list closes any other that isn't the current page's, so the lists fit above Settings (and when they still don't, the
 * list scrolls, with a soft edge where there is more). A section link goes to the page if needed, then scrolls to the
 * section and highlights it (section-nav.tsx); the section in view is marked aria-current="location". Settings is
 * pinned at the foot. Looks: app/shell.css (`shell-*`).
 */

export type SidebarVariant = "rail" | "drawer";

/** Called after any link in the list is used: the drawer closes. `jumpTo` is a section on the page already shown. */
export type OnNavigate = (jumpTo?: string) => void;

/**
 * Each page's tile (ui/icon-tile, DESIGN.md §12): a lucide glyph on a colour with a job. Cobalt is Hogee's agent (the
 * chat), green is money (the wallet); the rest are the neutral ink and grey, like every system row.
 */
const TILES: Record<string, { icon: LucideIcon; tone: Tone }> = {
  "/chat": { icon: MessageCircle, tone: "agent" },
  "/officer": { icon: Landmark, tone: "ink" },
  "/dashboard": { icon: Wallet, tone: "paid" },
  "/plan": { icon: ScrollText, tone: "ink" },
  [PROOF_HREF]: { icon: ShieldCheck, tone: "ink" },
  [SETTINGS_ROUTE.href]: { icon: Settings, tone: "grey" },
};
/** How long a list takes to open (--dur-spring-fast) before the nav scrolls it into view. */
const LIST_OPEN_MS = 420;

type SubLink = { key: string; href: string; label: string; section?: string; current: boolean };

/** What a page's drop-down lists: its sections, or (Proof) its sub-pages. */
function subLinksFor(route: NavRoute, pathname: string, currentSection: string | undefined): SubLink[] {
  if (route.href === PROOF_HREF) {
    return PROOF_TABS.map((tab) => ({ key: tab.href, href: tab.href, label: tab.label, current: isActiveRoute(pathname, tab.href) }));
  }
  const here = pathname === route.href;
  return sectionsFor(route.href).map((s) => ({
    key: s.id,
    href: sectionHref(route.href, s.id),
    label: s.label,
    section: s.id,
    current: here && currentSection === s.id,
  }));
}

const isModified = (e: MouseEvent) => e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;

function NavTile({ href }: { href: string }) {
  const tile = TILES[href];
  return tile ? <IconTile icon={tile.icon} tone={tile.tone} size="sm" /> : null;
}

function NavItem({
  route,
  variant,
  open,
  onToggle,
  onNavigate,
}: {
  route: NavRoute;
  variant: SidebarVariant;
  open: boolean;
  /** Opens or closes the list; `item` is this row, for the nav to bring an opened list into view. */
  onToggle: (item: HTMLElement | null) => void;
  onNavigate?: OnNavigate;
}) {
  const itemRef = useRef<HTMLLIElement>(null);
  const pathname = usePathname();
  const { current, jump } = useSectionNav();
  const listId = useId();
  const active = isNavActive(pathname, route);
  const subs = subLinksFor(route, pathname, current);
  const currentIndex = subs.findIndex((s) => s.current);

  function onSubClick(e: MouseEvent<HTMLAnchorElement>, sub: SubLink) {
    if (isModified(e)) return;
    if (sub.section && pathname === route.href) {
      // Same page: no navigation, just the jump. The URL keeps the section so it can be shared or reloaded.
      e.preventDefault();
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#${sub.section}`);
      if (onNavigate) onNavigate(sub.section);
      else jump(sub.section);
      return;
    }
    // Another page: the link navigates (no scroll of its own); section-nav.tsx jumps once the section is drawn.
    onNavigate?.();
  }

  return (
    <li ref={itemRef} className="shell-item" data-variant={variant}>
      <div className="shell-row">
        <Link href={route.href} aria-current={active ? "page" : undefined} className="shell-link" onClick={() => onNavigate?.()}>
          <NavTile href={route.href} />
          <span className="min-w-0 truncate">{route.label}</span>
        </Link>
        {subs.length > 0 ? (
          <button
            type="button"
            className="shell-disclosure"
            aria-expanded={open}
            aria-controls={listId}
            aria-label={`${route.label} ${route.href === PROOF_HREF ? "pages" : "sections"}`}
            onClick={() => onToggle(itemRef.current)}
          >
            <ChevronRight aria-hidden />
          </button>
        ) : null}
      </div>
      {subs.length > 0 ? (
        <div id={listId} className="shell-sub" data-open={open}>
          <div className="shell-sub-inner" style={{ "--shell-at": Math.max(currentIndex, 0) } as CSSProperties} data-has-current={currentIndex >= 0}>
            {/* One marker that slides to the current row (transform only), over the guide line. */}
            <span aria-hidden className="shell-sub-marker" />
            <ul className="shell-sub-list">
            {subs.map((sub) => (
              <li key={sub.key}>
                <Link
                  href={sub.href}
                  scroll={sub.section ? false : undefined}
                  aria-current={sub.current ? (sub.section ? "location" : "page") : undefined}
                  className="shell-sub-link"
                  onClick={(e) => onSubClick(e, sub)}
                >
                  <span className="min-w-0 truncate">{sub.label}</span>
                </Link>
              </li>
            ))}
            </ul>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Marks the nav while it has more above or below (`data-more`), for the soft scroll edges in app/shell.css. It watches
 * the nav's box and its content's (a list opening or closing), and the nav's scroll.
 */
function useScrollEdges(ref: RefObject<HTMLElement | null>, content: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    const inner = content.current;
    if (!el || !inner) return;
    const update = () => {
      const above = el.scrollTop > 1;
      const below = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      el.dataset.more = above && below ? "both" : above ? "above" : below ? "below" : "none";
    };
    update();
    const resize = new ResizeObserver(update);
    resize.observe(el);
    resize.observe(inner);
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      resize.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, [ref, content]);
}

/** Scrolls the nav (only the nav: the page stays put) so an opened list's last row shows. */
function bringIntoView(nav: HTMLElement | null, item: HTMLElement | null): void {
  if (!nav || !item) return;
  const box = nav.getBoundingClientRect();
  const row = item.getBoundingClientRect();
  if (row.bottom <= box.bottom) return;
  // As far as needed for the last row, never so far that the page's own row goes out the top.
  const by = Math.min(row.bottom - box.bottom + 8, Math.max(0, row.top - box.top - 4));
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  nav.scrollBy({ top: by, behavior: smooth ? "smooth" : "instant" });
}

/**
 * The lists: "Main" (the persona's pages, routes.ts) and Settings at the foot. The disclosure state is the person's
 * once they touch it; until then a list is open exactly while its page is current. Opening one list closes the
 * others, except the current page's.
 */
export function SidebarNav({ variant, onNavigate }: { variant: SidebarVariant; onNavigate?: OnNavigate }) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const routes = session ? navRoutesFor(session.persona) : [];
  const navRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useScrollEdges(navRef, listRef);
  const [chosen, setChosen] = useState<Readonly<Record<string, boolean>>>({});
  // A new page starts from the rule again (its own list open, the rest closed): choices are for the page they were
  // made on, so a list closed while another was opened never stays shut on its own page.
  const [chosenOn, setChosenOn] = useState(pathname);
  if (chosenOn !== pathname) {
    setChosenOn(pathname);
    setChosen({});
  }
  const isOpen = (route: NavRoute) => chosen[route.href] ?? isNavActive(pathname, route);
  const toggle = (route: NavRoute, item: HTMLElement | null) => {
    const opening = !isOpen(route);
    setChosen((prev) => {
      if (!opening) return { ...prev, [route.href]: false };
      const closed = [...routes, SETTINGS_ROUTE].filter((r) => r.href !== route.href && !isNavActive(pathname, r));
      return { ...prev, ...Object.fromEntries(closed.map((r) => [r.href, false])), [route.href]: true };
    });
    if (opening && route !== SETTINGS_ROUTE) window.setTimeout(() => bringIntoView(navRef.current, item), LIST_OPEN_MS);
  };
  const item = (route: NavRoute) => (
    <NavItem key={route.href} route={route} variant={variant} open={isOpen(route)} onToggle={(el) => toggle(route, el)} onNavigate={onNavigate} />
  );

  return (
    <>
      <nav ref={navRef} aria-label="Main" className="shell-nav" data-variant={variant}>
        <div ref={listRef}>
          {routes.length === 0 ? (
            <div aria-hidden className="grid gap-1 px-1 pt-1">
              {[0, 1, 2].map((i) => (
                <span key={i} className="h-10 rounded-[10px] bg-sunk-2/70" />
              ))}
            </div>
          ) : (
            <ul className="grid gap-0.5">{routes.map(item)}</ul>
          )}
        </div>
      </nav>
      <div className="shell-foot" data-variant={variant}>
        <ul className="grid">{item(SETTINGS_ROUTE)}</ul>
      </div>
    </>
  );
}

/** From 900 px: the fixed 248 px sidebar (`w-62`) in the sidebar material; the content column leaves room for it. */
export function Sidebar({ className }: { className?: string }) {
  return (
    <div data-testid="sidebar" className={cn("shell-sidebar material fixed inset-y-0 left-0 z-30 w-62 flex-col", className)}>
      <div className="flex h-14 shrink-0 items-center px-4">
        <BrandLink />
      </div>
      <SidebarNav variant="rail" />
    </div>
  );
}
