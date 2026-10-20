import { Tag } from "@/components/ui/pill";
import { cn } from "@/lib/utils";
import { buDelta, moneyParts } from "./money-parts";

/**
 * What a new signature changes on one amount (DESIGN.md §7, needs v2 rows): the old value struck through in ink-3, then
 * a 20 px tag with the change ("+300", "−300"). The new amount is printed by the caller, usually right after.
 * The struck value is read as "was 1,200 BU" so the change isn't only visual.
 *
 *   <ChangeChip fromMinor="120000" toMinor="150000" /> <Money minor="150000" />
 */
export function ChangeChip({ fromMinor, toMinor, className }: { fromMinor: string; toMinor: string; className?: string }) {
  const was = moneyParts(fromMinor).figure;
  return (
    <span data-slot="change-chip" className={cn("inline-flex items-center gap-1.5", className)}>
      <s className="text-[0.78125rem] text-ink-3 tabular-nums decoration-ink-3">
        <span className="sr-only">was </span>
        {was}
        <span className="sr-only"> BU</span>
      </s>
      <Tag className="tabular-nums text-ink">{buDelta(fromMinor, toMinor)}</Tag>
    </span>
  );
}
