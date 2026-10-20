"use client";

import * as React from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { COPIED_MS, COPY_FAILED_TEXT, copyStatusText, copyText, type CopyStatus } from "@/components/ui/copy-text";
import { cn } from "@/lib/utils";

// Icon cross-fade (both icons stay in the DOM): opacity, scale and blur as interruptible CSS transitions.
const ICON = "absolute inset-0 size-4 transition-[opacity,scale,filter] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none";
const ICON_ON = "scale-100 opacity-100 blur-0";
const ICON_OFF = "scale-25 opacity-0 blur-[4px]";

type CopyButtonProps = Omit<React.ComponentProps<typeof Button>, "children" | "onClick" | "asChild"> & {
  /** The exact text put on the clipboard. */
  text: string;
  label?: string;
  copiedLabel?: string;
  /** Shown (and announced) when the browser refuses the copy. */
  failedText?: string;
  /** Icon only: the label becomes the accessible name. Defaults the size to "icon". */
  iconOnly?: boolean;
  onCopied?: () => void;
};

/**
 * Copies `text` and says so: "Copied" for two seconds, or a visible hint to select the text by hand when the
 * clipboard is unavailable or refuses. One polite live region carries both, so each is announced once.
 */
function CopyButton({
  text,
  label = "Copy",
  copiedLabel = "Copied",
  failedText = COPY_FAILED_TEXT,
  iconOnly = false,
  onCopied,
  variant = "secondary",
  size,
  className,
  ...props
}: CopyButtonProps) {
  const [status, setStatus] = React.useState<CopyStatus>("idle");

  React.useEffect(() => {
    if (status !== "copied") return;
    const t = setTimeout(() => setStatus("idle"), COPIED_MS);
    return () => clearTimeout(t);
  }, [status]);

  function copy() {
    setStatus("idle");
    // navigator is read on click only, so the module is safe to render on the server.
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    void copyText(text, clipboard).then((outcome) => {
      setStatus(outcome);
      if (outcome === "copied") onCopied?.();
    });
  }

  const copied = status === "copied";
  const shown = copied ? copiedLabel : label;

  return (
    <span data-slot="copy-button" className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <Button
        type="button"
        variant={variant}
        size={size ?? (iconOnly ? "icon" : "sm")}
        aria-label={iconOnly ? shown : undefined}
        title={iconOnly ? shown : undefined}
        className={className}
        onClick={copy}
        {...props}
      >
        <span aria-hidden className="relative size-4">
          <CopyIcon className={cn(ICON, copied ? ICON_OFF : ICON_ON)} />
          <CheckIcon className={cn(ICON, "text-paid", copied ? ICON_ON : ICON_OFF)} />
        </span>
        {iconOnly ? null : shown}
      </Button>
      <span
        role="status"
        aria-live="polite"
        data-slot="copy-button-status"
        className={status === "failed" ? "text-meta text-pretty text-blocked" : "sr-only"}
      >
        {copyStatusText(status, copiedLabel, failedText)}
      </span>
    </span>
  );
}

export { CopyButton };
export type { CopyButtonProps };
