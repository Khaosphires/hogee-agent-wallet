/**
 * Named checks that data/pii/*.json refer to (`hogee_validator` / `validator`). Each takes the matched text (already
 * folded to ASCII, see fold.ts) and returns true when it really is that identifier. Pure and deterministic.
 */

const digitsOf = (s: string): string => s.replace(/[^0-9]/g, "");
const num = (s: string, from: number, to: number): number => Number(s.slice(from, to));
const allSame = (d: string): boolean => /^(\d)\1*$/.test(d);

/** Days in month `mm` (1-12); a two-digit year divisible by 4 allows 29 February (1900 is the only miss, irrelevant here). */
function daysIn(mm: number, yy: number): number {
  if (mm === 2) return yy % 4 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(mm) ? 30 : 31;
}

function validDate(yy: number, mm: number, dd: number): boolean {
  return mm >= 1 && mm <= 12 && dd >= 1 && dd <= daysIn(mm, yy);
}

/**
 * MyKad place-of-birth codes (JPN): 01-16 states, 21-59 states (alternate codes), 60-68 / 71-72 / 74-79 / 83-93 foreign,
 * 82 unknown state, 98 stateless, 99 other. Never issued: 00, 17-20, 69, 70, 73, 80, 81, 94-97.
 */
function validMyBirthPlace(pb: number): boolean {
  return (pb >= 1 && pb <= 16) || (pb >= 21 && pb <= 68) || pb === 71 || pb === 72 || (pb >= 74 && pb <= 79) || (pb >= 82 && pb <= 93) || pb >= 98;
}

/** MyKad YYMMDD-PB-###G: a real calendar date and an issued place-of-birth code. */
export function isMyNric(text: string): boolean {
  const d = digitsOf(text);
  if (d.length !== 12) return false;
  return validDate(num(d, 0, 2), num(d, 2, 4), num(d, 4, 6)) && validMyBirthPlace(num(d, 6, 8));
}

/**
 * New-format SSM company numbers are YYYY + entity type (01-06) + 6-digit serial. Those registered 2001-2012 also read
 * as a valid MyKad (YY=20, MM=01..12, DD=01..06), so the plain 12-digit form treats that shape as an SSM number.
 */
export function isSsmShaped(digits: string): boolean {
  return /^20(?:0[1-9]|1[0-2])0[1-6]/.test(digits);
}

/** A MyKad written as 12 bare digits: as isMyNric, minus SSM-shaped company numbers. */
export function isMyNricPlain(text: string): boolean {
  return isMyNric(text) && !isSsmShaped(digitsOf(text));
}

/** Dukcapil province codes, including the four Papua provinces created in 2022 (93-96). */
function validIdProvince(pp: number): boolean {
  return (pp >= 11 && pp <= 19) || pp === 21 || (pp >= 31 && pp <= 36) || (pp >= 51 && pp <= 53) || (pp >= 61 && pp <= 65) || (pp >= 71 && pp <= 76) || pp === 81 || pp === 82 || (pp >= 91 && pp <= 96);
}

/** NIK PPKKCC-DDMMYY-SSSS: province, non-zero regency and district, birth date (day + 40 for women), non-zero serial. */
export function isIdNik(text: string): boolean {
  const d = digitsOf(text);
  if (d.length !== 16) return false;
  if (!validIdProvince(num(d, 0, 2)) || num(d, 2, 4) === 0 || num(d, 4, 6) === 0) return false;
  const day = num(d, 6, 8);
  const dd = day > 40 ? day - 40 : day;
  return validDate(num(d, 10, 12), num(d, 8, 10), dd) && num(d, 12, 16) !== 0;
}

const SG_TABLES: Readonly<Record<string, { readonly offset: number; readonly letters: string }>> = {
  S: { offset: 0, letters: "JZIHGFEDCBA" },
  T: { offset: 4, letters: "JZIHGFEDCBA" },
  F: { offset: 0, letters: "XWUTRQPNMLK" },
  G: { offset: 4, letters: "XWUTRQPNMLK" },
  M: { offset: 3, letters: "XWUTRQPNJLK" },
};
const SG_WEIGHTS = [2, 7, 6, 5, 4, 3, 2] as const;

