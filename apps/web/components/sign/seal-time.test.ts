/** "19 Oct, 14:02 SGT": the time beside a seal, in the facility's own zone. */
import { describe, expect, it } from "vitest";
import { sealSignerLine, sealTime, signerName } from "./seal-time";

describe("sealTime", () => {
  it("reads in Singapore time for an SGD facility", () => {
    expect(sealTime("2026-10-19T06:02:00Z", "SGD")).toBe("19 Oct, 14:02 SGT");
  });

  it("reads in Malaysia time for an MYR facility", () => {
    expect(sealTime("2026-10-19T06:02:00Z", "MYR")).toBe("19 Oct, 14:02 MYT");
  });

  it("falls back to UTC when the facility currency is unknown or missing", () => {
    expect(sealTime("2026-10-19T06:02:00Z", undefined)).toBe("19 Oct, 06:02 UTC");
    expect(sealTime("2026-10-19T06:02:00Z", "IDR")).toBe("19 Oct, 06:02 UTC");
  });

  it("says nothing for a time it cannot read", () => {
    expect(sealTime("yesterday", "SGD")).toBeNull();
  });
});

describe("signerName", () => {
  it("names the signer from the persona", () => {
    expect(signerName("founder:mei")).toBe("Mei");
    expect(signerName("founder:rina")).toBe("Rina");
    expect(signerName("officer")).toBe("the loan officer");
  });

  it("knows no name before the session is known", () => {
    expect(signerName(undefined)).toBeNull();
  });
});

describe("sealSignerLine", () => {
  it("says a passkey signed, never which authenticator (the page cannot know it)", () => {
    expect(sealSignerLine("Mei", "passkey")).toBe("Signed by Mei with a passkey");
    expect(sealSignerLine(null, "passkey")).toBe("Signed with a passkey");
  });

  it("says a wallet signed, or nothing about how when the page doesn't know", () => {
    expect(sealSignerLine("Mei", "wallet")).toBe("Signed by Mei with a wallet");
    expect(sealSignerLine("Mei", null)).toBe("Signed by Mei");
    expect(sealSignerLine(null, null)).toBe("Signed");
  });

  it("never names Touch ID", () => {
    for (const who of ["Mei", null]) for (const how of ["passkey", "wallet", null] as const) expect(sealSignerLine(who, how)).not.toMatch(/touch id/i);
  });
});
