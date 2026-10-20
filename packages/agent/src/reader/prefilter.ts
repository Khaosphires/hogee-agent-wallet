/**
 * Deterministic pre-parse of untrusted documents (regex first, the LLM only for the rest). Runs locally on the RAW
 * text, before redaction, so values like payout account numbers never need to leave the machine.
 *
 * Amounts are parsed from the string as written into integer minor units (no floats, D16). A stated total that the
 * regex finds always wins over the Reader model's value; two different stated totals are a red flag.
 */
import { normalizeSnippet, snippetHash, type CurrencyCode, type Hex32, type Minor } from "@hogee/core";
import { foldForTargets } from "./fold";

export const READER_CURRENCIES = ["MYR", "CNY", "USD", "IDR", "SGD"] as const;
export type ReaderCurrency = (typeof READER_CURRENCIES)[number];

const CURRENCY_ALIASES: Readonly<Record<string, ReaderCurrency>> = {
  MYR: "MYR",
  RM: "MYR",
  CNY: "CNY",
  RMB: "CNY",
  USD: "USD",
  US$: "USD",
  IDR: "IDR",
  RP: "IDR",
  SGD: "SGD",
  S$: "SGD",
};

/** "RM" → "MYR", "Rp" → "IDR", "S$" → "SGD"; null for anything else (a bare "$" names no currency). */
export function normalizeCurrency(raw: string | null | undefined): ReaderCurrency | null {
  if (!raw) return null;
  return CURRENCY_ALIASES[raw.trim().toUpperCase()] ?? null;
}

const MAX_MINOR_DIGITS = 30;

/**
 * An amount as written ("1,234.50", "10,000", IDR "1.500.000") → minor units (1 unit = 100 minor), or null when it
 * is not an unambiguous non-negative amount with at most 2 decimals.
 */
export function parseAmountToMinor(raw: string, currency: CurrencyCode): Minor | null {
  const s = raw.trim().replace(/\s+/g, "");
  let whole: string;
  let cents = "00";
  if (currency === "IDR" && /^\d{1,3}(\.\d{3})+$/.test(s)) {
    whole = s.replace(/\./g, ""); // IDR writes thousands with dots and has no sen in practice
  } else {
    const m = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(s);
    if (!m) return null;
    whole = (m[1] ?? "").replace(/,/g, "");
    cents = (m[2] ?? "").padEnd(2, "0");
  }
  const minor = BigInt(whole) * 100n + BigInt(cents);
  const out = minor.toString();
  return out.length > MAX_MINOR_DIGITS ? null : out;
}

export interface StatedTotal {
  readonly currency: ReaderCurrency;
  readonly amountMinor: Minor;
  /** The amount as written. */
  readonly raw: string;
  /** The whole source line, trimmed (its snippetHash is the evidence). */
  readonly snippet: string;
  readonly snippetHash: Hex32;
}

export interface InvoicePrefilter {
  readonly invoiceNumber: string | null;
  /** Every "total / amount due" statement, in document order. */
  readonly totals: readonly StatedTotal[];
  /**
   * Every payout target the document states: the digits of each account number next to "account / akaun / rekening /
   * a/c", and each PayNow target (UEN or NRIC/FIN in upper case, SG mobile as +65XXXXXXXX) near a PayNow mention or an
   * account label. Read on folded text (fold.ts), so look-alike, full-width or invisible characters and separators
   * inside a target do not hide it. Private: never sent out. Compare with payoutTargetKey.
   */
  readonly accountNumbers: readonly string[];
  /**
   * True when the document has more than MAX_PAYOUT_WINDOWS PayNow mentions and account labels. Only the first ones
   * were read, so accountNumbers may be incomplete and the invoice is flagged PAYEE_DETAILS_CHANGED (fail closed).
   */
  readonly payoutScanCapped: boolean;
}

