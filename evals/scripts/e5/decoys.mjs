/**
 * E5 hard negatives: numbers that look like the PII formats but are not personal data, so a correct
 * redactor must leave them. Each returns { decoy: kind, text }; the generator rejects a document if any
 * of them passes a detector (see ids.mjs), so every decoy here fails the format, validator or context rule.
 */
import { daysIn, genMyKad, pad } from "./ids.mjs";

const dec = (decoy, text) => ({ decoy, text });
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const upper = (r, n) => Array.from({ length: n }, () => r.pick([...UPPER])).join("");
const alnum = (r, n) => Array.from({ length: n }, () => r.pick([...`${UPPER}0123456789`])).join("");
const hex = (r, n, alphabet = "0123456789abcdef") => Array.from({ length: n }, () => r.pick([...alphabet])).join("");
const group = (digits, sep) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, sep);

// ---- on-chain references ------------------------------------------------------------------------
/** 0x + 64 hex; half of them hide a MyKad-valid 12-digit run between hex letters (a trap for unbounded regexes). */
export function txHash(r) {
  if (!r.chance(0.5)) return dec("hex_hash", `0x${hex(r, 64)}`);
  const run = genMyKad(r).text.replace(/\D/g, "");
  const before = r.int(4, 40);
  const body = `${hex(r, before - 1)}${hex(r, 1, "abcdef")}${run}${hex(r, 1, "abcdef")}`;
  return dec("hex_hash", `0x${body}${hex(r, 64 - body.length)}`);
}
export const address = (r) => dec("hex_address", `0x${hex(r, 40)}`);

// ---- marketplace and logistics ids ----------------------------------------------------------------
export function orderId(r, platform) {
  const yymmdd = `26${pad(r.int(9, 11), 2)}${pad(r.int(1, 28), 2)}`;
  if (platform === "shopee") return dec("order_id", `${yymmdd}${upper(r, 2)}${alnum(r, 6)}`);
  if (platform === "lazada") return dec("order_id", `${r.pick(["2", "3"])}${r.digits(r.pick([14, 15]))}`);
  if (platform === "tiktok") return dec("order_id", `5${r.pick(["7", "8"])}${r.digits(16)}`);
  if (platform === "tokopedia") return dec("order_id", `INV/20${yymmdd}/MPL/${r.int(2, 9)}${r.digits(9)}`);
  throw new Error(`unknown platform ${platform}`);
}
export const invoiceNo = (r, prefix = "INV") => dec("invoice_no", `${prefix}-2026-${pad(r.int(1, 99999), 5)}`);
export const quoteNo = (r) => dec("invoice_no", `QT-26${pad(r.int(9, 11), 2)}-${pad(r.int(1, 999), 3)}`);
export function tracking(r, country = "MY") {
  const kind = r.int(0, 2);
  if (kind === 0) return dec("tracking", `SPX${country}${r.digits(12)}`);
  if (kind === 1) return dec("tracking", `${r.pick(["JP", "JX", "NV"])}${r.digits(10)}`);
  return dec("tracking", `E${r.pick(["R", "P", "M"])}${r.digits(9)}${country}`);
}
export const billOfLading = (r) => dec("bill_of_lading", `${r.pick(["MEDU", "COSU", "ONEY", "EGLV"])}${upper(r, 2)}${r.digits(8)}`);

/** ISO 6346 container number with a correct check digit. */
export function container(r) {
  const owner = `${upper(r, 3)}U${r.digits(6)}`;
  const values = {};
  let v = 10;
  for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    if (v % 11 === 0) v++;
    values[ch] = v++;
  }
  const sum = [...owner].reduce((acc, ch, i) => acc + (values[ch] ?? Number(ch)) * 2 ** i, 0);
  return dec("container", `${owner}${(sum % 11) % 10}`);
}

// ---- company registrations ------------------------------------------------------------------------
/** SSM: new 12-digit form uses years 2015+ so it never reads as a valid MyKad birth date. */
export function ssm(r) {
  const kind = r.int(0, 2);
  if (kind === 0) return dec("ssm", `20${r.int(15, 26)}${r.pick(["01", "03"])}${r.digits(6)}`);
  if (kind === 1) return dec("ssm", `${r.int(1, 1599999)}-${upper(r, 1)}`);
  return dec("ssm", `${r.pick(["JM", "SA", "KT", "PG", "CA"])}${r.digits(7)}-${upper(r, 1)}`);
}
/** Singapore UEN, types A (business), B (local company) and C (other entities). */
export function uen(r, type = r.pick(["A", "B", "C"])) {
  if (type === "A") return dec("uen", `${r.int(52, 53)}${r.digits(6)}${upper(r, 1)}`);
  if (type === "B") return dec("uen", `20${pad(r.int(8, 25), 2)}${r.digits(5)}${upper(r, 1)}`);
  return dec("uen", `T${pad(r.int(8, 25), 2)}${r.pick(["LL", "SS", "FC", "PF"])}${r.digits(4)}${upper(r, 1)}`);
}
export const npraNotification = (r) => dec("permit_no", `NOT26${pad(r.int(1, 10), 2)}${r.digits(5)}${upper(r, 1)}`);

