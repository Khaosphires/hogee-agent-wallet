import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { BadgeCheck, Factory, LifeBuoy, Megaphone, Package, Store, Truck } from "lucide-react";
import type { LineKey } from "@hogee/core";
import { ListRow } from "@/components/ui/grouped-list";
import { IconTile } from "@/components/ui/icon-tile";
import { ProgressRing } from "@/components/ui/progress";
import { slotTone } from "@/components/ui/tones";
import { lineLabel } from "@/lib/format";
import { LINE_SLOT } from "./line-slots";
import { Money } from "./money";
import { usedPct } from "./pocket-math";

export { usedPct };

/** Each pocket's glyph (iOS Settings style); its colour is the pocket's chart slot, so it matches every chart. */
export const POCKET_ICON: { readonly [K in LineKey]: LucideIcon } = {
  SUPPLIER: Factory,
  PACKAGING: Package,
  LOGISTICS: Truck,
  ADS: Megaphone,
  PLATFORM_FEES: Store,
  LICENSING: BadgeCheck,
  CONTINGENCY: LifeBuoy,
};

/**
 * One pocket, read the same way on every page (UX round 3): the value is what is **left**, the subtitle what it holds
 * in all, and the ring fills as money goes **out** (an untouched pocket is an empty ring). Put it in a GroupedList.
 */
export function PocketRow({
  lineKey,
  allocatedMinor,
  leftMinor,
  subtitle,
  href,
  className,
}: {
  lineKey: LineKey;
  allocatedMinor: string;
  leftMinor: string;
  /** Replaces "of <total>" (e.g. "Up to 375 BU a payment"); the total then belongs in the value's context. */
  subtitle?: ReactNode;
  href?: string;
  className?: string;
}) {
  const tone = slotTone(LINE_SLOT[lineKey]);
  const name = lineLabel(lineKey);
  const pct = usedPct(allocatedMinor, leftMinor);
  const row = {
    "data-testid": "pocket-row",
    "data-line": lineKey,
    className,
    leading: <IconTile icon={POCKET_ICON[lineKey]} tone={tone} size="md" />,
    title: name,
    subtitle: subtitle ?? (
      <>
        of <Money minor={allocatedMinor} />
      </>
    ),
    value: (
      <>
        <Money minor={leftMinor} /> left
      </>
    ),
    trailing: <ProgressRing value={pct} tone={tone} size={28} stroke={3.5} label={`${name}: ${Math.round(pct)}% paid out`} />,
  };
  return href ? <ListRow {...row} href={href} /> : <ListRow {...row} />;
}
