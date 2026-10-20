/**
 * E5 PII formats (project.md §12.2, §15; SG names from SG-DECISIONS.md): seeded synthetic generators, the
 * validators, and the reference detector whose output DEFINES the labels. A labelled span is exactly a number
 * that matches one of its entity's formats, passes the validator (date/region/checksum/prefix, or a bank word
 * before it on the same line for MY_BANK_ACCOUNT) and is not part of a longer letter/digit group.
 * Offsets are Unicode code points, end exclusive (G0-DECISION in packages/core/src/schemas/datasets.ts).
 */

// ---- seeded randomness (no Math.random, no clock) ---------------------------------------------
export function seedFor(...parts) {
  let h = 0x811c9dc5;
  for (const ch of parts.join(":")) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function rngFrom(seed) {
  let a = seed >>> 0;
  const float = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo, hi) => lo + Math.floor(float() * (hi - lo + 1));
  const pick = (arr) => arr[int(0, arr.length - 1)];
  const chance = (p) => float() < p;
  const digits = (n) => Array.from({ length: n }, () => String(int(0, 9))).join("");
  const shuffle = (arr) => {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(0, i);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  return { float, int, pick, chance, digits, shuffle };
}

// ---- small helpers ------------------------------------------------------------------------------
export const pad = (n, w) => String(n).padStart(w, "0");
const range = (lo, hi) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
const onlyDigits = (s) => s.replace(/\D/g, "");
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const daysIn = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
const validDate = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m);
const validYymmdd = (yy, mm, dd) => validDate(1900 + yy, mm, dd) || validDate(2000 + yy, mm, dd);
const ent = (entity, text, format) => ({ entity, text, format });

/** Example numbers from specs and library docs (core example, python-stdnum and Business::ID::NPWP docs), never reused. */
const WELL_KNOWN = new Set(["900101145678", "0123456789", "60123456789", "013000666091000", "021832415000000", "S1234567D"]);

/** True for runs a human would spot as made up (5 equal digits, 5 ascending or descending) or a known example. */
export function rejectValue(text) {
  const d = onlyDigits(text);
  if (WELL_KNOWN.has(d) || WELL_KNOWN.has(text)) return true;
  if (/(\d)\1{4}/.test(d)) return true;
  let up = 1;
  let down = 1;
  for (let i = 1; i < d.length; i++) {
    const step = d.charCodeAt(i) - d.charCodeAt(i - 1);
    up = step === 1 ? up + 1 : 1;
    down = step === -1 ? down + 1 : 1;
    if (up >= 5 || down >= 5) return true;
  }
  return false;
}

const until = (make) => {
  for (let i = 0; i < 1000; i++) {
    const v = make();
    if (v && !rejectValue(v.text)) return v;
  }
  throw new Error("value generator exhausted"); // fail closed
};

// ---- MY_NRIC (MyKad YYMMDD-PB-###G) ---------------------------------------------------------------
const MY_PB_BORN_IN_MY = [...range(1, 16), ...range(21, 59)].map((n) => pad(n, 2));
const MY_PB_VALID = new Set([...range(1, 16), ...range(21, 68), 71, 72, ...range(74, 79), ...range(82, 93), 98, 99].map((n) => pad(n, 2)));

export function validMyKad(text) {
  const d = onlyDigits(text);
  if (d.length !== 12) return false;
  return validYymmdd(+d.slice(0, 2), +d.slice(2, 4), +d.slice(4, 6)) && MY_PB_VALID.has(d.slice(6, 8));
}

export function genMyKad(r) {
  return until(() => {
    const y = r.int(1965, 2004);
    const m = r.int(1, 12);
    const day = r.int(1, daysIn(y, m));
    if (m === 1 && day === 1) return null;
    const d = pad(y % 100, 2) + pad(m, 2) + pad(day, 2) + r.pick(MY_PB_BORN_IN_MY) + r.digits(4);
    const f = r.float();
    if (f < 0.6) return ent("MY_NRIC", `${d.slice(0, 6)}-${d.slice(6, 8)}-${d.slice(8)}`, "dashed");
    if (f < 0.9) return ent("MY_NRIC", d, "plain");
    return ent("MY_NRIC", `${d.slice(0, 6)} ${d.slice(6, 8)} ${d.slice(8)}`, "spaced");
  });
}

