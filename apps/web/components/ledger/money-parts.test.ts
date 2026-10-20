/** Money display pieces: the figure, a true minus for signed amounts, and the change between two amounts. */
import { describe, expect, it } from "vitest";
import { buDelta, moneyParts } from "./money-parts";

describe("moneyParts", () => {
  it("splits a minor-unit string into the BU figure", () => {
    expect(moneyParts("880000")).toEqual({ negative: false, figure: "8,800" });
    expect(moneyParts("0")).toEqual({ negative: false, figure: "0" });
  });

  it("keeps cents when an amount isn't whole, rather than rounding money away", () => {
    expect(moneyParts("1234567")).toEqual({ negative: false, figure: "12,345.67" });
  });

  it("reads a signed amount (SignedMinor) and marks it negative", () => {
    expect(moneyParts("-192500")).toEqual({ negative: true, figure: "1,925" });
  });

  it("throws on anything that isn't a minor-unit digit string", () => {
    expect(() => moneyParts("12.5")).toThrow();
    expect(() => moneyParts("-0")).toThrow();
    expect(() => moneyParts("")).toThrow();
  });
});

describe("buDelta", () => {
  it("says the change in whole BU with a sign, and a true minus for a cut", () => {
    expect(buDelta("120000", "150000")).toBe("+300");
    expect(buDelta("150000", "120000")).toBe("−300");
    expect(buDelta("150000", "150000")).toBe("±0");
    expect(buDelta("100000000", "100120000")).toBe("+1,200");
  });
});
