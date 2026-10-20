/**
 * Imperative-text detector for untrusted content (listings, invoices, emails, web pages; §7.3, T11-T13, T30-T33).
 * It returns FLAGS ONLY: data for the red-flag card, the supplier gates and the invoice escalation. It never
 * returns or triggers an action, and its output never feeds a payee, an amount or a cap.
 *
 * Text is normalised first (NFKC folds full-width/compatibility letters; every format (Cf) and default-ignorable
 * code point is removed; whitespace collapsed; lower-cased) so invisible characters inside a keyword do not hide
 * an instruction. Bidi controls, Unicode tag characters and variation-selector runs are a red flag on their own
 * (HIDDEN_CHARACTERS): tag characters U+E0020-U+E007E map 1:1 to ASCII, and variation selectors after an emoji can
 * carry arbitrary bytes, so a whole instruction no human sees can ride along. Both are also decoded and scanned, and
 * the red-flag card shows what was hidden (security audit run-2). One presentation selector (VS15/VS16) is normal.
 * Visible blanks (Braille blank, Hangul fillers) are folded to spaces, and matching also runs with them removed, so
 * neither "ignore⠀previous" nor "ign⠀ore" hides a keyword. Keywords match on a confusables skeleton: Cyrillic and
 * Greek look-alikes of Latin letters map to those letters (LATIN_LOOKALIKE), so "іgnоre" is "ignore" (security audit
 * run-3). Patterns cover English, Malay, Indonesian and Chinese phrasings seen in the E1 categories.
 */
import type { SupplierGate } from "../schemas/enums";
import type { RedFlag } from "../schemas/supplier";

export const IMPERATIVE_FLAGS = [
  "IGNORE_INSTRUCTIONS",
  "AI_DIRECTED",
  "RANK_MANIPULATION",
  "ROLE_OVERRIDE",
  "SECRET_REQUEST",
  "PII_REQUEST",
  "PAYMENT_REDIRECT",
  "OFF_PLATFORM_PAYMENT",
  "ENCODED_PAYLOAD",
  "HIDDEN_CHARACTERS",
] as const;
export type ImperativeFlagCode = (typeof IMPERATIVE_FLAGS)[number];

export interface ImperativeFlag {
  readonly flag: ImperativeFlagCode;
  /** Normalised text around the match (≤ 120 chars), for the red-flag card. */
  readonly excerpt: string;
  /** Offset in the normalised text. */
  readonly index: number;
}

/**
 * Removed before matching: every format character (Cf: zero-width, LRM/RLM, bidi embeddings/overrides/isolates, tag
 * characters) and every Default_Ignorable_Code_Point (CGJ, variation selectors, Hangul fillers, ...). NFKC leaves
 * them intact and they are neither \s nor \w, so one inside a keyword would defeat every \b pattern.
 */
const INVISIBLE_RE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
/**
 * Visible blanks: render as an empty space but are not \s (Braille pattern blank U+2800; Hangul fillers U+3164,
 * U+115F, U+1160, U+FFA0; NFKC maps U+3164 and U+FFA0 to U+1160). Removed, they glue words together ("ignore⠀previous"
 * becomes one word), so normalisation folds them to a space; inside a keyword they split it, so detection also matches
 * a copy with them removed.
 */
const VISIBLE_BLANK_RE = /[\u2800\u3164\u115f\u1160\uffa0]/gu;
const HAS_VISIBLE_BLANK_RE = /[\u2800\u3164\u115f\u1160\uffa0]/u;
/** Bidi embeddings/overrides (U+202A-U+202E), isolates (U+2066-U+2069) and tag characters (U+E0000-U+E007F). */
const HIDDEN_MARKER_RE = /[\u202a-\u202e\u2066-\u2069\u{e0000}-\u{e007f}]/u;
/** Tag characters that mirror printable ASCII (U+E0020-U+E007E). */
const TAG_ASCII_RE = /[\u{e0020}-\u{e007e}]/gu;
const TAG_BASE = 0xe0000;
/**
 * Variation-selector runs that can carry bytes: 2+ consecutive selectors (VS1-16 U+FE00-U+FE0F, VS17-256
 * U+E0100-U+E01EF), or any single VS17-256. A lone VS15/VS16 (text/emoji presentation) is ordinary text.
 */
