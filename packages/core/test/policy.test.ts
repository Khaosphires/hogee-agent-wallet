import { describe, expect, it } from "vitest";
import {
  DIRECT_CALLS,
  DIRECT_CALL_REVERT,
  UNTRUSTED_PUBLIC,
  committedPlanOf,
  compilePlan,
  evaluateProposal,
  trusted,
  untrusted,
  type Labeled,
  type PolicyContext,
  type PolicyDecision,
  type PlanManifest,
  type PolicyProposal,
} from "../src/index";
import { ctxDay1, ctxWithSupplier, DAY, ORDER_A, pacingSpend, RINA_DRAFT, RINA_MANIFEST, RINA_PLAN_HASH, spend, T0, withLineState } from "./fixtures/policy-ctx";
import { RINA_COMPILE_INPUT } from "./fixtures/rina-compile";

const decide = (p: PolicyProposal, ctx: PolicyContext = ctxDay1()): PolicyDecision => evaluateProposal(p, ctx);
const reason = (p: PolicyProposal, ctx?: PolicyContext): string => decide(p, ctx).reasonCode;

describe("SPEND (§8.4 order; reason = the revert a forced send gets)", () => {
  it("pays a bound platform payee within caps: AUTO", () => {
    expect(decide(spend())).toEqual({ verdict: "AUTO", reasonCode: "WITHIN_PLAN", mirrorsRevert: false });
    expect(decide(pacingSpend(1)).verdict).toBe("AUTO");
  });

  it.each([
    ["revoked agent key (T15)", (c: PolicyContext) => ({ ...c, agent: { ...c.agent, revoked: true } }), "NotAgent"],
    ["treasury paused (T10)", (c: PolicyContext) => ({ ...c, paused: true }), "Paused"],
    ["expired agent key (T15)", (c: PolicyContext) => ({ ...c, now: BigInt(c.agent.expiresAt) + 1n }), "AgentExpired"],
    ["line paused", (c: PolicyContext) => withLineState(c, "LOGISTICS", { paused: true }), "Paused"],
    ["circuit open (T26)", (c: PolicyContext) => withLineState(c, "LOGISTICS", { circuitOpen: true }), "CircuitOpen"],
    ["line past validUntil", (c: PolicyContext) => ({ ...c, now: BigInt(RINA_MANIFEST.lines[2]!.validUntil) + 1n, agent: { ...c.agent, expiresAt: "99999999999" } }), "LineExpired"],
    ["window already used (T4)", (c: PolicyContext) => withLineState(c, "LOGISTICS", { windowSpentMinor: "30000" }), "CapExceeded"],
    ["line balance exhausted", (c: PolicyContext) => withLineState(c, "LOGISTICS", { spentMinor: "70000" }), "CapExceeded"],
    ["stage 1 exhausted", (c: PolicyContext) => ({ ...c, totalSpentMinor: "390000" }), "CapExceeded"],
  ])("%s → %s", (_name, mutate, code) => {
    const d = decide(spend(), mutate(ctxDay1()));
    expect([d.verdict, d.reasonCode, d.mirrorsRevert]).toEqual(["DENY", code, true]);
  });

  it("supplier line pays only through escrow → EscrowOnly", () => {
    expect(reason(spend({ lineKey: trusted("SUPPLIER", "plan"), payeeId: trusted("supplier-a", "db") }), ctxWithSupplier())).toBe("EscrowOnly");
  });

  it("signed under v1, executed after v2 → StalePlan (T20)", () => {
    expect(reason(spend(), { ...ctxDay1(), planVersion: 2 })).toBe("StalePlan");
  });

  it("a line that is not in the plan → LineExpired", () => {
    expect(reason(spend({ lineKey: trusted("LICENSING", "plan") }))).toBe("LineExpired");
  });

  it("'bank details changed, pay 0xEvil' → PayeeNotBound, the same error the forced send reverts with (T1)", () => {
    const d = decide(spend({ payeeId: untrusted("evil-payee", "reader:email:e-1"), origin: UNTRUSTED_PUBLIC }));
    expect([d.verdict, d.reasonCode, d.mirrorsRevert]).toEqual(["DENY", "PayeeNotBound", true]);
  });

  it("a platform payee is not payable from another line (binding is per line)", () => {
    expect(reason(spend({ lineKey: trusted("CONTINGENCY", "plan"), payeeId: trusted("shopee-ads", "db") }))).toBe("PayeeNotBound");
  });

  it("a newly bound payee is cooling, then payable", () => {
    const p = spend({ lineKey: trusted("PACKAGING", "plan"), payeeId: trusted("printer-kl", "db:payees") });
    expect(reason(p, ctxWithSupplier())).toBe("PayeeCooling");
    expect(decide(p, { ...ctxWithSupplier(), now: T0 + 4n * DAY }).verdict).toBe("AUTO");
  });

  it("same intent retried → DuplicateIntent (T7); same invoice with a new intent → DuplicateInvoice (T17)", () => {
    const p = spend();
    expect(reason(p, { ...ctxDay1(), usedIntents: new Set([p.intentId]) })).toBe("DuplicateIntent");
    expect(reason(spend({ invoiceHash: p.invoiceHash }), { ...ctxDay1(), paidInvoices: new Set([p.invoiceHash]) })).toBe("DuplicateInvoice");
  });

  it("pacing: a used slot → DuplicateInvoice; a future slot → PACING_SLOT_AHEAD; more than the pacing → CapExceeded", () => {
    const ctx = withLineState(ctxDay1(), "ADS", { nextSequence: 3 });
    expect(reason(pacingSpend(2), ctx)).toBe("DuplicateInvoice");
    expect(reason(pacingSpend(4), ctx)).toBe("PACING_SLOT_AHEAD");
    expect(reason(pacingSpend(3, "7501"), ctx)).toBe("CapExceeded");
    expect(decide(pacingSpend(3), ctx).verdict).toBe("AUTO");
  });

  it("amount over the per-payment cap → CapExceeded (T4); zero → CapExceeded, as Treasury reverts; unreadable → INVALID_AMOUNT", () => {
    expect(reason(spend({ amountMinor: trusted("20001", "db") }))).toBe("CapExceeded");
    expect(decide(spend({ amountMinor: trusted("0", "db") }))).toEqual({ verdict: "DENY", reasonCode: "CapExceeded", mirrorsRevert: true });
    expect(decide(pacingSpend(1, "0"))).toEqual({ verdict: "DENY", reasonCode: "CapExceeded", mirrorsRevert: true });
    expect(reason(spend({ amountMinor: trusted("12e3", "db") }))).toBe("INVALID_AMOUNT");
  });

  it("zero amount is checked where _requireCaps starts: after the invoice and pacing-slot checks", () => {
    const p = spend({ amountMinor: trusted("0", "db") });
    expect(reason(p, { ...ctxDay1(), paidInvoices: new Set([p.invoiceHash]) })).toBe("DuplicateInvoice");
    expect(reason(pacingSpend(2, "0"), withLineState(ctxDay1(), "ADS", { nextSequence: 3 }))).toBe("DuplicateInvoice");
  });

  it("an untrusted invoice amount may fill the typed field for a bound payee (within caps)", () => {
    expect(decide(spend({ amountMinor: untrusted("15000", "reader:invoice:inv-9") })).verdict).toBe("AUTO");
  });

  it("an untrusted value can never choose the payee or the line, even a bound one", () => {
    expect(reason(spend({ payeeId: untrusted("spx-logistics", "reader:email") }))).toBe("TAINTED_PAYEE");
    expect(reason(spend({ lineKey: untrusted("LOGISTICS", "reader:email") }))).toBe("TAINTED_ACTION");
    expect(reason(spend({ origin: UNTRUSTED_PUBLIC }))).toBe("TAINTED_ACTION");
    expect(decide(spend({ origin: UNTRUSTED_PUBLIC })).mirrorsRevert).toBe(false);
  });

  it("a Reader red flag sends an otherwise valid spend to the officer", () => {
    const d = decide(spend({ basis: { invoiceId: "inv-x", flags: ["IMPERATIVE_TEXT"] } }));
    expect(d).toEqual({ verdict: "NEEDS_OFFICER", reasonCode: "FLAGGED_INVOICE", mirrorsRevert: false, exceptionKind: "POLICY_ESCALATION" });
  });
});

