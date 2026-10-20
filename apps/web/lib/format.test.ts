/** Display formatting (ux-money): one plain name per pocket, and times in the facility's own clock. */
import { describe, expect, it } from "vitest";
import { LINE_KEYS } from "@hogee/core";
import { dayMonth, lineLabel, localDateTime } from "./format";

describe("lineLabel", () => {
  it("gives every pocket the one plain name the plan uses everywhere", () => {
    expect(LINE_KEYS.map(lineLabel)).toEqual(["Supplier", "Packaging", "Delivery", "Ads", "Marketplace fees", "Licence fees", "Safety buffer"]);
  });

  it("falls back to the key's own words for a pocket it doesn't know", () => {
    expect(lineLabel("NEW_LINE")).toBe("New line");
  });
});

describe("localDateTime", () => {
  it("reads Singapore time for SGD, Malaysia time for MYR, both UTC+8", () => {
    expect(localDateTime("2026-10-19T06:02:00Z", "SGD")).toBe("19 Oct, 14:02 SGT");
    expect(localDateTime("2026-10-19T06:02:00Z", "MYR")).toBe("19 Oct, 14:02 MYT");
  });

  it("crosses midnight into the local day", () => {
    expect(localDateTime("2026-10-19T17:30:00.000Z", "SGD")).toBe("20 Oct, 01:30 SGT");
  });

  it("takes unix seconds as a digit string or a number", () => {
    const unix = String(Date.parse("2026-10-25T01:00:00Z") / 1000);
    expect(localDateTime(unix, "SGD")).toBe("25 Oct, 09:00 SGT");
    expect(localDateTime(Number(unix), "SGD")).toBe("25 Oct, 09:00 SGT");
  });

  it("reads Singapore time until the currency is known, and UTC for any other currency", () => {
    expect(localDateTime("2026-10-19T06:02:00Z")).toBe("19 Oct, 14:02 SGT");
    expect(localDateTime("2026-10-19T06:02:00Z", "EUR")).toBe("19 Oct, 06:02 UTC");
  });

  it("says so when the time is unreadable, rather than show a wrong one", () => {
    expect(localDateTime("not a time", "SGD")).toBe("unknown time");
  });
});

describe("dayMonth", () => {
  it("prints a calendar day as '25 Oct'", () => {
    expect(dayMonth("2026-10-25")).toBe("25 Oct");
    expect(dayMonth("2026-11-02")).toBe("2 Nov");
  });

  it("leaves an unreadable day as it is", () => {
    expect(dayMonth("soon")).toBe("soon");
  });
});