const VS_PAYLOAD_SOURCE = "[\\ufe00-\\ufe0f\\u{e0100}-\\u{e01ef}]{2,}|[\\u{e0100}-\\u{e01ef}]";
const VS_PAYLOAD_RE = new RegExp(VS_PAYLOAD_SOURCE, "gu");
const VS_PAYLOAD_FIRST_RE = new RegExp(VS_PAYLOAD_SOURCE, "u");
/** The byte a variation selector stands for in the common encoding: VS1-16 = 0-15, VS17-256 = 16-255. */
const vsByte = (c: number): number => (c <= 0xfe0f ? c - 0xfe00 : c - 0xe0100 + 16);

/** NFKC, visible blanks folded to `blank`, invisible characters removed, whitespace collapsed; case kept. */
function normalizeCased(text: string, blank: " " | "" = " "): string {
  return stripInvisible(text, blank).replace(/\s+/g, " ").trim();
}

export function normalizeForDetection(text: string): string {
  return normalizeCased(text).toLowerCase();
}

const S = "[^.!?\\n]"; // same-sentence filler
const PATTERNS: readonly { readonly flag: ImperativeFlagCode; readonly re: RegExp }[] = [
  {
    flag: "IGNORE_INSTRUCTIONS",
    re: new RegExp(`\\b(ignore|disregard|forget|override|bypass)\\b${S}{0,40}\\b(previous|prior|above|earlier|all|any|your|system|the)\\b${S}{0,20}\\b(instructions?|prompts?|rules?|messages?|directions?|guidelines?|polic(y|ies))\\b`),
  },
  { flag: "IGNORE_INSTRUCTIONS", re: new RegExp(`\\babaikan\\b${S}{0,40}\\b(arahan|instruksi|perintah|peraturan)\\b`) },
  { flag: "IGNORE_INSTRUCTIONS", re: /(忽略|无视|忘记)(之前|以上|所有|先前|上面)?的?(指令|指示|提示|规则|说明)/ },
  { flag: "AI_DIRECTED", re: /\b(attention|note to|dear|hey|message (for|to))\s+(the\s+|all\s+)?(ai|llm|assistants?|agents?|bots?|gpt|claude)\b/ },
  { flag: "AI_DIRECTED", re: /\b(ai|llm)\s+(agents?|assistants?|models?|systems?|bots?)\s*[:,]/ },
  { flag: "AI_DIRECTED", re: /\bif you are an? (ai|llm|language model|assistant|agent|bot)\b/ },
  { flag: "AI_DIRECTED", re: /(人工智能|ai)(助手|代理):|人工智能:/ },
  {
    flag: "RANK_MANIPULATION",
    re: new RegExp(`\\b(rank|rate|score|list|recommend|choose|select|pick|put)\\b${S}{0,30}\\b(us|me|this (supplier|seller|shop|store|listing|factory))\\b${S}{0,20}(#\\s*1\\b|\\bnumber\\s*(one|1)\\b|\\bfirst\\b|\\btop\\b|\\bhighest\\b|\\bbest\\b)`),
  },
  { flag: "RANK_MANIPULATION", re: /\b(always|must|should)\s+(recommend|choose|select|pick|rank|prefer)\s+(us|this)\b/ },
  { flag: "ROLE_OVERRIDE", re: /\b(you are now|from now on,? you|act as|pretend (to be|you are)|new instructions|developer mode|jailbreak)\b/ },
  { flag: "ROLE_OVERRIDE", re: /(^|\s)(\[system\]|<\s*system\s*>|system\s*:)/ },
  {
    flag: "SECRET_REQUEST",
    re: new RegExp(`\\b(print|reveal|show|send|share|tell|output|display|leak|give|repeat|dump|paste)\\b${S}{0,40}\\b(system prompt|your instructions|session key|private key|secret key|api key|seed phrase|mnemonic|password|credentials)\\b`),
  },
  {
    flag: "PII_REQUEST",
    re: new RegExp(`\\b(send|share|provide|include|forward|give|attach)\\b${S}{0,40}\\b(ic number|mykad|nric|nik|ktp|npwp|passport|phone number|bank account number|identity card)\\b`),
  },
  {
    flag: "PAYMENT_REDIRECT",
    re: new RegExp(`\\b(bank (details|account|info(rmation)?)|account (number|details)|beneficiary|payment details|rekening|akaun bank)\\b${S}{0,30}\\b(changed|updated|new|baru|berubah|diubah)\\b`),
  },
  { flag: "PAYMENT_REDIRECT", re: new RegExp(`\\b(pay|send|transfer|wire|remit|bayar)\\b${S}{0,30}\\b(to|into|ke|kepada)\\b${S}{0,25}(\\b0x[0-9a-f]{6,}|new account|this account|account below|following account|akaun baru|rekening baru)`) },
  { flag: "PAYMENT_REDIRECT", re: /\b0x[0-9a-f]{40}\b/ },
  {
    flag: "OFF_PLATFORM_PAYMENT",
    re: new RegExp(`\\b(off[- ]?platform|outside (the )?(platform|shopee|lazada|tiktok|app)|direct (bank )?(transfer|payment)|pay (us )?directly|whatsapp|wechat|telegram)\\b${S}{0,40}\\b(discount|cheaper|save|pay|payment|price|off)\\b`),
  },
  { flag: "OFF_PLATFORM_PAYMENT", re: new RegExp(`\\b(discount|cheaper|save)\\b${S}{0,40}\\b(off[- ]?platform|direct (bank )?(transfer|payment)|pay (us )?directly|outside (the )?platform)\\b`) },
];

