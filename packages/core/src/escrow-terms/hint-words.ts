/**
 * The words parseTermsHint knows (English, plus the Singlish/Malay/Indonesian forms founders type). Maps, not object
 * literals, so a word such as "constructor" can never hit a prototype property.
 *
 * Triggers are STRONG (a specific event) or WEAK (a vague one: "first", "now", "check", the trigger meaning of
 * "balance"). In one part, a single strong trigger wins over weak ones; two different strong (or, with no strong,
 * two different weak) triggers are a conflict and the hint is refused.
 */
import type { MilestoneTrigger } from "./constants";

const O: MilestoneTrigger = "ON_ORDER";
const S: MilestoneTrigger = "ON_SAMPLE_OK";
const H: MilestoneTrigger = "ON_SHIPMENT";
const D: MilestoneTrigger = "ON_DELIVERY_INSPECTED";

function table(rows: readonly (readonly [MilestoneTrigger, string])[]): ReadonlyMap<string, MilestoneTrigger> {
  return new Map(rows.flatMap(([trigger, words]) => words.split(" ").map((w) => [w, trigger] as const)));
}

export const STRONG_TRIGGERS = table([
  [O, "deposit deposits upfront advance downpayment dp"],
  [S, "sample samples sampling"],
  [H, "ship ships shipped shipping shipment shipments loading loaded dispatch dispatched"],
  [D, "delivery deliveries deliver delivered delivering inspection inspect inspected arrival arrive arrives arrived receipt receive received receiving cod qc"],
]);

export const WEAK_TRIGGERS = table([
  [O, "first now initially confirm confirmed confirmation"],
  [D, "check checked checking"],
]);

/** "balance": an amount (the rest) when its clause has no other amount, else a weak ON_DELIVERY_INSPECTED trigger. */
export const BALANCE_WORD = "balance";
export const BALANCE_TRIGGER: MilestoneTrigger = D;

/** "order"/"ordering" is ON_ORDER only after one of these ("on order", "upon ordering", "when we order")… */
export const ORDER_WORDS: ReadonlySet<string> = new Set(["order", "ordering"]);
export const ORDER_BEFORE: ReadonlySet<string> = new Set(["on", "upon", "at", "with", "when", "place", "placing", "placed", "we", "i"]);
/** …or before one of these ("order confirmation"). "after the order arrives" is not a trigger. */
export const ORDER_AFTER: ReadonlySet<string> = new Set(["confirmation", "confirmed", "confirm", "placed"]);
export const ORDER_TRIGGER: MilestoneTrigger = O;

/** Two-word strong triggers: "up front", "down payment". */
export const PAIR_TRIGGERS: ReadonlyMap<string, MilestoneTrigger> = new Map([
  ["up front", O],
  ["down payment", O],
]);

/** Words after a number that make it a percentage. "per cent" is handled as a pair. */
export const PERCENT_WORDS: ReadonlySet<string> = new Set(["percent", "percentage", "pct", "peratus", "persen"]);

/** The remainder of the total. */
export const REST_WORDS: ReadonlySet<string> = new Set(["rest", "remaining", "remainder"]);

/** "full" is 100% only in these company: "in full", "pay full", "full payment", "full amount". */
export const FULL_BEFORE: ReadonlySet<string> = new Set(["in", "pay", "paid"]);
export const FULL_AFTER: ReadonlySet<string> = new Set(["payment", "amount", "pay"]);
/** "whole amount", "entire payment". */
export const WHOLE_WORDS: ReadonlySet<string> = new Set(["whole", "entire"]);
export const WHOLE_AFTER: ReadonlySet<string> = new Set(["amount", "payment", "sum"]);
export const EVERYTHING_WORD = "everything";

export const HALF_WORD = "half";
/** "half half", "half-half", "half and half", "half & half" mean a 50/50 split. */
export const HALF_JOINERS: ReadonlySet<string> = new Set(["-", "and", "&"]);

/** Clause breaks. */
export const SEPARATOR_WORDS: ReadonlySet<string> = new Set(["and", "then"]);
export const SEPARATOR_PUNCT: ReadonlySet<string> = new Set([",", ";", ".", "!", "?", "\n", "&", "+"]);
/** What may join the numbers of a bare split: "30/70", "50-50", "30:70" (spaces also join: "30 40 30"). */
export const SPLIT_JOINERS: ReadonlySet<string> = new Set(["/", "-", ":"]);

/** Bare splits by convention: 2 parts = deposit + balance, 3 parts = deposit + shipment + balance (the presets). */
export const BARE_SPLIT_TRIGGERS: ReadonlyMap<number, readonly MilestoneTrigger[]> = new Map([
  [2, [O, D]],
  [3, [O, H, D]],
]);
