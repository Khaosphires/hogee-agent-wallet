"use client";

import { useEffect, useRef, useState, type TransitionEvent } from "react";
import { PanelLeft } from "lucide-react";
import { Dialog } from "radix-ui";
import { Button } from "@/components/ui/button";
import { DialogCloseButton } from "@/components/ui/dialog";
import { BrandLink } from "./brand-link";
import { useSectionNav } from "./section-nav";
import { SidebarNav } from "./sidebar";

/** An exit that never fires transitionend (never painted, or no transition) still unmounts after this long. */
const EXIT_FALLBACK_MS = 800;
const WIDE = "(min-width: 900px)";

/**
 * Under 900 px the side nav is a drawer from the left (P1, UX round 2), opened by the button at the top left of the
 * bar. It is a modal (scrim, focus trapped, Esc and the scrim close it) and solid like every sheet (DESIGN.md §5). It
 * slides in from the left on the default spring and goes back the same way; a re-open mid-exit turns around from
 * where it is (CSS transitions, app/shell.css); reduced motion cross-fades. Any link in it closes it: a page link
 * navigates, and a section on this page is jumped to while the drawer slides away. It stays mounted only from open
 * until its exit has played, so the page never has two "Main" navs at rest.
 *
 * Built here rather than with components/ui/sheet.tsx, which has no `side="left"` (ux2-nav may not edit ui/*).
 */
export function NavDrawer({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  if (open && !mounted) setMounted(true);
  const { jump } = useSectionNav();
  // Closed by a navigation: focus goes to the page (or the section), not back to the menu button.
  const navigated = useRef(false);

  // At 900 px and up the sidebar is back: a drawer left open closes with it.
  useEffect(() => {
    const wide = window.matchMedia(WIDE);
    const onChange = () => {
      if (wide.matches) setOpen(false);
    };
    wide.addEventListener("change", onChange);
    return () => wide.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (open || !mounted) return;
    const t = setTimeout(() => setMounted(false), EXIT_FALLBACK_MS);
    return () => clearTimeout(t);
  }, [open, mounted]);

  function onNavigate(jumpTo?: string) {
    navigated.current = true;
    setOpen(false);
    if (jumpTo) jump(jumpTo);
  }

  function onTransitionEnd(e: TransitionEvent<HTMLDivElement>) {
    if (!open && e.target === e.currentTarget && (e.propertyName === "translate" || e.propertyName === "opacity")) setMounted(false);
  }

  return (
    <div className={className}>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Open menu"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="size-11"
        onClick={() => {
          navigated.current = false;
          setOpen(true);
        }}
      >
        <PanelLeft className="size-[1.15rem]" />
      </Button>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        {mounted ? (
          <Dialog.Portal forceMount>
            <Dialog.Overlay forceMount data-visible={open} className="shell-scrim fixed inset-0 z-50 bg-ink/30" />
            <Dialog.Content
              forceMount
              data-visible={open}
              data-testid="nav-drawer"
              onTransitionEnd={onTransitionEnd}
              onCloseAutoFocus={(e) => {
                if (navigated.current) e.preventDefault();
              }}
              className="shell-drawer fixed inset-y-0 left-0 z-50 flex w-[min(300px,calc(100%-3.5rem))] flex-col overflow-y-auto overscroll-contain rounded-r-2xl text-ink shadow-pop outline-none"
            >
              <Dialog.Title className="sr-only">Menu</Dialog.Title>
              <Dialog.Description className="sr-only">The pages, each with its sections, and Settings.</Dialog.Description>
              <div className="flex h-14 shrink-0 items-center pr-14 pl-4">
                <BrandLink onClick={() => onNavigate()} />
              </div>
              <SidebarNav variant="drawer" onNavigate={onNavigate} />
              <DialogCloseButton className="top-2" />
            </Dialog.Content>
          </Dialog.Portal>
        ) : null}
      </Dialog.Root>
    </div>
  );
}
