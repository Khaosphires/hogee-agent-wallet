/**
 * Parity with the final-1 contracts (task 1.8, docs/assurance/require-table-final1.md): spend's reserve lock,
 * MilestoneEscrow.fundMilestone / releaseMilestone, the lender's releaseStage gate, the founder's ownerSpend and
 * SalesOracle.recordSale. Each DENY names the contract error the call would revert with, in on-chain order.
 */
import { describe, expect, it } from "vitest";
import {
  RESERVE_LINE_KEY,
  ZERO_HEX32,
  evaluateOwnerSpend,
  evaluateProposal,
  evaluateRecordSale,
  fakeHex32,
  sequenceInvoiceHash,
  trusted,
  type Labeled,
  type OwnerSpendIn,
  type PolicyContext,
  type PolicyDecision,
  type PolicyEscrowOrder,
  type PolicyMilestone,
  type PolicyProposal,
} from "../src/index";
import { ctxDay1, ctxWithSupplier, DAY, ORDER_A, RINA_MANIFEST, spend, T0, withLineState } from "./fixtures/policy-ctx";

const origin = { trust: "trusted", sensitivity: "public" } as const;
const mirrored = (reasonCode: string) => ({ verdict: "DENY", reasonCode, mirrorsRevert: true });
const decide = (p: PolicyProposal, ctx: PolicyContext): PolicyDecision => evaluateProposal(p, ctx);

describe("Treasury.spend row 4a: lineId RESERVE → ReserveLocked, right after the agent gate (T8)", () => {
  const reserve = spend({ lineKey: trusted(RESERVE_LINE_KEY, "plan") });

  it("the reserve is not a line: ReserveLocked, not LineExpired", () => {
    expect(decide(reserve, ctxDay1())).toEqual(mirrored("ReserveLocked"));
  });

  it("after NotAgent / Paused / AgentExpired, before StalePlan and every line check", () => {
    expect(decide(reserve, { ...ctxDay1(), agent: { ...ctxDay1().agent, revoked: true } }).reasonCode).toBe("NotAgent");
    expect(decide(reserve, { ...ctxDay1(), paused: true }).reasonCode).toBe("Paused");
    expect(decide(reserve, { ...ctxDay1(), now: BigInt(ctxDay1().agent.expiresAt) + 1n }).reasonCode).toBe("AgentExpired");
    expect(decide(spend({ ...reserve, planVersion: 9 }), ctxDay1()).reasonCode).toBe("ReserveLocked");
  });
});

