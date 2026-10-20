"use client";

import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { XIcon } from "lucide-react";
import { cn } from "@/lib/utils";

function Dialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger(props: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal(props: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose(props: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

/**
 * An ink scrim, no blur (DESIGN.md §5: the material is for floating chrome only; a modal task dims to focus). It fades
 * on an interruptible transition (`scrim` in globals.css) and stays mounted until its fade-out has played.
 */
function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return <DialogPrimitive.Overlay data-slot="dialog-overlay" className={cn("scrim fixed inset-0 z-50 bg-ink/35", className)} {...props} />;
}

/** The close button every dialog and sheet uses: a 30 px round fill (iOS) inside a 40 × 40 hit area. */
function DialogCloseButton({ className }: { className?: string }) {
  return (
    <DialogPrimitive.Close
      data-slot="dialog-close"
      className={cn(
        "group/close absolute top-3 right-3 grid size-10 place-items-center rounded-full text-ink-2 transition-[color,scale] duration-(--dur-state) ease-settle outline-none hover:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/50 active:scale-(--press) active:duration-(--dur-press) disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:relative [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:stroke-[2.25]",
        "before:absolute before:size-[30px] before:rounded-full before:bg-fill-strong before:transition-[background-color] before:duration-(--dur-state) before:content-[''] hover:before:bg-sunk-2",
        className,
      )}
    >
      <XIcon />
      <span className="sr-only">Close</span>
    </DialogPrimitive.Close>
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { showCloseButton?: boolean }) {
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed top-[50%] left-[50%] z-50 grid max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto overscroll-contain rounded-sheet bg-raised p-5 text-ink shadow-pop outline-none sm:max-w-lg sm:p-6",
          // Grows from 0.96 at its centre on the default spring, and shrinks back the same way (globals.css pop-surface).
          "pop-surface",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton ? <DialogCloseButton /> : null}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-header" className={cn("flex flex-col gap-1.5 pr-10 text-left", className)} {...props} />;
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-footer" className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />;
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn("text-title-3 text-balance", className)} {...props} />;
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description data-slot="dialog-description" className={cn("text-subhead text-pretty text-ink-2", className)} {...props} />;
}

export { Dialog, DialogClose, DialogCloseButton, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogOverlay, DialogPortal, DialogTitle, DialogTrigger };