// ---- ID_NIK (16 digits: province, regency, district, DDMMYY with DD+40 for women, serial) --------
const ID_PROVINCES_GEN = [11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 31, 32, 33, 34, 35, 36, 51, 52, 53, 61, 62, 63, 64, 65, 71, 72, 73, 74, 75, 76, 81, 82];
const ID_PROVINCES_VALID = new Set([...ID_PROVINCES_GEN, ...range(91, 96)].map((n) => pad(n, 2)));

export function validNik(text) {
  const d = onlyDigits(text);
  if (d.length !== 16 || !ID_PROVINCES_VALID.has(d.slice(0, 2))) return false;
  if (d.slice(2, 4) === "00" || d.slice(4, 6) === "00" || d.slice(12) === "0000") return false;
  const dd = +d.slice(6, 8);
  return validYymmdd(+d.slice(10, 12), +d.slice(8, 10), dd > 40 ? dd - 40 : dd);
}

export function genNik(r) {
  return until(() => {
    const y = r.int(1965, 2004);
    const m = r.int(1, 12);
    const day = r.int(1, daysIn(y, m));
    const female = r.chance(0.5);
    const regency = r.chance(0.7) ? r.int(1, 12) : r.int(71, 76);
    const d = pad(r.pick(ID_PROVINCES_GEN), 2) + pad(regency, 2) + pad(r.int(1, 25), 2) + pad(female ? day + 40 : day, 2) + pad(m, 2) + pad(y % 100, 2) + pad(r.int(1, 2999), 4);
    if (r.chance(0.12)) return ent("ID_NIK", d.match(/.{4}/g).join(" "), "spaced");
    return ent("ID_NIK", d, "plain");
  });
}

// ---- ID_NPWP (15 digits, 9th = Luhn check over the first 8; or 16 = "0" + 15 since 2024) ---------
export function luhnValid(s) {
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    let v = +s[s.length - 1 - i];
    if (i % 2 === 1) v = v * 2 > 9 ? v * 2 - 9 : v * 2;
    sum += v;
  }
  return sum % 10 === 0;
}
const luhnDigit = (payload) => String(range(0, 9).find((c) => luhnValid(payload + c)));

export function validNpwp(text) {
  let d = onlyDigits(text);
  if (d.length === 16) {
    if (d[0] !== "0") return false;
    d = d.slice(1);
  }
  return d.length === 15 && luhnValid(d.slice(0, 9));
}

/** company: a business NPWP (types 01–03, may use the 16-digit form); otherwise a pre-2024 personal NPWP. */
export function genNpwp(r, { company = r.chance(0.6) } = {}) {
  return until(() => {
    const first8 = r.pick(company ? ["01", "02", "03"] : ["04", "05", "06", "07", "08", "09"]) + r.digits(6);
    const d = first8 + luhnDigit(first8) + pad(r.int(1, 999), 3) + (r.chance(0.85) ? "000" : pad(r.int(1, 3), 3));
    const f = r.float();
    if (company && f < 0.2) return ent("ID_NPWP", `0${d}`, "npwp16");
    if (f < 0.75) return ent("ID_NPWP", `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}.${d[8]}-${d.slice(9, 12)}.${d.slice(12)}`, "dotted");
    return ent("ID_NPWP", d, "plain");
  });
}

// ---- MY_BANK_ACCOUNT (no checksum exists: length per bank + a bank word before it on the line) ------
export const MY_BANKS = [
  { name: "Maybank", len: 12, lead: ["1", "5"] },
  { name: "CIMB Bank", len: 10, lead: ["7", "8"] },
  { name: "Public Bank", len: 10, lead: ["3", "4", "6"] },
  { name: "RHB Bank", len: 14, lead: ["1", "2"] },
  { name: "Hong Leong Bank", len: 11, lead: ["1", "2", "3"] },
  { name: "AmBank", len: 13, lead: ["8"] },
  { name: "Bank Islam", len: 14, lead: ["1"] },
  { name: "BSN", len: 16, lead: ["1"] },
];
const BANK_LENGTHS = new Set(MY_BANKS.map((b) => b.len));
/** Lower-case words that make a 10–16 digit number a bank account when they precede it on the same line. */
export const BANK_WORDS = ["bank", "akaun", "account", "acct", "a/c", "cimb", "rhb", "bsn", "hong leong", "户口", "账户", "账号", "银行"];
export const BANK_WINDOW = 48;

