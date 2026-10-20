/**
 * Offline registry-number validators: China USCC (GB 32100-2015), Malaysia SSM, Singapore UEN. Results never echo
 * the input. A number that is valid here is only well-formed; it is not proof that the entity exists.
 */
import type { ValidationResult } from "./types";

const MAX_INPUT_CHARS = 64;
const OK: ValidationResult = { valid: true };
const NOT_ASCII = "not a printable ASCII string of at most 64 characters";
const bad = (reason: string): ValidationResult => ({ valid: false, reason });

/** Trimmed, upper-cased, inner whitespace collapsed; null unless a printable-ASCII string (so `ſ` never folds to S). */
function normalised(input: unknown): string | null {
  if (typeof input !== "string" || input.length > MAX_INPUT_CHARS || /[^\x09-\x0d\x20-\x7e]/.test(input)) return null;
  return input.trim().replace(/\s+/g, " ").toUpperCase();
}

function plausibleYear(year: number, earliest: number): boolean {
  return year >= earliest && year <= new Date().getUTCFullYear();
}

// ---- China USCC (GB 32100-2015) ------------------------------------------------------------------

/** The 31 code characters: digits and capitals without I, O, Z, S, V. A character's value is its index. */
export const USCC_CHARSET = "0123456789ABCDEFGHJKLMNPQRTUWXY";
/** Weight of position i (0-based) = 3^i mod 31. */
const USCC_WEIGHTS = Array.from({ length: 17 }, (_, i) => Number(3n ** BigInt(i) % 31n));

/** The GB 32100-2015 check character for the first 17 characters (assumed in USCC_CHARSET). */
export function usccCheckChar(first17: string): string {
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += USCC_CHARSET.indexOf(first17.charAt(i)) * (USCC_WEIGHTS[i] ?? 0);
  return USCC_CHARSET.charAt((31 - (sum % 31)) % 31);
}

/**
 * China Unified Social Credit Code: 18 characters from the GB 32100-2015 set; characters 3–8 are the 6-digit
 * administrative division code; character 18 is the check character (weights 3^i mod 31, check = 31 − Σ mod 31).
 */
export function validateUSCC(code: string): ValidationResult {
  const c = normalised(code);
  if (c === null) return bad(NOT_ASCII);
  if (c.length !== 18) return bad("a USCC has 18 characters");
  if ([...c].some((ch) => !USCC_CHARSET.includes(ch))) return bad("contains a character outside the GB 32100-2015 set");
  if (!/^\d{6}$/.test(c.slice(2, 8))) return bad("characters 3-8 must be the 6-digit administrative division code");
  if (usccCheckChar(c) !== c.charAt(17)) return bad("check character does not match");
  return OK;
}

// ---- Malaysia SSM ----------------------------------------------------------------------------------

type SsmKind = "company" | "business" | "llp";

/** Entity-type digits (5th–6th) of the 12-digit number that this validator accepts, and the register each belongs to. */
const SSM_ENTITY_CODES: Readonly<Record<string, SsmKind>> = { "01": "company", "02": "company", "03": "business", "04": "llp" };
/** Earliest registration year accepted in the 12-digit format. */
const SSM_EARLIEST_YEAR = 1800;

const SSM_NEW = /^(\d{4})(\d{2})(\d{6})$/;
const SSM_COMBINED = /^(\d{12}) ?\(([^()]+)\)$/;
const SSM_OLD: ReadonlyArray<readonly [SsmKind, RegExp]> = [
  ["company", /^[1-9]\d{0,6}-?[A-Z]$/], // e.g. 1312525-A
  ["business", /^(?:\d{9}|[A-Z]{2}\d{7})-?[A-Z]$/], // e.g. 003398685-U, CT0132710-X
  ["llp", /^LLP\d{7}-?L[A-Z]{2}$/], // e.g. LLP0028186-LGN
];

function ssmNewKind(n: string): SsmKind | string {
  const m = SSM_NEW.exec(n);
  if (!m) return "the new format is 12 digits";
  if (!plausibleYear(Number(m[1]), SSM_EARLIEST_YEAR)) return "the first 4 digits must be a registration year";
  const kind = SSM_ENTITY_CODES[m[2] ?? ""];
  if (!kind) return "digits 5-6 are not a known SSM entity type (01, 02, 03, 04)";
  if (m[3] === "000000") return "the 6-digit sequence cannot be 000000";
  return kind;
}

const ssmOldKind = (n: string): SsmKind | null => SSM_OLD.find(([, re]) => re.test(n))?.[0] ?? null;
const isKind = (k: string): k is SsmKind => k === "company" || k === "business" || k === "llp";

/**
 * Malaysian SSM registration number. Accepts the 12-digit format (YYYY + entity-type digits + 6-digit sequence;
 * 01/02 company, 03 business, 04 LLP), the old formats (company `1234567-X`, business `003398685-U` or
 * `CT0132710-X`, LLP `LLP0028186-LGN`), and the combined form `201901000005 (1312525-A)`, whose two parts must name
 * the same register. Old check letters are format-checked only (SSM publishes no algorithm).
 */
export function validateSSM(registrationNumber: string): ValidationResult {
  const n = normalised(registrationNumber);
  if (n === null) return bad(NOT_ASCII);
  const combined = SSM_COMBINED.exec(n);
  if (combined) {
    const kind = ssmNewKind(combined[1] ?? "");
    if (!isKind(kind)) return bad(kind);
    const oldKind = ssmOldKind(combined[2] ?? "");
    if (!oldKind) return bad("the bracketed old number has an unknown format");
    return oldKind === kind ? OK : bad("the new and old numbers name different registers");
  }
  if (/^\d{12}$/.test(n)) {
    const kind = ssmNewKind(n);
    return isKind(kind) ? OK : bad(kind);
  }
  return ssmOldKind(n) ? OK : bad("not an SSM registration number format");
}

// ---- Singapore UEN ---------------------------------------------------------------------------------

const UEN_BUSINESS = /^\d{8}[A-Z]$/;
const UEN_LOCAL_COMPANY = /^(\d{4})\d{5}[A-Z]$/;
const UEN_OTHER = /^([TS])(\d{2})[A-Z]{2}\d{4}[A-Z]$/;
/** Earliest incorporation year accepted for a local-company UEN. */
const UEN_EARLIEST_YEAR = 1800;

/**
 * Singapore Unique Entity Number, format only: businesses `nnnnnnnnX` (8 digits + letter), local companies
 * `yyyynnnnnX` (year + 5 digits + letter), other entities `TyyPQnnnnX` (T = 20yy, S = 19yy, PQ = entity-type
 * letters, 4 digits, letter). ACRA does not publish the check-letter algorithm, so the last letter is not verified.
 */
export function validateUEN(uen: string): ValidationResult {
  const u = normalised(uen);
  if (u === null) return bad(NOT_ASCII);
  if (UEN_BUSINESS.test(u)) return OK;
  const company = UEN_LOCAL_COMPANY.exec(u);
  if (company) return plausibleYear(Number(company[1]), UEN_EARLIEST_YEAR) ? OK : bad("the first 4 digits must be a registration year");
  const other = UEN_OTHER.exec(u);
  if (other) {
    const year = (other[1] === "T" ? 2000 : 1900) + Number(other[2]);
    return plausibleYear(year, 1900) ? OK : bad("the year digits are in the future");
  }
  return bad("not a UEN format (nnnnnnnnX, yyyynnnnnX or TyyPQnnnnX)");
}
