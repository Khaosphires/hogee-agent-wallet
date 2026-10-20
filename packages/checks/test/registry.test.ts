import { describe, expect, it } from "vitest";
import { usccCheckChar, validateSSM, validateUEN, validateUSCC } from "../src/index";

// Real, published numbers: the USCCs, SSM numbers and UENs below are the `registeredAs` values of GLEIF LEI
// records (api.gleif.org, retrieved 2026-10-18), plus SSM's own announcement example and ACRA's Special UEN examples.

describe("validateUSCC (GB 32100-2015)", () => {
  const published = ["91110115MADYDPLF7X", "91440106685244680R", "91330110MAE8KHJC44", "91460106MAA9AE6K8C", "91370220MAD45PBT7P"];

  it.each(published)("accepts the published code %s", (code) => {
    expect(validateUSCC(code)).toEqual({ valid: true });
  });

  it("accepts surrounding whitespace and lower case", () => {
    expect(validateUSCC("  91110115madydplf7x ").valid).toBe(true);
  });

  it("rejects a wrong check character", () => {
    expect(validateUSCC("91370220MAD45PBT7Q")).toEqual({ valid: false, reason: "check character does not match" });
  });

  it("rejects every single-character change of a published code", () => {
    const code = "91440106685244680R";
    for (let i = 0; i < 18; i += 1) {
      const next = code.charAt(i) === "1" ? "2" : "1";
      expect(validateUSCC(code.slice(0, i) + next + code.slice(i + 1)).valid).toBe(false);
    }
  });

  it("rejects wrong length, characters outside the set and a non-numeric division code", () => {
    expect(validateUSCC("9144010668524468").reason).toBe("a USCC has 18 characters");
    expect(validateUSCC("91440106685244680I").reason).toBe("contains a character outside the GB 32100-2015 set");
    const letters = "91AB0106685244680";
    expect(validateUSCC(letters + usccCheckChar(letters)).reason).toBe("characters 3-8 must be the 6-digit administrative division code");
  });

  it("fails closed on non-strings, non-ASCII and oversized input", () => {
    expect(validateUSCC(undefined as unknown as string).valid).toBe(false);
    expect(validateUEN("12345678\u017F")).toEqual({ valid: false, reason: "not a printable ASCII string of at most 64 characters" });
    expect(validateSSM("\uFF11312525-A").valid).toBe(false);
    expect(validateUSCC("9".repeat(65)).valid).toBe(false);
  });
});

describe("validateSSM", () => {
  it.each([
    "201901000005 (1312525-A)", // SSM's announcement of the 12-digit format
    "200401005618 (644121-W)",
    "202401018658 (1564507-K)",
    "196001000162 (3837-H)",
    "202203121513 (003398685-U)",
    "202403038906 (CT0132710-X)",
    "202104001557 (LLP0028186-LGN)",
    "201901000005",
    "202104001557",
    "1312525-A",
    "003398685-U",
    "CT0132710-X",
    "LLP0028186-LGN",
  ])("accepts %s", (n) => {
    expect(validateSSM(n)).toEqual({ valid: true });
  });

  it.each([
    ["201905000005", "digits 5-6 are not a known SSM entity type (01, 02, 03, 04)"],
    ["209901000005", "the first 4 digits must be a registration year"],
    ["201901000000", "the 6-digit sequence cannot be 000000"],
    ["201901000005 (003398685-U)", "the new and old numbers name different registers"],
    ["202203121513 (1312525-A)", "the new and old numbers name different registers"],
    ["201901000005 (ABC)", "the bracketed old number has an unknown format"],
    ["20190100005", "not an SSM registration number format"],
    ["1312525", "not an SSM registration number format"],
    ["12345678-A", "not an SSM registration number format"],
    ["LL22145", "not an SSM registration number format"],
    ["", "not an SSM registration number format"],
  ])("rejects %s", (n, reason) => {
    expect(validateSSM(n)).toEqual({ valid: false, reason });
  });
});

describe("validateUEN (format only; ACRA publishes no check-letter algorithm)", () => {
  it.each(["53505676A", "53499999V", "196800306E", "199600288D", "201888888A", "T08LL0784H", "T20VC0154D", "T18LP2222J", "S99SS0001A", " t08ll0784h "])(
    "accepts %s",
    (uen) => {
      expect(validateUEN(uen)).toEqual({ valid: true });
    },
  );

  it.each([
    ["5350567A", "not a UEN format (nnnnnnnnX, yyyynnnnnX or TyyPQnnnnX)"],
    ["1968003060", "not a UEN format (nnnnnnnnX, yyyynnnnnX or TyyPQnnnnX)"],
    ["X08LL0784H", "not a UEN format (nnnnnnnnX, yyyynnnnnX or TyyPQnnnnX)"],
    ["T26VC0130G-SF001", "not a UEN format (nnnnnnnnX, yyyynnnnnX or TyyPQnnnnX)"],
    ["209900306E", "the first 4 digits must be a registration year"],
    ["T99LL0784H", "the year digits are in the future"],
  ])("rejects %s", (uen, reason) => {
    expect(validateUEN(uen)).toEqual({ valid: false, reason });
  });
});
