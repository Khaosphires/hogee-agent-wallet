import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  evaluateProposal,
  evaluateSpend,
  parseMinor,
  planPacingSlot,
  projectInFlight,
  sequenceInvoiceHash,
  spendIntentId,
  stringToBytes32,
  type PacingInFlight,
  type PacingSlotPlan,
  type PolicyContext,
  type PolicyPayeeState,
} from "../src/index";
import { ctxDay1, DAY, pacingSpend, RINA_MANIFEST, T0, withLineState } from "./fixtures/policy-ctx";

const ads = RINA_MANIFEST.lines.find((l) => l.lineKey === "ADS")!;
const PACING = parseMinor(ads.pacing!.amountMinor);
const WINDOW_CAP = parseMinor(ads.windowCapMinor);
const NONE: PacingInFlight = { slots: 0, lineMinor: "0", totalMinor: "0" };
/** `slots` in-flight ADS slots of `each` minor units, plus `other` minor units in flight on other lines. */
const flight = (slots: number, each: bigint = PACING, other = 0n): PacingInFlight => ({
  slots,
  lineMinor: (BigInt(slots) * each).toString(),
  totalMinor: (BigInt(slots) * each + other).toString(),
});

const adsCtx = (windowSpent: bigint, nextSequence = 4): PolicyContext =>
  withLineState(ctxDay1(), "ADS", { windowSpentMinor: windowSpent.toString(), nextSequence });

const withAdsPayee = (ctx: PolicyContext, patch: Partial<PolicyPayeeState>): PolicyContext => ({
  ...ctx,
  payees: ctx.payees.map((p) => (p.payeeId === "shopee-ads" ? { ...p, ...patch } : p)),
});

/** A second platform payee on ADS, listed next to shopee-ads. */
const withSecondAdsPayee = (ctx: PolicyContext): PolicyContext =>
  withLineState({ ...ctx, payees: [...ctx.payees, { payeeId: "tiktok-ads", source: "platform", lineKeys: ["ADS"], paidMinor: "0" }] }, "ADS", { payeeIds: ["shopee-ads", "tiktok-ads"] });

const proposed = (plan: PacingSlotPlan) => (plan.action === "PROPOSE" ? plan : expect.unreachable(`expected PROPOSE, got ${JSON.stringify(plan)}`));

describe("planPacingSlot (autonomous-tick, G0 decision §1 #1)", () => {
  it("Rina's ADS line fits 8 pacing slots in one window", () => {
    expect([PACING, WINDOW_CAP]).toEqual([7_500n, 60_000n]);
    expect(PACING * 8n).toBeLessThanOrEqual(WINDOW_CAP);
  });

  it("proposes the next on-chain slot at the manifest's pacing amount, as the exact spend it evaluated", () => {
    const plan = proposed(planPacingSlot(adsCtx(0n), "ADS", NONE));
    expect(plan).toMatchObject({ pacingSlot: 4, amountMinor: "7500", payeeId: "shopee-ads" });
    expect(plan.proposal).toMatchObject({ kind: "SPEND", invoiceHash: sequenceInvoiceHash(4), planVersion: 1, basis: { pacingSlot: 4 } });
    expect([plan.proposal.lineKey.value, plan.proposal.payeeId.value, plan.proposal.amountMinor.value]).toEqual(["ADS", "shopee-ads", "7500"]);
    expect(plan.proposal.intentId).toBe(
      spendIntentId({ planId: RINA_MANIFEST.planId, lineId: stringToBytes32("ADS"), payeeId: stringToBytes32("shopee-ads"), invoiceHash: sequenceInvoiceHash(4), amountMinor: 7_500n }),
    );
    expect(evaluateSpend(plan.proposal, adsCtx(0n)).verdict).toBe("AUTO");
  });

  it("a fresh plan's first slot is 1, as Treasury.lineSequence returns (slot 0 would revert)", () => {
    expect(planPacingSlot(ctxDay1(), "ADS", NONE)).toMatchObject({ action: "PROPOSE", pacingSlot: 1, amountMinor: "7500" });
    expect(evaluateProposal(pacingSpend(0), ctxDay1()).reasonCode).toBe("DuplicateInvoice");
    expect(ctxDay1().lines.LOGISTICS?.nextSequence).toBe(0);
  });

  it("proposes the 8th slot of a window: exactly the cap is allowed", () => {
    expect(planPacingSlot(adsCtx(PACING * 7n), "ADS", NONE).action).toBe("PROPOSE");
  });

  it.each([
    ["one minor unit short", WINDOW_CAP - PACING + 1n, NONE, "7499"],
    ["window full", WINDOW_CAP, NONE, "0"],
    ["window above the cap after a tighten", WINDOW_CAP + 5_000n, NONE, "0"],
    ["in-flight spend fills the rest", PACING * 6n, flight(1, 7_501n), "7499"],
  ])("skips when there is no headroom: %s", (_name, spent, inFlight, headroom) => {
    expect(planPacingSlot(adsCtx(spent), "ADS", inFlight)).toMatchObject({ action: "SKIP", reason: "NO_WINDOW_HEADROOM", headroomMinor: headroom });
  });

  it("skips a line without pacing", () => {
    expect(planPacingSlot(ctxDay1(), "LOGISTICS", NONE)).toEqual({ action: "SKIP", reason: "NOT_PACING_LINE" });
  });

  it("rejects malformed in-flight input instead of guessing", () => {
    expect(() => planPacingSlot(adsCtx(0n), "ADS", { ...NONE, lineMinor: "-1" })).toThrow(/inFlight/);
    expect(() => planPacingSlot(adsCtx(0n), "ADS", { ...NONE, slots: -1 })).toThrow(/inFlight/);
    expect(() => planPacingSlot(adsCtx(0n), "ADS", { ...NONE, slots: 1.5 })).toThrow(/inFlight/);
    expect(() => planPacingSlot(adsCtx(0n), "ADS", { slots: 1, lineMinor: "7500", totalMinor: "0" })).toThrow(/inFlight/);
  });
});