export const validMyBank = (text) => {
  const d = onlyDigits(text);
  return BANK_LENGTHS.has(d.length) && d[0] !== "0";
};

/** Returns { bank, value } so the template can name the bank next to its account number. */
export function genMyBank(r) {
  const bank = r.pick(MY_BANKS);
  const value = until(() => {
    const d = r.pick(bank.lead) + r.digits(bank.len - 1);
    const groupable = bank.len === 12 || bank.len === 16;
    const f = r.float();
    if (groupable && f < 0.2) return ent("MY_BANK_ACCOUNT", d.match(/.{4}/g).join(" "), "grouped-space");
    if (groupable && f < 0.35) return ent("MY_BANK_ACCOUNT", d.match(/.{4}/g).join("-"), "grouped-dash");
    return ent("MY_BANK_ACCOUNT", d, "plain");
  });
  return { bank: bank.name, value };
}

// ---- MY_PHONE (+60 / 0; mobile 01X, landline 03 + 8, 0[4-79] + 7, 08[2-9] + 6) --------------------
export function validMyPhone(text) {
  let d = onlyDigits(text);
  if (text.startsWith("+")) {
    if (!d.startsWith("60")) return false;
    d = d.slice(2);
  } else if (d[0] === "0") d = d.slice(1);
  else return false;
  if (/^1\d/.test(d)) return d.length === (d.startsWith("11") || d.startsWith("15") ? 10 : 9);
  if (d[0] === "3") return d.length === 9;
  if (/^[4-79]/.test(d)) return d.length === 8;
  if (/^8[2-9]/.test(d)) return d.length === 8;
  return false;
}

/** kind "mobile" or "landline"; `area` (e.g. "3", "82") pins a landline to the address it sits next to. */
export function genMyPhone(r, kind = "mobile", area = undefined) {
  return until(() => {
    let lead;
    let groups;
    if (kind === "mobile") {
      lead = r.pick(["10", "11", "12", "12", "13", "14", "16", "17", "18", "19"]);
      const sub = r.digits(lead === "11" ? 8 : 7);
      groups = lead === "11" ? [sub.slice(0, 4), sub.slice(4)] : [sub.slice(0, 3), sub.slice(3)];
    } else {
      lead = area ?? r.pick(["3", "3", "3", "4", "5", "6", "7", "9", "82", "88"]);
      const subLen = lead === "3" ? 8 : lead.length === 2 ? 6 : 7;
      const sub = String(r.int(2, 9)) + r.digits(subLen - 1);
      groups = subLen === 8 ? [sub.slice(0, 4), sub.slice(4)] : [sub.slice(0, 3), sub.slice(3)];
    }
    const style = r.int(0, 2);
    if (r.chance(kind === "mobile" ? 0.3 : 0.15)) {
      const text = [`+60 ${lead}-${groups[0]} ${groups[1]}`, `+60${lead}-${groups[0]} ${groups[1]}`, `+60${lead}${groups.join("")}`][style];
      return ent("MY_PHONE", text, `${kind}-intl-${["spaced", "compact", "plain"][style]}`);
    }
    const text = [`0${lead}-${groups[0]} ${groups[1]}`, `0${lead}-${groups.join("")}`, `0${lead}${groups.join("")}`][style];
    return ent("MY_PHONE", text, `${kind}-national-${["spaced", "dash", "plain"][style]}`);
  });
}

// ---- ID_PHONE (+62 / 0; mobile 08xx with an operator prefix, landline (0xx) / +62 xx) ------------
const ID_MOBILE_PREFIXES = ["811", "812", "813", "821", "822", "823", "851", "852", "853", "814", "815", "816", "855", "856", "857", "858", "817", "818", "819", "859", "877", "878", "831", "832", "833", "838", "881", "882", "887", "888", "889", "895", "896", "897", "898", "899"];
const ID_AREAS = [
  { code: "21", sub: 8 },
  { code: "22", sub: 7 },
  { code: "24", sub: 7 },
  { code: "31", sub: 7 },
  { code: "61", sub: 7 },
  { code: "274", sub: 6 },
  { code: "361", sub: 6 },
  { code: "411", sub: 6 },
];

