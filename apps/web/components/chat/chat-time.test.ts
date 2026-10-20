import { describe, expect, it } from "vitest";
import { uuidv7 } from "../../lib/chat-session";
import { BREAK_GAP_MS, dayKey, messageTimes, relativeTime, serverMintedIds, stretchLabel, timeBreaks, uuidv7Ms, zoneOfCurrency, type TimedMessage } from "./chat-time";

const SG = "Asia/Singapore";
// 19 Oct 2026, 14:02 in Singapore (UTC+8).
const T = Date.UTC(2026, 9, 19, 6, 2);
const MIN = 60_000;

const press = (id: string, actionId: string): TimedMessage => ({ id, role: "user", parts: [{ type: "data-action", data: { action: { type: "signed", actionId } } }] });
const typed = (id: string): TimedMessage => ({ id, role: "user", parts: [{ type: "text" }] });
const reply = (id: string): TimedMessage => ({ id, role: "assistant", parts: [{ type: "text" }] });

describe("uuidv7Ms", () => {
  it("reads the press time back out of a UUIDv7", () => {
    expect(uuidv7Ms(uuidv7(T))).toBe(T);
  });

  it("refuses anything that is not a plausible v7 id", () => {
    expect(uuidv7Ms("not-an-id")).toBeNull();
    expect(uuidv7Ms("0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b")).toBeNull(); // v4
    expect(uuidv7Ms(uuidv7(Date.UTC(2010, 0, 1)))).toBeNull(); // before 2024: not a real press
    expect(uuidv7Ms(uuidv7(T).toUpperCase())).toBeNull();
  });
});

describe("messageTimes", () => {
  it("uses what the page saw, then a press's id, and gives a reply the time of what it answers", () => {
    const messages = [typed("u1"), reply("a1"), press("u2", uuidv7(T + 5 * MIN)), reply("a2"), typed("u3"), reply("a3")];
    const times = messageTimes(messages, new Map([["u3", T + 9 * MIN]]));
    expect(times.get("u1")).toBeUndefined();
    expect(times.get("a1")).toBeUndefined();
    expect(times.get("u2")).toBe(T + 5 * MIN);
    expect(times.get("a2")).toBe(T + 5 * MIN);
    expect(times.get("u3")).toBe(T + 9 * MIN);
    expect(times.get("a3")).toBe(T + 9 * MIN);
  });

  it("never carries a time across a message without one", () => {
    const times = messageTimes([press("u1", uuidv7(T)), reply("a1"), typed("u2"), reply("a2")], new Map());
    expect(times.get("a1")).toBe(T);
    expect(times.has("u2")).toBe(false);
    expect(times.has("a2")).toBe(false);
  });

  it("ignores a press id that is not a UUIDv7", () => {
    expect(messageTimes([press("u1", "abc")], new Map()).size).toBe(0);
  });

  it("never reads a Next button's server-minted id as the press time; the page's own press time wins", () => {
    const old = uuidv7(T - 7 * 86_400_000);
    const withButton: TimedMessage = { id: "a1", role: "assistant", parts: [{ type: "data-next", data: { actions: [{ label: "How are we doing?", action: { type: "show_cfo", actionId: old } }] } }] };
    const messages = [withButton, press("u2", old), reply("a2")];
    expect(serverMintedIds(messages)).toEqual(new Set([old]));
    const fromHistory = messageTimes(messages, new Map());
    expect(fromHistory.has("u2")).toBe(false);
    expect(fromHistory.has("a2")).toBe(false);
    const live = messageTimes(messages, new Map(), new Map([[old, T]]));
    expect(live.get("u2")).toBe(T);
    expect(live.get("a2")).toBe(T);
  });
});

describe("timeBreaks", () => {
  it("opens a stretch at the first known time, after a long gap, and on a new day", () => {
    const messages = [typed("u0"), press("u1", uuidv7(T)), reply("a1"), press("u2", uuidv7(T + 10 * MIN)), press("u3", uuidv7(T + 10 * MIN + BREAK_GAP_MS)), press("u4", uuidv7(T + 11 * 3_600_000))];
    const breaks = timeBreaks(messages, messageTimes(messages, new Map()), SG);
    expect([...breaks]).toEqual(["u1", "u3", "u4"]);
  });

  it("returns nothing when no time is known", () => {
    expect(timeBreaks([typed("u1"), reply("a1")], new Map(), SG).size).toBe(0);
  });
});

describe("labels", () => {
  it("reads in the facility's zone", () => {
    expect(zoneOfCurrency("SGD")).toBe(SG);
    expect(zoneOfCurrency("MYR")).toBe("Asia/Kuala_Lumpur");
    expect(zoneOfCurrency(undefined)).toBe("UTC");
    // 23:30 UTC on the 18th is already the 19th in Singapore.
    expect(dayKey(Date.UTC(2026, 9, 18, 23, 30), SG)).toBe("2026-10-19");
  });

  it("names the stretch by day", () => {
    expect(stretchLabel(T, T + 3 * MIN, SG)).toBe("Today, 14:02");
    expect(stretchLabel(T - 86_400_000, T, SG)).toBe("Yesterday, 14:02");
    expect(stretchLabel(Date.UTC(2026, 8, 28, 2, 14), T, SG)).toBe("28 Sep, 10:14");
  });

  it("says how long ago, briefly", () => {
    expect(relativeTime(T, T + 20_000, SG)).toBe("Just now");
    expect(relativeTime(T + MIN, T, SG)).toBe("Just now");
    expect(relativeTime(T - 5 * MIN, T, SG)).toBe("5 min ago");
    expect(relativeTime(T - 2 * 3_600_000, T, SG)).toBe("2 h ago");
    expect(relativeTime(T - 20 * 3_600_000, T, SG)).toBe("Yesterday");
    expect(relativeTime(T - 3 * 86_400_000, T, SG)).toBe("3 days ago");
    expect(relativeTime(Date.UTC(2026, 8, 28, 2, 14), T, SG)).toBe("28 Sep");
  });
});
