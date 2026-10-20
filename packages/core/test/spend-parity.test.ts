/**
 * evaluateSpend parity with Treasury.spend (skills re-check of fix/run2-core): _requireLineOpen checks the circuit
 * before the pause, and _requireCaps also refuses a 65th live spend in the window and any outflow above fundedMinor.
 */
import { describe, expect, it } from "vitest";
import { MAX_LIVE_SPENDS_PER_WINDOW, evaluateProposal, type PolicyContext } from "../src/index";
import { ctxDay1, spend, withLineState } from "./fixtures/policy-ctx";

const decide = (ctx: PolicyContext) => evaluateProposal(spend(), ctx); // 20,000 on LOGISTICS

describe("Treasury._requireLineOpen order: circuit before pause", () => {
  it("a line that is both paused and tripped → CircuitOpen", () => {
    expect(decide(withLineState(ctxDay1(), "LOGISTICS", { paused: true, circuitOpen: true }))).toEqual({ verdict: "DENY", reasonCode: "CircuitOpen", mirrorsRevert: true });
    expect(decide(withLineState(ctxDay1(), "LOGISTICS", { paused: true })).reasonCode).toBe("Paused");
  });
});

describe("Treasury._requireCaps: at most 64 live spends in the rolling window", () => {
  it("a fresh context mirrors an empty window", () => {
    expect(MAX_LIVE_SPENDS_PER_WINDOW).toBe(64);
    expect(ctxDay1().lines.LOGISTICS?.windowLiveSpends).toBe(0);
  });

  it("the 64th live spend is allowed, a 65th → CapExceeded; not mirrored → not checked", () => {
    expect(decide(withLineState(ctxDay1(), "LOGISTICS", { windowLiveSpends: 63 })).verdict).toBe("AUTO");
    expect(decide(withLineState(ctxDay1(), "LOGISTICS", { windowLiveSpends: 64 }))).toEqual({ verdict: "DENY", reasonCode: "CapExceeded", mirrorsRevert: true });
    const { windowLiveSpends: _dropped, ...unmirrored } = ctxDay1().lines.LOGISTICS!;
    expect(decide({ ...ctxDay1(), lines: { ...ctxDay1().lines, LOGISTICS: unmirrored } }).verdict).toBe("AUTO");
  });
});

describe("Treasury._requireCaps: outflow never exceeds fundedMinor", () => {
  it("spent + escrowed + amount ≤ fundedMinor; above → CapExceeded; not mirrored → not checked", () => {
    expect(decide({ ...ctxDay1(), fundedMinor: "20000" }).verdict).toBe("AUTO");
    expect(decide({ ...ctxDay1(), fundedMinor: "19999" })).toEqual({ verdict: "DENY", reasonCode: "CapExceeded", mirrorsRevert: true });
    expect(decide({ ...ctxDay1(), fundedMinor: "50000", totalSpentMinor: "20000", totalEscrowedMinor: "10001" }).reasonCode).toBe("CapExceeded");
    expect(decide({ ...ctxDay1(), fundedMinor: undefined }).verdict).toBe("AUTO");
  });
});
