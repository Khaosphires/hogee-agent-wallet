/**
 * Money display pieces for <Money> and <ChangeChip>. Amounts stay minor-unit strings (1 BU = 100 minor) and are never
 * parsed into a JS number. A signed amount (core SignedMinor, e.g. a P&L net) may lead with "-"; "-0" is refused, as
 * the schema refuses it.
 */
import { formatBu, parseMinor } from "@hogee/core";

export interface MoneyParts {
  negative: boolean;
  /** "8,800", or "12,345.67" when the amount isn't whole BU (never rounded away). */
  figure: string;
}

const figureOf = (magnitude: bigint): string => formatBu(magnitude).replace(/ BU$/, "");

export function moneyParts(minor: string): MoneyParts {
  const negative = minor.startsWith("-");
  const magnitude = parseMinor(negative ? minor.slice(1) : minor);
  if (negative && magnitude === 0n) throw new RangeError(`amount must not be "-0"`);
  return { negative, figure: figureOf(magnitude) };
}

/** The change from one amount to another in BU: "+300", "−300" (true minus), "±0". */
export function buDelta(fromMinor: string, toMinor: string): string {
  const d = parseMinor(toMinor) - parseMinor(fromMinor);
  if (d === 0n) return "±0";
  return `${d > 0n ? "+" : "−"}${figureOf(d > 0n ? d : -d)}`;
}
