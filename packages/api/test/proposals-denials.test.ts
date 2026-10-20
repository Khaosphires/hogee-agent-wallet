/**
 * Which refused spend proposals are anchored with recordDenied (audit run-4
 * `proposals.ts:propose:recordDenied-for-state-and-duplicate-denials`): a refusal the chain would also make counts
 * against the agent, but one that describes the treasury's state (a pause, an expired line or agent, an open circuit)
 * never does, or three of them would trip the line's circuit (core pacing.ts WORKER RULE).
 */
import { describe, expect, it } from "vitest";
import { recordsDenial } from "../src/routes/proposals";
import type { Evaluated } from "../src/services/spend-proposal";

const denied = (reasonCode: string, opts: { invoice?: boolean; mirrorsRevert?: boolean } = {}) =>
  ({
    decision: { verdict: "DENY", reasonCode, mirrorsRevert: opts.mirrorsRevert ?? true },
    derived: { lineKey: "LOGISTICS", payeeId: "spx-logistics", amountMinor: "1000", ...(opts.invoice === false ? { pacingSlot: 1 } : { invoiceId: "inv-1" }) },
    proposal: {},
  }) as unknown as Evaluated;

describe("recordsDenial", () => {
  it("records an agent-caused refusal of an invoice proposal the chain would also refuse", () => {
    for (const code of ["CapExceeded", "PayeeNotBound", "DuplicateIntent", "DuplicateInvoice"]) expect(recordsDenial(denied(code))).toBe(true);
  });

  it("never records a refusal that describes the treasury's state", () => {
    for (const code of ["Paused", "CircuitOpen", "LineExpired", "AgentExpired", "NotAgent"]) expect(recordsDenial(denied(code))).toBe(false);
  });

  it("never records a pacing proposal, a refusal the chain would not make, or a non-DENY verdict", () => {
    expect(recordsDenial(denied("CapExceeded", { invoice: false }))).toBe(false);
    expect(recordsDenial(denied("FLAGGED_INVOICE", { mirrorsRevert: false }))).toBe(false);
    const auto = { ...denied("CapExceeded"), decision: { verdict: "AUTO", reasonCode: "OK", mirrorsRevert: false } } as unknown as Evaluated;
    expect(recordsDenial(auto)).toBe(false);
  });
});
