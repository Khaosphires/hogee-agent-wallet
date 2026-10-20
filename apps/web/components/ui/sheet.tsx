"use client";

import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import { DialogCloseButton } from "./dialog";
import {
  SPRING_DEFAULT,
  SPRING_DRAWER,
  SPRING_FAST,
  decideRelease,
  releaseVelocity,
  rubberband,
  springAt,
  springSettled,
  type Sample,
  type SpringParams,
} from "./sheet-physics";

/**
 * A sheet: a dialog anchored to an edge (DESIGN.md: radius 20, solid, no blur; a modal task dims to focus). `bottom` is
 * the phone wallet sheet the "Next step · Wallet" strip opens under 1100 px; `top` is the nav menu under 900 px;
 * `right` a side panel. Focus is trapped and Escape closes, as in Dialog.
 *
 * Motion (apple-design): every sheet leaves along the edge it came from, and a re-open mid-exit turns around from where
 * it is. The bottom sheet is a physical object: drag it by its grab handle or header (never by its scrolling body),
 * it tracks the finger 1:1 from where it was grabbed, rubber-bands above open, and on release momentum decides
 * whether it closes or springs back, continuing at the finger's speed (sheet-physics.ts). With reduced motion it
 * cross-fades instead and never springs.
 *
 *   <Sheet open={open} onOpenChange={setOpen}>
 *     <SheetContent side="bottom" aria-describedby={undefined}>
 *       <SheetHeader><SheetTitle>Wallet</SheetTitle></SheetHeader>
 *       …
 *     </SheetContent>
 *   </Sheet>
 */

interface SheetPresence {
  /** What the opener wants: false while the sheet plays its exit (it is still mounted then). */
  readonly visible: boolean;
  /** In the DOM: from the open until the exit has played. */
  readonly mounted: boolean;
  /** The exit has played: unmount it (Radix then returns focus to the opener). */
  readonly onExited: () => void;
  /** Ask the opener to close (a drag that dismisses) or to stay open (a drag that catches a closing sheet). */
  readonly setOpen: (open: boolean) => void;
}

const SheetPresenceContext = React.createContext<SheetPresence | null>(null);

/** Drag handlers for the bottom sheet's header (the grab handle has them too). */
type DragHandlers = Pick<React.HTMLAttributes<HTMLElement>, "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel">;
const SheetDragContext = React.createContext<DragHandlers | null>(null);

/**
 * The root keeps the sheet mounted after the opener closes it until its exit has played, so the exit is ours (a spring
 * that starts at the live position and velocity), not a fixed keyframe Radix waits for. Radix itself closes at once
 * (the content is force-mounted meanwhile), so the focus trap lets go as it used to during an exit: a Next step run
 * from the sheet can move focus into the thread while the sheet is still leaving.
 */
function Sheet({ open: openProp, defaultOpen = false, onOpenChange, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultOpen);
  const open = openProp ?? uncontrolled;
  const [mounted, setMounted] = React.useState(open);
  if (open && !mounted) setMounted(true);

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (openProp === undefined) setUncontrolled(next);
      onOpenChange?.(next);
    },
    [openProp, onOpenChange],
  );
  const onExited = React.useCallback(() => setMounted(false), []);
  const presence = React.useMemo(() => ({ visible: open, mounted, onExited, setOpen }), [open, mounted, onExited, setOpen]);

  return (
    <SheetPresenceContext.Provider value={presence}>
      <DialogPrimitive.Root data-slot="sheet" open={open} onOpenChange={setOpen} {...props}>
        {children}
      </DialogPrimitive.Root>
    </SheetPresenceContext.Provider>
  );
}