// ---- money, dates, tariff codes, masked values ---------------------------------------------------
const MONEY_FORMS = {
  MYR: [(b) => `RM ${b}`, (b) => `RM${b}`, (b) => `MYR ${b}`],
  USD: [(b) => `USD ${b}`, (b) => `US$${b}`],
  SGD: [(b) => `SGD ${b}`, (b) => `S$${b}`],
  IDR: [(b) => `Rp ${b}`, (b) => `Rp${b},00`],
};

/** A formatter with one style per document: minor units (integer) → amount decoy. IDR has no cents. */
export function moneyFmt(r, currency) {
  const form = r.pick(MONEY_FORMS[currency]);
  if (currency === "IDR") return (minor) => dec("amount", form(group(String(Math.floor(minor / 100)), ".")));
  return (minor) => dec("amount", form(`${group(String(Math.floor(minor / 100)), ",")}.${pad(minor % 100, 2)}`));
}

/** Minor units for an amount between loMajor and hiMajor whole units (IDR rounded to Rp1,000; else to 0.50). */
export const minorBetween = (r, currency, loMajor, hiMajor) =>
  currency === "IDR" ? r.int(Math.ceil(loMajor / 1000), Math.floor(hiMajor / 1000)) * 100000 : r.int(loMajor * 2, hiMajor * 2) * 50;

/** A one-off amount between loMajor and hiMajor whole currency units. */
export const amount = (r, currency, loMajor, hiMajor) => moneyFmt(r, currency)(minorBetween(r, currency, loMajor, hiMajor));

const MONTHS = {
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  ms: ["Jan", "Feb", "Mac", "Apr", "Mei", "Jun", "Jul", "Ogos", "Sep", "Okt", "Nov", "Dis"],
  id: ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"],
};
function dayToYmd(dayIndex) {
  let [y, m, d] = [2026, 9, 1 + dayIndex];
  while (d > daysIn(y, m)) {
    d -= daysIn(y, m);
    [y, m] = m === 12 ? [y + 1, 1] : [y, m + 1];
  }
  return [y, m, d];
}

function formatDate(lang, style, [y, m, d]) {
  if (lang === "zh") return style ? `${y}年${m}月${d}日` : `${y}-${pad(m, 2)}-${pad(d, 2)}`;
  if (style === 1) return lang === "id" ? `${pad(d, 2)}-${pad(m, 2)}-${y}` : `${pad(d, 2)}/${pad(m, 2)}/${y}`;
  return `${d} ${MONTHS[lang][m - 1]} ${y}`;
}

/**
 * Dates for one document, in one style the way `lang` writes them, that only move forward:
 * next(minGap, maxGap) is that many days after the previous one (the first falls in Sep–Oct 2026).
 */
export function dateSeq(r, lang) {
  const style = r.int(0, 1);
  let day = r.int(0, 60);
  return (minGap = 0, maxGap = minGap) => {
    day += r.int(minGap, maxGap);
    return dec("date", formatDate(lang, style, dayToYmd(day)));
  };
}
export const date = (r, lang) => dateSeq(r, lang)();

/** HS heading for a product kind, in a national 8/10-digit or compact 10-digit form. */
export function hsCode(r, heading) {
  const [h4, h2] = heading.split(".");
  const style = r.int(0, 2);
  if (style === 0) return dec("hs_code", `${h4}.${h2}.${r.pick(["10", "20", "90"])}`);
  if (style === 1) return dec("hs_code", `${h4}.${h2}.${r.pick(["10", "90"])}${r.pick(["00", "10"])}`);
  return dec("hs_code", `${h4}${h2}${r.pick(["10", "90"])}${r.pick(["00", "10", "90"])}`);
}

export function masked(r, kind) {
  if (kind === "phone") return dec("masked", `01${r.int(0, 9)}-*** ${r.digits(4)}`);
  if (kind === "ic") return dec("masked", `******-**-${r.digits(4)}`);
  return dec("masked", r.pick([`****${r.digits(4)}`, `xxxx-xxxx-${r.digits(4)}`, `**** **** ${r.digits(4)}`]));
}

export const postcode = (r, country) => dec("postcode", country === "SG" ? `${r.int(10, 82)}${r.digits(4)}` : `${r.int(10, 98)}${r.digits(3)}`);
export const timeOfDay = (r) => `${pad(r.int(8, 22), 2)}:${pad(r.int(0, 59), 2)}`;
