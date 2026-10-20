import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { IconTile } from "@/components/ui/icon-tile";
import type { Tone } from "@/components/ui/tones";
import { cn } from "@/lib/utils";

/**
 * Settings and the quick settings are built from the shared primitives (UX round 3, DESIGN.md §12): `GroupedList`,
 * `ListRow`, `IconTile`, `Switch`. Every Settings row has a tile, in a neutral tone: pocket colours are only for
 * pockets. `grey` for what is about you and this device, `ink` for security (the passkey, what you signed, how the money
 * is kept safe). Buttons in a group (reset, go back) are actions, not rows, and carry no tile, as in iOS.
 */
export const SETTING_TONE: Tone = "grey";
export const SECURITY_TONE: Tone = "ink";

/** The tile at the start of a settings row (30 px, solid, iOS Settings). */
export function SettingTile({ icon, tone = SETTING_TONE }: { icon: LucideIcon; tone?: Tone }) {
  return <IconTile icon={icon} tone={tone} />;
}

/**
 * A row `ListRow` can't hold (a text field, the colour swatches, the View as choice), with ListRow's anatomy: the tile,
 * then a column whose bottom edge is the separator, so it starts where the text starts and the last row has none.
 * Must sit directly in a `GroupedList`.
 */
export function SettingRow({
  icon,
  tone = SETTING_TONE,
  children,
  className,
  columnClassName,
  "data-testid": testId,
}: {
  icon: LucideIcon;
  tone?: Tone;
  children: ReactNode;
  className?: string;
  columnClassName?: string;
  "data-testid"?: string;
}) {
  return (
    <li data-slot="list-row" data-testid={testId} className={cn("group/item relative flex min-w-0 items-start gap-3 pl-4", className)}>
      <span className="flex shrink-0 items-center py-[7px]">
        <SettingTile icon={icon} tone={tone} />
      </span>
      <div className={cn("grid min-h-11 min-w-0 flex-1 grid-cols-1 content-center pr-4 shadow-[inset_0_-1px_0_var(--separator)] group-last/item:shadow-none", columnClassName)}>
        {children}
      </div>
    </li>
  );
}

/** An action in its own group (iOS: "Sign Out"): the whole row is the button, its words centred or leading. */
export const ACTION_ROW = cn(
  "flex min-h-11 w-full items-center gap-2 px-4 py-2.5 text-callout font-medium outline-none",
  "transition-[background-color,color,opacity] duration-(--dur-state) ease-settle hover:bg-fill active:bg-fill-strong active:duration-0",
  "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-50",
);
