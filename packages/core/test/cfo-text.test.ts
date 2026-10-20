/** CFO wording helpers (ux-money): plain pocket names, estimates in whole BU, days as "25 Oct". */
import { describe, expect, it } from "vitest";
import { LINE_KEYS } from "../src/index";
import { dayMonthOf, lineLabel, timesWordOfTenths, wholeBu } from "../src/cfo/text";

describe("CFO text", () => {
  it("names every pocket as the web does", () => {
    expect(LINE_KEYS.map(lineLabel)).toEqual(["Supplier", "Packaging", "Delivery", "Ads", "Marketplace fees", "Licence fees", "Safety buffer"]);
  });

  it("rounds an estimate to whole BU (half up), never showing cents", () => {
    expect(wholeBu(12_214n)).toBe("122 BU");
    expect(wholeBu(12_250n)).toBe("123 BU");
    expect(wholeBu(12_249n)).toBe("122 BU");
    expect(wholeBu(0n)).toBe("0 BU");
    expect(wholeBu(-12_214n)).toBe("122 BU");
  });

  it("prints a report day as day and month", () => {
    expect(dayMonthOf("2026-10-25")).toBe("25 Oct");
    expect(dayMonthOf("2026-11-02")).toBe("2 Nov");
  });

  it("says a ratio in words", () => {
    expect(timesWordOfTenths(16n)).toBe("1.6 times");
  });
});
