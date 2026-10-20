import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * "Show details": proof one click away (UX-PLAN §1). A native disclosure, so it works without script and the folded
 * content stays in the page (searchable, and read by tests), never removed.
 */
export function ShowDetails({ children, label = "Show details", className, testId }: { children: ReactNode; label?: string; className?: string; testId?: string }) {
  return (
    <details className={cn("group min-w-0 text-footnote text-ink-2", className)} data-testid={testId}>
      <summary className="inline-flex min-h-10 cursor-pointer list-none items-center gap-1.5 rounded-md font-medium text-ink-2 outline-none hover:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-4 text-ink-3 transition-transform duration-(--dur-state) group-open:rotate-90" />
        {label}
      </summary>
      <div className="grid min-w-0 gap-3 pt-1 pb-1">{children}</div>
    </details>
  );
}
