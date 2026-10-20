/**
 * Sanctions screening against the local UN Security Council list, data/sanctions/un_sc.csv (§26.8, built by
 * scripts/build-sanctions.mjs). Offline. Names and aliases match after normalisation (full-width and compatibility
 * forms, invisible letters, Cyrillic and Greek look-alikes, case, diacritics, punctuation and word order); this is exact
 * matching on normalised names, not fuzzy matching. List entries and queries go through the same normalisation. Each
 * name also gets keys with its company designators removed (Ltd, Co, Corp, Inc, Pte, Sdn Bhd, Limited, 有限公司 …), so
 * "Foo Trading Co., Ltd." meets "FOO TRADING LIMITED"; these keys only add hits. Fails closed: a missing, empty or
 * malformed list throws instead of reporting "no hit".
 */
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { SANCTIONS_CSV_COLUMNS, SanctionsRow } from "@hogee/core";
import { foldLookalikes } from "./lookalike";
import { CheckInputError, CheckUnavailableError, type SanctionsResult } from "./types";

/** The `list` value of a hit on un_sc.csv. */
export const UN_SC_LIST = "UN_SC";
const MAX_NAME_CHARS = 300;
const MAX_LIST_BYTES = 32 * 1024 * 1024;
/** Letters NFKD does not decompose to a base letter. */
const FOLD: Readonly<Record<string, string>> = { ß: "ss", æ: "ae", œ: "oe", ø: "o", ł: "l", đ: "d", ð: "d", þ: "th", ı: "i" };
/** Apostrophes, transliteration marks (U+02B9..U+02BF), primes, format characters (soft hyphen …) and the Arabic tatweel. */
const DROPPED = /['\u2018\u2019\u201B`\u00B4\u02B9-\u02BF\u02C8\u2032\u0640\p{Cf}]/gu;
/**
 * Code points that render as nothing (security audit run-8): every Default_Ignorable_Code_Point (zero-width
 * characters, variation selectors, CGJ, bidi controls, tag characters …) and, named explicitly, the Hangul fillers
 * U+115F, U+1160, U+3164 and U+FFA0. The fillers are letters (Lo), so without this they stay inside a word token.
 */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\u115F\u1160\u3164\uFFA0]/gu;

/** NFKC (full-width and compatibility forms), invisible code points removed, then NFKD with combining marks removed. */
function visibleBase(name: string): string {
  return name.normalize("NFKC").replace(INVISIBLE, "").normalize("NFKD").replace(/\p{M}+/gu, "");
}

/** Lower-case word tokens of a visible base: special letters folded, apostrophes and format characters removed. */
function tokensOf(base: string): string[] {
  const folded = Array.from(base.toLowerCase(), (ch) => FOLD[ch] ?? ch).join("");
  return folded.replace(DROPPED, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Lower-case word tokens without diacritics, apostrophes, punctuation or invisible letters, in the script written. */
export function nameTokens(name: string): string[] {
  return tokensOf(visibleBase(name));
}

/**
 * Latin skeleton of a visible base: look-alikes mapped while case still decides (Greek Η is H), then lower-cased and
 * mapped again, so a capital with no look-alike agrees with its small letter (Cyrillic П, п → n).
 */
function latinSkeleton(base: string): string {
  return foldLookalikes(foldLookalikes(base).toLowerCase());
}

/** Sorted tokens (word order ignored) and tokens run together (so "Al-Qaida", "Al Qaida" and "AlQaida" meet). */
function keysOf(tokens: readonly string[]): string[] {
  return tokens.length === 0 ? [] : [`w:${[...tokens].sort().join(" ")}`, `c:${tokens.join("")}`];
}

/** Company designator words (VISION-DECISIONS §8), lower case without punctuation: "Co." and "Co" are both "co". */
const DESIGNATOR_TOKENS: ReadonlySet<string> = new Set(["ltd", "co", "corp", "corporation", "inc", "pte", "limited"]);
/** "有限公司" (limited company). A Chinese name has no spaces, so it is cut from the end of a word. */
const CJK_DESIGNATOR = "有限公司";

/** The words without company designators ("sdn" + "bhd" as a pair); empty when nothing else is left. */
function withoutDesignators(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] ?? "";
    if (t === "sdn" && tokens[i + 1] === "bhd") {
      i += 1;
      continue;
    }
    if (DESIGNATOR_TOKENS.has(t)) continue;
    const cut = t.endsWith(CJK_DESIGNATOR) ? t.slice(0, -CJK_DESIGNATOR.length) : t;
    if (cut !== "") out.push(cut);
  }
  return out;
}

/** Keys of the name as written and of its Latin skeleton (one pair for a plain Latin name, where both agree). */
function exactKeys(base: string): string[] {
  return [...keysOf(tokensOf(base)), ...keysOf(tokensOf(latinSkeleton(base)))];
}

/** The same keys with company designators removed. */
function designatorFreeKeys(base: string): string[] {
  return [...keysOf(withoutDesignators(tokensOf(base))), ...keysOf(withoutDesignators(tokensOf(latinSkeleton(base))))];
}

/**
 * Match keys of a name: those of its tokens as written and those of its Latin skeleton, then the same two without
 * company designators (extra keys only add hits). The written form keeps original-script names case-insensitive where
 * a capital and its small letter look like different Latin letters (Greek Η and η); the skeleton catches look-alike
 * spellings. Exact keys come first. Empty when the name has no visible letters or digits.
 */