// Whitespace, an optional ":" and whitespace again, written so that a long whitespace run cannot backtrack
// quadratically ("\s*[:=]?\s*" does: about 1.8 s for "a/c" plus 50,000 spaces, security audit run-8).
const TOTAL_RE = /\b(?:grand\s+total|total(?:\s+(?:due|amount|payable))?|amount\s+(?:due|payable)|jumlah(?:\s+perlu\s+dibayar)?)\b\s*(?:[:=]\s*)?(MYR|RM|CNY|RMB|USD|US\$|IDR|Rp|SGD|S\$)\s*([0-9][0-9.,]*[0-9]|[0-9])/gi;
const INVOICE_NO_RE = /\b(?:invoice|inv)\b\.?\s*(?:no\.?|number|#)\s*(?:[:#]\s*)?([A-Z0-9][A-Z0-9/-]{2,40})/i;
const ACCOUNT_LABEL = "\\b(?:account|acct|akaun|rekening|a\\/c)\\b";
const ACCOUNT_RE = new RegExp(`${ACCOUNT_LABEL}(?:\\s*(?:no\\.?|number|#))?\\s*(?:[:#]\\s*)?([0-9][0-9 -]{6,30}[0-9])`, "dgi");

/** Up to three spaces, tabs, dots or dashes may separate the characters of a PayNow target ("2019-12345-K", "9123 . 4567"). */
const SEP = "[ \\t.-]{0,3}";
const SEP1 = "[ \\t.-]{1,3}";
/** `n` (to `m`) digits, each pair optionally separated. */
const digits = (n: number, m = n): string => `\\d(?:${SEP}\\d){${n - 1},${m - 1}}`;

/**
 * Singapore PayNow targets (SG-DESIGN §4 fail-open 5), whole matches only (no letter or digit touching them):
 * - a UEN: 8 or 9 digits + check letter (businesses, local companies), or T/S/R + 2 digits + a 2-letter entity type +
 *   4 digits + check letter (other entities), with room for a short PayNow suffix after an attached check letter;
 * - an NRIC/FIN: [STFGM] + 7 digits + letter (individuals can link one to PayNow);
 * - an SG mobile: 8 digits starting 8 or 9, with an optional +65 / 0065 / (65) prefix.
 * Separators (SEP) may sit between any two characters. A check letter set apart from the digits ("201998765 X") is
 * tried last, so "9123 4567 - J. Lim" stays a mobile, and it takes no suffix, so "2026-10-18 at 5pm" is no UEN.
 * Read only near a PayNow mention or an account label: a UEN elsewhere on an invoice is usually the issuer's own
 * registration number, and a +65 number elsewhere is usually a contact phone.
 */
const UEN_BODY = `(?:${digits(8, 9)}|[STR]${SEP}${digits(2)}${SEP}[A-Z]${SEP}[A-Z]${SEP}${digits(4)})`;
const UEN = `${UEN_BODY}[A-Z](?:[A-Z0-9]{1,4})?`;
const UEN_SPLIT = `${UEN_BODY}${SEP1}[A-Z]`;
const NRIC = `[STFGM]${SEP}${digits(7)}${SEP}[A-Z]`;
const SG_MOBILE = `(?:(?:\\+|00)${SEP}65${SEP}|\\(${SEP}\\+?65${SEP}\\)${SEP})?[89]${SEP}${digits(7)}`;
const PAYNOW_TARGET_RE = new RegExp(`(?<![A-Za-z0-9+-])(?<!\\d[.,])(?:(${UEN})|(${NRIC})|(${SG_MOBILE})|(${UEN_SPLIT}))(?![A-Za-z0-9-])(?![.,]\\d)`, "gi");
/** "PayNow", also "Pay Now" / "Pay-Now" / "Pay  Now": recall over precision, since a missed target is a missed flag. */
const PAYNOW_RE = /(?<![a-z0-9])pay[ \t._-]{0,3}now(?![a-z0-9])/gi;
const ACCOUNT_LABEL_RE = new RegExp(ACCOUNT_LABEL, "gi");

/**
 * At most this many PayNow mentions and account labels are read per document (security audit run-8, critic gap 1).
 * One more flags the invoice instead of skipping the check.
 */
export const MAX_PAYOUT_WINDOWS = 32;
/** A PayNow mention also reads the block under it: up to this many non-blank lines, to the first blank line. */
const PAYNOW_BLOCK_LINES = 3;

function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? text.length : end).trim();
}

/** Every line's [start, end) and whether it is blank, in one pass. */
interface Lines {
  readonly starts: readonly number[];
  readonly ends: readonly number[];
  readonly blank: readonly boolean[];
}

function linesOf(text: string): Lines {
  const starts: number[] = [];
  const ends: number[] = [];
  const blank: boolean[] = [];
  for (let start = 0; start <= text.length; ) {
    const nl = text.indexOf("\n", start);
    const end = nl === -1 ? text.length : nl;
    starts.push(start);
    ends.push(end);
    blank.push(!/\S/.test(text.slice(start, end)));
    start = end + 1;
  }
  return { starts, ends, blank };
}

