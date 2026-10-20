import { cn } from "@/lib/utils";
import { moneyParts } from "./money-parts";

const FIGURE = {
  /** In running text and table cells: tabular numerals. */
  inline: "tabular-nums",
  /** The 28 px semibold amount on a payment card. */
  amount: "text-amount [font-variant-numeric:tabular-nums_lining-nums]",
  /** The one 44 px semibold hero figure a view leads with. */
  hero: "text-hero [font-variant-numeric:tabular-nums_lining-nums]",
} as const;

/** The unit shrinks more as the figure grows (ux2), so "BU" never competes with the number. */
const UNIT = {
  inline: "text-[0.72em]",
  amount: "ml-[0.12em] text-[0.56em]",
  hero: "ml-[0.12em] text-[0.48em]",
} as const;

/**
 * A money figure with its unit (DESIGN.md §2, §12): "8,800 BU" in tabular numerals, the suffix smaller (0.72em inline,
 * 0.56em on an amount, 0.48em on the hero), weight 500, ink-3, never coloured.
 * `minor` is a minor-unit string (1 BU = 100 minor); a signed one (SignedMinor, "-192500") shows a true minus.
 * `currency` adds "(facility: MYR)". The text always reads "<figure> BU" and the element keeps `data-minor`.
 */
export function Money({
  minor,
  currency,
  className,
  figure = "inline",
}: {
  minor: string;
  currency?: string;
  className?: string;
  figure?: keyof typeof FIGURE;
}) {
  const parts = moneyParts(minor);
  return (
    <span className={cn("whitespace-nowrap", FIGURE[figure], className)} data-minor={minor}>
      {parts.negative ? "−" : null}
      {parts.figure}
      <span className={cn("font-medium tracking-[0.02em] text-ink-3", UNIT[figure])}>{" BU"}</span>
      {currency ? <span className="text-[0.86em] font-normal text-ink-3">{` (facility: ${currency})`}</span> : null}
    </span>
  );
}