/**
 * Long base64-looking runs (mixed case + digits/symbols, not plain hex: hashes and addresses are fine) and Morse
 * sequences (T13). Matched on the case-preserving text with invisible characters removed.
 */
function encodedPayloadMatch(raw: string): { index: number; text: string } | null {
  for (const m of raw.matchAll(/[A-Za-z0-9+/]{40,}={0,2}/g)) {
    const s = m[0];
    if (/[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9+/]/.test(s) && !/^(0x)?[0-9a-fA-F]+$/.test(s)) return { index: m.index ?? 0, text: s };
  }
  const morse = /(?:[.-]{1,6}[ /]+){10,}[.-]{1,6}/.exec(raw);
  if (morse && morse[0].includes(".") && morse[0].includes("-")) return { index: morse.index, text: morse[0] };
  return null;
}

function excerpt(text: string, index: number): string {
  const start = Math.max(0, index - 30);
  return text.slice(start, start + 120);
}

/**
 * NFKC, fold visible blanks to `blank`, strip invisible characters; NFKC again because removing a character can let
 * its neighbours compose. Blanks are folded first: the Hangul fillers are also default-ignorable.
 */
function stripInvisible(text: string, blank: " " | "" = " "): string {
  const strip = (s: string): string => s.replace(VISIBLE_BLANK_RE, blank).replace(INVISIBLE_RE, "");
  return strip(strip(text.normalize("NFKC")).normalize("NFKC"));
}

const MARK_RE = /\p{M}/gu;

/**
 * Confusables skeleton (security audit run-3): Cyrillic and Greek letters that look like a Latin letter, mapped to it.
 * A small local table after Unicode's confusables.txt (no dependency), applied before lower-casing so the case of the
 * look-alike decides (Greek Η looks like H, η like n). Letters with no Latin look-alike are left alone, so ordinary
 * Russian or Greek text never forms an English keyword. Accented forms reach it decomposed (ё → е → e).
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

/**
 * The text the patterns run on: `cased` with each character NFKD-decomposed, its combining marks (\p{M}) removed,
 * mapped through LATIN_LOOKALIKE and lower-cased, whitespace re-collapsed, plus a map from every UTF-16 unit back to
 * its offset in `cased.toLowerCase()`. So 'İGNORE', 'ignóre', 'іgnоre' or a U+0332 inside a keyword still match, while
 * excerpts come from the unfolded (lower-cased) text.
 */
