import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { TONE, type Tone } from "./tones";

/**
 * A rounded-square tile around a lucide icon (iOS Settings style; DESIGN.md §12). It gives a row, a stat or a pocket
 * its colour and its kind at a glance, so the words next to it can stay short.
 *
 *   <IconTile icon={Truck} tone={slotTone(LINE_SLOT.LOGISTICS)} />          // a pocket in a grouped list
 *   <IconTile icon={ArrowDownLeft} tone="paid" variant="tinted" size="lg" /> // money in, on a stat
 *
 * - `tone`: see ./tones (a pocket's slot, paid, agent, waiting, blocked, ink, grey; `seal` only for Mei's signature).
 * - `variant`: `solid` (default) is the colour with a white glyph and a faint top highlight; `tinted` is the colour at
 *   13 % with the glyph in a deepened colour, for quieter places (several tiles in one card, empty states).
 * - `size` (box / radius / glyph): `sm` 24/6/14, `md` 30/8/17 (default), `lg` 40/10/20, `xl` 52/13/26 px. The radius is
 *   about a quarter of the box, like an app icon, so a tile never reads as a button.
 *
 * Decorative by default (`aria-hidden`): the row's words say what it is. Pass `label` when the tile stands alone; it
 * becomes `role="img"` with that name.
 */
export type IconTileSize = "sm" | "md" | "lg" | "xl";
export type IconTileVariant = "solid" | "tinted";

const SIZE: Record<IconTileSize, string> = {
  sm: "size-6 rounded-[6px] [&_svg]:size-3.5",
  md: "size-[30px] rounded-[8px] [&_svg]:size-[17px]",
  lg: "size-10 rounded-[10px] [&_svg]:size-5",
  xl: "size-[52px] rounded-[13px] [&_svg]:size-[26px]",
};

/** A white glyph on the colour; a hairline ring and a top highlight make the tile read as a small raised object. */
const SOLID = "text-white shadow-[inset_0_1px_0_oklch(1_0_0/0.2),inset_0_0_0_1px_oklch(0.235_0.028_262/0.06)]";

type IconTileProps = Omit<React.ComponentProps<"span">, "children"> & {
  icon?: LucideIcon;
  tone?: Tone;
  size?: IconTileSize;
  variant?: IconTileVariant;
  /** The accessible name when the tile stands alone; without it the tile is hidden from assistive tech. */
  label?: string;
  /** In place of `icon`: a letter or a custom glyph. */
  children?: React.ReactNode;
};

function IconTile({ icon: Icon, tone = "ink", size = "md", variant = "solid", label, className, children, ...props }: IconTileProps) {
  const t = TONE[tone];
  return (
    <span
      data-slot="icon-tile"
      data-tone={tone}
      data-variant={variant}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn(
        "inline-grid shrink-0 place-items-center font-semibold select-none [&_svg]:shrink-0 [&_svg]:stroke-[2.1]",
        SIZE[size],
        variant === "solid" ? cn(t.solid, SOLID) : cn(t.tint, t.ink),
        className,
      )}
      {...props}
    >
      {Icon ? <Icon aria-hidden /> : children}
    </span>
  );
}

export { IconTile };
export type { IconTileProps };
