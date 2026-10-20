/**
 * The Forecast's runway bar (UX round 3, Steve #13), pure so it is unit-tested: the report's own "money lasts about N
 * days" (core forecast.runwayDays: floor(cash you can spend ÷ spending per day over the last 7 days)) drawn as one bar
 * from today to the day it runs out, on a track of at least a month, green while there is time, amber for the last
 * RUNWAY_WARN_DAYS. Nothing here changes the figure; a forecast with no runway (nothing spent lately) draws no bar.
 */
import type { CfoReport } from "@hogee/core";

/** The last two weeks before the money runs out are drawn amber (the report's RUNWAY_SHORT note warns from 14 days too). */
export const RUNWAY_WARN_DAYS = 14;
/** The bar's track is at least a month, so a short runway looks short (12 days fill 40 % of it, not all of it). */
export const RUNWAY_MIN_TRACK_DAYS = 30;

const DAY_MS = 86_400_000;

export interface Runway {
  readonly days: number;
  /** Days before the amber part (0 when the whole runway is inside the last two weeks). */
  readonly calmDays: number;
  readonly warnDays: number;
  /** The track's length in days: the runway, or a month when the runway is shorter. */
  readonly trackDays: number;
  /** The day the amber part starts (YYYY-MM-DD), null when it starts today. */
  readonly warnFrom: string | null;
  /** About when the money runs out at this pace (YYYY-MM-DD). */
  readonly endDate: string;
}

const addDays = (isoDay: string, n: number): string => new Date(Date.parse(`${isoDay}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** The runway from the report's forecast and its `asOf`; null when the report makes no runway guess. */
export function runwayOf(r: Pick<CfoReport, "forecast" | "asOf">): Runway | null {
  const days = r.forecast.runwayDays;
  if (days === null || !Number.isFinite(days) || days < 0) return null;
  const today = r.asOf.slice(0, 10);
  const warnDays = Math.min(days, RUNWAY_WARN_DAYS);
  const calmDays = days - warnDays;
  return { days, calmDays, warnDays, trackDays: Math.max(days, RUNWAY_MIN_TRACK_DAYS), warnFrom: calmDays > 0 ? addDays(today, calmDays) : null, endDate: addDays(today, days) };
}
