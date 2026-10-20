import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The budget-unit disclosure (project.md D4, §14.4; REWRITES A10.17, P1 D22). It keeps all three properties (BU can't
 * be sent, can't be swapped for money, aren't worth a fixed amount of any currency) and who holds the money. Every
 * page shows it once: the footer (one line, the rest one press away: UX round 3), or the chat rail's foot.
 */
export const BU_LEAD = "Amounts are in BU (budget units).";
export const BU_MORE =
  "BU are only Hogee's way of counting your budget. You can't send them to anyone, swap them for money, or count on them being worth a fixed amount of any currency. In real use, a licensed partner bank holds the money; the blockchain only keeps the rules and the record.";
export const BU_NOTE = `${BU_LEAD} ${BU_MORE}`;

/**
 * The footer's line: "Amounts are in BU (budget units). What's a BU?" with the rest behind the press (a native
 * <details>, so it works before hydration and with any assistive tech). The whole line is the 44 px target.
 */
export function BuDisclosure({ className }: { className?: string }) {
  return (
    <details data-testid="bu-note" className={cn("group/bu min-w-0 text-footnote text-ink-3", className)}>
      <summary
        className={cn(
          "-mx-1.5 inline-flex min-h-11 cursor-pointer list-none items-center gap-x-1.5 rounded-lg px-1.5 outline-none select-none [&::-webkit-details-marker]:hidden",
          "transition-[color] duration-(--dur-state) ease-settle hover:text-ink-2 focus-visible:ring-[3px] focus-visible:ring-ring/50",
        )}
      >
        <span>{BU_LEAD}</span>
        <span className="inline-flex items-center gap-0.5 font-medium text-ink-2 underline decoration-line-2 underline-offset-[3px] group-hover/bu:decoration-ink-3">
          What&apos;s a BU?
          <ChevronDown aria-hidden className="size-3.5 transition-[rotate] duration-(--dur-state) ease-settle group-open/bu:rotate-180 motion-reduce:transition-none" />
        </span>
      </summary>
      <p className="max-w-[68ch] pb-1 text-pretty text-ink-2">{BU_MORE}</p>
    </details>
  );
}
