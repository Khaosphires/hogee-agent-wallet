/**
 * Countdown maths behind <Countdown>, kept free of React so it can be unit-tested. Seconds round up, so the clock
 * reads 0:01 until the end time itself and "Ready" never shows early. A time that cannot be read fails closed: it
 * is "invalid", never "ready" (for the payee cooling period, Ready means the payee can be paid).
 */

export type CountdownState =
  | { kind: "pending" } // the client clock is not known yet (server render, hydration)
  | { kind: "invalid" }
  | { kind: "ready" }
  | { kind: "running"; seconds: number; text: string; spoken: string; iso: string };

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// A full ISO-8601 date-time with an explicit zone; a zone-less time would be read in the viewer's local time.
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Milliseconds since the epoch for a zoned ISO-8601 date-time, or undefined when it cannot be read. */
export function parseIsoTime(iso: string | undefined): number | undefined {
  if (iso === undefined || !ISO_DATE_TIME.test(iso)) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

function parts(totalSeconds: number) {
  const s = Math.max(0, Math.floor(totalSeconds));
  return { d: Math.floor(s / DAY), h: Math.floor((s % DAY) / HOUR), m: Math.floor((s % HOUR) / MINUTE), s: s % MINUTE };
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** "4:05", "3:04:05", "2d 03:04:05". */
export function clockText(totalSeconds: number): string {
  const { d, h, m, s } = parts(totalSeconds);
  if (d > 0) return `${d}d ${pad(h)}:${pad(m)}:${pad(s)}`;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

/** "2 days 1 hour 5 seconds", for screen readers (a clock like 3:04:05 is read as a time of day). */
export function spokenDuration(totalSeconds: number): string {
  const { d, h, m, s } = parts(totalSeconds);
  const named = ([[d, "day"], [h, "hour"], [m, "minute"], [s, "second"]] as const)
    .filter(([n]) => n > 0)
    .map(([n, unit]) => `${n} ${unit}${n === 1 ? "" : "s"}`);
  return named.length > 0 ? named.join(" ") : "0 seconds";
}

/** ISO-8601 duration for <time dateTime>: "PT1M45S", "P2DT3H4M5S". */
export function isoDuration(totalSeconds: number): string {
  const { d, h, m, s } = parts(totalSeconds);
  const time = `${h > 0 ? `${h}H` : ""}${m > 0 ? `${m}M` : ""}${s > 0 ? `${s}S` : ""}`;
  if (d > 0) return `P${d}D${time ? `T${time}` : ""}`;
  return `PT${time || "0S"}`;
}

/** Where a countdown to `endIso` stands at `nowMs` (0 or NaN = the clock is not known yet). */
export function countdownState(endIso: string, nowMs: number): CountdownState {
  if (!Number.isFinite(nowMs) || nowMs <= 0) return { kind: "pending" };
  const end = parseIsoTime(endIso);
  if (end === undefined) return { kind: "invalid" };
  const seconds = Math.ceil((end - nowMs) / 1000);
  if (seconds <= 0) return { kind: "ready" };
  return { kind: "running", seconds, text: clockText(seconds), spoken: spokenDuration(seconds), iso: isoDuration(seconds) };
}

/** True only for the render where a watched countdown reaches zero (running → ready); not for one already over at load. */
export function reachedZero(previous: CountdownState["kind"], next: CountdownState["kind"]): boolean {
  return previous === "running" && next === "ready";
}

/** Share of the period from `startIso` to `endIso` that has passed (0..1), or null when there is no bar to draw. */
export function elapsedFraction(startIso: string | undefined, endIso: string, nowMs: number): number | null {
  if (!Number.isFinite(nowMs) || nowMs <= 0) return null;
  const start = parseIsoTime(startIso);
  const end = parseIsoTime(endIso);
  if (start === undefined || end === undefined || end <= start) return null;
  return Math.min(1, Math.max(0, (nowMs - start) / (end - start)));
}