export function validIdPhone(text) {
  let d = onlyDigits(text);
  if (text.startsWith("+")) {
    if (!d.startsWith("62")) return false;
    d = d.slice(2);
  } else if (d[0] === "0") d = d.slice(1);
  else return false;
  if (d[0] === "8") return ID_MOBILE_PREFIXES.includes(d.slice(0, 3)) && d.length >= 9 && d.length <= 12;
  // Landline: any 2–3 digit area code (not 0, 1 or 8) and a 6–8 digit subscriber number.
  return /^[2-79]/.test(d) && d.length >= 8 && d.length <= 11;
}

/** kind "mobile" or "landline"; `areaCode` (e.g. "21", "274") pins a landline to its city. */
export function genIdPhone(r, kind = "mobile", areaCode = undefined) {
  return until(() => {
    if (kind === "mobile") {
      const p = r.pick(ID_MOBILE_PREFIXES);
      const rest = r.digits(r.pick([7, 8, 8, 8, 8, 9]));
      const [a, b] = [rest.slice(0, 4), rest.slice(4)];
      const style = r.int(0, 2);
      if (r.chance(0.3)) {
        const text = [`+62 ${p}-${a}-${b}`, `+62 ${p} ${a} ${b}`, `+62${p}${rest}`][style];
        return ent("ID_PHONE", text, `mobile-intl-${["dash", "spaced", "plain"][style]}`);
      }
      const text = [`0${p}-${a}-${b}`, `0${p} ${a} ${b}`, `0${p}${rest}`][style];
      return ent("ID_PHONE", text, `mobile-national-${["dash", "spaced", "plain"][style]}`);
    }
    const area = ID_AREAS.find((a) => a.code === areaCode) ?? r.pick(ID_AREAS);
    const sub = String(r.int(2, 9)) + r.digits(area.sub - 1);
    const cut = area.sub === 8 ? 4 : 3;
    if (r.chance(0.25)) return ent("ID_PHONE", `+62 ${area.code} ${sub.slice(0, cut)} ${sub.slice(cut)}`, "landline-intl");
    return ent("ID_PHONE", `(0${area.code}) ${sub.slice(0, cut)} ${sub.slice(cut)}`, "landline-national");
  });
}

// ---- SG_NRIC ([STFGM] + 7 digits + check letter) and SG_PHONE (8 digits from 3/6/8/9, optional +65)
const SG_WEIGHTS = [2, 7, 6, 5, 4, 3, 2];
const SG_LETTERS = { S: "JZIHGFEDCBA", T: "JZIHGFEDCBA", F: "XWUTRQPNMLK", G: "XWUTRQPNMLK", M: "XWUTRQPNJLK" };
const SG_OFFSET = { S: 0, T: 4, F: 0, G: 4, M: 3 };

export function sgCheckLetter(prefix, digits7) {
  const total = [...digits7].reduce((acc, c, i) => acc + Number(c) * SG_WEIGHTS[i], SG_OFFSET[prefix]);
  return SG_LETTERS[prefix][total % 11];
}

export const validSgNric = (text) => /^[STFGM]\d{7}[A-Z]$/.test(text) && sgCheckLetter(text[0], text.slice(1, 8)) === text[8];

export function genSgNric(r, prefix = r.pick(["S", "S", "S", "S", "T", "T", "F", "G", "G", "M"])) {
  return until(() => {
    const lead = prefix === "S" ? pad(r.int(65, 99), 2) : prefix === "T" ? pad(r.int(0, 8), 2) : r.digits(2);
    const digits = lead + r.digits(5);
    return ent("SG_NRIC", `${prefix}${digits}${sgCheckLetter(prefix, digits)}`, prefix === "S" || prefix === "T" ? "nric" : "fin");
  });
}

export function validSgPhone(text) {
  let d = onlyDigits(text);
  if (text.startsWith("+")) {
    if (!d.startsWith("65")) return false;
    d = d.slice(2);
  }
  return d.length === 8 && /^[3689]/.test(d);
}

