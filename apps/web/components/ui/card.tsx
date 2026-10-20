import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The card shell (DESIGN.md §7, §12): a solid white sheet on the grey canvas, `shadow-card` (a hairline ring, a contact
 * shadow and a soft ambient one), 18 px radius (`rounded-card`), 16 px padding (20 from 640 px). Hierarchy inside comes
 * from scale: the title is the 17 px headline, the description a 13 px footnote in ink-2, figures use <Stat>/<Money>.
 *
 * `lifted` marks the one card waiting on Mei: `bg-raised` plus `shadow-lift` on a ::before layer whose opacity fades
 * (600 ms), so lifting and settling never animate a shadow. Never lift two cards at once.
 *
 * Money cards end in <CardStub>; info cards end at their content.
 */
function Card({ className, lifted = false, ...props }: React.ComponentProps<"div"> & { lifted?: boolean }) {
  return (
    <div
      data-slot="card"
      data-lifted={lifted || undefined}
      className={cn(
        "relative isolate flex flex-col gap-4 rounded-xl bg-card py-4 text-card-foreground shadow-card sm:py-5",
        "before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] before:opacity-0 before:shadow-lift before:transition-opacity before:duration-(--dur-seal) before:ease-settle before:content-['']",
        "data-[lifted=true]:bg-raised data-[lifted=true]:before:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        // Under 440 px the action (one pill) drops under the title, so a phone keeps the title's full width.
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-x-3 gap-y-1 px-4 sm:px-5 min-[440px]:has-data-[slot=card-action]:grid-cols-[minmax(0,1fr)_auto] [.border-b]:pb-4",
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-title" className={cn("text-title text-balance", className)} {...props} />;
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-description" className={cn("text-footnote text-pretty text-ink-2", className)} {...props} />;
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn("mt-1.5 self-start justify-self-start min-[440px]:col-start-2 min-[440px]:row-span-2 min-[440px]:row-start-1 min-[440px]:mt-0 min-[440px]:justify-self-end", className)}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("px-4 sm:px-5", className)} {...props} />;
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-footer" className={cn("flex items-center px-4 sm:px-5 [.border-t]:pt-4", className)} {...props} />;
}

/**
 * The stub: a money card's perforated foot (DESIGN.md §7), full bleed on `bg-canvas` under a dashed edge with a
 * 14 px notch at each end. Put it last inside a <Card>. It is never empty: pending ("What you're signing" + Sign),
 * signed (the seal, signer, time, tx; see sign/seal-stub) or paid ("Payment record", line usage, tx).
 */
function CardStub({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-stub"
      className={cn("stub -mb-4 flex flex-wrap items-center gap-x-3.5 gap-y-3 px-4 py-4 sm:-mb-5 sm:px-5", className)}
      {...props}
    />
  );
}

export { Card, CardHeader, CardFooter, CardTitle, CardAction, CardDescription, CardContent, CardStub };
