import { describe, expect, it } from "vitest";
import { clampPct, ringGeometry } from "./progress-math";

describe("clampPct", () => {
  it("keeps 0..100 and clamps the rest", () => {
    expect(clampPct(42)).toBe(42);
    expect(clampPct(-5)).toBe(0);
    expect(clampPct(140)).toBe(100);
  });
  it("treats a missing or broken value as 0, never as full", () => {
    expect(clampPct(undefined)).toBe(0);
    expect(clampPct(null)).toBe(0);
    expect(clampPct(Number.NaN)).toBe(0);
    expect(clampPct(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("ringGeometry", () => {
  it("fits the circle inside the box and hides the part not reached", () => {
    const g = ringGeometry(40, 4, 25);
    expect(g.r).toBe(18);
    expect(g.circumference).toBeCloseTo(2 * Math.PI * 18);
    expect(g.offset).toBeCloseTo(g.circumference * 0.75);
  });
  it("is empty at 0, full at 100, and shows a sliver for under 1 %", () => {
    expect(ringGeometry(40, 4, 0).offset).toBeCloseTo(ringGeometry(40, 4, 0).circumference);
    expect(ringGeometry(40, 4, 100).offset).toBeCloseTo(0);
    expect(ringGeometry(40, 4, 0.2).offset).toBeCloseTo(ringGeometry(40, 4, 1).offset);
  });
  it("refuses a ring that cannot be drawn", () => {
    expect(() => ringGeometry(8, 4, 50)).toThrow(RangeError);
    expect(() => ringGeometry(0, 1, 50)).toThrow(RangeError);
  });
});
