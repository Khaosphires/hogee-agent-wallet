/**
 * Folds text to the ASCII view the data/pii regexes expect, keeping a map back to ORIGINAL offsets:
 * - Unicode decimal digits (full-width ９, Arabic-Indic ٩, ...) become 0-9;
 * - space separators (NBSP, ideographic space) become " ", dash punctuation and the minus sign become "-";
 * - format characters (zero-width space, soft hyphen, BOM) and combining marks are dropped, so they cannot split an ID;
 * - anything whose NFKC form is printable ASCII becomes that (full-width letters, ＋, ＠, circled digits).
 * Pure ASCII input is returned as is. Each folded UTF-16 unit maps to the [start, end) of the code point it came from.
 */

export interface FoldedText {
  readonly text: string;
  /** Maps a [start, end) range of `text` back to the original string. */
  readonly toOriginal: (start: number, end: number) => { readonly start: number; readonly end: number };
}

const NON_ASCII = /[^\x00-\x7f]/;
const DROP = /^[\p{Cf}\p{Mn}]$/u;
const DIGIT = /^\p{Nd}$/u;
const SPACE = /^\p{Zs}$/u;
const DASH = /^[\p{Pd}\u{2212}]$/u;
const PRINTABLE_ASCII = /^[\x20-\x7e]{1,4}$/;

const cache = new Map<number, string>();
const CACHE_MAX = 1 << 17;

/** Value of a Unicode decimal digit: Nd characters come in contiguous runs of ten starting at zero. */
function digitValue(cp: number): number {
  let k = 0;
  while (k < 64 && DIGIT.test(String.fromCodePoint(cp - k - 1))) k += 1;
  return k % 10;
}

function foldCodePoint(cp: number): string {
  const hit = cache.get(cp);
  if (hit !== undefined) return hit;
  const ch = String.fromCodePoint(cp);
  let out = ch;
  if (DROP.test(ch)) out = "";
  else if (DIGIT.test(ch)) out = String(digitValue(cp));
  else if (SPACE.test(ch)) out = " ";
  else if (DASH.test(ch)) out = "-";
  else {
    const n = ch.normalize("NFKC");
    if (PRINTABLE_ASCII.test(n)) out = n;
  }
  if (cache.size < CACHE_MAX) cache.set(cp, out);
  return out;
}

const identity = (start: number, end: number) => ({ start, end });

export function foldText(input: string): FoldedText {
  if (!NON_ASCII.test(input)) return { text: input, toOriginal: identity };
  const parts: string[] = [];
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  while (i < input.length) {
    const cp = input.codePointAt(i) as number;
    const width = cp > 0xffff ? 2 : 1;
    const piece = cp < 0x80 ? input.charAt(i) : foldCodePoint(cp);
    for (let k = 0; k < piece.length; k += 1) {
      from.push(i);
      to.push(i + width);
    }
    parts.push(piece);
    i += width;
  }
  return {
    text: parts.join(""),
    toOriginal: (start, end) => ({ start: from[start] ?? input.length, end: to[end - 1] ?? input.length }),
  };
}

/** Decodes JSON string escapes (\n, \", \\, 9, ...) so a serialised prompt is scanned as the text it carries. */
export function decodeJsonEscapes(input: string): string {
  if (!input.includes("\\")) return input;
  return input.replace(/\\(?:u([0-9a-fA-F]{4})|([\\"/bfnrt]))/g, (_m, hex: string | undefined, ch: string | undefined) => {
    if (hex !== undefined) return String.fromCharCode(parseInt(hex, 16));
    return ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" } as Record<string, string>)[ch ?? ""] ?? ch ?? "";
  });
}
