/**
 * rcfix-autonomy (skills re-check W-4): the Wallet's "N AI payments" counts only the payments the agent decided by
 * itself (SPEND, FUND_MILESTONE). The founder's MilestoneRelease and OwnerSpend are her signatures (humanSigs) and never
 * also AI payments, both where the store counts its own records (autonomy.ts, the sample business) and in the other
 * scenarios' running counter (transitions.ts createScriptedPayment). Sepolia final-2 had 2 FUND_MILESTONE + 1
 * RELEASE_MILESTONE and read "3 AI payments" where the AI made 2.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autonomyOf } from "../src/autonomy";
import { readEnv } from "../src/env";
import { applyMilestoneRelease } from "../src/signing";
import { appendTrace, getState, nextId, resetState, type MockState } from "../src/store";
import { advance, createScriptedPayment, STEP_MS } from "../src/transitions";

const T0 = Date.parse("2026-10-19T06:00:00Z");
/** Past the end of every scripted path: each payment below is mined (and settled) by then. */
const LATER = T0 + 20 * STEP_MS;
const ORDER = "order-autonomy-001";

beforeEach(() => {
  vi.stubEnv("MOCK_SCENARIO", "fresh");
  resetState(readEnv());
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetState(readEnv());
});

/** What submitSignature (signing.ts) records for the founder's passkey MilestoneRelease, then its payment. */
function founderReleases(st: MockState, orderId: string, atMs: number): void {
  st.escrow.set(orderId, [
    { idx: 0, amountMinor: "75000", funded: "75000", released: true, autoRelease: true },
    { idx: 1, amountMinor: "175000", funded: "175000", released: false, autoRelease: false },
  ]);
  const traceId = nextId(st, "trace");
  appendTrace(st, { traceId, actor: "founder", kind: "SIGNATURE", summary: "Founder signed MilestoneRelease with passkey (Touch ID)", refs: {} });
  appendTrace(st, { traceId, actor: "worker", kind: "TX", summary: "Relayer submitted the signed MilestoneRelease", refs: {} });
  applyMilestoneRelease(st, orderId, atMs);
}

/** The agent funds a milestone by itself, as applySupplierApproval / applyWebApproval do. */
function agentFunds(st: MockState, amountMinor: string, atMs: number): void {
  createScriptedPayment(st, { kind: "FUND_MILESTONE", lineKey: "SUPPLIER", payeeId: st.profile.ids.supplierAPayeeId, amountMinor, reason: "Fund milestone exactly as pre-signed" }, atMs);
}

const mined = (st: MockState, kind: string) => st.payments.filter((sp) => sp.payment.kind === kind && sp.applied.has("INCLUDED"));

describe("AI payments are the agent's own; a founder-signed payment is a person's signature (W-4)", () => {
  it("one founder MilestoneRelease: agentTxs 0, humanSigs 1", () => {
    const st = getState(readEnv());
    founderReleases(st, ORDER, T0);
    advance(st, LATER);
    const [release] = mined(st, "RELEASE_MILESTONE");
    // It carries a decision id (the schema requires one), which is why counting decision ids called it the AI's.
    expect(release?.payment.decisionId).not.toBeNull();
    expect(autonomyOf(st, T0, LATER)).toMatchObject({ agentTxs: 0, humanSigs: 1 });
    expect(st.autonomy.agentTxs).toBe(0);
  });

  it("one automatic FUND_MILESTONE: agentTxs 1, humanSigs 0", () => {
    const st = getState(readEnv());
    agentFunds(st, "75000", T0);
    advance(st, LATER);
    expect(mined(st, "FUND_MILESTONE")).toHaveLength(1);
    expect(autonomyOf(st, T0, LATER)).toMatchObject({ agentTxs: 1, humanSigs: 0 });
    expect(st.autonomy.agentTxs).toBe(1);
  });

  it("the final-2 order (deposit and balance funded by the agent, balance released by the founder) reads 2 and 1", () => {
    const st = getState(readEnv());
    agentFunds(st, "75000", T0);
    agentFunds(st, "175000", T0);
    founderReleases(st, ORDER, T0 + STEP_MS);
    advance(st, LATER);
    expect(st.payments.map((sp) => sp.payment.kind).sort()).toEqual(["FUND_MILESTONE", "FUND_MILESTONE", "RELEASE_MILESTONE"]);
    expect(autonomyOf(st, T0, LATER)).toMatchObject({ agentTxs: 2, humanSigs: 1 });
    expect(st.autonomy.agentTxs).toBe(2);
  });

  it("the founder's OwnerSpend (manual fallback) is not an AI payment either", () => {
    const st = getState(readEnv());
    createScriptedPayment(st, { kind: "OWNER_SPEND", lineKey: "LOGISTICS", payeeId: "spx-logistics", amountMinor: "4200", reason: "Founder paid the invoice manually" }, T0);
    advance(st, LATER);
    expect(mined(st, "OWNER_SPEND")).toHaveLength(1);
    expect(autonomyOf(st, T0, LATER).agentTxs).toBe(0);
    expect(st.autonomy.agentTxs).toBe(0);
  });
});