export function genSgPhone(r, kind = "mobile") {
  return until(() => {
    const first = kind === "mobile" ? r.pick(["8", "9", "9"]) : kind === "landline" ? "6" : "3";
    const n = first + r.digits(7);
    const style = r.int(0, 4);
    const text = [`${n.slice(0, 4)} ${n.slice(4)}`, n, `+65 ${n.slice(0, 4)} ${n.slice(4)}`, `+65 ${n}`, `+65${n}`][style];
    return ent("SG_PHONE", text, `${kind}-${["spaced", "plain", "intl-spaced", "intl-plain", "intl-compact"][style]}`);
  });
}

// ---- reference detector ----------------------------------------------------------------------------
// Not inside a longer letter/digit group: no ASCII letter or digit next to it, and no digit + one space
// or dash next to it ("03-6201 2345" never yields an SG "6201 2345").
const LEFT = String.raw`(?<![A-Za-z0-9])(?<!\d[ -])`;
const RIGHT = String.raw`(?![A-Za-z0-9])(?![ -]\d)`;

export const DETECTORS = [
  { entity: "MY_NRIC", formats: [String.raw`\d{6}-\d{2}-\d{4}`, String.raw`\d{12}`, String.raw`\d{6} \d{2} \d{4}`], valid: validMyKad },
  { entity: "ID_NIK", formats: [String.raw`\d{16}`, String.raw`\d{4} \d{4} \d{4} \d{4}`], valid: validNik },
  { entity: "ID_NPWP", formats: [String.raw`\d{2}\.\d{3}\.\d{3}\.\d-\d{3}\.\d{3}`, String.raw`\d{15}`, String.raw`0\d{15}`], valid: validNpwp },
  { entity: "MY_BANK_ACCOUNT", formats: [String.raw`\d{10,16}`, String.raw`\d{4}([ -])\d{4}\1\d{4}(?:\1\d{4})?`], valid: validMyBank, bankWords: true },
  { entity: "MY_PHONE", formats: [String.raw`(?:\+60[ -]?|0)(?:1\d|[3-79]|8[2-9])[ -]?\d{3,4}[ -]?\d{3,4}`], valid: validMyPhone },
  {
    entity: "ID_PHONE",
    formats: [String.raw`(?:\+62[ -]?|0)8\d{2}[ -]?\d{3,4}[ -]?\d{3,5}`, String.raw`(?:\(0\d{2,3}\)|\+62[ -]?\d{2,3})[ -]?\d{3,4}[ -]?\d{3,4}`],
    valid: validIdPhone,
  },
  { entity: "SG_NRIC", formats: [String.raw`[STFGM]\d{7}[A-Z]`], valid: validSgNric },
  { entity: "SG_PHONE", formats: [String.raw`(?:\+65[ -]?)?[3689]\d{3}[ -]?\d{4}`], valid: validSgPhone },
];

const COMPILED = DETECTORS.map((d) => ({
  ...d,
  scan: d.formats.map((f) => new RegExp(`${LEFT}(?:${f})${RIGHT}`, "g")),
  whole: d.formats.map((f) => new RegExp(`^(?:${f})$`)),
}));

function bankWordBefore(text, start) {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const window = text.slice(Math.max(lineStart, start - BANK_WINDOW), start).toLowerCase();
  return BANK_WORDS.some((w) => window.includes(w));
}

/** Every validated match in `text` (UTF-16 indices), all candidate starts, deduplicated. */
export function detect(text, entities) {
  const found = new Map();
  for (const d of COMPILED) {
    if (!entities.has(d.entity)) continue;
    for (const re of d.scan) {
      re.lastIndex = 0;
      for (let m = re.exec(text); m !== null; m = re.exec(text)) {
        const start = m.index;
        const end = start + m[0].length;
        if (d.valid(m[0]) && (!d.bankWords || bankWordBefore(text, start))) found.set(`${start}:${end}:${d.entity}`, { start, end, entity: d.entity });
        re.lastIndex = start + 1;
      }
    }
  }
  return [...found.values()].sort((a, b) => a.start - b.start || a.end - b.end);
}

/** The span text alone matches one of the entity's formats and passes its validator. */
export function sliceMatchesEntity(entity, slice) {
  const d = COMPILED.find((x) => x.entity === entity);
  return Boolean(d) && d.whole.some((re) => re.test(slice)) && d.valid(slice);
}
