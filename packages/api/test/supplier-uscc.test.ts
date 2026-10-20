/**
 * The supplier generator's GB 32100-2015 (USCC) and GB 11714-1997 (organisation code) check characters
 * (data/suppliers/lib/uscc.mjs), against a published example and the second implementation in support/supplier-data.
 */
import { describe, expect, it } from "vitest";
import { USCC_CHARSET, isValidUscc, makeUscc, orgCodeCheckChar, usccCheckChar, withWrongCheckChar } from "../../../data/suppliers/lib/uscc.mjs";
import { usccChecksumOk } from "./support/supplier-data";

/** The example code printed in many GB 32100 explainers. */
const EXAMPLE = "91350100M000100Y43";

describe("GB 32100 USCC check character (generator)", () => {
  it("accepts the published example and computes both of its check characters", () => {
    expect(isValidUscc(EXAMPLE)).toBe(true);
    expect(usccCheckChar(EXAMPLE.slice(0, 17))).toBe("3");
    expect(orgCodeCheckChar(EXAMPLE.slice(8, 16))).toBe(EXAMPLE[16]);
  });

  it("rejects every single-character substitution (31 is prime, so one changed character always shows)", () => {
    for (let i = 0; i < 18; i += 1) {
      for (const ch of USCC_CHARSET) {
        if (ch === EXAMPLE[i]) continue;
        const bad = `${EXAMPLE.slice(0, i)}${ch}${EXAMPLE.slice(i + 1)}`;
        expect(isValidUscc(bad), bad).toBe(false);
      }
    }
  });

  it("rejects malformed input (length, I/O/S/V/Z, lower case, non-strings)", () => {
    for (const bad of ["", EXAMPLE.slice(0, 17), `${EXAMPLE}0`, "91350100M000100I43", "91350100m000100y43", "9135010OM000100Y43"]) expect(isValidUscc(bad), bad).toBe(false);
    expect(isValidUscc(91350100 as unknown)).toBe(false);
    expect(() => usccCheckChar("91350100M000100Z4")).toThrow();
  });

  it("makeUscc writes valid codes (by the independent check too); withWrongCheckChar breaks only the check character", () => {
    for (const body of ["MA2H7K3P", "00000000", "YYYYYYYY", "12345678"]) {
      const code = makeUscc("330784", body);
      expect([code.length, isValidUscc(code), usccChecksumOk(code)]).toEqual([18, true, true]);
      expect(code.slice(8, 16)).toBe(body);
      const bad = withWrongCheckChar(code);
      expect([bad.slice(0, 17), isValidUscc(bad), usccChecksumOk(bad)]).toEqual([code.slice(0, 17), false, false]);
    }
    expect(() => makeUscc("33078", "MA2H7K3P")).toThrow();
    expect(() => makeUscc("330784", "MA2H7K3O")).toThrow();
  });

  it("GB 11714 organisation-code check maps 10 to X and 11 to 0", () => {
    // These 40 bodies include remainders that hit both special cases.
    const all = ["0000000", "1000000", "2000000", "3000000"].flatMap((p) => Array.from("0123456789", (d) => `${p}${d}`));
    const checks = new Set(all.map(orgCodeCheckChar));
    expect(checks.has("X")).toBe(true);
    expect(checks.has("0")).toBe(true);
    expect([...checks].every((c) => /^[0-9X]$/.test(c))).toBe(true);
  });
});
