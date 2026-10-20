import { describe, expect, it } from "vitest";
import { GAP_PX, PAD_PX, segmentIndex, thumbTranslate, thumbWidth } from "./segmented-math";

describe("segmentIndex", () => {
  const values = ["week", "month", "loan"] as const;
  it("finds the chosen option", () => {
    expect(segmentIndex(values, "week")).toBe(0);
    expect(segmentIndex(values, "loan")).toBe(2);
  });
  it("is -1 when nothing or something unknown is chosen", () => {
    expect(segmentIndex(values, undefined)).toBe(-1);
    expect(segmentIndex(values, "year")).toBe(-1);
  });
});

describe("thumbWidth", () => {
  it("is one segment of the track's inner width, after the padding and the gaps", () => {
    expect(thumbWidth(1)).toBe(`calc((100% - ${2 * PAD_PX}px) / 1)`);
    expect(thumbWidth(3)).toBe(`calc((100% - ${2 * PAD_PX + 2 * GAP_PX}px) / 3)`);
  });
  it("refuses a control with no options", () => {
    expect(() => thumbWidth(0)).toThrow(RangeError);
    expect(() => thumbWidth(1.5)).toThrow(RangeError);
  });
});

describe("thumbTranslate", () => {
  it("moves by whole segments plus the gaps between them", () => {
    expect(thumbTranslate(0)).toBe("0 0");
    expect(thumbTranslate(2)).toBe(`calc(2 * (100% + ${GAP_PX}px)) 0`);
  });
  it("stays at the start when nothing is chosen", () => {
    expect(thumbTranslate(-1)).toBe("0 0");
  });
});
