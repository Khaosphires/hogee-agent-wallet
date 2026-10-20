import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { IconTile } from "@/components/ui/icon-tile";
import { slotTone } from "@/components/ui/tones";
import { pctOf } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SLOT_BG, type LineSlot } from "./line-slots";
import { Money } from "./money";

export interface AllocationItem {
  key: string;
  label: string;
  minor: string;
  slot: LineSlot;
  /** The rule beneath the name ("Escrow milestones only", "Paced at 75 BU a day"). */
  detail?: ReactNode;
  /** Anything after the amount, e.g. a <ChangeChip> on a v2 row. */
  trailing?: ReactNode;
  /** Tints the row waiting-wash: a value this signature changes. */
  changed?: boolean;
  /** A lucide icon for the pocket: the row then leads with an icon tile in the slot's colour instead of a swatch. */
  icon?: LucideIcon;
}

/**
 * The budget split (DESIGN.md §7, §12, needs card and plan): a 10 px segmented bar, one rounded segment per line in
 * its fixed chart slot with 3 px gaps (the surface shows through, so there is no track), then (unless `rows={false}`)
 * a row per line: a swatch or an icon tile, the name, the rule beneath, the amount, on hairline separators. The rows
 * are the readable form, so the bar itself is decorative. Amounts are minor-unit strings; shares are computed in bigint
 * against `totalMinor`.
 */
export function AllocationBar({
  items,
  totalMinor,
  rows = true,
  className,
}: {
  items: readonly AllocationItem[];
  totalMinor: string;
  rows?: boolean;
  className?: string;
}) {
  return (
    <div data-slot="allocation-bar" className={cn("grid gap-3", className)}>
      <div aria-hidden className="flex h-2.5 gap-[3px]">
        {items.map((it) => {
          const pct = pctOf(it.minor, totalMinor);
          return pct > 0 ? (
            <span
              key={it.key}
              className={cn("h-full min-w-1.5 rounded-full shadow-[inset_0_1px_0_oklch(1_0_0/0.18)]", SLOT_BG[it.slot])}
              style={{ flexBasis: `${pct}%` }}
            />
          ) : null;
        })}
      </div>
      {rows ? (
        <ul className="grid">
          {items.map((it) => (
            <li
              key={it.key}
              data-changed={it.changed || undefined}
              className={cn(
                "grid items-center gap-x-3 py-2.5 text-ui shadow-[inset_0_-1px_0_var(--separator)] last:shadow-none",
                it.icon ? "grid-cols-[30px_minmax(0,1fr)_auto]" : "grid-cols-[10px_minmax(0,1fr)_auto]",
                "data-[changed=true]:-mx-2 data-[changed=true]:rounded-lg data-[changed=true]:bg-waiting-wash data-[changed=true]:px-2 data-[changed=true]:shadow-none",
              )}
            >
              {it.icon ? (
                <IconTile icon={it.icon} tone={slotTone(it.slot)} />
              ) : (
                <span aria-hidden className={cn("size-2.5 rounded-[3px]", SLOT_BG[it.slot])} />
              )}
              <span className="min-w-0">
                <span className="block font-medium text-ink">{it.label}</span>
                {it.detail ? <span className="block text-footnote text-ink-3">{it.detail}</span> : null}
              </span>
              <span className="inline-flex items-center gap-2 justify-self-end">
                {it.trailing}
                <Money minor={it.minor} className="text-callout font-semibold" />
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