describe("MilestoneEscrow.fundMilestone, in on-chain order (no listing rule; planVersion is off-chain only)", () => {
  const fund = (idx: number, amount: string, orderId: Labeled<string> = trusted("order-a-001", "db"), planVersion = 1) =>
    ({ kind: "FUND_MILESTONE", origin, orderId, idx, amountMinor: trusted(amount, "schedule"), planVersion }) as const;
  const ready = (): PolicyContext => ({ ...ctxWithSupplier(), now: T0 + DAY });
  const supplier = (ctx: PolicyContext, patch: object) => withLineState(ctx, "SUPPLIER", patch);

  it("a supplier bound by its signed approval is fundable although no plan version lists it", () => {
    expect(RINA_MANIFEST.lines.find((l) => l.lineKey === "SUPPLIER")?.payeeIds).toEqual([]);
    expect(decide(fund(0, "30000"), ready()).verdict).toBe("AUTO");
  });

  it.each<[string, (c: PolicyContext) => PolicyContext, number, string, string]>([
    ["unknown milestone index", (c) => c, 7, "30000", "PayeeNotBound"],
    ["supplier line past validUntil", (c) => supplier(c, { validUntil: String(T0) }), 0, "30000", "LineExpired"],
    ["supplier line not in the mirror", (c) => ({ ...c, lines: { ...c.lines, SUPPLIER: undefined } }), 0, "30000", "LineExpired"],
    ["supplier line circuit open", (c) => supplier(c, { circuitOpen: true }), 0, "30000", "CircuitOpen"],
    ["supplier line paused", (c) => supplier(c, { paused: true }), 0, "30000", "Paused"],
    ["order payee not bound to the line", (c) => ({ ...c, payees: c.payees.filter((p) => p.payeeId !== "supplier-a") }), 0, "30000", "PayeeNotBound"],
    ["order payee cooling", (c) => ({ ...c, now: T0 + 60n }), 0, "30000", "PayeeCooling"],
    ["zero amount", (c) => c, 0, "0", "CapExceeded"],
    ["above the signed milestone", (c) => c, 0, "30001", "AmountExceedsSchedule"],
    ["above the line balance", (c) => supplier(c, { spentMinor: "0", escrowedMinor: "480000" }), 0, "30000", "CapExceeded"],
    ["above releasedMinor", (c) => ({ ...c, totalSpentMinor: "380000" }), 0, "30000", "CapExceeded"],
    ["above funded BU", (c) => ({ ...c, fundedMinor: "29999" }), 0, "30000", "CapExceeded"],
  ])("%s → %s", (_name, mutate, idx, amount, code) => {
    expect(decide(fund(idx, amount), mutate(ready()))).toEqual(mirrored(code));
  });

  it("first failing row wins: line before payee, circuit before pause, schedule before balance", () => {
    expect(decide(fund(0, "30000"), supplier({ ...ready(), now: T0 + 60n }, { circuitOpen: true, paused: true })).reasonCode).toBe("CircuitOpen");
    const expired = { ...ready(), now: BigInt(RINA_MANIFEST.lines[0]!.validUntil) + 1n, agent: { ...ready().agent, expiresAt: "99999999999" } };
    expect(decide(fund(0, "30000"), { ...expired, payees: [] }).reasonCode).toBe("LineExpired");
    expect(decide(fund(0, "30001"), supplier(ready(), { escrowedMinor: "500000" })).reasonCode).toBe("AmountExceedsSchedule");
  });

  it("a released milestone whose payout failed is never re-funded → AmountExceedsSchedule (re-check M-1)", () => {
    const failed: PolicyEscrowOrder = { ...ORDER_A, milestones: ORDER_A.milestones.map((m, i) => (i === 0 ? { ...m, fundedMinor: m.amountMinor, released: true } : m)) };
    expect(decide(fund(0, "1"), { ...ready(), escrowOrders: [failed] })).toEqual(mirrored("AmountExceedsSchedule"));
  });

  it("a failed balance payout frees the line: a new order to the same supplier funds from it (re-check M-1)", () => {
    const failed: PolicyEscrowOrder = { ...ORDER_A, milestones: ORDER_A.milestones.map((m) => ({ ...m, fundedMinor: m.amountMinor, released: true })) };
    const reorder: PolicyEscrowOrder = { ...ORDER_A, orderId: "order-a-002", milestones: [{ amountMinor: "280000", fundedMinor: "0", autoRelease: true, released: false }] };
    const ctx = (escrowedMinor: string): PolicyContext =>
      supplier({ ...ready(), releasedMinor: "1000000", totalEscrowedMinor: escrowedMinor, escrowOrders: [failed, reorder] }, { escrowedMinor });
    // Treasury.pocket after failSettlement: 430,000 escrowed − the failed 280,000 balance.
    expect(decide(fund(0, "280000", trusted("order-a-002", "db")), ctx("150000")).verdict).toBe("AUTO");
    // The pre-fix ledger (the failed balance still escrowed) would exceed the 500,000 line.
    expect(decide(fund(0, "280000", trusted("order-a-002", "db")), ctx("430000"))).toEqual(mirrored("CapExceeded"));
  });

  it("a stale planVersion is an off-chain refusal, after every on-chain row (fundMilestone takes no planVersion)", () => {
    const stale = decide(fund(0, "30000", undefined, 2), ready());
    expect(stale).toEqual({ verdict: "DENY", reasonCode: "STALE_PLAN_VERSION", mirrorsRevert: false });
    expect(decide(fund(0, "30001", undefined, 2), ready())).toEqual(mirrored("AmountExceedsSchedule"));
  });
});

describe("MilestoneEscrow.releaseMilestone: signed amount and a failed payout (M8, re-check M-1)", () => {
  const evidence = fakeHex32("test:evidence:balance");
  const release = (patch: object = {}) => ({ kind: "RELEASE_MILESTONE", origin, orderId: "order-a-001", idx: 2, evidenceHash: evidence, ...patch }) as PolicyProposal;
  const funded = (m: Partial<PolicyMilestone> = {}): PolicyContext => {
    const order: PolicyEscrowOrder = { ...ORDER_A, milestones: ORDER_A.milestones.map((x, i) => ({ ...x, fundedMinor: x.amountMinor, ...(i === 2 ? m : {}) })) };
    return { ...ctxWithSupplier(), escrowOrders: [order] };
  };

  it("the signed amount must equal the schedule → else AmountExceedsSchedule (after MilestoneLocked, before EvidenceMissing)", () => {
    expect(decide(release({ amountMinor: "279999" }), funded())).toEqual(mirrored("AmountExceedsSchedule"));
    expect(decide(release({ amountMinor: "280000" }), funded()).verdict).toBe("NEEDS_FOUNDER");
    expect(decide(release({ amountMinor: "1", evidenceHash: undefined }), funded()).reasonCode).toBe("AmountExceedsSchedule");
    expect(decide(release({ amountMinor: "1" }), funded({ fundedMinor: "0" })).reasonCode).toBe("MilestoneLocked");
  });

  it("a zero evidence hash is missing evidence", () => {
    expect(decide(release({ evidenceHash: ZERO_HEX32 }), funded())).toEqual(mirrored("EvidenceMissing"));
  });

  it("after a failed payout the milestone stays released → MilestoneLocked, before any later row (re-check M-1)", () => {
    expect(decide(release(), funded({ released: true }))).toEqual(mirrored("MilestoneLocked"));
    expect(decide(release({ amountMinor: "1", evidenceHash: undefined }), funded({ released: true })).reasonCode).toBe("MilestoneLocked");
  });

  it("a known settlement means a release happened: MilestoneLocked even if the mirror still reads it unreleased (re-check M-1)", () => {
    expect(decide(release(), funded({ released: false, settlementUsed: true }))).toEqual(mirrored("MilestoneLocked"));
    expect(decide(release({ evidenceHash: undefined }), funded({ settlementUsed: true })).reasonCode).toBe("MilestoneLocked");
  });

  it("escrowRelease: the payee's lifetime cap → CapExceeded", () => {
    const ctx = funded();
    const capped = { ...ctx, payees: ctx.payees.map((p) => (p.payeeId === "supplier-a" ? { ...p, paidMinor: "150001" } : p)) };
    expect(decide(release(), capped)).toEqual(mirrored("CapExceeded"));
  });

  it("escrowRelease: inside the payee's cooling window (a re-bind restarts it) → PayeeCooling, after MilestoneLocked, before CapExceeded (audit run-3)", () => {
    const now = T0 + DAY;
    const rebound = (ctx: PolicyContext, patch: object = {}): PolicyContext => ({
      ...ctx,
      payees: ctx.payees.map((p) => (p.payeeId === "supplier-a" ? { ...p, coolingUntil: String(now + 120n), ...patch } : p)),
    });
    expect(decide(release(), rebound(funded()))).toEqual(mirrored("PayeeCooling"));
    expect(decide(release(), { ...rebound(funded()), now: now + 120n }).verdict).toBe("NEEDS_FOUNDER");
    expect(decide(release(), rebound(funded({ settlementUsed: true }))).reasonCode).toBe("MilestoneLocked");
    expect(decide(release(), rebound(funded(), { paidMinor: "150001" })).reasonCode).toBe("PayeeCooling");
  });
});

describe("Treasury.releaseStage: unknown, released or unmet → CapExceeded (the stage stop-loss error)", () => {
  const stage = (sales: string, extra: object = {}) => ({ kind: "RELEASE_STAGE", origin, stageId: "stage-2", salesMinor: trusted(sales, "oracle"), ...extra }) as PolicyProposal;
  const withGate = (gate: object): PolicyContext => {
    const c = ctxDay1();
    return { ...c, plan: { ...c.plan, stages: c.plan.stages.map((s) => (s.stageId === "stage-2" ? { ...s, gate: { ...s.gate!, ...gate } } : s)) } };
  };

  it("gate met by the deadline → NEEDS_OFFICER; short or late → CapExceeded", () => {
    expect(decide(stage("200000"), ctxDay1())).toMatchObject({ verdict: "NEEDS_OFFICER", exceptionKind: "RELEASE_STAGE" });
    expect(decide(stage("199999"), ctxDay1())).toEqual(mirrored("CapExceeded"));
    expect(decide(stage("200000"), { ...ctxDay1(), now: T0 + 31n * DAY })).toEqual(mirrored("CapExceeded"));
  });

  it("an already-released or unknown stage → CapExceeded", () => {
    expect(decide({ kind: "RELEASE_STAGE", origin, stageId: "stage-1", salesMinor: trusted("0", "oracle") }, ctxDay1())).toEqual(mirrored("CapExceeded"));
    expect(decide({ kind: "RELEASE_STAGE", origin, stageId: "stage-9", salesMinor: trusted("999999", "oracle") }, ctxDay1())).toEqual(mirrored("CapExceeded"));
  });

  it("deadline 0 means no deadline; METRIC_ORDERS counts recorded sales", () => {
    expect(decide(stage("200000"), { ...withGate({ deadline: "0" }), now: T0 + 400n * DAY }).verdict).toBe("NEEDS_OFFICER");
    const orders = withGate({ metric: "orders", target: "25" });
    expect(decide(stage("0", { salesCount: trusted("25", "oracle") }), orders).verdict).toBe("NEEDS_OFFICER");
    expect(decide(stage("0", { salesCount: trusted("24", "oracle") }), orders)).toEqual(mirrored("CapExceeded"));
    expect(decide(stage("999999"), orders)).toEqual(mirrored("CapExceeded")); // no count: never met
  });
});

