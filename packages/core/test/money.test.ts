import { describe, expect, it } from "vitest";
import {
  MoneyError,
  bpsFloor,
  bpsHalfUp,
  formatBu,
  mulDivCeil,
  mulDivFloor,
  mulDivHalfUp,
  parseMinor,
  rationalOf,
  toMinor,
  tryParseMinor,
} from "../src/index";

describe("money helpers", () => {
  it("parseMinor accepts only canonical digit strings within uint128", () => {
    expect(parseMinor("0")).toBe(0n);
    expect(parseMinor("1000000")).toBe(1_000_000n);
    for (const bad of ["", "01", "-1", "1.5", "1e3", " 1", (2n ** 128n).toString()]) {
      expect(() => parseMinor(bad)).toThrow(MoneyError);
      expect(tryParseMinor(bad)).toBeNull();
    }
    expect(() => parseMinor(10 as unknown as string)).toThrow(MoneyError);
  });

  it("toMinor refuses negatives", () => {
    expect(toMinor(42n)).toBe("42");
    expect(() => toMinor(-1n)).toThrow(MoneyError);
  });

  it("rounds floor / ceil / half-up as named", () => {
    expect(mulDivFloor(7n, 1n, 2n)).toBe(3n);
    expect(mulDivCeil(7n, 1n, 2n)).toBe(4n);
    expect(mulDivHalfUp(5n, 1n, 2n)).toBe(3n); // 2.5 -> 3
    expect(mulDivHalfUp(7n, 1n, 4n)).toBe(2n); // 1.75 -> 2
    expect(mulDivHalfUp(5n, 1n, 4n)).toBe(1n); // 1.25 -> 1
    expect(bpsFloor(150_000n, 2500)).toBe(37_500n);
    expect(bpsFloor(99n, 2500)).toBe(24n);
    expect(bpsHalfUp(105n, 1000)).toBe(11n); // 10.5 -> 11
    expect(() => mulDivFloor(1n, 1n, 0n)).toThrow(MoneyError);
    expect(() => mulDivFloor(-1n, 1n, 1n)).toThrow(MoneyError);
  });

  it("rationalOf reads a rate exactly from its shortest decimal form", () => {
    expect(rationalOf(0.61)).toEqual({ num: 61n, den: 100n });
    expect(rationalOf(1)).toEqual({ num: 1n, den: 1n });
    expect(rationalOf(1e-7)).toEqual({ num: 1n, den: 10_000_000n });
    expect(rationalOf(1.5e21)).toEqual({ num: 1_500_000_000_000_000_000_000n, den: 1n });
    expect(rationalOf(0.1 + 0.2)).toEqual({ num: 30_000_000_000_000_004n, den: 100_000_000_000_000_000n });
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => rationalOf(bad)).toThrow(MoneyError);
  });

  it("formatBu displays budget units", () => {
    expect(formatBu("1000000")).toBe("10,000 BU");
    expect(formatBu(123_456n)).toBe("1,234.56 BU");
  });
});
