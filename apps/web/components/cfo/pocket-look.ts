/**
 * How each pocket looks on the Wallet page (DESIGN.md §12.2): its chart slot from components/ledger/line-slots (the same
 * colour in every chart, tile and ring) as a ui tone, and the glyph PocketRow uses (components/ledger/pocket-row
 * POCKET_ICON), so a pocket reads the same on every page. The name always sits beside the tile, so colour never
 * carries identity alone.
 */
import { Wallet, type LucideIcon } from "lucide-react";
import type { LineKey } from "@hogee/core";
import { LINE_SLOT, type LineSlot } from "@/components/ledger/line-slots";
import { POCKET_ICON } from "@/components/ledger/pocket-row";
import { slotTone, type Tone } from "@/components/ui/tones";

/** The CSS colour of a slot, for inline styles (chart bars). */
export const slotVar = (slot: LineSlot): string => (slot === "neutral" ? "var(--chart-neutral)" : `var(--chart-${slot})`);

export interface PocketLook {
  readonly slot: LineSlot;
  readonly tone: Tone;
  readonly Icon: LucideIcon;
}

const isLineKey = (key: string | null | undefined): key is LineKey => typeof key === "string" && Object.hasOwn(LINE_SLOT, key);

/** A pocket's slot, tone and icon; an unknown key (a new line) is neutral with the wallet icon, never a blank. */
export function pocketLook(lineKey: string | null | undefined): PocketLook {
  if (!isLineKey(lineKey)) return { slot: "neutral", tone: "slot-neutral", Icon: Wallet };
  const slot = LINE_SLOT[lineKey];
  return { slot, tone: slotTone(slot), Icon: POCKET_ICON[lineKey] };
}
