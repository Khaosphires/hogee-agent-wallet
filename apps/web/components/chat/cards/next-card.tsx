"use client";

import { Check } from "lucide-react";
import type { DataNext } from "@hogee/core";
import { repeatsBar } from "@/lib/next-step";
import { cn } from "@/lib/utils";
import { useJourneyThread } from "../journey-context";
import type { CardProps } from "./types";

/**
 * Next-step buttons (1–4, the server's preferred step first; DESIGN.md §7: all `rounded-full` 40 px secondary). Each sends its structured action (the label only shows in the
 * founder's bubble). Once a later message exists the buttons go quiet, and the one the founder pressed stays marked (visually
 * only: their own bubble already says it, and the accessible name stays the label). While the buttons are live, one that
 * repeats the Next step bar's is left out: the bar already offers it (UX round 3 #4, each step said once).
 */
export function NextCard({ data, answered, act }: CardProps<DataNext>) {
  const { chosenActionIds, barAction } = useJourneyThread();
  const shown = answered ? data.actions : data.actions.filter(({ action }) => !repeatsBar(barAction, action));
  if (shown.length === 0) return null;
  return (
    <div role="group" aria-label="Next steps" data-testid="card-next" className="flex flex-wrap gap-2">
      {shown.map(({ label, action }) => {
        const chosen = chosenActionIds.has(action.actionId);
        return (
          <button
            key={action.actionId}
            type="button"
            data-testid="next-action"
            data-action-type={action.type}
            data-chosen={chosen ? "true" : undefined}
            disabled={answered}
            onClick={() => act(action, label)}
            className={cn(
              "inline-flex h-10 max-w-full items-center gap-1.5 rounded-full px-4 text-ui font-medium whitespace-nowrap outline-none",
              "transition-[background-color,color,box-shadow,scale] duration-(--dur-press) ease-settle focus-visible:ring-[3px] focus-visible:ring-ring/50",
              "active:scale-(--press) enabled:active:bg-sunk disabled:cursor-default disabled:active:scale-100",
              "bg-raised text-ink shadow-[0_0_0_1px_var(--line-2),0_1px_2px_oklch(0.235_0.028_262/0.05)] enabled:hover:bg-canvas",
              answered && !chosen && "text-ink-3",
              chosen && "bg-sunk shadow-[0_0_0_1px_var(--line)]",
            )}
          >
            {chosen ? <Check aria-hidden className="size-4" /> : null}
            <span className="truncate">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
