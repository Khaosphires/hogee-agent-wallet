/**
 * Deterministic grounding of the Planner's PlanIntent (D6: the LLM never decides amounts). The only money field in a
 * PlanIntent is `budgetCeilingMinor`, the founder's own stated budget: it must equal an amount parsed by CODE from a
 * founder (user) turn, in the facility's currency. Anything else becomes a templated question for that slot.
 * compilePlan then caps it at the facility limit and builds every line, cap, payee and stage itself.
 *
 * The founder's latest money statement wins. A turn that talks money but states no usable figure (only another
 * currency, or only a negated or negative one) invalidates the earlier figure, so the budget is asked again instead of
 * falling back to an older turn (security audit run-3).
 *
 * Turns are folded first (security audit run-8, critic gap 5; reader/fold.ts): NFKC, invisible characters removed,
 * dashes to "-", whitespace runs to one space. A figure is read whole or not at all: never its first digits ("S$10" of
 * "S$10,000USD", "S$10 000", "S$10⁴"). A digit-like character NFKC would change, or a digit in a script other than
 * ASCII and full-width, is never parsed, so such a figure is money talk with no usable figure (BUDGET_UNCLEAR).
 */
import { PlanIntent, type CompileFacility, type CurrencyCode, type IntentSlot } from "@hogee/core";
import { UNCLEAR_DIGIT, foldForAmounts } from "../reader/fold";
import { parseAmountToMinor } from "../reader/prefilter";
import { templatedAssumptions } from "./questions";

export interface PlannerTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
}

/** Currency markers, lower-case with single spaces. A bare "$" is no currency: it is never read as SGD (or USD). */
const CURRENCY_WORDS: Readonly<Record<string, CurrencyCode>> = {
  rm: "MYR",
  myr: "MYR",
  ringgit: "MYR",
  rp: "IDR",
  idr: "IDR",
  rupiah: "IDR",
  sgd: "SGD",
  s$: "SGD",
  sg$: "SGD",
  "singapore dollar": "SGD",
  "singapore dollars": "SGD",
};
const currencyOf = (marker: string | undefined): CurrencyCode | undefined => CURRENCY_WORDS[(marker ?? "").toLowerCase().replace(/\s+/g, " ")];
const MULTIPLIER: Readonly<Record<string, bigint>> = { k: 1_000n, thousand: 1_000n, ribu: 1_000n, rb: 1_000n, m: 1_000_000n, mil: 1_000_000n, million: 1_000_000n, juta: 1_000_000n, jt: 1_000_000n };

/**
 * A whole number: no digit, and no "." or "," plus digit, right after it, so the regex can never backtrack to its
 * first digits ("10" of "10,000"). UNCLEAR_DIGIT counts as a digit throughout.
 */
const NUM = `([0-9][0-9.,]*[0-9]|[0-9])(?![0-9${UNCLEAR_DIGIT}]|[.,][0-9])`;
const MULT = "(k|thousand|ribu|rb|m|mil|million|juta|jt)?";
/** The figure ends here: no letter or digit, and no digit group after one separator ("S$10 000", "S$10'000", "S$10, 000"). */
const AMOUNT_END = `(?![a-z0-9${UNCLEAR_DIGIT}])(?![ '_][0-9${UNCLEAR_DIGIT}])(?![.,] [0-9]{3}(?![0-9]))`;
/** The figure starts here: the same rules, looking back. */
const AMOUNT_START = `(?<![a-z0-9.,${UNCLEAR_DIGIT}])(?<![0-9${UNCLEAR_DIGIT}][ '_])(?<![0-9][.,] )`;
// "S$" / "SG$" need the (?<![a-z]) guard so the "S$" inside "US$" is never read as SGD.
const PREFIXED = new RegExp(`(?<![a-z])(rm|myr|rp|idr|sgd|sg\\$|s\\$)\\s?${NUM}\\s?${MULT}${AMOUNT_END}`, "gi");
const SUFFIXED = new RegExp(`${AMOUNT_START}${NUM}\\s?${MULT}\\s?(ringgit|myr|rupiah|idr|sgd|singapore\\s+dollars?)(?![a-z])`, "gi");

/** An amount with a currency marker, in ANY currency and with any sign: the turn talks about money. */
const ANY_PREFIX = "(?:rm|myr|rp|idr|usd|us\\$|sg\\$|s\\$|sgd|cny|rmb|eur|gbp|jpy|thb|php|vnd|inr|hkd|aud|\\$|¥|€|£|₱|₫|₹|฿)";
const ANY_SUFFIX = "(?:ringgit|myr|rupiah|idr|usd|sgd|singapore\\s+dollars?|cny|rmb|yuan|元|eur|euros?|gbp|jpy|yen|thb|baht|php|vnd|inr|rupees?|hkd|aud|dollars?)";
/** What may sit between a currency marker and its figure in money talk ("SGD: 12,000", "S$(12,000)", "RM -10,000"). */
const GAP = "[ :=(-]{0,3}";
const DIGITISH = `[0-9${UNCLEAR_DIGIT}]`;
const ANY_MONEY = new RegExp(
  [
    `(?<![a-z])${ANY_PREFIX}${GAP}${DIGITISH}`,
    `[$¥€£₱₫₹฿]${GAP}${DIGITISH}`,
    `${DIGITISH}${GAP}${MULT}${GAP}${ANY_SUFFIX}(?![a-z])`,
    `(?<![a-z])${ANY_SUFFIX}${GAP}${DIGITISH}`,
  ].join("|"),
  "i",
);