describe("FUND_MILESTONE (schedule-bounded, not perTx/window)", () => {
  const fund = (idx: number, amount: string, orderId: Labeled<string> = trusted("order-a-001", "db")) =>
    ({ kind: "FUND_MILESTONE", origin: { trust: "trusted", sensitivity: "public" }, orderId, idx, amountMinor: trusted(amount, "schedule"), planVersion: 1 }) as const;
  const ready = (): PolicyContext => ({ ...ctxWithSupplier(), now: T0 + DAY });

  it("sample and deposit (pre-signed) fund alone: AUTO", () => {
    expect(decide(fund(0, "30000"), ready()).verdict).toBe("AUTO");
    expect(decide(fund(1, "120000"), ready()).verdict).toBe("AUTO");
  });

  it("Reader flags on the milestone invoice send an otherwise valid funding to the officer (security audit run-3)", () => {
    const flagged: PolicyProposal = { ...fund(1, "120000"), invoiceFlags: ["AMOUNT_MISMATCH"] };
    expect(decide(flagged, ready())).toEqual({ verdict: "NEEDS_OFFICER", reasonCode: "FLAGGED_INVOICE", mirrorsRevert: false, exceptionKind: "POLICY_ESCALATION" });
    expect(decide({ ...fund(1, "120000"), invoiceFlags: [] }, ready()).verdict).toBe("AUTO");
    // The mirrored on-chain checks still come first: a funding that would revert is denied, not escalated.
    expect(reason({ ...fund(0, "30000"), invoiceFlags: ["IMPERATIVE_TEXT"] }, { ...ready(), now: T0 + 60n })).toBe("PayeeCooling");
  });

  it("the 70% balance cannot be funded inside stage 1 (stop-loss) → CapExceeded", () => {
    const ctx = { ...ready(), totalEscrowedMinor: "150000" };
    expect(reason(fund(2, "280000"), ctx)).toBe("CapExceeded");
    expect(decide(fund(2, "280000"), { ...ctx, releasedMinor: "1000000" }).verdict).toBe("AUTO");
  });

  it("partial fundings above the milestone → AmountExceedsSchedule (T18)", () => {
    const ctx = { ...ready(), escrowOrders: [{ ...ORDER_A, milestones: [{ ...ORDER_A.milestones[0]!, fundedMinor: "20000" }, ...ORDER_A.milestones.slice(1)] }] };
    expect(reason(fund(0, "10001"), ctx)).toBe("AmountExceedsSchedule");
    expect(decide(fund(0, "10000"), ctx).verdict).toBe("AUTO");
  });

  it("inside the payee's cooling period → PayeeCooling (G0 H6); unknown order → PayeeNotBound; untrusted order → TAINTED_ACTION", () => {
    expect(reason(fund(0, "30000"), { ...ready(), now: T0 + 60n })).toBe("PayeeCooling");
    expect(reason(fund(0, "30000", trusted("order-zzz", "db")), ready())).toBe("PayeeNotBound");
    expect(reason(fund(0, "30000", untrusted("order-a-001", "reader:email")), ready())).toBe("TAINTED_ACTION");
  });
});

