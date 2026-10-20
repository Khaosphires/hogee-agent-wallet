import { describe, expect, it } from "vitest";
import { usedPct } from "./pocket-math";

describe("usedPct", () => {
  it("is 0 for an untouched pocket and 100 for an empty one", () => {
    expect(usedPct("500000", "500000")).toBe(0);
    expect(usedPct("500000", "0")).toBe(100);
  });
  it("is the share paid out, to one decimal", () => {
    expect(usedPct("150000", "114000")).toBe(24);
    expect(usedPct("300000", "100000")).toBe(66.6);
  });
  it("clamps an empty or over-full pocket", () => {
    expect(usedPct("0", "0")).toBe(0);
    expect(usedPct("100000", "120000")).toBe(0);
    expect(usedPct("100000", "-5000")).toBe(100);
  });
});
