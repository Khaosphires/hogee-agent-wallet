/** Recording mode (UX-PLAN D14): the URL turns it on or off once; the tab keeps it; anything else is off. */
import { describe, expect, it } from "vitest";
import { resolveRecording, withoutRecordingParam } from "./presentation";

describe("resolveRecording", () => {
  it("turns on with ?recording=1 and asks to keep it for the tab", () => {
    expect(resolveRecording("?recording=1", null)).toEqual({ recording: true, store: "1" });
    expect(resolveRecording("?persona=x&recording=true", "0")).toEqual({ recording: true, store: "1" });
  });

  it("turns off with ?recording=0, even when the tab had it on", () => {
    expect(resolveRecording("?recording=0", "1")).toEqual({ recording: false, store: "0" });
    expect(resolveRecording("?recording=false", "1")).toEqual({ recording: false, store: "0" });
  });

  it("keeps the tab's stored value when the URL says nothing (client navigation drops the query)", () => {
    expect(resolveRecording("", "1")).toEqual({ recording: true });
    expect(resolveRecording("?tab=sales", "0")).toEqual({ recording: false });
  });

  it("is off by default, and for any other value", () => {
    expect(resolveRecording("", null)).toEqual({ recording: false });
    expect(resolveRecording("?recording=yes", null)).toEqual({ recording: false });
    expect(resolveRecording("?recording=", "garbage")).toEqual({ recording: false });
  });
});

describe("withoutRecordingParam", () => {
  it("drops the flag and keeps every other parameter in order", () => {
    expect(withoutRecordingParam("?recording=1")).toBe("");
    expect(withoutRecordingParam("?tab=sales&recording=0&period=7d")).toBe("?tab=sales&period=7d");
  });

  it("leaves a query without the flag exactly as it was", () => {
    expect(withoutRecordingParam("")).toBe("");
    expect(withoutRecordingParam("?tab=sales")).toBe("?tab=sales");
  });
});
