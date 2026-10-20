/** The seal code printed on a chop: the first four hex characters of the signing transaction's hash. */
import { describe, expect, it } from "vitest";
import { sealCode, sealCodeRows } from "./seal-code";

describe("sealCode", () => {
  it("takes the first four hex characters after 0x, upper case", () => {
    expect(sealCode("0xc21e7b04aa000000000000000000000000000000000000000000000000007b04")).toBe("C21E");
  });

  it("refuses anything that isn't a whole 32-byte 0x hash, so a chop never shows invented characters (re-check keccak INFO)", () => {
    expect(sealCode("9f3ae210")).toBeNull();
    expect(sealCode("0x9f3ae210")).toBeNull();
    expect(sealCode(`0x${"ab".repeat(31)}`)).toBeNull();
    expect(sealCode(`0x${"ab".repeat(33)}`)).toBeNull();
    expect(sealCode(`${"ab".repeat(32)}`)).toBeNull();
    expect(sealCode(`0x${"ab".repeat(32)}\n`)).toBeNull();
    expect(sealCode(`0X${"ab".repeat(32)}`)).toBeNull();
    expect(sealCode("0xzz12")).toBeNull();
    expect(sealCode("0x12")).toBeNull();
    expect(sealCode("")).toBeNull();
    expect(sealCode(undefined)).toBeNull();
    expect(sealCode(null)).toBeNull();
  });

  it("splits the code 2 × 2 for the 40 px chop", () => {
    expect(sealCodeRows("C21E")).toEqual(["C2", "1E"]);
  });
});