/** Singapore NRIC/FIN [STFGM] + 7 digits + check letter (ICA weights 2765432; S/T, F/G and M tables and offsets). */
export function isSgNric(text: string): boolean {
  const s = text.toUpperCase();
  if (!/^[STFGM]\d{7}[A-Z]$/.test(s)) return false;
  const table = SG_TABLES[s.charAt(0)];
  if (!table) return false;
  let sum = table.offset;
  for (let i = 0; i < SG_WEIGHTS.length; i += 1) sum += Number(s.charAt(i + 1)) * (SG_WEIGHTS[i] ?? 0);
  return table.letters.charAt(sum % 11) === s.charAt(8);
}

export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let v = Number(digits.charAt(digits.length - 1 - i));
    if (i % 2 === 1) {
      v *= 2;
      if (v > 9) v -= 9;
    }
    sum += v;
  }
  return sum % 10 === 0;
}

/** Issuer prefixes: Visa, Mastercard, Amex, Discover, JCB, UnionPay, Diners. */
const CARD_PREFIX = /^(?:4|5[1-5]|2(?:22[1-9]|2[3-9]\d|[3-6]\d\d|7[01]\d|720)|3[47]|6011|64[4-9]|65|35(?:2[89]|[3-8]\d)|62|36|38|30[0-5])/;

/** 13-19 digits, a known issuer prefix and a valid Luhn check digit. */
export function isCreditCard(text: string): boolean {
  const d = digitsOf(text);
  return d.length >= 13 && d.length <= 19 && !allSame(d) && CARD_PREFIX.test(d) && luhn(d);
}

/**
 * A valid card (isCreditCard) of the length nearly every card carries: 16 digits (Visa, Mastercard, Discover, JCB,
 * UnionPay) or 15 (Amex). Not a validator: detect.ts uses it to exempt a card from the money-word veto.
 */
export function isStandardLengthCard(text: string): boolean {
  const n = digitsOf(text).length;
  return (n === 15 || n === 16) && isCreditCard(text);
}

/**
 * A phone written with its international prefix: "+CC", "00CC" or "(CC)" / "(+CC)". "(021)" is a bracketed area code,
 * not a country code. Not a validator: detect.ts uses it to exempt a phone from the money-word veto.
 */
export function hasCountryCode(text: string): boolean {
  return /^(?:\+|00|\(\+?)[1-9]/.test(text);
}

/**
 * NPWP: 15 digits whose 9th is a Luhn check digit over the first 8 (python-stdnum `id.npwp` and Perl
 * Business::ID::NPWP agree, and python-stdnum's 101 published numbers all pass). The 16-digit form is "0" + those 15
 * (same check), or an individual's NIK (DJP via OECD TIN sheet, since 14 July 2022).
 */
export function isIdNpwp(text: string): boolean {
  const d = digitsOf(text);
  if (d.length === 15) return luhn(d.slice(0, 9));
  if (d.length === 16) return d.startsWith("0") ? luhn(d.slice(1, 10)) : isIdNik(d);
  return false;
}

/** Malaysian account numbers run 10-16 digits; a run of one repeated digit is a placeholder, not an account. */
export function isMyBankAccount(text: string): boolean {
  const d = digitsOf(text);
  return d.length >= 10 && d.length <= 16 && !allSame(d);
}

/** Indonesian mobile numbers are 10-13 digits with the leading 0. */
export function isIdMobile(text: string): boolean {
  const d = digitsOf(text);
  return d.length >= 10 && d.length <= 13;
}

/** The domain ends in an alphabetic TLD and no label starts or ends with a hyphen (rules out `pkg@1.2.3`). */
export function isEmail(text: string): boolean {
  const at = text.lastIndexOf("@");
  const labels = text.slice(at + 1).split(".");
  const tld = labels[labels.length - 1] ?? "";
  return /^[A-Za-z]{2,24}$/.test(tld) && labels.every((l) => l.length > 0 && !l.startsWith("-") && !l.endsWith("-"));
}

export const VALIDATORS = {
  MY_NRIC: isMyNric,
  MY_NRIC_PLAIN: isMyNricPlain,
  ID_NIK: isIdNik,
  ID_NPWP: isIdNpwp,
  SG_NRIC: isSgNric,
  CREDIT_CARD: isCreditCard,
  MY_BANK_ACCOUNT: isMyBankAccount,
  ID_MOBILE: isIdMobile,
  EMAIL: isEmail,
} as const satisfies Record<string, (text: string) => boolean>;

export type ValidatorName = keyof typeof VALIDATORS;
export const VALIDATOR_NAMES = Object.keys(VALIDATORS) as [ValidatorName, ...ValidatorName[]];