describe("in-flight slots: one evaluator over the projected context", () => {
  it("proposes the slot after the in-flight ones; AUTO once they are mined, PACING_SLOT_AHEAD on the unmined mirror", () => {
    const ctx = adsCtx(0n, 4);
    const plan = proposed(planPacingSlot(ctx, "ADS", flight(2)));
    expect(plan.pacingSlot).toBe(6);
    expect(evaluateSpend(plan.proposal, projectInFlight(ctx, "ADS", flight(2), plan.payeeId)).verdict).toBe("AUTO");
    expect(evaluateSpend(plan.proposal, ctx).reasonCode).toBe("PACING_SLOT_AHEAD"); // why the worker must use the projection
  });

  it("projectInFlight: what the line, the payee and the totals look like once the in-flight spends are mined", () => {
    const ctx = withLineState(adsCtx(15_000n, 4), "ADS", { spentMinor: "15000", windowLiveSpends: 2 });
    const p = projectInFlight(ctx, "ADS", flight(2, PACING, 1_000n), "shopee-ads");
    expect(p.lines.ADS).toMatchObject({ windowSpentMinor: "30000", spentMinor: "30000", nextSequence: 6, windowLiveSpends: 4 });
    expect(p.payees.find((x) => x.payeeId === "shopee-ads")?.paidMinor).toBe("15000");
    expect(p.totalSpentMinor).toBe("16000");
    expect(ctx.lines.ADS?.nextSequence).toBe(4); // the input is not mutated
    expect(projectInFlight(ctx, "ADS", NONE, "shopee-ads")).toEqual(ctx);
  });
});

