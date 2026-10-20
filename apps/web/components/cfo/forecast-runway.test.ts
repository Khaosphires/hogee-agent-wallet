import { describe, expect, it } from "vitest";
import { CfoReport, exampleCfoReport } from "@hogee/core";
import { RUNWAY_WARN_DAYS, runwayOf } from "./forecast-runway";

const base = CfoReport.parse(exampleCfoReport);
const at = (runwayDays: number | null) => ({ asOf: "2026-10-19T09:00:00.000Z", forecast: { ...base.forecast, runwayDays } });

describe("the runway bar", () => {
  it("is the report's runway: green while there is time, amber for the last two weeks", () => {
    expect(runwayOf(at(40))).toEqual({ days: 40, calmDays: 26, warnDays: RUNWAY_WARN_DAYS, trackDays: 40, warnFrom: "2026-11-14", endDate: "2026-11-28" });
  });
  it("is all amber inside the last two weeks, on a month-long track so a short runway looks short", () => {
    expect(runwayOf(at(12))).toEqual({ days: 12, calmDays: 0, warnDays: 12, trackDays: 30, warnFrom: null, endDate: "2026-10-31" });
    expect(runwayOf(at(0))).toMatchObject({ days: 0, warnDays: 0, endDate: "2026-10-19" });
  });
  it("draws nothing when the report makes no runway guess", () => {
    expect(runwayOf(at(null))).toBeNull();
  });
});