export function nameKeys(name: string): string[] {
  const base = visibleBase(name);
  return [...new Set([...exactKeys(base), ...designatorFreeKeys(base)])];
}

/** Strict RFC 4180 subset (the builder's output): quotes only around a whole field, `""` inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let wasQuoted = false;
  const endField = () => {
    row.push(field);
    field = "";
    wasQuoted = false;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (quoted) {
      if (ch === '"' && text.charAt(i + 1) === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') {
      if (field !== "" || wasQuoted) throw new CheckUnavailableError("sanctions list: stray quote");
      quoted = true;
      wasQuoted = true;
    } else if (ch === ",") endField();
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text.charAt(i + 1) === "\n") i += 1;
      endField();
      rows.push(row);
      row = [];
    } else if (wasQuoted) throw new CheckUnavailableError("sanctions list: text after a closing quote");
    else field += ch;
  }
  if (quoted) throw new CheckUnavailableError("sanctions list: unterminated quote");
  if (field !== "" || row.length > 0) {
    endField();
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

type SanctionsIndex = ReadonlyMap<string, string>;

/** Every listed string (name, each ';' part of a combined name, each alias) by match key; the first wins. */
export function buildIndex(csvText: string): SanctionsIndex {
  const [header, ...rows] = parseCsv(csvText.replace(/^\uFEFF/, ""));
  if (!header || header.join(",") !== SANCTIONS_CSV_COLUMNS.join(",")) throw new CheckUnavailableError("sanctions list: unexpected header");
  if (rows.length === 0) throw new CheckUnavailableError("sanctions list is empty");
  const index = new Map<string, string>();
  const listedNames: string[] = [];
  rows.forEach((cells, i) => {
    const parsed = SanctionsRow.safeParse(Object.fromEntries(SANCTIONS_CSV_COLUMNS.map((c, j) => [c, cells[j]])));
    if (cells.length !== SANCTIONS_CSV_COLUMNS.length || !parsed.success) throw new CheckUnavailableError(`sanctions list: row ${i + 2} is malformed`);
    const { name, aliases } = parsed.data;
    listedNames.push(...[name, ...(name.includes(";") ? name.split(";") : []), ...aliases.split(";")].map((n) => n.trim()).filter(Boolean));
  });
  // Exact keys first for every listed string, then designator-free keys only where no exact key took the slot, so an
  // exact match still reports the listed string it matches.
  for (const listed of listedNames) for (const key of exactKeys(visibleBase(listed))) if (!index.has(key)) index.set(key, listed);
  for (const listed of listedNames) for (const key of designatorFreeKeys(visibleBase(listed))) if (!index.has(key)) index.set(key, listed);
  return index;
}

/** data/sanctions/un_sc.csv under HOGEE_DATA_DIR, else under the first parent of the cwd holding data/schemas. */
export function defaultSanctionsPath(env: NodeJS.ProcessEnv = process.env, from = process.cwd()): string {
  const explicit = env.HOGEE_DATA_DIR;
  if (explicit) return join(resolve(/*turbopackIgnore: true*/ explicit), "sanctions", "un_sc.csv");
  let dir = resolve(/*turbopackIgnore: true*/ from);
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "data", "schemas"))) return join(dir, "data", "sanctions", "un_sc.csv");
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new CheckUnavailableError("sanctions list not found (set HOGEE_DATA_DIR)");
}

let cache: { readonly path: string; readonly mtimeMs: number; readonly size: number; readonly index: SanctionsIndex } | null = null;

async function loadIndex(path: string): Promise<SanctionsIndex> {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new CheckUnavailableError("sanctions list is missing");
  }
  if (!stat.isFile() || stat.size === 0) throw new CheckUnavailableError("sanctions list is missing or empty");
  if (stat.size > MAX_LIST_BYTES) throw new CheckUnavailableError("sanctions list is too large");
  if (cache && cache.path === path && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.index;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
  } catch {
    throw new CheckUnavailableError("sanctions list is not valid UTF-8");
  }
  const index = buildIndex(text);
  cache = { path, mtimeMs: stat.mtimeMs, size: stat.size, index };
  return index;
}

export interface ScreenOptions {
  /** Path of the list (default: defaultSanctionsPath()). */
  readonly csvPath?: string;
}

/** Local match against data/sanctions/un_sc.csv (names + aliases). Offline; throws when the list cannot be read. */
export async function screenSanctions(name: string, opts: ScreenOptions = {}): Promise<SanctionsResult> {
  if (typeof name !== "string" || name.trim() === "" || name.length > MAX_NAME_CHARS) {
    throw new CheckInputError(`name must be 1-${MAX_NAME_CHARS} characters`);
  }
  const keys = nameKeys(name);
  if (keys.length === 0) throw new CheckInputError("name has no letters or digits to screen");
  const index = await loadIndex(opts.csvPath ?? defaultSanctionsPath());
  for (const key of keys) {
    const matched = index.get(key);
    if (matched !== undefined) return { hit: true, list: UN_SC_LIST, matchedName: matched };
  }
  return { hit: false, list: null, matchedName: null };
}