/** Index of the line holding `index` (binary search). */
function lineIndexAt(lines: Lines, index: number): number {
  let lo = 0;
  let hi = lines.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((lines.starts[mid] as number) <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** [start, end) of line `li`; for a PayNow mention, extended over the block under it (blank lines right after it skipped). */
function windowOf(lines: Lines, li: number, block: boolean): [number, number] {
  let last = li;
  if (block) {
    let at = li + 1;
    while (at < lines.blank.length && lines.blank[at]) at += 1;
    for (let k = 0; k < PAYNOW_BLOCK_LINES && at < lines.blank.length && !lines.blank[at]; k += 1, at += 1) last = at;
  }
  return [lines.starts[li] as number, lines.ends[last] as number];
}

/**
 * The lines to read, at most one window per line (several mentions on one line are one window), sorted and merged
 * where they overlap or touch, so every character is scanned once. `capped` when the cap stopped the count.
 */
function payoutWindows(text: string): { readonly windows: readonly (readonly [number, number])[]; readonly capped: boolean } {
  const lines = linesOf(text);
  const blockOf = new Map<number, boolean>();
  let seen = 0;
  const visit = (re: RegExp, block: boolean): boolean => {
    for (const m of text.matchAll(re)) {
      seen += 1;
      if (seen > MAX_PAYOUT_WINDOWS) return false;
      const li = lineIndexAt(lines, m.index);
      blockOf.set(li, block || blockOf.get(li) === true);
    }
    return true;
  };
  const capped = !visit(PAYNOW_RE, true) || !visit(ACCOUNT_LABEL_RE, false);
  const sorted = [...blockOf].sort((a, b) => a[0] - b[0]).map(([li, block]) => windowOf(lines, li, block));
  const windows: [number, number][] = [];
  for (const [from, to] of sorted) {
    const last = windows[windows.length - 1];
    if (last !== undefined && from <= last[1] + 1) windows[windows.length - 1] = [last[0], Math.max(last[1], to)];
    else windows.push([from, to]);
  }
  return { windows, capped };
}

interface Found {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

/** Every PayNow target in the windows, in canonical form, with its position: sorted and non-overlapping. */
function payNowTargets(text: string, windows: readonly (readonly [number, number])[]): Found[] {
  const found: Found[] = [];
  for (const [from, to] of windows) {
    for (const m of text.slice(from, to).matchAll(PAYNOW_TARGET_RE)) {
      const start = from + m.index;
      const value = m[3] !== undefined ? `+65${m[3].replace(/\D/g, "").slice(-8)}` : m[0].replace(/[\s.-]/g, "").toUpperCase();
      found.push({ value, start, end: start + m[0].length });
    }
  }
  return found;
}

/** True when [start, end) lies inside one of `sorted` (sorted, non-overlapping). */
function insideAny(sorted: readonly Found[], start: number, end: number): boolean {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as Found).start <= start) lo = mid + 1;
    else hi = mid;
  }
  const p = sorted[lo - 1];
  return p !== undefined && end <= p.end;
}

/**
 * The canonical form of a payout target, so the stated and the bound one compare equal however they are written:
 * folded (fold.ts), upper case without spaces, dots, dashes or brackets, and an SG mobile as "+65" + 8 digits.
 */
export function payoutTargetKey(raw: string): string {
  const t = foldForTargets(raw).toUpperCase().trim().replace(/^\(\s*\+?65\s*\)/, "+65").replace(/[\s.()-]/g, "");
  const mobile = /^(?:\+65|0065)?([89]\d{7})$/.exec(t);
  return mobile ? `+65${mobile[1]}` : t;
}

/** Account numbers next to an account label (digits only) and PayNow targets; a number inside a PayNow target is not a second one. */
function payoutTargets(raw: string): { readonly targets: string[]; readonly capped: boolean } {
  const text = foldForTargets(raw);
  const { windows, capped } = payoutWindows(text);
  const payNow = payNowTargets(text, windows);
  const accounts = [...text.matchAll(ACCOUNT_RE)].flatMap((m) => {
    const [start, end] = m.indices?.[1] ?? [m.index, m.index + m[0].length];
    return insideAny(payNow, start, end) ? [] : [(m[1] ?? "").replace(/[ -]/g, "")];
  });
  return { targets: [...new Set([...accounts, ...payNow.map((p) => p.value)])], capped };
}