describe("TIGHTEN (agent alone) vs LOOSEN (founder + lender + timelock)", () => {
  const tighten = (action: string, lineKey?: string, newValue?: string, origin = { trust: "trusted", sensitivity: "public" }) =>
    ({ kind: "TIGHTEN", origin, action, ...(lineKey ? { lineKey: trusted(lineKey, "plan") } : {}), ...(newValue ? { newValue: trusted(newValue, "policy") } : {}) }) as PolicyProposal;

  it.each([
    ["lower a per-payment cap", tighten("LOWER_PER_TX_CAP", "ADS", "10000"), "AUTO", "TIGHTEN_OK"],
    ["'lower' a cap upwards (T6)", tighten("LOWER_PER_TX_CAP", "ADS", "30001"), "DENY", "NotOwner"],
    ["lower a window cap", tighten("LOWER_WINDOW_CAP", "ADS", "60000"), "AUTO", "TIGHTEN_OK"],
    ["raise the reserve", tighten("RAISE_RESERVE_BPS", undefined, "600"), "AUTO", "TIGHTEN_OK"],
    ["lower the reserve", tighten("RAISE_RESERVE_BPS", undefined, "400"), "DENY", "NotOwner"],
    ["reserve above 100%", tighten("RAISE_RESERVE_BPS", undefined, "10001"), "DENY", "NotOwner"],
    ["pause a line", tighten("PAUSE_LINE", "ADS"), "AUTO", "TIGHTEN_OK"],
    ["revoke its own key", tighten("REVOKE_AGENT"), "AUTO", "TIGHTEN_OK"],
    ["tighten triggered by a listing", tighten("PAUSE", undefined, undefined, UNTRUSTED_PUBLIC), "DENY", "TAINTED_ACTION"],
  ])("%s → %s %s", (_name, p, verdict, code) => {
    expect([decide(p).verdict, decide(p).reasonCode]).toEqual([verdict, code]);
  });

  it("pausing is allowed while paused; untrusted values may only tighten", () => {
    expect(decide(tighten("PAUSE"), { ...ctxDay1(), paused: true }).verdict).toBe("AUTO");
    const p = { ...(tighten("LOWER_PER_TX_CAP", "ADS") as object), newValue: untrusted("5000", "reader:invoice") } as PolicyProposal;
    expect(decide(p).verdict).toBe("AUTO");
  });

  const loosen = (request: object, origin = { trust: "trusted", sensitivity: "public" }) => ({ kind: "LOOSEN", origin, request }) as PolicyProposal;

  it("a valid cap raise becomes a NEEDS_OFFICER exception (both signatures + timelock)", () => {
    const ctx = withLineState(ctxDay1(), "ADS", { perTxCapMinor: "10000" });
    expect(decide(loosen({ kind: "RAISE_CAP", lineKey: "ADS", cap: "perTx", newCapMinor: trusted("25000", "founder") }), ctx)).toEqual({
      verdict: "NEEDS_OFFICER",
      reasonCode: "LOOSEN_NEEDS_BOTH_SIGS",
      mirrorsRevert: false,
      exceptionKind: "RAISE_CAP",
    });
  });

  it("a raise past 25% / 50% is refused before any human sees it (executeLoosen re-check)", () => {
    const d = decide(loosen({ kind: "RAISE_CAP", lineKey: "ADS", cap: "perTx", newCapMinor: trusted("30001", "founder") }));
    expect([d.reasonCode, d.constitutionCode]).toEqual(["PlanInvariantViolated", "PER_TX_CAP_OVER_25PCT"]);
    expect(reason(loosen({ kind: "RAISE_CAP", lineKey: "ADS", cap: "window", newCapMinor: trusted("60001", "founder") }))).toBe("PlanInvariantViolated");
    expect(reason(loosen({ kind: "RAISE_CAP", lineKey: "ADS", cap: "perTx", newCapMinor: trusted("30000", "founder") }))).toBe("NOT_A_LOOSENING");
  });

  it("untrusted values never raise a cap, extend an expiry, move money or name a payee (T12)", () => {
    expect(reason(loosen({ kind: "RAISE_CAP", lineKey: "ADS", cap: "perTx", newCapMinor: untrusted("25000", "web:tax-page") }))).toBe("TAINTED_CAP");
    expect(reason(loosen({ kind: "EXTEND_EXPIRY", target: "agent", newExpiresAt: untrusted("1797292801", "web") }))).toBe("TAINTED_CAP");
    expect(reason(loosen({ kind: "MOVE_POCKETS", fromLineKey: "CONTINGENCY", toLineKey: "ADS", amountMinor: untrusted("1", "web") }))).toBe("TAINTED_CAP");
    expect(reason(loosen({ kind: "ADD_PAYEE", lineKey: "PACKAGING", payeeId: untrusted("evil-payee", "reader:email") }))).toBe("TAINTED_PAYEE");
    expect(reason(loosen({ kind: "UNPAUSE" }, UNTRUSTED_PUBLIC))).toBe("TAINTED_ACTION");
  });

  it("expiry past now + 90 days → PlanInvariantViolated", () => {
    const d = decide(loosen({ kind: "EXTEND_EXPIRY", target: "line", lineKey: "ADS", newExpiresAt: trusted(String(T0 + DAY + 90n * DAY + 1n), "founder") }));
    expect([d.reasonCode, d.constitutionCode]).toEqual(["PlanInvariantViolated", "LINE_VALIDITY_TOO_LONG"]);
  });

  it("moving money keeps the source line's caps within 25%/50% of what is left", () => {
    const move = loosen({ kind: "MOVE_POCKETS", fromLineKey: "CONTINGENCY", toLineKey: "ADS", amountMinor: trusted("20000", "founder") });
    expect(reason(move)).toBe("PlanInvariantViolated"); // caps 25,000 / 50,000 > 25% / 50% of 80,000
    const tightened = withLineState(ctxDay1(), "CONTINGENCY", { perTxCapMinor: "20000", windowCapMinor: "40000" });
    expect(decide(move, tightened).verdict).toBe("NEEDS_OFFICER");
    expect(reason(loosen({ kind: "MOVE_POCKETS", fromLineKey: "CONTINGENCY", toLineKey: "ADS", amountMinor: trusted("100001", "founder") }))).toBe("CapExceeded");
  });

  it("reserve withdrawal: within the reserve → NEEDS_OFFICER; above it → CapExceeded; ADD_PAYEE and UNPAUSE → NEEDS_OFFICER", () => {
    const w = (amount: string) => loosen({ kind: "WITHDRAW_RESERVE", amountMinor: trusted(amount, "founder"), taxPayeeId: trusted("lhdn-tax", "registry") });
    const tax = { payeeId: "lhdn-tax", source: "platform", lineKeys: [], paidMinor: "0" } as const;
    const ctx = { ...ctxDay1(), reserveMinor: "5000", payees: [...ctxDay1().payees, tax] };
    expect(decide(w("5000"), ctx).exceptionKind).toBe("WITHDRAW_RESERVE");
    expect(reason(w("5001"), ctx)).toBe("CapExceeded");
    expect(decide(loosen({ kind: "ADD_PAYEE", lineKey: "PACKAGING", payeeId: trusted("printer-kl", "founder") })).verdict).toBe("NEEDS_OFFICER");
    expect(decide(loosen({ kind: "UNPAUSE" })).exceptionKind).toBe("UNPAUSE");
  });
});