/**
 * A second currency marker on the same amount, on either side of it ("USD S$10,000", "US$: 10,000 SGD",
 * "S$10,000 USD"). A generic "$" / "dollars" belongs to a dollar amount ("$10,000 SGD", "S$10,000 dollars") but never
 * to a ringgit or rupiah one ("$10,000 MYR"). Any other marker must name the same currency, or the amount is
 * ambiguous and not a usable figure.
 */
const MARKER_BEFORE = new RegExp(`(?<![a-z])(${ANY_PREFIX})[ :=(]{0,3}$`, "i");
const MARKER_AFTER = new RegExp(`^[ )]{0,2}(${ANY_SUFFIX})(?![a-z])`, "i");
const GENERIC_MARKER = /^(?:\$|dollars?)$/i;
const DOLLAR_CURRENCIES: ReadonlySet<CurrencyCode> = new Set(["SGD", "USD"]);

/**
 * A negation right before an amount: "not RM10,000", "isn't really RM10,000", "bukan RM10,000", "instead of RM10,000",
 * or a minus sign. One filler word may sit between; a comparison may not ("not more than RM10,000", "don't spend more
 * than RM10,000" and "not exceeding RM10,000" are ceilings, so they still state the figure).
 */
const NEGATED_BEFORE =
  /(?:\b(?:not|never|no longer|instead of|rather than|bukan|bukannya|tidak|tak)|n't)(?:\s+(?!(?:more|less|over|under|above|below|beyond|than|up|exceed\w*)\b)[a-z']+)?\s*$/i;
const MINUS_BEFORE = /[-\u2212]\s*$/;
/** A "$" sign (bare, "S$" or "SG$") just before the amount is skipped, so "not $10,000 SGD" and "-$10,000 SGD" stay negated. */
const DOLLAR_BEFORE = /(?<![a-z])(?:sg|s)?\$\s*$/i;

function negatedAt(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 40), index).replace(DOLLAR_BEFORE, "");
  return MINUS_BEFORE.test(before) || NEGATED_BEFORE.test(before);
}

function markerConflicts(marker: string | undefined, currency: CurrencyCode): boolean {
  if (marker === undefined) return false;
  return GENERIC_MARKER.test(marker) ? !DOLLAR_CURRENCIES.has(currency) : currencyOf(marker) !== currency;
}
const markerBefore = (text: string, index: number) => MARKER_BEFORE.exec(text.slice(Math.max(0, index - 12), index))?.[1];
const markerAfter = (text: string, index: number) => MARKER_AFTER.exec(text.slice(index, index + 24))?.[1];
/** Another currency's marker right before or right after the amount [start, end). */
const conflictsAround = (text: string, start: number, end: number, currency: CurrencyCode): boolean =>
  markerConflicts(markerBefore(text, start), currency) || markerConflicts(markerAfter(text, end), currency);

function toMinor(num: string, mult: string | undefined, currency: CurrencyCode): string | null {
  const base = parseAmountToMinor(num, currency);
  if (base === null) return null;
  const factor = mult ? MULTIPLIER[mult.toLowerCase()] : 1n;
  return factor === undefined ? null : (BigInt(base) * factor).toString();
}

/** statedAmounts over an already folded turn. */
function amountsIn(text: string, currency: CurrencyCode): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PREFIXED)) {
    const at = m.index ?? 0;
    if (currencyOf(m[1]) !== currency || negatedAt(text, at) || conflictsAround(text, at, at + m[0].length, currency)) continue;
    const v = toMinor(m[2] ?? "", m[3], currency);
    if (v !== null) out.push(v);
  }
  for (const m of text.matchAll(SUFFIXED)) {
    const at = m.index ?? 0;
    if (currencyOf(m[3]) !== currency || negatedAt(text, at) || conflictsAround(text, at, at + m[0].length, currency)) continue;
    const v = toMinor(m[1] ?? "", m[2], currency);
    if (v !== null) out.push(v);
  }
  return out;
}

/** Every budget-like amount the founder stated in `text`, in `currency`, as minor-unit strings (negated ones excluded). */
export function statedAmounts(text: string, currency: CurrencyCode): string[] {
  return amountsIn(foldForAmounts(text), currency);
}

export type GroundingResult =
  | { readonly ok: true; readonly intent: PlanIntent; readonly budgetSource: string }
  | { readonly ok: false; readonly slots: readonly IntentSlot[]; readonly reason: string };

/** Validate the intent and tie its budget to a founder turn. Pure. */
export function groundIntent(raw: unknown, turns: readonly PlannerTurn[], facility: Pick<CompileFacility, "countryCode" | "currency">): GroundingResult {
  const parsed = PlanIntent.safeParse(raw);
  if (!parsed.success) return { ok: false, slots: [], reason: "INVALID_INTENT" };
  const intent: PlanIntent = { ...parsed.data, assumptions: templatedAssumptions(parsed.data) };
  if (intent.countryCode !== facility.countryCode) return { ok: false, slots: ["countryCode"], reason: "COUNTRY_NOT_FACILITY" };
  // The founder's LATEST statement of an amount wins (a correction replaces the earlier figure).
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = turns[i];
    if (t?.role !== "user") continue;
    const text = foldForAmounts(t.text);
    const amounts = amountsIn(text, facility.currency);
    if (amounts.length === 0) {
      // Money talk with no usable figure (another currency, negated, negative) replaces the earlier figure with none.
      if (ANY_MONEY.test(text)) return { ok: false, slots: ["budgetCeilingMinor"], reason: "BUDGET_UNCLEAR" };
      continue;
    }
    return amounts.includes(intent.budgetCeilingMinor)
      ? { ok: true, intent, budgetSource: `user-turn:${i}` }
      : { ok: false, slots: ["budgetCeilingMinor"], reason: "BUDGET_NOT_STATED" };
  }
  return { ok: false, slots: ["budgetCeilingMinor"], reason: "BUDGET_NOT_STATED" };
}
