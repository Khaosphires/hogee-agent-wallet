/**
 * The §3 wire shape of a CfoReport: every bigint becomes a digit string (Minor, or SignedMinor where §3 says so:
 * overview.netMinor, pnl.netMinor, forecast.points[].cashMinor), field names and order unchanged. A value past 39
 * digits (the Minor / SignedMinor bound) throws rather than ship a number the schema would refuse.
 */
import { CfoInputError, type CfoReport } from "./types";

const MAX_DIGITS = 39;

export type Serialised<T> = T extends bigint
  ? string
  : T extends readonly (infer U)[]
    ? Serialised<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: Serialised<T[K]> }
      : T;

export type CfoReportJson = Serialised<CfoReport>;

function serialise(v: unknown, path: string): unknown {
  if (typeof v === "bigint") {
    const s = v.toString();
    if (s.replace("-", "").length > MAX_DIGITS) throw new CfoInputError(`${path} exceeds ${MAX_DIGITS} digits`);
    return s;
  }
  if (Array.isArray(v)) return v.map((x, k) => serialise(x, `${path}[${k}]`));
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, serialise(x, `${path}.${k}`)]));
  }
  return v;
}

export function toCfoReportJson(r: CfoReport): CfoReportJson {
  return serialise(r, "report") as CfoReportJson;
}