export function prefilterInvoice(text: string): InvoicePrefilter {
  const totals: StatedTotal[] = [];
  for (const m of text.matchAll(TOTAL_RE)) {
    const currency = normalizeCurrency(m[1]);
    const raw = m[2] ?? "";
    const amountMinor = currency ? parseAmountToMinor(raw, currency) : null;
    if (!currency || amountMinor === null) continue;
    const snippet = lineAt(text, m.index ?? 0);
    totals.push({ currency, amountMinor, raw, snippet, snippetHash: snippetHash(snippet) });
  }
  const payout = payoutTargets(text);
  return { invoiceNumber: INVOICE_NO_RE.exec(text)?.[1] ?? null, totals, accountNumbers: payout.targets, payoutScanCapped: payout.capped };
}

const norm = (s: string): string => normalizeSnippet(s).toLowerCase();

/**
 * True when `snippet` occurs in `text` (whitespace-normalised, case-insensitive) and `value` occurs in `snippet`.
 * A substring test, right for names and descriptions; numbers use isNumberGrounded.
 */
export function isGrounded(text: string, snippet: string, value: string): boolean {
  const sn = norm(snippet);
  return sn.length > 0 && norm(text).includes(sn) && sn.includes(norm(value));
}

const DIGIT_RE = /[0-9]/;
const SEPARATOR_RE = /[.,]/;
const MINUS_RE = /[-\u2212]/;

/** `s.slice(start, end)` is a whole number: no digit, separator+digit or minus sign touches it. */
function isWholeNumberAt(s: string, start: number, end: number): boolean {
  const [b1, b2, a1, a2] = [s[start - 1] ?? "", s[start - 2] ?? "", s[end] ?? "", s[end + 1] ?? ""];
  if (DIGIT_RE.test(b1) || MINUS_RE.test(b1) || (SEPARATOR_RE.test(b1) && DIGIT_RE.test(b2))) return false;
  return !(DIGIT_RE.test(a1) || (SEPARATOR_RE.test(a1) && DIGIT_RE.test(a2)));
}

/**
 * Like isGrounded, but `value` must occur in `snippet` as a whole number (security audit run-3): no adjacent digit,
 * no separator or decimal point followed/preceded by a digit, no minus sign. So "1,000.00" does not ground in
 * "11,000.00", "1,000.005" or "-1,000.00", while sentence punctuation after it ("1,000.00.") is fine.
 *
 * The boundary is checked in the whole (normalised) DOCUMENT at every place the snippet occurs, never inside the
 * snippet alone (security re-check M2): the model chooses the snippet, and one cut right after the value ("RM 1" of
 * "RM 1,250.00", "MOQ 1" of "MOQ 1000", "3" of "30 days") would otherwise hide the digits that follow. The value is
 * grounded when at least one occurrence passes.
 */
export function isNumberGrounded(text: string, snippet: string, value: string): boolean {
  const doc = norm(text);
  const sn = norm(snippet);
  const v = norm(value);
  if (sn.length === 0 || v.length === 0) return false;
  const inSnippet: number[] = [];
  for (let at = sn.indexOf(v); at !== -1; at = sn.indexOf(v, at + 1)) inSnippet.push(at);
  if (inSnippet.length === 0) return false;
  for (let start = doc.indexOf(sn); start !== -1; start = doc.indexOf(sn, start + 1)) {
    if (inSnippet.some((at) => isWholeNumberAt(doc, start + at, start + at + v.length))) return true;
  }
  return false;
}

/** The codes and symbols each Reader currency is written with (CURRENCY_ALIASES). */
const CURRENCY_TOKENS: { readonly [C in ReaderCurrency]: readonly string[] } = {
  MYR: ["MYR", "RM"],
  CNY: ["CNY", "RMB"],
  USD: ["USD", "US$"],
  IDR: ["IDR", "Rp"],
  SGD: ["SGD", "S$"],
};
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A token not glued to a letter on either side ("RM" in "RM128" and "128 RM", not in "FORM" or "RMB"). */
const TOKEN_RE: { readonly [C in ReaderCurrency]: RegExp } = Object.fromEntries(
  READER_CURRENCIES.map((c) => [c, new RegExp(`(?<!\\p{L})(?:${CURRENCY_TOKENS[c].map(escapeRe).join("|")})(?!\\p{L})`, "iu")]),
) as { readonly [C in ReaderCurrency]: RegExp };

/** True when `snippet` names `currency` by one of its codes or symbols, as a whole token. */
export function namesCurrency(snippet: string, currency: ReaderCurrency): boolean {
  return TOKEN_RE[currency].test(normalizeSnippet(snippet));
}

/** Every Reader currency `snippet` names. */
export function currenciesNamed(snippet: string): ReaderCurrency[] {
  return READER_CURRENCIES.filter((c) => namesCurrency(snippet, c));
}
