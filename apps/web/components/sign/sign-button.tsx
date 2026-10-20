"use client";

import * as React from "react";
import { Fingerprint } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const LAYER = "col-start-1 row-start-1 inline-flex items-center justify-center gap-2 transition-[opacity,translate] duration-(--dur-state) ease-settle motion-reduce:translate-y-0";
// The one loop in the product; with reduced motion the mark holds still (the label still says what is happening).
const BREATHE = "animate-breathe motion-reduce:animate-none";

/**
 * The primary sign button (DESIGN.md §4): while the passkey prompt is open its label cross-fades to "Waiting for your passkey…" and
 * the fingerprint breathes in opacity, the one loop in the product. Both labels stay in the DOM (stacked in one grid
 * cell, so the width never jumps); the hidden one is aria-hidden, so the accessible name is always the shown label.
 *
 *   <SignButton busy={busy === "sign"} onClick={sign} disabled={!canSign}>Sign with passkey</SignButton>
 */
function SignButton({
  busy,
  busyLabel = "Waiting for your passkey…",
  icon,
  children,
  className,
  size = "lg",
  ...props
}: Omit<React.ComponentProps<typeof Button>, "variant"> & {
  busy: boolean;
  busyLabel?: string;
  /** Replaces the fingerprint (e.g. a wallet icon for MetaMask); it breathes while busy too. */
  icon?: React.ReactElement<{ className?: string }>;
}) {
  const mark = (breathing: boolean) =>
    icon ? (
      React.cloneElement(icon, { className: cn(icon.props.className, breathing && BREATHE) })
    ) : (
      <Fingerprint aria-hidden className={breathing ? BREATHE : undefined} />
    );
  return (
    <Button size={size} data-busy={busy || undefined} aria-busy={busy || undefined} className={cn("grid", className)} {...props}>
      <span aria-hidden={busy || undefined} className={cn(LAYER, busy && "-translate-y-1 opacity-0")}>
        {mark(false)}
        {children}
      </span>
      <span aria-hidden={!busy || undefined} className={cn(LAYER, !busy && "translate-y-1 opacity-0")}>
        {mark(busy)}
        {busyLabel}
      </span>
    </Button>
  );
}

export { SignButton };