describe("releases, replans and direct calls", () => {
  const origin = { trust: "trusted", sensitivity: "public" } as const;
  const release = (idx: number, evidenceHash?: string) =>
    ({ kind: "RELEASE_MILESTONE", origin, orderId: "order-a-001", idx, ...(evidenceHash ? { evidenceHash } : {}) }) as PolicyProposal;
  const funded = (): PolicyContext => ({
    ...ctxWithSupplier(),
    escrowOrders: [{ ...ORDER_A, milestones: ORDER_A.milestones.map((m) => ({ ...m, fundedMinor: m.amountMinor })) }],
  });

  it("balance release: unfunded or auto → MilestoneLocked; no inspection evidence → EvidenceMissing; else NEEDS_FOUNDER", () => {
    expect(reason(release(2, `0x${"ab".repeat(32)}`), ctxWithSupplier())).toBe("MilestoneLocked");
    expect(reason(release(0), funded())).toBe("MilestoneLocked");
    expect(reason(release(2), funded())).toBe("EvidenceMissing");
    expect(decide(release(2, `0x${"ab".repeat(32)}`), funded())).toMatchObject({ verdict: "NEEDS_FOUNDER", exceptionKind: "RELEASE_ESCROW_BALANCE" });
  });

  it("stage 2: gate met by the deadline → NEEDS_OFFICER; short, late or released → CapExceeded (as releaseStage reverts); untrusted sales → TAINTED_CAP", () => {
    const stage = (sales: string, label: Labeled<string> = trusted(sales, "oracle")) => ({ kind: "RELEASE_STAGE", origin, stageId: "stage-2", salesMinor: label }) as PolicyProposal;
    expect(decide(stage("200000"))).toMatchObject({ verdict: "NEEDS_OFFICER", exceptionKind: "RELEASE_STAGE" });
    expect(reason(stage("199999"))).toBe("CapExceeded");
    expect(reason(stage("200000"), { ...ctxDay1(), now: T0 + 31n * DAY })).toBe("CapExceeded");
    expect(reason(stage("200000", untrusted("200000", "webhook:unverified")))).toBe("TAINTED_CAP");
    expect(reason({ kind: "RELEASE_STAGE", origin, stageId: "stage-1", salesMinor: trusted("0", "oracle") })).toBe("CapExceeded");
  });

  describe("replan (founder-only, so tighten-only: G0-AUDIT v-1)", () => {
    const v2Of = (patch: (m: PlanManifest) => PlanManifest, base: PlanManifest = RINA_MANIFEST) => ({
      ...RINA_DRAFT,
      draftId: "draft-rina-002",
      manifest: patch({ ...base, version: 2, prevPlanHash: RINA_PLAN_HASH }),
    });
    const lowerAdsCaps = (m: PlanManifest): PlanManifest => ({
      ...m,
      lines: m.lines.map((l) => (l.lineKey === "ADS" ? { ...l, perTxCapMinor: "20000", windowCapMinor: "40000" } : l)),
    });
    const replan = (draft: ReturnType<typeof v2Of>) => ({ kind: "REPLAN", origin, draft }) as PolicyProposal;
    const loosens = { verdict: "DENY", reasonCode: "PlanInvariantViolated", mirrorsRevert: true, constitutionCode: "REPLAN_LOOSENS" };

    it("the frozen REPLAN example (lower the ADS caps) → NEEDS_FOUNDER (REPLAN)", () => {
      expect(decide(replan(v2Of(lowerAdsCaps)))).toMatchObject({ verdict: "NEEDS_FOUNDER", reasonCode: "FOUNDER_SIGNATURE_REQUIRED", exceptionKind: "REPLAN" });
    });

    it("a loosening re-commit → DENY PlanInvariantViolated(REPLAN_LOOSENS), never NEEDS_FOUNDER", () => {
      const current = committedPlanOf(RINA_MANIFEST, RINA_PLAN_HASH);
      const ids = { ...RINA_COMPILE_INPUT.ids, version: 2, prevPlanHash: RINA_PLAN_HASH };
      const redrafted = compilePlan({ ...RINA_COMPILE_INPUT, now: T0 + DAY, ids, current, currentIntent: RINA_COMPILE_INPUT.intent });
      expect(decide({ kind: "REPLAN", origin, draft: redrafted })).toMatchObject({ verdict: "NEEDS_FOUNDER", exceptionKind: "REPLAN" }); // same intent: tighten-only
      const longer = compilePlan({ ...RINA_COMPILE_INPUT, intent: { ...RINA_COMPILE_INPUT.intent, horizonDays: 90 }, now: T0 + DAY, ids, current, currentIntent: RINA_COMPILE_INPUT.intent });
      expect(decide({ kind: "REPLAN", origin, draft: longer })).toEqual(loosens); // a longer horizon: later validUntil
      const raise = v2Of((m) => ({ ...m, lines: m.lines.map((l) => (l.lineKey === "ADS" ? { ...l, perTxCapMinor: "30000" } : l)) }));
      expect(decide(replan(raise), withLineState(ctxDay1(), "ADS", { perTxCapMinor: "20000" }))).toEqual(loosens); // undoes a tighten
      expect(decide(replan(v2Of((m) => m)), { ...ctxDay1(), reserveBps: 700 })).toEqual(loosens); // undoes TIGHTEN_RAISE_RESERVE_BPS
      const move = v2Of((m) => ({
        ...m,
        lines: m.lines.map((l) =>
          l.lineKey === "PACKAGING" ? { ...l, amountMinor: "140000", perTxCapMinor: "35000", windowCapMinor: "70000" } : l.lineKey === "ADS" ? { ...l, amountMinor: "130000" } : l,
        ),
      }));
      expect(decide(replan(move))).toEqual(loosens); // the old "shift budget from PACKAGING to ADS" is MOVE_POCKETS
    });

    it("StalePlan unless it is exactly the next version of the same plan series", () => {
      expect(reason(replan({ ...RINA_DRAFT, manifest: RINA_MANIFEST }))).toBe("StalePlan"); // re-signed version 1
      expect(reason(replan(v2Of((m) => ({ ...m, version: 3 }))))).toBe("StalePlan");
      expect(reason(replan(v2Of((m) => ({ ...m, prevPlanHash: `0x${"0".repeat(64)}` }))))).toBe("StalePlan");
      expect(reason(replan(v2Of((m) => ({ ...m, planId: `0x${"ab".repeat(32)}` }))))).toBe("StalePlan");
    });

    it("codes 1-13 are reported before code 14 (T21: a malicious draft reverts with its first code)", () => {
      expect(decide(replan(v2Of((m) => ({ ...m, reserveBps: 0 }))))).toMatchObject({ verdict: "DENY", reasonCode: "PlanInvariantViolated", constitutionCode: "RESERVE_BELOW_FLOOR" });
    });

    it("compares with the current on-chain state: executed loosens and payees bound since are kept", () => {
      const supplier = v2Of((m) => ({ ...m, lines: m.lines.map((l) => (l.lineKey === "SUPPLIER" ? { ...l, payeeIds: ["supplier-a"] } : l)) }));
      expect(decide(replan(supplier), ctxWithSupplier()).verdict).toBe("NEEDS_FOUNDER");
      expect(decide(replan(supplier)).constitutionCode).toBe("PLAN_ADDS_PAYEE"); // not bound yet
      const extended = String(BigInt(RINA_MANIFEST.lines[3]!.validUntil) + DAY);
      const ctx = withLineState(ctxDay1(), "ADS", { validUntil: extended }); // LOOSEN_EXTEND_LINE_EXPIRY executed
      const keep = v2Of((m) => ({ ...m, lines: m.lines.map((l) => (l.lineKey === "ADS" ? { ...l, validUntil: extended } : l)) }));
      expect(decide(replan(keep), ctx).verdict).toBe("NEEDS_FOUNDER");
    });

    it("fails closed when the mirror lacks a line's on-chain state", () => {
      const ctx = ctxDay1();
      const { CONTINGENCY: _gone, ...lines } = ctx.lines;
      expect(decide(replan(v2Of((m) => m)), { ...ctx, lines })).toEqual(loosens);
    });
  });

  it.each(DIRECT_CALLS.map((fn) => [fn, DIRECT_CALL_REVERT[fn]] as const))("agent calls %s → DENY %s (mirrors the revert)", (fn, code) => {
    expect(decide({ kind: "DIRECT_CALL", origin, fn })).toEqual({ verdict: "DENY", reasonCode: code, mirrorsRevert: true });
  });

  it("maps the §13.2 rows: T2/T6 NotOwner, T5 MilestoneLocked, T8 ReserveLocked, T9 TimelockActive, T23 NotLender, T24 NotOracle", () => {
    expect([DIRECT_CALL_REVERT.bindPayee, DIRECT_CALL_REVERT.commitPlan, DIRECT_CALL_REVERT.releaseMilestone]).toEqual(["NotOwner", "NotOwner", "MilestoneLocked"]);
    expect([DIRECT_CALL_REVERT.withdrawReserve, DIRECT_CALL_REVERT.executeLoosen, DIRECT_CALL_REVERT.releaseStage, DIRECT_CALL_REVERT.recordSale]).toEqual([
      "ReserveLocked",
      "TimelockActive",
      "NotLender",
      "NotOracle",
    ]);
  });
});