function SheetTrigger(props: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose(props: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="sheet-close" {...props} />;
}

function usePresence(): SheetPresence {
  const presence = React.useContext(SheetPresenceContext);
  if (!presence) throw new Error("SheetContent needs a <Sheet> around it");
  return presence;
}

const reducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** An exit that never fires transitionend (never painted, or no transition) still unmounts after this long. */
const EXIT_FALLBACK_MS = 800;

type ContentProps = React.ComponentProps<typeof DialogPrimitive.Content> & { showCloseButton?: boolean };

// ---- top and right: CSS transitions along their edge ----------------------------------------------------------------

const EDGE = {
  // --sheet-from is 100% (0% under reduced motion, which leaves only the cross-fade).
  top: "inset-x-0 top-0 max-h-[100dvh] rounded-b-sheet starting:-translate-y-(--sheet-from) data-[visible=false]:-translate-y-(--sheet-from)",
  right: "inset-y-0 right-0 h-full w-[min(380px,calc(100%-2rem))] rounded-l-sheet starting:translate-x-(--sheet-from) data-[visible=false]:translate-x-(--sheet-from)",
} as const;

function EdgeSheetContent({ side, className, children, showCloseButton = true, ...props }: ContentProps & { side: keyof typeof EDGE }) {
  const { visible, onExited } = usePresence();
  React.useEffect(() => {
    if (visible) return;
    const t = setTimeout(onExited, EXIT_FALLBACK_MS);
    return () => clearTimeout(t);
  }, [visible, onExited]);
  const onTransitionEnd = (e: React.TransitionEvent<HTMLDivElement>) => {
    if (!visible && e.target === e.currentTarget && (e.propertyName === "translate" || e.propertyName === "opacity")) onExited();
  };
  return (
    <DialogPrimitive.Portal forceMount data-slot="sheet-portal">
      <DialogPrimitive.Overlay
        forceMount
        data-slot="sheet-overlay"
        data-visible={visible}
        className="fixed inset-0 z-50 bg-ink/30 transition-opacity duration-(--dur-spring) ease-(--ease-spring) starting:opacity-0 data-[visible=false]:opacity-0"
      />
      <DialogPrimitive.Content
        forceMount
        data-slot="sheet-content"
        data-side={side}
        data-visible={visible}
        onTransitionEnd={onTransitionEnd}
        className={cn(
          "fixed z-50 flex flex-col gap-4 overflow-y-auto overscroll-contain bg-raised p-5 text-ink shadow-pop outline-none",
          "transition-[translate,opacity] duration-(--dur-spring) ease-(--ease-spring) motion-reduce:starting:opacity-0 motion-reduce:data-[visible=false]:opacity-0",
          EDGE[side],
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton ? <DialogCloseButton /> : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

// ---- bottom: the draggable sheet --------------------------------------------------------------------------------------

/** A press on one of these inside the drag zone stays a press: the drag never steals its click. */
const INTERACTIVE = "button, a, input, textarea, select, label, summary, [role=button], [contenteditable=true]";
/** Off-screen: the sheet's own height plus room for its shadow. */
const SHADOW_ROOM = 16;
/** Keep 100 ms of pointer samples (the velocity reads the last 80). */
const SAMPLE_KEEP_MS = 100;

interface Motion {
  /** The sheet's live offset below open (px): what is on screen, the start of any new spring. */
  y: number;
  /** Its live velocity (px/s), handed to the next spring. */
  v: number;
  raf: number;
  /** The next spring follows a drag release: use the drawer spring (the only bounce in the product). */
  momentum: boolean;
  /** The enter has started (React may run the layout effect twice in development). */
  started: boolean;
}

interface Drag {
  readonly id: number;
  readonly downY: number;
  readonly startY: number;
  readonly height: number;
  samples: Sample[];
}

function BottomSheetContent({ className, children, showCloseButton = true, ...props }: ContentProps) {
  const { visible, onExited, setOpen } = usePresence();
  const content = React.useRef<HTMLDivElement>(null);
  const overlay = React.useRef<HTMLDivElement>(null);
  const motion = React.useRef<Motion>({ y: 0, v: 0, raf: 0, momentum: false, started: false });
  const drag = React.useRef<Drag | null>(null);

  /** Draws offset `y`: transform only, and the scrim dims with how much of the sheet is up (skill §1: continuous). */
  const draw = React.useCallback((y: number) => {
    motion.current.y = y;
    const el = content.current;
    if (!el) return;
    el.style.transform = `translate3d(0, ${y}px, 0)`;
    if (overlay.current && !reducedMotion()) {
      const h = el.offsetHeight || 1;
      overlay.current.style.opacity = String(Math.min(1, Math.max(0, 1 - y / h)));
    }
  }, []);

  const stop = React.useCallback(() => cancelAnimationFrame(motion.current.raf), []);
  const hidden = React.useCallback(() => (content.current?.offsetHeight ?? 0) + SHADOW_ROOM, []);

  /** A spring from the live position and velocity to `to` (interruptible: any new one starts from this frame). */
  const springTo = React.useCallback(
    (to: number, params: SpringParams, done?: () => void) => {
      stop();
      const from = motion.current.y;
      const v0 = motion.current.v;
      let start = -1;
      const tick = (now: number) => {
        if (start < 0) start = now;
        const s = springAt((now - start) / 1000, from, to, v0, params);
        motion.current.v = s.velocity;
        // Leaving ends as soon as it is fully off-screen; staying ends at rest.
        if (springSettled(s, to) || (done !== undefined && to > 0 && s.value >= to)) {
          motion.current.v = 0;
          draw(to);
          done?.();
          return;
        }
        draw(s.value);
        motion.current.raf = requestAnimationFrame(tick);
      };
      motion.current.raf = requestAnimationFrame(tick);
    },
    [draw, stop],
  );

  // Enter, exit and every turn-around: the opener's wish (visible) against the live position.
  React.useLayoutEffect(() => {
    const m = motion.current;
    if (reducedMotion()) {
      // A cross-fade (the CSS below), never a slide; the exit's fade ends in onTransitionEnd or the fallback.
      stop();
      draw(0);
      if (visible) return;
      const t = setTimeout(onExited, EXIT_FALLBACK_MS);
      return () => clearTimeout(t);
    }
    if (visible) {
      if (!m.started) {
        m.started = true;
        m.v = 0;
        draw(hidden());
      }
      springTo(0, m.momentum ? SPRING_DRAWER : SPRING_DEFAULT);
    } else {
      springTo(hidden(), m.momentum ? SPRING_DRAWER : SPRING_FAST, onExited);
    }
    m.momentum = false;
    return stop;
  }, [visible, draw, hidden, springTo, stop, onExited]);

  const onTransitionEnd = (e: React.TransitionEvent<HTMLDivElement>) => {
    if (!visible && e.target === e.currentTarget && e.propertyName === "opacity") onExited();
  };

  // ---- the drag (grab handle and header only: the body keeps its own scrolling) -------------------------------------
  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || !e.isPrimary || (e.target as Element).closest(INTERACTIVE)) return;
    const el = content.current;
    if (!el) return;
    // Caught mid-flight: stop where it is, and track from there (skill §3).
    stop();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, downY: e.clientY, startY: motion.current.y, height: el.offsetHeight, samples: [{ t: e.timeStamp, y: e.clientY }] };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    // 1:1 with the finger from where it grabbed; above open the sheet resists (rubber-band, skill §9).
    const raw = d.startY + (e.clientY - d.downY);
    draw(raw >= 0 ? raw : rubberband(raw, d.height));
    d.samples.push({ t: e.timeStamp, y: e.clientY });
    d.samples = d.samples.filter((s) => e.timeStamp - s.t <= SAMPLE_KEEP_MS);
  };

  const onPointerEnd = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    const velocity = e.type === "pointercancel" ? 0 : releaseVelocity(d.samples, e.timeStamp);
    const decision = decideRelease({ offset: motion.current.y, velocity, height: d.height });
    if (reducedMotion()) {
      // No spring: it is back in place at once, or it fades out from where it was let go.
      if (decision === "dismiss") setOpen(false);
      else draw(0);
      return;
    }
    // Hand the finger's speed to the spring (skill §5); a release above open starts from rest.
    motion.current.v = motion.current.y < 0 ? 0 : velocity;
    motion.current.momentum = true;
    if (decision === "dismiss") {
      if (visible) setOpen(false);
      else springTo(hidden(), SPRING_DRAWER, onExited);
    } else if (!visible) {
      setOpen(true);
    } else {
      springTo(0, SPRING_DRAWER);
    }
  };

  const handlers: DragHandlers = { onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd };

  return (
    <DialogPrimitive.Portal forceMount data-slot="sheet-portal">
      <DialogPrimitive.Overlay
        forceMount
        ref={overlay}
        data-slot="sheet-overlay"
        data-visible={visible}
        className="fixed inset-0 z-50 bg-ink/30 motion-reduce:transition-opacity motion-reduce:duration-(--dur-spring) motion-reduce:ease-(--ease-spring) motion-reduce:starting:opacity-0 motion-reduce:data-[visible=false]:opacity-0"
      />
      <DialogPrimitive.Content
        forceMount
        ref={content}
        data-slot="sheet-content"
        data-side="bottom"
        data-visible={visible}
        onTransitionEnd={onTransitionEnd}
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 flex max-h-[min(88dvh,calc(100dvh-3rem))] flex-col rounded-t-sheet bg-raised text-ink shadow-pop outline-none will-change-transform",
          // Below its bottom edge the sheet goes on, so a bounce or a rubber-band never shows a gap under it.
          "after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-[50dvh] after:bg-raised after:content-['']",
          "motion-reduce:transition-opacity motion-reduce:duration-(--dur-spring) motion-reduce:ease-(--ease-spring) motion-reduce:starting:opacity-0 motion-reduce:data-[visible=false]:opacity-0",
          className,
        )}
        {...props}
      >
        {/* The grab handle: drag the sheet down to close it, or let it spring back. Esc and Close still work. */}
        <div
          aria-hidden
          data-slot="sheet-handle"
          data-testid="sheet-handle"
          className="flex h-7 shrink-0 cursor-grab touch-none items-center justify-center select-none active:cursor-grabbing"
          {...handlers}
        >
          <span className="h-[5px] w-10 rounded-full bg-ink-4/70" />
        </div>
        <SheetDragContext.Provider value={handlers}>
          <div data-slot="sheet-body" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-5 pt-1 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
            {children}
          </div>
        </SheetDragContext.Provider>
        {showCloseButton ? <DialogCloseButton /> : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

/** Mounted from the open until the exit has played (Sheet's presence); force-mounted in Radix meanwhile. */
function SheetContent({ side = "bottom", ...props }: ContentProps & { side?: "bottom" | keyof typeof EDGE }) {
  if (!usePresence().mounted) return null;
  return side === "bottom" ? <BottomSheetContent {...props} /> : <EdgeSheetContent side={side} {...props} />;
}

/** In the bottom sheet the header is part of the grab area (with the handle), so a drag there moves the sheet. */
function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  const drag = React.useContext(SheetDragContext);
  return <div data-slot="sheet-header" className={cn("flex flex-col gap-1 pr-10", drag && "touch-none select-none", className)} {...drag} {...props} />;
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="sheet-title" className={cn("text-title", className)} {...props} />;
}

function SheetDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description data-slot="sheet-description" className={cn("text-[0.8125rem] text-ink-2", className)} {...props} />;
}

export { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger };
