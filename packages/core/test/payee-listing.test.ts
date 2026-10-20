/**
 * Payee drop (security audit run-2, fix 5). Treasury.spend pays only payees LISTED on the line in the current plan
 * version: a re-commit that drops a payee de-authorises it, even though its binding stays. The mirror denies with
 * the same error a forced send reverts with (PayeeNotBound).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluateProposal, planPacingSlot, trusted, type LineKey, type PolicyContext, type PolicyProposal } from "../src/index";
import { ctxDay1, ctxWithSupplier, DAY, ORDER_A, T0, pacingSpend, spend, withLineState } from "./fixtures/policy-ctx";

/** The context after a re-commit whose `lineKey` lists only `payeeIds` (bindings unchanged). */
const dropPayees = (ctx: PolicyContext, lineKey: LineKey, payeeIds: string[]): PolicyContext => ({
  ...ctx,
  plan: { ...ctx.plan, lines: ctx.plan.lines.map((l) => (l.lineKey === lineKey ? { ...l, payeeIds } : l)) },
});

describe("SPEND pays only payees listed on the line in the current plan version", () => {
  it("a bound payee the current plan no longer lists → DENY PayeeNotBound, mirroring the revert", () => {
    const ctx = dropPayees(ctxDay1(), "LOGISTICS", []);
    expect(ctx.payees.some((p) => p.payeeId === "spx-logistics")).toBe(true); // the binding stays
    expect(evaluateProposal(spend(), ctx)).toEqual({ verdict: "DENY", reasonCode: "PayeeNotBound", mirrorsRevert: true });
  });

  it("the listing check sits before cooling (spend row 10): a dropped payee still cooling → PayeeNotBound", () => {
    const p = spend({ lineKey: trusted("PACKAGING", "plan"), payeeId: trusted("printer-kl", "db:payees") });
    expect(evaluateProposal(p, ctxWithSupplier()).reasonCode).toBe("PayeeCooling"); // listed, cooling until day 3
    expect(evaluateProposal(p, withLineState(ctxWithSupplier(), "PACKAGING", { payeeIds: [] }))).toEqual({ verdict: "DENY", reasonCode: "PayeeNotBound", mirrorsRevert: true });
  });

  it("the mirrored on-chain list wins over the manifest when the worker provides it", () => {
    expect(evaluateProposal(spend(), withLineState(ctxDay1(), "LOGISTICS", { payeeIds: [] })).reasonCode).toBe("PayeeNotBound");
    expect(evaluateProposal(spend(), withLineState(ctxDay1(), "LOGISTICS", { payeeIds: ["spx-logistics"] })).verdict).toBe("AUTO");
  });

  it("a payee ADD_PAYEE appended to the line (listed on-chain) is payable once cooled", () => {
    const p = spend({ lineKey: trusted("PACKAGING", "plan"), payeeId: trusted("printer-kl", "db:payees") });
    expect(evaluateProposal(p, { ...ctxWithSupplier(), now: T0 + 4n * DAY }).verdict).toBe("AUTO");
    const unlisted = withLineState({ ...ctxWithSupplier(), now: T0 + 4n * DAY }, "PACKAGING", { payeeIds: [] });
    expect(evaluateProposal(p, unlisted).reasonCode).toBe("PayeeNotBound");
  });

  it("a dropped pacing payee is refused, so the pacing tick skips the slot instead of collecting denials", () => {
    const none = { slots: 0, lineMinor: "0", totalMinor: "0" };
    const ctx = dropPayees(ctxDay1(), "ADS", []);
    expect(evaluateProposal(pacingSpend(1), ctx).reasonCode).toBe("PayeeNotBound");
    expect(planPacingSlot(ctx, "ADS", none)).toEqual({ action: "SKIP", reason: "NO_PAYABLE_PAYEE" });
    expect(planPacingSlot(withLineState(ctxDay1(), "ADS", { payeeIds: [] }), "ADS", none)).toEqual({ action: "SKIP", reason: "NO_PAYABLE_PAYEE" });
    expect(planPacingSlot(ctxDay1(), "ADS", none).action).toBe("PROPOSE");
  });

  it("the pacing tick also skips while the line's only payee is cooling", () => {
    const ctx = { ...ctxDay1(), payees: ctxDay1().payees.map((p) => (p.payeeId === "shopee-ads" ? { ...p, coolingUntil: String(T0 + 3n * DAY) } : p)) };
    expect(evaluateProposal(pacingSpend(1), ctx).reasonCode).toBe("PayeeCooling");
    expect(planPacingSlot(ctx, "ADS", { slots: 0, lineMinor: "0", totalMinor: "0" })).toEqual({ action: "SKIP", reason: "NO_PAYABLE_PAYEE" });
  });

  it("escrow funding is unaffected: the supplier is paid through its signed binding, not a line listing", () => {
    const fund = { kind: "FUND_MILESTONE", origin: { trust: "trusted", sensitivity: "public" }, orderId: trusted(ORDER_A.orderId, "db"), idx: 0, amountMinor: trusted("30000", "schedule"), planVersion: 1 } as const;
    expect(evaluateProposal(fund, { ...ctxWithSupplier(), now: T0 + DAY }).verdict).toBe("AUTO");
  });

  it("property: a spend to a payee missing from the line's listed set is never AUTO", () => {
    const payees = ["spx-logistics", "shopee-ads", "shopee-fees", "printer-kl", "supplier-a"];
    fc.assert(
      fc.property(fc.constantFrom<LineKey>("LOGISTICS", "PACKAGING", "PLATFORM_FEES", "CONTINGENCY"), fc.constantFrom(...payees), fc.subarray(payees), (lineKey, payeeId, listed) => {
        const ctx = withLineState({ ...ctxWithSupplier(), now: T0 + 4n * DAY }, lineKey, { payeeIds: listed });
        const d = evaluateProposal(spend({ lineKey: trusted(lineKey, "plan"), payeeId: trusted(payeeId, "db"), amountMinor: trusted("1000", "db") }) as PolicyProposal, ctx);
        if (!listed.includes(payeeId)) expect([d.verdict, d.reasonCode]).toEqual(["DENY", "PayeeNotBound"]);
      }),
      { numRuns: 300 },
    );
  });
});