describe("Treasury.ownerSpend (founder's fallback): spend's rules without the agent, pause or window rows", () => {
  const owner = (patch: Partial<OwnerSpendIn> = {}): OwnerSpendIn => ({
    lineKey: "LOGISTICS",
    payeeId: "spx-logistics",
    amountMinor: "20000",
    invoiceHash: fakeHex32("test:owner:invoice"),
    intentId: fakeHex32("test:owner:intent"),
    ...patch,
  });
  const ok = { verdict: "NEEDS_FOUNDER", reasonCode: "FOUNDER_SIGNATURE_REQUIRED", mirrorsRevert: false };

  it("not blocked by a pause, a tripped line, a revoked agent, a stale plan, a full window or the per-tx cap", () => {
    let ctx = withLineState({ ...ctxDay1(), paused: true, planVersion: 3, agent: { ...ctxDay1().agent, revoked: true } }, "LOGISTICS", {
      paused: true,
      circuitOpen: true,
      windowSpentMinor: "40000",
      windowLiveSpends: 64,
      perTxCapMinor: "1",
    });
    ctx = { ...ctx, now: BigInt(ctx.agent.expiresAt) - 1n };
    expect(evaluateOwnerSpend(owner({ amountMinor: "30000" }), ctx)).toEqual(ok);
  });

  it.each<[string, Partial<OwnerSpendIn>, (c: PolicyContext) => PolicyContext, string]>([
    ["the reserve", { lineKey: RESERVE_LINE_KEY }, (c) => c, "ReserveLocked"],
    ["the escrow-only supplier line", { lineKey: "SUPPLIER", payeeId: "supplier-a" }, () => ctxWithSupplier(), "EscrowOnly"],
    ["a line outside the plan", { lineKey: "LICENSING" }, (c) => c, "LineExpired"],
    ["a line past validUntil", {}, (c) => withLineState(c, "LOGISTICS", { validUntil: String(T0) }), "LineExpired"],
    ["a bound payee the current version does not list", {}, (c) => withLineState(c, "LOGISTICS", { payeeIds: [] }), "PayeeNotBound"],
    ["a payee in cooling", { lineKey: "PACKAGING", payeeId: "printer-kl" }, () => ctxWithSupplier(), "PayeeCooling"],
    ["a used intent", {}, (c) => ({ ...c, usedIntents: new Set([owner().intentId]) }), "DuplicateIntent"],
    ["a paid invoice", {}, (c) => ({ ...c, paidInvoices: new Set([owner().invoiceHash]) }), "DuplicateInvoice"],
    ["a zero amount", { amountMinor: "0" }, (c) => c, "CapExceeded"],
    ["above the line balance", {}, (c) => withLineState(c, "LOGISTICS", { spentMinor: "60001" }), "CapExceeded"],
    ["above the payee's lifetime cap", {}, (c) => ({ ...c, payees: c.payees.map((p) => (p.payeeId === "spx-logistics" ? { ...p, lifetimeCapMinor: "19999" } : p)) }), "CapExceeded"],
    ["above releasedMinor", {}, (c) => ({ ...c, totalSpentMinor: "380001" }), "CapExceeded"],
    ["above funded BU", {}, (c) => ({ ...c, fundedMinor: "19999" }), "CapExceeded"],
  ])("%s → %s", (_name, patch, mutate, code) => {
    expect(evaluateOwnerSpend(owner(patch), mutate(ctxDay1()))).toEqual(mirrored(code));
  });

  it("on a pacing line it pays the next slot at most the pacing amount: used slot DuplicateInvoice, skipped slot or more → CapExceeded", () => {
    const ads = withLineState(ctxDay1(), "ADS", { nextSequence: 3 });
    const slot = (n: number, amount = "7500") => owner({ lineKey: "ADS", payeeId: "shopee-ads", invoiceHash: sequenceInvoiceHash(n), amountMinor: amount });
    expect(evaluateOwnerSpend(slot(3), ads)).toEqual(ok);
    expect(evaluateOwnerSpend(slot(2), ads)).toEqual(mirrored("DuplicateInvoice"));
    expect(evaluateOwnerSpend(slot(4), ads)).toEqual(mirrored("CapExceeded"));
    expect(evaluateOwnerSpend(slot(3, "7501"), ads)).toEqual(mirrored("CapExceeded"));
  });

  it("first failing row wins: escrowOnly before validity, listing before cooling, invoice before the zero amount", () => {
    expect(evaluateOwnerSpend(owner({ lineKey: "SUPPLIER" }), { ...ctxWithSupplier(), now: T0 + 400n * DAY }).reasonCode).toBe("EscrowOnly");
    const p = owner({ amountMinor: "0" });
    expect(evaluateOwnerSpend(p, { ...ctxDay1(), paidInvoices: new Set([p.invoiceHash]) }).reasonCode).toBe("DuplicateInvoice");
  });
});

describe("SalesOracle.recordSale (the oracle's pre-check; the agent gets NotOracle)", () => {
  const sale = fakeHex32("test:sale:evt-1");

  it("a sale before the first plan → StalePlan (no reserveBps to skim yet); after it → AUTO", () => {
    expect(evaluateRecordSale(sale, { planVersion: 0, recordedSales: new Set() })).toEqual(mirrored("StalePlan"));
    expect(evaluateRecordSale(sale, { planVersion: 1, recordedSales: new Set() }).verdict).toBe("AUTO");
  });

  it("a replayed sale → DuplicateSale, checked before the plan", () => {
    expect(evaluateRecordSale(sale, { planVersion: 0, recordedSales: new Set([sale]) })).toEqual(mirrored("DuplicateSale"));
    expect(evaluateRecordSale(sale.toUpperCase().replace("0X", "0x") as typeof sale, { planVersion: 1, recordedSales: new Set([sale]) }).reasonCode).toBe("DuplicateSale");
  });
});
