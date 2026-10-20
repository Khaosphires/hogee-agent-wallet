/**
 * Lexer for parseTermsHint. The founder's text arrives after @hogee/privacy's redact(), so identifiers are already
 * `<ENTITY_TYPE>` placeholders; those become an inert " _ " (it splits a run of bare numbers but not a clause).
 *
 * ReDoS: both regexes are in privacy's linear-time subset (`linearRegexProblem`: bounded quantifiers only, no repeated
 * alternation, no backreferences), the input is capped at MAX_HINT_CHARS before any work, and every later step is a
 * single pass over the lexeme list. The tests check the subset and time max-length adversarial inputs.
 */

/** Longer input gets no prefill (a chat message is ≤ 4,000 characters; redaction placeholders can lengthen it). */
export const MAX_HINT_CHARS = 16_000;
/** NFKC and lower-casing can lengthen text; past this the hint is refused too. */
const MAX_NORMALISED_CHARS = 4 * MAX_HINT_CHARS;

/** A redaction placeholder from @hogee/privacy redact(): `<SG_PHONE>`, `<EMAIL_ADDRESS>`, … */
const PLACEHOLDER_RE = /<[A-Z][A-Z0-9_]{0,63}>/g;
/**
 * One lexeme per match: a number (12 digits at most, with an optional `.`/`,` fraction part that marks it a decimal;
 * it never starts inside another number), a word (24 letters at most, never starting inside a word), or one
 * punctuation mark that matters. Everything else (spaces, brackets, the placeholder's `_`) is skipped.
 */
const LEXEME_RE = /(?<!\d)(?<!\d[.,])(\d{1,12})(?:[.,](\d{1,12}))?|(?<![a-z])([a-z]{1,24})|([%/:;,.!?&+\n-])/g;

/** Every regex the hint reader uses (the ReDoS test walks this list). */
export const HINT_REGEXES: readonly RegExp[] = [PLACEHOLDER_RE, LEXEME_RE];

interface Span {
  readonly start: number;
  readonly end: number;
}
export interface NumLexeme extends Span {
  readonly kind: "num";
  /** The whole-number part (≤ 12 digits, so exact in a double). */
  readonly value: number;
  /** Had a `.`/`,` fraction part ("30.5", "12,5", "1,000"). */
  readonly decimal: boolean;
  readonly digits: number;
}
export interface WordLexeme extends Span {
  readonly kind: "word";
  readonly text: string;
}
export interface PunctLexeme extends Span {
  readonly kind: "punct";
  readonly text: string;
}
export type Lexeme = NumLexeme | WordLexeme | PunctLexeme;

/** NFKC (full-width digits and `％` become ASCII), placeholders made inert, lower case. Null when too long. */
export function normaliseHint(text: string): string | null {
  if (text.length > MAX_HINT_CHARS) return null;
  const s = text.normalize("NFKC").replace(PLACEHOLDER_RE, " _ ").toLowerCase();
  return s.length > MAX_NORMALISED_CHARS ? null : s;
}

export function lexHint(s: string): Lexeme[] {
  const lexemes: Lexeme[] = [];
  for (const m of s.matchAll(LEXEME_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    const [, intPart, fraction, word, punct] = m;
    if (intPart !== undefined) {
      lexemes.push({ kind: "num", value: Number(intPart), decimal: fraction !== undefined, digits: intPart.length, start, end });
    } else if (word !== undefined) {
      lexemes.push({ kind: "word", text: word, start, end });
    } else if (punct !== undefined) {
      lexemes.push({ kind: "punct", text: punct, start, end });
    }
  }
  return lexemes;
}

/** Only whitespace between two lexemes (nothing the lexer skipped, such as a placeholder's `_`). */
export function blankBetween(s: string, a: Lexeme, b: Lexeme): boolean {
  return s.slice(a.end, b.start).trim() === "";
}
