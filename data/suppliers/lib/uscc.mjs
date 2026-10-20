/**
 * Chinese Unified Social Credit Code (USCC, 统一社会信用代码), GB 32100-2015: 18 characters
 *   [1] registration authority  [2] entity category  [3-8] administrative division (GB/T 2260)
 *   [9-17] organisation code (GB 11714-1997: 8 body characters + its own check character)  [18] check character
 * Every character comes from the 31-character set below (no I, O, S, V, Z). The check character is
 *   C18 = 31 - (sum(Ci * Wi) mod 31), with Wi = 3^(i-1) mod 31, and 31 maps to 0.
 * The organisation-code check (GB 11714) is C9 = 11 - (sum(Ci * Wi) mod 11) with weights 3,7,9,10,5,8,4,2;
 * 10 maps to X and 11 to 0. Pure functions, no dependencies.
 */

export const USCC_CHARSET = "0123456789ABCDEFGHJKLMNPQRTUWXY";
const USCC_WEIGHTS = Array.from({ length: 17 }, (_, i) => {
  let w = 1;
  for (let k = 0; k < i; k += 1) w = (w * 3) % 31;
  return w;
});
const ORG_WEIGHTS = [3, 7, 9, 10, 5, 8, 4, 2];
const ORG_BODY_RE = /^[0-9A-Z]{8}$/;

function usccValue(ch) {
  const v = USCC_CHARSET.indexOf(ch);
  if (v < 0) throw new Error(`"${ch}" is not a USCC character`);
  return v;
}

/** GB 32100-2015 check character for the first 17 characters. Throws on a character outside the set. */
export function usccCheckChar(first17) {
  if (typeof first17 !== "string" || first17.length !== 17) throw new Error("USCC body must be 17 characters");
  const sum = [...first17].reduce((s, ch, i) => s + usccValue(ch) * USCC_WEIGHTS[i], 0);
  return USCC_CHARSET[(31 - (sum % 31)) % 31];
}

/** GB 11714-1997 organisation-code check character for an 8-character body (digits and A-Z count 10..35). */
export function orgCodeCheckChar(body8) {
  if (!ORG_BODY_RE.test(body8)) throw new Error("organisation-code body must be 8 characters 0-9/A-Z");
  const sum = [...body8].reduce((s, ch, i) => s + Number.parseInt(ch, 36) * ORG_WEIGHTS[i], 0);
  const c = 11 - (sum % 11);
  return c === 10 ? "X" : c === 11 ? "0" : String(c);
}

/** True when `code` has 18 characters from the USCC set and a correct GB 32100 check character. */
export function isValidUscc(code) {
  if (typeof code !== "string" || code.length !== 18) return false;
  if (![...code].every((ch) => USCC_CHARSET.includes(ch))) return false;
  return usccCheckChar(code.slice(0, 17)) === code[17];
}

/**
 * A USCC for an enterprise (authority 9, category 1) in `division` (6 digits) whose organisation code is `orgBody`
 * (8 characters from the USCC set) plus its GB 11714 check character.
 */
export function makeUscc(division, orgBody) {
  if (!/^[0-9]{6}$/.test(division)) throw new Error("division must be 6 digits");
  if (orgBody.length !== 8 || ![...orgBody].every((ch) => USCC_CHARSET.includes(ch))) throw new Error("org body must be 8 USCC characters");
  const first17 = `91${division}${orgBody}${orgCodeCheckChar(orgBody)}`;
  return `${first17}${usccCheckChar(first17)}`;
}

/** The same code with a wrong (but in-set) check character: format-valid, checksum-invalid. */
export function withWrongCheckChar(code) {
  const i = USCC_CHARSET.indexOf(code[17]);
  return `${code.slice(0, 17)}${USCC_CHARSET[(i + 7) % 31]}`;
}