function foldForMatching(cased: string): { readonly text: string; readonly source: readonly number[] } {
  let text = "";
  const source: number[] = [];
  let offset = 0;
  for (const ch of cased) {
    const skeleton = [...ch.normalize("NFKD").replace(MARK_RE, "")].map((c) => LATIN_LOOKALIKE[c] ?? c).join("");
    let folded = skeleton.toLowerCase().replace(/\s+/g, " ");
    if (folded.startsWith(" ") && text.endsWith(" ")) folded = folded.slice(1);
    text += folded;
    for (let k = 0; k < folded.length; k += 1) source.push(offset);
    offset += ch.toLowerCase().length;
  }
  return { text, source };
}

/** First match of each pattern flag in normalised text (earliest position wins); excerpts from its lower-cased form. */
function matchPatterns(cased: string): Map<ImperativeFlagCode, ImperativeFlag> {
  const norm = cased.toLowerCase();
  const { text, source } = foldForMatching(cased);
  const found = new Map<ImperativeFlagCode, ImperativeFlag>();
  for (const { flag, re } of PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const index = source[m.index] ?? norm.length;
    const prev = found.get(flag);
    if (!prev || prev.index > index) found.set(flag, { flag, index, excerpt: excerpt(norm, index) });
  }
  return found;
}

/** Every tag character that mirrors ASCII, decoded and joined (an instruction split across visible text included). */
function decodeTagText(text: string): string {
  return [...text.matchAll(TAG_ASCII_RE)].map((m) => String.fromCharCode((m[0].codePointAt(0) ?? TAG_BASE) - TAG_BASE)).join("");
}

/** Every variation-selector payload run, decoded as UTF-8 bytes (invalid sequences become U+FFFD). */
function decodeVariationSelectors(text: string): string {
  const bytes = [...text.matchAll(VS_PAYLOAD_RE)].flatMap((m) => [...m[0]].map((ch) => vsByte(ch.codePointAt(0) ?? 0xfe00)));
  return bytes.length === 0 ? "" : new TextDecoder("utf-8").decode(Uint8Array.from(bytes));
}

/** Offset of the first bidi control, tag character or variation-selector payload in `text`, or null. */
function firstHiddenMarker(text: string): number | null {
  const at = [HIDDEN_MARKER_RE.exec(text)?.index, VS_PAYLOAD_FIRST_RE.exec(text)?.index].filter((i): i is number => i !== undefined);
  return at.length === 0 ? null : Math.min(...at);
}

/**
 * Bidi controls, tag characters or variation-selector payloads in untrusted text: the flag itself, plus the flags of
 * any instruction hidden in them. Excerpts come from the decoded text (control characters blanked), so the red-flag
 * card shows what was hidden. `index` is where the first such character sits in the normalised text.
 */
function hiddenCharacterFlags(text: string): ImperativeFlag[] {
  const markerAt = firstHiddenMarker(text);
  if (markerAt === null) return [];
  const norm = normalizeForDetection(text);
  const index = Math.min(normalizeForDetection(text.slice(0, markerAt)).length, norm.length);
  const hidden = [decodeTagText(text), decodeVariationSelectors(text)].filter((t) => t.length > 0).join(" ");
  const decoded = normalizeForDetection(hidden.replace(/\p{Cc}/gu, " "));
  const flags: ImperativeFlag[] = [{ flag: "HIDDEN_CHARACTERS", index, excerpt: decoded ? excerpt(decoded, 0) : excerpt(norm, index) }];
  for (const f of matchPatterns(decoded).values()) flags.push({ ...f, index });
  return flags;
}

/**
 * Every distinct imperative/red-flag pattern in `text` (first occurrence of each flag), ordered by position. With
 * visible blanks present, a second pass matches the text with them removed (a flag only it finds keeps its offset
 * in that copy).
 */
