/** The wallet meter's segments: paid, agent pays next, waits for you, each a share of the signed limit. */
import { describe, expect, it } from "vitest";
import { walletSegments } from "./wallet-meter-math";

describe("walletSegments", () => {
  it("gives each part its share of the limit, in percent of the track", () => {
    // Mei's supplier line after the deposit: 1,200 paid, 2,800 waits for her release, of 5,000.
    const s = walletSegments({ limitMinor: "500000", paidMinor: "120000", agentMinor: "0", waitingMinor: "280000" });
    expect(s).toEqual({ paidPct: 24, agentPct: 0, waitingPct: 56, usedPct: 80, overMinor: "0" });
  });

  it("scales the parts down to the track and reports what is over the limit", () => {
    const s = walletSegments({ limitMinor: "100000", paidMinor: "80000", agentMinor: "38000", waitingMinor: "0" });
    expect(s.paidPct + s.agentPct + s.waitingPct).toBeLessThanOrEqual(100);
    expect(s.usedPct).toBe(100);
    expect(s.overMinor).toBe("18000");
  });

  it("draws an empty track for a zero limit and fails closed on a bad amount", () => {
    expect(walletSegments({ limitMinor: "0", paidMinor: "0", agentMinor: "0", waitingMinor: "0" })).toEqual({
      paidPct: 0,
      agentPct: 0,
      waitingPct: 0,
      usedPct: 0,
      overMinor: "0",
    });
    expect(() => walletSegments({ limitMinor: "1.5", paidMinor: "0", agentMinor: "0", waitingMinor: "0" })).toThrow();
  });
});
