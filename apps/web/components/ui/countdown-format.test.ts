/** Countdown maths for the payee cooling period: whole seconds, rounded up, "Ready" only at a real zero. */
import { describe, expect, it } from "vitest";
import { clockText, countdownState, elapsedFraction, isoDuration, reachedZero, spokenDuration } from "./countdown-format";

const at = (iso: string) => Date.parse(iso);
const END = "2026-10-19T12:00:00.000Z";

describe("clockText", () => {
  it("shows m:ss under an hour", () => {
    expect(clockText(0)).toBe("0:00");
    expect(clockText(5)).toBe("0:05");
    expect(clockText(120)).toBe("2:00");
    expect(clockText(3_599)).toBe("59:59");
  });

  it("shows h:mm:ss under a day", () => {
    expect(clockText(3_600)).toBe("1:00:00");
    expect(clockText(3 * 3_600 + 4 * 60 + 5)).toBe("3:04:05");
  });

  it("shows days separately from a day up", () => {
    expect(clockText(86_400)).toBe("1d 00:00:00");
    expect(clockText(2 * 86_400 + 3 * 3_600 + 4 * 60 + 5)).toBe("2d 03:04:05");
  });
});

describe("spokenDuration", () => {
  it("names each non-zero part, singular or plural", () => {
    expect(spokenDuration(1)).toBe("1 second");
    expect(spokenDuration(61)).toBe("1 minute 1 second");
    expect(spokenDuration(120)).toBe("2 minutes");
    expect(spokenDuration(2 * 86_400 + 3_600 + 5)).toBe("2 days 1 hour 5 seconds");
  });

  it("says 0 seconds for zero", () => {
    expect(spokenDuration(0)).toBe("0 seconds");
  });
});

describe("isoDuration (the <time dateTime> value)", () => {
  it("writes an ISO-8601 duration", () => {
    expect(isoDuration(0)).toBe("PT0S");
    expect(isoDuration(105)).toBe("PT1M45S");
    expect(isoDuration(86_400)).toBe("P1D");
    expect(isoDuration(2 * 86_400 + 3 * 3_600 + 4 * 60 + 5)).toBe("P2DT3H4M5S");
  });
});

describe("countdownState", () => {
  it("runs while the end time is ahead, rounding part seconds up", () => {
    expect(countdownState(END, at("2026-10-19T11:58:00.000Z"))).toEqual({
      kind: "running",
      seconds: 120,
      text: "2:00",
      spoken: "2 minutes",
      iso: "PT2M",
    });
    expect(countdownState(END, at("2026-10-19T11:59:59.400Z"))).toMatchObject({ kind: "running", seconds: 1, text: "0:01" });
  });

  it("is ready exactly at the end time and after it", () => {
    expect(countdownState(END, at(END))).toEqual({ kind: "ready" });
    expect(countdownState(END, at("2026-10-20T00:00:00.000Z"))).toEqual({ kind: "ready" });
  });

  it("is pending before the client clock is known (server render and hydration see 0)", () => {
    expect(countdownState(END, 0)).toEqual({ kind: "pending" });
    expect(countdownState(END, Number.NaN)).toEqual({ kind: "pending" });
  });

  it("accepts an offset instead of Z", () => {
    expect(countdownState("2026-10-19T20:00:00+08:00", at("2026-10-19T11:59:00.000Z"))).toMatchObject({ kind: "running", seconds: 60 });
  });

  it("fails closed on a time it cannot read: never Ready", () => {
    for (const bad of ["", "not a date", "2026-10-19", "2026-10-19T12:00:00", "2026-13-40T99:00:00Z", "1760875200"]) {
      expect(countdownState(bad, at("2030-01-01T00:00:00.000Z")), JSON.stringify(bad)).toEqual({ kind: "invalid" });
    }
  });
});

describe("reachedZero (when Ready is announced and onReady fires)", () => {
  it("is true only when a running countdown turns ready", () => {
    expect(reachedZero("running", "ready")).toBe(true);
  });

  it("is false when the period was already over at load (pending → ready) or nothing changed", () => {
    expect(reachedZero("pending", "ready")).toBe(false);
    expect(reachedZero("ready", "ready")).toBe(false);
    expect(reachedZero("invalid", "ready")).toBe(false);
    expect(reachedZero("ready", "running")).toBe(false);
  });
});

describe("elapsedFraction (the optional progress bar)", () => {
  const START = "2026-10-19T11:58:00.000Z";

  it("is the share of the period that has passed, clamped to 0..1", () => {
    expect(elapsedFraction(START, END, at(START))).toBe(0);
    expect(elapsedFraction(START, END, at("2026-10-19T11:59:00.000Z"))).toBe(0.5);
    expect(elapsedFraction(START, END, at(END))).toBe(1);
    expect(elapsedFraction(START, END, at("2026-10-19T11:00:00.000Z"))).toBe(0);
    expect(elapsedFraction(START, END, at("2026-10-19T13:00:00.000Z"))).toBe(1);
  });

  it("is null when there is no bar to draw (no start, unreadable times, empty or reversed period, clock unknown)", () => {
    expect(elapsedFraction(undefined, END, at(START))).toBeNull();
    expect(elapsedFraction("soon", END, at(START))).toBeNull();
    expect(elapsedFraction(END, END, at(START))).toBeNull();
    expect(elapsedFraction(END, START, at(START))).toBeNull();
    expect(elapsedFraction(START, END, 0)).toBeNull();
  });
});