describe("planPacingSlot skips whatever evaluateSpend would deny (skills re-check)", () => {
  it.each<[string, (c: PolicyContext) => PolicyContext, PacingInFlight, string, string]>([
    ["per-tx cap tightened below the pacing", (c) => withLineState(c, "ADS", { perTxCapMinor: "7000" }), NONE, "PER_TX_CAP_BELOW_PACING", "7000"],
    ["line balance short", (c) => withLineState(c, "ADS", { spentMinor: "113000" }), NONE, "NO_LINE_BALANCE", "7000"],
    ["line balance short after in-flight slots", (c) => withLineState(c, "ADS", { spentMinor: "106000" }), flight(1), "NO_LINE_BALANCE", "6500"],
    ["released stage short", (c) => ({ ...c, totalSpentMinor: "393000" }), NONE, "NO_RELEASED_HEADROOM", "7000"],
    ["released stage short after in-flight spends on other lines", (c) => ({ ...c, totalSpentMinor: "380000" }), flight(0, PACING, 13_000n), "NO_RELEASED_HEADROOM", "7000"],
    ["payee lifetime cap reached", (c) => withAdsPayee(c, { lifetimeCapMinor: "20000", paidMinor: "5001" }), flight(1), "PAYEE_CAP_REACHED", "7499"],
    ["funded budget short", (c) => ({ ...c, fundedMinor: "7499" }), NONE, "NO_FUNDED_HEADROOM", "7499"],
  ])("%s → SKIP %s", (_name, mutate, inFlight, reason, headroom) => {
    const plan = planPacingSlot(mutate(adsCtx(0n)), "ADS", inFlight);
    expect(plan).toMatchObject({ action: "SKIP", reason, headroomMinor: headroom, decision: { verdict: "DENY", reasonCode: "CapExceeded" } });
  });

  it("64 live spends in the window → SKIP NO_LIVE_SPEND_ROOM", () => {
    expect(planPacingSlot(withLineState(adsCtx(0n), "ADS", { windowLiveSpends: 63 }), "ADS", flight(1))).toMatchObject({ action: "SKIP", reason: "NO_LIVE_SPEND_ROOM" });
    expect(planPacingSlot(withLineState(adsCtx(0n), "ADS", { windowLiveSpends: 62 }), "ADS", flight(1)).action).toBe("PROPOSE");
  });

  it.each<[string, (c: PolicyContext) => PolicyContext, string]>([
    ["treasury paused", (c) => ({ ...c, paused: true }), "Paused"],
    ["line paused", (c) => withLineState(c, "ADS", { paused: true }), "Paused"],
    ["circuit open", (c) => withLineState(c, "ADS", { circuitOpen: true }), "CircuitOpen"],
    ["agent revoked", (c) => ({ ...c, agent: { ...c.agent, revoked: true } }), "NotAgent"],
    ["agent expired", (c) => ({ ...c, now: BigInt(c.agent.expiresAt) + 1n }), "AgentExpired"],
    ["line past validUntil", (c) => ({ ...c, now: BigInt(ads.validUntil) + 1n, agent: { ...c.agent, expiresAt: "99999999999" } }), "LineExpired"],
  ])("%s → SKIP %s (never proposed, so never denied or recorded)", (_name, mutate, reason) => {
    const plan = planPacingSlot(mutate(adsCtx(0n)), "ADS", flight(1));
    expect(plan).toMatchObject({ action: "SKIP", reason, decision: { verdict: "DENY", reasonCode: reason } });
  });

  it("payee choice: the line's single payable payee, an explicit one, or a skip", () => {
    const two = withSecondAdsPayee(adsCtx(0n));
    expect(planPacingSlot(two, "ADS", NONE)).toEqual({ action: "SKIP", reason: "PACING_PAYEE_AMBIGUOUS" });
    expect(planPacingSlot(two, "ADS", NONE, "tiktok-ads")).toMatchObject({ action: "PROPOSE", payeeId: "tiktok-ads" });
    const oneCooling = { ...two, payees: two.payees.map((p) => (p.payeeId === "tiktok-ads" ? { ...p, coolingUntil: String(T0 + 3n * DAY) } : p)) };
    expect(planPacingSlot(oneCooling, "ADS", NONE)).toMatchObject({ action: "PROPOSE", payeeId: "shopee-ads" });
    expect(planPacingSlot(oneCooling, "ADS", NONE, "tiktok-ads")).toMatchObject({ action: "SKIP", reason: "PayeeCooling" });
    expect(planPacingSlot(adsCtx(0n), "ADS", NONE, "evil-payee")).toMatchObject({ action: "SKIP", reason: "PayeeNotBound" });
  });

  it("property: a proposed slot is always AUTO under the projected context; a skip carries a non-AUTO decision", () => {
    // Ranges lean towards a payable state, so PROPOSE and each kind of SKIP all occur often.
    const amt = (min: number, max: number) => fc.integer({ min, max }).map(String);
    fc.assert(
      fc.property(
        fc.record({ perTxCapMinor: amt(5_000, 30_000), windowCapMinor: amt(20_000, 60_000), windowSpentMinor: amt(0, 45_000), allocatedMinor: amt(60_000, 150_000), spentMinor: amt(0, 120_000), nextSequence: fc.integer({ min: 1, max: 30 }), windowLiveSpends: fc.option(fc.integer({ min: 40, max: 64 }), { nil: undefined }) }),
        fc.record({ releasedMinor: amt(300_000, 1_000_000), totalSpentMinor: amt(0, 500_000), fundedMinor: fc.option(amt(200_000, 1_000_000), { nil: undefined }) }),
        fc.record({ lifetimeCapMinor: fc.option(amt(20_000, 200_000), { nil: undefined }), paidMinor: amt(0, 100_000) }),
        fc.record({ treasuryPaused: fc.nat(15), linePaused: fc.nat(15), circuitOpen: fc.nat(15), revoked: fc.nat(15), expired: fc.nat(15), pastValidUntil: fc.nat(15) }),
        fc.constantFrom<"single" | "two" | "two-explicit">("single", "single", "two", "two-explicit", "two-explicit"),
        fc.integer({ min: 0, max: 3 }),
        fc.bigInt({ min: 0n, max: 50_000n }),
        (line, totals, payee, odds, payees, slots, other) => {
          const on = (n: number) => n === 0; // each state flag is on in 1 of 16 cases
          let ctx: PolicyContext = withAdsPayee({ ...withLineState(ctxDay1(), "ADS", { ...line, paused: on(odds.linePaused), circuitOpen: on(odds.circuitOpen) }), ...totals }, payee);
          if (payees !== "single") ctx = withSecondAdsPayee(ctx);
          ctx = { ...ctx, paused: on(odds.treasuryPaused), agent: { revoked: on(odds.revoked), expiresAt: on(odds.expired) ? String(T0) : ctx.agent.expiresAt } };
          if (on(odds.pastValidUntil)) ctx = withLineState(ctx, "ADS", { validUntil: String(T0) });
          const inFlight = flight(slots, PACING, other);
          const plan = planPacingSlot(ctx, "ADS", inFlight, payees === "two-explicit" ? "tiktok-ads" : undefined);
          if (plan.action === "PROPOSE") {
            expect(plan.pacingSlot).toBe(line.nextSequence + slots);
            expect(evaluateSpend(plan.proposal, projectInFlight(ctx, "ADS", inFlight, plan.payeeId)).verdict).toBe("AUTO");
          } else if ("decision" in plan) {
            expect(plan.decision.verdict).not.toBe("AUTO");
          } else {
            expect(["NO_PAYABLE_PAYEE", "PACING_PAYEE_AMBIGUOUS"]).toContain(plan.reason);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });
});
