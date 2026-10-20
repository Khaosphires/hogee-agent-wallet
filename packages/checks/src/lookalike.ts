/**
 * Confusables skeleton for name screening (security audit run-8): Cyrillic and Greek letters that look like a Latin
 * letter, mapped to it, so "KОRЕА" with Cyrillic О and Е screens as "KOREA". The same reviewed table as core's
 * LATIN_LOOKALIKE (packages/core/src/taint/imperative.ts, audit run-3; after Unicode's confusables.txt, no dependency).
 * Keys are case-sensitive because the case of the look-alike decides what it looks like: Greek Η looks like H, η like n.
 * Letters with no Latin look-alike are left alone, so a genuine Russian or Greek name never turns into a Latin one.
 */
export const LATIN_LOOKALIKE: Readonly<Record<string, string>> = {
  // Cyrillic capitals
  "Ѕ": "S", "І": "I", "Ј": "J", "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M",
  "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T", "У": "Y", "Х": "X", "Ү": "Y",
  "Һ": "H", "Ӏ": "I", "Ԛ": "Q", "Ԝ": "W",
  // Cyrillic small letters
  "а": "a", "в": "b", "е": "e", "к": "k", "м": "m", "н": "h", "о": "o", "п": "n",
  "р": "p", "с": "c", "т": "t", "у": "y", "х": "x", "ь": "b", "ѕ": "s", "і": "i",
  "ј": "j", "ү": "y", "һ": "h", "ӏ": "l", "ԁ": "d", "ԛ": "q", "ԝ": "w",
  // Greek capitals
  "Ϳ": "J", "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K",
  "Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X", "Ϲ": "C",
  // Greek small letters
  "α": "a", "β": "b", "γ": "y", "ε": "e", "η": "n", "ι": "i", "κ": "k", "μ": "u",
  "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x", "ω": "w", "ϲ": "c",
  "ϳ": "j",
};

/** Any key of LATIN_LOOKALIKE (all single BMP letters, none special inside a character class). */
const LOOKALIKE_RE = new RegExp(`[${Object.keys(LATIN_LOOKALIKE).join("")}]`, "gu");

/** Each Cyrillic or Greek look-alike replaced by its Latin letter; every other character kept. One linear pass. */
export function foldLookalikes(text: string): string {
  return text.replace(LOOKALIKE_RE, (ch) => LATIN_LOOKALIKE[ch] ?? ch);
}
