/** Settings wording that depends on state (UX round 3). */
import { describe, expect, it } from "vitest";
import { SAMPLE_BUSINESS_HINT, SAMPLE_BUSINESS_OFFICER_ONLY, canSwitchSampleBusiness, passkeyText, sampleBusinessNote } from "./settings-copy";

describe("passkeyText", () => {
  it("names this device and the passkey's last four characters when the passkey was made here", () => {
    expect(passkeyText("a1B2", true)).toBe("On this device · a1B2");
    expect(passkeyText("a1B2", false)).toBe("On this device · a1B2");
  });

  it("says where it is, not that it is missing, once a plan is signed elsewhere", () => {
    expect(passkeyText(null, true)).toBe("On your signing device");
    expect(passkeyText(null, true, "Mei")).toBe("On Mei's signing device");
  });

  it("before any passkey, says it isn't set up yet (the start, not a fault)", () => {
    expect(passkeyText(null, false)).toBe("Not set up yet");
    for (const text of [passkeyText(null, true), passkeyText(null, false)]) expect(text).not.toMatch(/not on this device|missing|error|failed/i);
  });
});

describe("the Sample business switch (loan officer only, as Reset the demo; run-10 v-5)", () => {
  const view = (mode: "mock" | "live" | "replay" | undefined, officer: boolean, available: boolean | undefined) => ({ mode, officer, available });

  it("works for the loan officer in a mock demo that offers it, and says what it does", () => {
    expect(canSwitchSampleBusiness(view("mock", true, true))).toBe(true);
    expect(sampleBusinessNote(view("mock", true, true))).toBe(SAMPLE_BUSINESS_HINT);
  });

  it("is locked for the founder, with one plain line saying who can switch it and how", () => {
    expect(SAMPLE_BUSINESS_OFFICER_ONLY).toBe("Only the loan officer can switch the demo data. Use View as \u2192 Loan officer.");
    for (const available of [true, undefined]) {
      expect(canSwitchSampleBusiness(view("mock", false, available))).toBe(false);
      expect(sampleBusinessNote(view("mock", false, available))).toBe(SAMPLE_BUSINESS_OFFICER_ONLY);
    }
  });

  it("is off for everyone in live mode, in the recorded demo, and where the mock does not offer it", () => {
    for (const officer of [true, false]) {
      expect(canSwitchSampleBusiness(view("live", officer, true))).toBe(false);
      expect(canSwitchSampleBusiness(view("replay", officer, true))).toBe(false);
      expect(canSwitchSampleBusiness(view("mock", officer, false))).toBe(false);
      expect(canSwitchSampleBusiness(view("mock", officer, undefined))).toBe(false);
      expect(canSwitchSampleBusiness(view(undefined, officer, true))).toBe(false);
      expect(sampleBusinessNote(view("live", officer, true))).toBe("Off in live mode: live money is never reset or made up.");
      expect(sampleBusinessNote(view("replay", officer, true))).toBe("Off in the recorded demo: it plays its recording.");
      expect(sampleBusinessNote(view("mock", officer, false))).toBe("Not available in this demo.");
    }
  });
});