export function detectImperativeText(text: string): ImperativeFlag[] {
  const found = matchPatterns(normalizeCased(text));
  if (HAS_VISIBLE_BLANK_RE.test(text)) {
    for (const f of matchPatterns(normalizeCased(text, "")).values()) if (!found.has(f.flag)) found.set(f.flag, f);
  }
  for (const f of hiddenCharacterFlags(text)) if (!found.has(f.flag)) found.set(f.flag, f);
  // Encoded runs are matched with blanks removed, so a blank cannot split a payload below the length threshold.
  const raw = stripInvisible(text, "");
  const encoded = encodedPayloadMatch(raw);
  if (encoded) found.set("ENCODED_PAYLOAD", { flag: "ENCODED_PAYLOAD", index: encoded.index, excerpt: excerpt(raw, encoded.index) });
  return [...found.values()].sort((a, b) => a.index - b.index || IMPERATIVE_FLAGS.indexOf(a.flag) - IMPERATIVE_FLAGS.indexOf(b.flag));
}

export function hasImperativeText(text: string): boolean {
  return detectImperativeText(text).length > 0;
}

/** Supplier hard gate a flag triggers in a listing (§11), or null for a red flag that does not exclude. */
export const FLAG_SUPPLIER_GATE: { readonly [F in ImperativeFlagCode]: SupplierGate | null } = {
  IGNORE_INSTRUCTIONS: "AI_INJECTION",
  AI_DIRECTED: "AI_INJECTION",
  RANK_MANIPULATION: "AI_INJECTION",
  ROLE_OVERRIDE: "AI_INJECTION",
  SECRET_REQUEST: "AI_INJECTION",
  PII_REQUEST: "AI_INJECTION",
  ENCODED_PAYLOAD: "AI_INJECTION",
  HIDDEN_CHARACTERS: "AI_INJECTION",
  OFF_PLATFORM_PAYMENT: "OFF_PLATFORM_DISCOUNT",
  PAYMENT_REDIRECT: null,
};

/** Invoice.flags codes (the policy engine escalates any of these to the loan officer). */
export const FLAG_INVOICE_CODE: { readonly [F in ImperativeFlagCode]: string } = {
  IGNORE_INSTRUCTIONS: "IMPERATIVE_TEXT",
  AI_DIRECTED: "IMPERATIVE_TEXT",
  RANK_MANIPULATION: "IMPERATIVE_TEXT",
  ROLE_OVERRIDE: "IMPERATIVE_TEXT",
  SECRET_REQUEST: "IMPERATIVE_TEXT",
  PII_REQUEST: "IMPERATIVE_TEXT",
  ENCODED_PAYLOAD: "ENCODED_PAYLOAD",
  HIDDEN_CHARACTERS: "IMPERATIVE_TEXT",
  PAYMENT_REDIRECT: "PAYEE_DETAILS_CHANGED",
  OFF_PLATFORM_PAYMENT: "OFF_PLATFORM_PAYMENT",
};

const FLAG_TEXT: { readonly [F in ImperativeFlagCode]: string } = {
  IGNORE_INSTRUCTIONS: "Tells an AI to ignore its instructions",
  AI_DIRECTED: "Addresses AI agents directly",
  RANK_MANIPULATION: "Asks to be ranked first",
  ROLE_OVERRIDE: "Tries to change the AI's role",
  SECRET_REQUEST: "Asks for prompts, keys or passwords",
  PII_REQUEST: "Asks for personal ID or phone details",
  PAYMENT_REDIRECT: "Says payment details changed or names a new destination",
  OFF_PLATFORM_PAYMENT: "Pushes payment outside the platform",
  ENCODED_PAYLOAD: "Contains an encoded message",
  HIDDEN_CHARACTERS: "Contains hidden or text-reversing characters",
};

/** Invoice.flags for a document's text (sorted, unique). */
export function invoiceFlags(text: string): string[] {
  return [...new Set(detectImperativeText(text).map((f) => FLAG_INVOICE_CODE[f.flag]))].sort();
}

/** Red flags for the UI (chat `data-redflag`, RankedSupplier.redFlags), e.g. source "listing:supplier-c". */
export function redFlagsFromText(text: string, source: string): RedFlag[] {
  return detectImperativeText(text).map((f) => ({ text: `${FLAG_TEXT[f.flag]}: "${f.excerpt.slice(0, 80)}"`, source }));
}
