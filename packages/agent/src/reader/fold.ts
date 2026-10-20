/**
 * Text folding for the deterministic parsers (security audit run-8: PayNow capture and SGD budget grounding). The
 * regexes must match what a person SEES, so the text is folded before matching:
 * - NFKC (full-width and compatibility forms: "ＰａｙＮｏｗ", "２０１９", "Ｓ＄" become ASCII), then every format (Cf)
 *   and default-ignorable code point is removed (zero-width space and joiners, soft hyphen, word joiner, BOM, bidi
 *   controls, variation selectors), visible blanks (Braille blank, Hangul fillers) become a space, and NFKC runs
 *   again, since removing a character can let its neighbours compose (as core's imperative-text normalisation does);
 * - combining marks are dropped, space separators become " ", dash punctuation and the minus sign become "-", curly
 *   apostrophes become "'";
 * - Cyrillic and Greek look-alikes of Latin letters become those letters ("201998765Х" with a Cyrillic Kha is a UEN).
 * Line breaks are kept. The result is for matching only: snippets and their hashes always come from the original text.
 */

const INVISIBLE_RE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
/** Visible blanks: Braille pattern blank, Hangul fillers (default-ignorable too, so they are folded first). */
const VISIBLE_BLANK_RE = /[\u2800\u3164\u115f\u1160\uffa0]/gu;
const NON_ASCII_RE = /[^\x00-\x7f]/u;
const NON_ASCII_ALL_RE = /[^\x00-\x7f]/gu;
const MARK_RE = /^\p{M}$/u;
const SPACE_RE = /^\p{Zs}$/u;
const DASH_RE = /^[\p{Pd}\u2212]$/u;
const APOSTROPHE_RE = /^[\u2018\u2019\u02bc\u2032]$/u;
const DIGIT_RE = /^\p{Nd}$/u;

/**
 * Confusables skeleton for Latin letters: a copy of core's LATIN_LOOKALIKE (packages/core/src/taint/imperative.ts,
 * after Unicode's confusables.txt), which core does not export. Letters with no Latin look-alike are left alone.
 */
const LATIN_LOOKALIKE: Readonly<Record<string, string>> = {
  // Cyrillic capitals
  "\u0405": "S", "\u0406": "I", "\u0408": "J", "\u0410": "A", "\u0412": "B", "\u0415": "E", "\u041a": "K", "\u041c": "M",
  "\u041d": "H", "\u041e": "O", "\u0420": "P", "\u0421": "C", "\u0422": "T", "\u0423": "Y", "\u0425": "X", "\u04ae": "Y",
  "\u04ba": "H", "\u04c0": "I", "\u051a": "Q", "\u051c": "W",
  // Cyrillic small letters
  "\u0430": "a", "\u0432": "b", "\u0435": "e", "\u043a": "k", "\u043c": "m", "\u043d": "h", "\u043e": "o", "\u043f": "n",
  "\u0440": "p", "\u0441": "c", "\u0442": "t", "\u0443": "y", "\u0445": "x", "\u044c": "b", "\u0455": "s", "\u0456": "i",
  "\u0458": "j", "\u04af": "y", "\u04bb": "h", "\u04cf": "l", "\u0501": "d", "\u051b": "q", "\u051d": "w",
  // Greek capitals
  "\u037f": "J", "\u0391": "A", "\u0392": "B", "\u0395": "E", "\u0396": "Z", "\u0397": "H", "\u0399": "I", "\u039a": "K",
  "\u039c": "M", "\u039d": "N", "\u039f": "O", "\u03a1": "P", "\u03a4": "T", "\u03a5": "Y", "\u03a7": "X", "\u03f9": "C",
  // Greek small letters
  "\u03b1": "a", "\u03b2": "b", "\u03b3": "y", "\u03b5": "e", "\u03b7": "n", "\u03b9": "i", "\u03ba": "k", "\u03bc": "u",
  "\u03bd": "v", "\u03bf": "o", "\u03c1": "p", "\u03c4": "t", "\u03c5": "u", "\u03c7": "x", "\u03c9": "w", "\u03f2": "c",
  "\u03f3": "j",
};

/** Value of a Unicode decimal digit: Nd characters come in contiguous runs of ten starting at zero. */
function digitValue(cp: number): number {
  let k = 0;
  while (k < 64 && DIGIT_RE.test(String.fromCodePoint(cp - k - 1))) k += 1;
  return k % 10;
}

const cache = new Map<string, string>();
const CACHE_MAX = 1 << 16;

function foldChar(ch: string): string {
  const hit = cache.get(ch);
  if (hit !== undefined) return hit;
  let out = LATIN_LOOKALIKE[ch] ?? ch;
  if (MARK_RE.test(ch)) out = "";
  else if (SPACE_RE.test(ch)) out = " ";
  else if (DASH_RE.test(ch)) out = "-";
  else if (APOSTROPHE_RE.test(ch)) out = "'";
  else if (DIGIT_RE.test(ch)) out = String(digitValue(ch.codePointAt(0) as number));
  if (cache.size < CACHE_MAX) cache.set(ch, out);
  return out;
}

function fold(text: string): string {
  const strip = (s: string): string => s.replace(VISIBLE_BLANK_RE, " ").replace(INVISIBLE_RE, "");
  return strip(strip(text.normalize("NFKC")).normalize("NFKC")).replace(NON_ASCII_ALL_RE, foldChar);
}

/** Folding for payout-target capture: every decimal digit, in any script, becomes its ASCII digit. */
export function foldForTargets(text: string): string {
  return NON_ASCII_RE.test(text) ? fold(text) : text;
}

/** Stands for a digit-like character that is not a plain digit, so no amount can be parsed through it. */
export const UNCLEAR_DIGIT = "\ufffd";
const NUMERIC_RE = /[\p{Nd}\p{No}\p{Nl}]/gu;
const ASCII_DIGIT_RE = /^[0-9]$/;

/**
 * Folding for stated amounts, with every whitespace run collapsed to one space. A digit NFKC maps to a plain digit
 * (full-width "１", mathematical "𝟏") is kept; any other digit-like character becomes UNCLEAR_DIGIT first, so NFKC
 * can never turn "S$10⁴" into "S$104" and an Arabic-Indic "١٠" is never silently read as some other figure.
 */
export function foldForAmounts(text: string): string {
  if (!NON_ASCII_RE.test(text)) return text.replace(/\s+/g, " ");
  const marked = text.replace(NUMERIC_RE, (ch) => (ASCII_DIGIT_RE.test(ch.normalize("NFKC")) && DIGIT_RE.test(ch) ? ch : UNCLEAR_DIGIT));
  return fold(marked).replace(/\s+/g, " ");
}
