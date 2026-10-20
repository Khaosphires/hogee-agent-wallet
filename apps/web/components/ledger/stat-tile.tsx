import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Stat tile: a card holding one figure (DESIGN.md §12): a 13 px ink-2 label, the value, an optional note. `hero` is
 * the one 44 px figure a view leads with; the others are 28 px. Both are semibold tabular figures, so hierarchy comes
 * from scale. For a figure without its own card (inside a card, a grouped header) use <Stat> from ui/stat.
 */
export function StatTile({ label, value, note, hero = false, testId }: { label: string; value: ReactNode; note?: ReactNode; hero?: boolean; testId?: string }) {
  return (
    <div data-slot="card" data-testid={testId} className="flex h-full flex-col gap-1 rounded-card bg-card p-4 shadow-card sm:p-5">
      <p className="text-footnote font-medium text-ink-2">{label}</p>
      <p className={cn("text-ink [font-variant-numeric:tabular-nums_lining-nums]", hero ? "text-hero" : "text-title-1 font-semibold")}>{value}</p>
      {note ? <p className="mt-auto pt-1 text-footnote text-pretty text-ink-3">{note}</p> : null}
    </div>
  );
}
