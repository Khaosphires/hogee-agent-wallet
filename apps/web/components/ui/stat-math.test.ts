import { describe, expect, it } from "vitest";
import { deltaTone, easeOut, tickMinor, tickNumber } from "./stat-math";

describe("easeOut", () => {
  it("starts at 0, ends at 1 and is ahead of linear in between", () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(0.5)).toBeGreaterThan(0.5);
  });
  it("clamps outside 0..1 and treats a non-number as done", () => {
    expect(easeOut(-1)).toBe(0);
    expect(easeOut(2)).toBe(1);
    expect(easeOut(Number.NaN)).toBe(1);
  });
});

describe("tickMinor", () => {
  it("counts from zero and lands exactly on the target", () => {
    expect(tickMinor("400000", 0)).toBe("0");
    expect(tickMinor("400000", 1)).toBe("400000");
    const mid = BigInt(tickMinor("400000", 0.5));
    expect(mid > 0n && mid < 400000n).toBe(true);
  });
  it("keeps amounts too big for a JS number exact", () => {
    const big = "123456789012345678901234";
    expect(tickMinor(big, 1)).toBe(big);
  });
  it("counts a negative amount down from zero and never shows -0", () => {
    expect(tickMinor("-192500", 1)).toBe("-192500");
    expect(tickMinor("-192500", 0)).toBe("0");
    expect(tickMinor("-192500", 0.3).startsWith("-")).toBe(true);
  });
  it("refuses an amount that is not a minor-unit string", () => {
    expect(() => tickMinor("12.5", 1)).toThrow();
  });
});

describe("tickNumber", () => {
  it("lands on the target and keeps its decimals", () => {
    expect(tickNumber(32, 1)).toBe(32);
    expect(tickNumber(5.25, 1)).toBe(5.25);
    expect(tickNumber(32, 0)).toBe(0);
    expect(Number.isInteger(tickNumber(32, 0.4))).toBe(true);
  });
  it("never shows -0", () => {
    expect(Object.is(tickNumber(-4, 0), 0)).toBe(true);
  });
});

describe("deltaTone", () => {
  it("is good when the change goes the good way, bad otherwise", () => {
    expect(deltaTone("up", true)).toBe("good");
    expect(deltaTone("down", true)).toBe("bad");
    expect(deltaTone("up", false)).toBe("bad");
    expect(deltaTone("down", false)).toBe("good");
  });
  it("is neutral when flat or when the caller does not say", () => {
    expect(deltaTone("flat", true)).toBe("neutral");
    expect(deltaTone("up", undefined)).toBe("neutral");
  });
});
