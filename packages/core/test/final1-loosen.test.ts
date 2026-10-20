/**
 * Parity with TreasuryGovernance / TreasuryLoosenRules (final-1, docs/assurance/require-table-final1.md): each
 * loosen kind's rules in `_checkLoosen` order, the live-queue bound, executeLoosen's timelock and grace period, and
 * the agent's direct calls. A DENY names the error queueLoosen / executeLoosen would revert with.
 */
import { describe, expect, it } from "vitest";
import {
  DIRECT_CALL_REVERT,
  LOOSEN_GRACE_SECONDS,
  MAX_QUEUED_LOOSENS,
  ZERO_HEX32,
  evaluateProposal,
  fakeHex32,
  trusted,
  untrusted,
  type LoosenRequestIn,
  type PolicyContext,
  type PolicyDecision,
  type PolicyProposal,
  type PolicyQueuedLoosen,
} from "../src/index";
import { ctxDay1, ctxWithSupplier, DAY, T0, withLineState } from "./fixtures/policy-ctx";

const origin = { trust: "trusted", sensitivity: "public" } as const;
const loosen = (request: LoosenRequestIn): PolicyProposal => ({ kind: "LOOSEN", origin, request });
const decide = (request: LoosenRequestIn, ctx: PolicyContext = ctxDay1()): PolicyDecision => evaluateProposal(loosen(request), ctx);
const mirrored = (reasonCode: string, constitutionCode?: string) => ({
  verdict: "DENY",
  reasonCode,
  mirrorsRevert: true,
  ...(constitutionCode ? { constitutionCode } : {}),
});
const founder = <T>(v: T) => trusted(v, "founder");
const NOW = T0 + DAY;
const HASH = fakeHex32("test:payout:printer");

describe("MOVE_POCKETS (_checkMove)", () => {
  const move = (from: string, to: string, amount: string) => ({ kind: "MOVE_POCKETS", fromLineKey: from, toLineKey: to, amountMinor: founder(amount) }) as LoosenRequestIn;
  const roomy = () => withLineState(ctxDay1(), "CONTINGENCY", { perTxCapMinor: "20000", windowCapMinor: "40000" });

  it("same line or a zero amount → PlanInvariantViolated(13), before the line checks", () => {
    expect(decide(move("ADS", "ADS", "1000"))).toEqual(mirrored("PlanInvariantViolated", "MALFORMED_PLAN"));
    expect(decide(move("CONTINGENCY", "ADS", "0"))).toEqual(mirrored("PlanInvariantViolated", "MALFORMED_PLAN"));
    expect(decide(move("LICENSING", "LICENSING", "1000"))).toEqual(mirrored("PlanInvariantViolated", "MALFORMED_PLAN"));
  });

  it("either line outside the plan → LineExpired; more than the unspent, unescrowed balance → CapExceeded", () => {
    expect(decide(move("LICENSING", "ADS", "1000"))).toEqual(mirrored("LineExpired"));
    expect(decide(move("CONTINGENCY", "LICENSING", "1000"))).toEqual(mirrored("LineExpired"));
    expect(decide(move("CONTINGENCY", "ADS", "60001"), withLineState(roomy(), "CONTINGENCY", { spentMinor: "30000", escrowedMinor: "10000" }))).toEqual(mirrored("CapExceeded"));
  });

  it("the from-line's per-tx cap above 25% of what is left → code 4; its window cap above 50% → code 5", () => {
    expect(decide(move("CONTINGENCY", "ADS", "20000"))).toEqual(mirrored("PlanInvariantViolated", "PER_TX_CAP_OVER_25PCT"));
    const perTxOk = withLineState(ctxDay1(), "CONTINGENCY", { perTxCapMinor: "20000" });
    expect(decide(move("CONTINGENCY", "ADS", "20000"), perTxOk)).toEqual(mirrored("PlanInvariantViolated", "WINDOW_CAP_OVER_50PCT"));
    expect(decide(move("CONTINGENCY", "ADS", "20000"), roomy())).toMatchObject({ verdict: "NEEDS_OFFICER", exceptionKind: "MOVE_POCKETS" });
  });
});

describe("ADD_PAYEE (direct-pay lines only; never a platform payee)", () => {
  const add = (lineKey: string, payeeId: string, payoutAccountHash?: string) =>
    ({ kind: "ADD_PAYEE", lineKey, payeeId: founder(payeeId), ...(payoutAccountHash ? { payoutAccountHash } : {}) }) as LoosenRequestIn;

  it("a zero payee id or payout hash → code 13, before every line check", () => {
    expect(decide(add("PACKAGING", "", HASH))).toEqual(mirrored("PlanInvariantViolated", "MALFORMED_PLAN"));
    expect(decide(add("PACKAGING", "printer-kl", ZERO_HEX32))).toEqual(mirrored("PlanInvariantViolated", "MALFORMED_PLAN"));
    expect(decide(add("SUPPLIER", "", HASH))).toEqual(mirrored("PlanInvariantViolated", "MALFORMED_PLAN"));
  });

  it("a line outside the plan or past validUntil → LineExpired", () => {
    expect(decide(add("LICENSING", "printer-kl", HASH))).toEqual(mirrored("LineExpired"));
    expect(decide(add("PACKAGING", "printer-kl", HASH), withLineState(ctxDay1(), "PACKAGING", { validUntil: String(T0) }))).toEqual(mirrored("LineExpired"));
  });

  it("the escrow line → code 10 (suppliers come from SupplierApproval); a static platform payee → code 11", () => {
    expect(decide(add("SUPPLIER", "printer-kl", HASH))).toEqual(mirrored("PlanInvariantViolated", "SUPPLIER_LINE_NOT_ESCROW"));
    expect(decide(add("PACKAGING", "shopee-ads", HASH))).toEqual(mirrored("PlanInvariantViolated", "PAYEE_CAP_OVER_SCHEDULE"));
    expect(decide(add("SUPPLIER", "shopee-ads", HASH)).constitutionCode).toBe("SUPPLIER_LINE_NOT_ESCROW");
    expect(decide(add("PACKAGING", "printer-kl", HASH))).toMatchObject({ verdict: "NEEDS_OFFICER", exceptionKind: "ADD_PAYEE" });
  });
});

describe("EXTEND_EXPIRY", () => {
  const agent = (at: bigint) => ({ kind: "EXTEND_EXPIRY", target: "agent", newExpiresAt: founder(String(at)) }) as LoosenRequestIn;
  const line = (lineKey: string | undefined, at: bigint) =>
    ({ kind: "EXTEND_EXPIRY", target: "line", ...(lineKey ? { lineKey } : {}), newExpiresAt: founder(String(at)) }) as LoosenRequestIn;
  const latest = NOW + 90n * DAY;

  it("agent (target 0): needs a committed plan (StalePlan), then ≤ now + 90 days (code 2)", () => {
    expect(decide(agent(latest), { ...ctxDay1(), planVersion: 0 })).toEqual(mirrored("StalePlan"));
    expect(decide(agent(latest + 1n), { ...ctxDay1(), planVersion: 0 })).toEqual(mirrored("StalePlan"));
    expect(decide(agent(latest + 1n))).toEqual(mirrored("PlanInvariantViolated", "AGENT_EXPIRY_TOO_LATE"));
    expect(decide(agent(latest)).verdict).toBe("NEEDS_OFFICER");
  });

  it("line: an active line (an expired one may be extended), then ≤ now + 90 days (code 6)", () => {
    expect(decide(line("LICENSING", latest))).toEqual(mirrored("LineExpired"));
    expect(decide(line(undefined, latest))).toEqual(mirrored("LineExpired"));
    expect(decide(line("LICENSING", latest + 1n))).toEqual(mirrored("LineExpired"));
    const expired = withLineState(ctxDay1(), "ADS", { validUntil: String(T0) });
    expect(decide(line("ADS", latest), expired).verdict).toBe("NEEDS_OFFICER");
  });
});

describe("RAISE_CAP, UNPAUSE, WITHDRAW_RESERVE", () => {
  const TAX = { payeeId: "lhdn-tax", source: "platform", lineKeys: [], paidMinor: "0" } as const;
  const withTax = (ctx: PolicyContext): PolicyContext => ({ ...ctx, payees: [...ctx.payees, TAX] });
  const withdraw = (amount: string, tax = "lhdn-tax") => ({ kind: "WITHDRAW_RESERVE", amountMinor: founder(amount), taxPayeeId: trusted(tax, "registry") }) as LoosenRequestIn;

  it("RAISE_CAP: line outside the plan → LineExpired; a window raise is checked against code 5 only", () => {
    expect(decide({ kind: "RAISE_CAP", lineKey: "LICENSING", cap: "window", newCapMinor: founder("1") })).toEqual(mirrored("LineExpired"));
    expect(decide({ kind: "RAISE_CAP", lineKey: "ADS", cap: "window", newCapMinor: founder("60001") })).toEqual(mirrored("PlanInvariantViolated", "WINDOW_CAP_OVER_50PCT"));
  });

  it("UNPAUSE: a line target must be an active line → else LineExpired; the treasury (target 0) always qualifies", () => {
    expect(decide({ kind: "UNPAUSE", lineKey: "LICENSING" })).toEqual(mirrored("LineExpired"));
    expect(decide({ kind: "UNPAUSE", lineKey: "ADS" }).verdict).toBe("NEEDS_OFFICER");
    expect(decide({ kind: "UNPAUSE" }).verdict).toBe("NEEDS_OFFICER");
  });

  it("WITHDRAW_RESERVE: the tax payee must be a static platform payee (PayeeNotBound), checked before the amount", () => {
    const ctx = withTax({ ...ctxDay1(), reserveMinor: "5000" });
    expect(decide(withdraw("5000", "spx-logistics"), ctx).verdict).toBe("NEEDS_OFFICER"); // any static platform payee
    expect(decide(withdraw("5000", "printer-kl"), ctxWithSupplier())).toEqual(mirrored("PayeeNotBound")); // bound, not platform
    expect(decide(withdraw("0", "nobody"), ctx)).toEqual(mirrored("PayeeNotBound"));
    expect(decide(withdraw("0"), ctx)).toEqual(mirrored("CapExceeded"));
    expect(decide(withdraw("5001"), ctx)).toEqual(mirrored("CapExceeded"));
  });

  it("an unreadable value is an off-chain refusal", () => {
    expect(decide(withdraw("1e3"), withTax(ctxDay1()))).toEqual({ verdict: "DENY", reasonCode: "INVALID_AMOUNT", mirrorsRevert: false });
    expect(decide({ kind: "MOVE_POCKETS", fromLineKey: "CONTINGENCY", toLineKey: "ADS", amountMinor: founder("-1") }).reasonCode).toBe("INVALID_AMOUNT");
  });
});

describe("loosening lifecycle: live-queue bound, timelock, grace period, veto", () => {
  const unpause: LoosenRequestIn = { kind: "UNPAUSE" };
  const entry = (n: number, patch: Partial<PolicyQueuedLoosen> = {}): PolicyQueuedLoosen => ({
    loosenId: fakeHex32(`test:loosen:${n}`),
    request: unpause,
    status: "QUEUED",
    executableAt: String(NOW - 10n),
    expiresAt: String(NOW + 100n),
    ...patch,
  });
  const queue = (n: number, patch: Partial<PolicyQueuedLoosen> = {}) => Array.from({ length: n }, (_, i) => entry(i, patch));
  const execute = (loosenId: string, o = origin): PolicyProposal => ({ kind: "EXECUTE_LOOSEN", origin: o, loosenId }) as PolicyProposal;

  it("16 live loosenings → CapExceeded (after the kind's rules); expired, executed and cancelled ones do not count", () => {
    expect(MAX_QUEUED_LOOSENS).toBe(16);
    expect(decide(unpause, { ...ctxDay1(), loosens: queue(16) })).toEqual(mirrored("CapExceeded"));
    expect(decide({ kind: "UNPAUSE", lineKey: "LICENSING" }, { ...ctxDay1(), loosens: queue(16) })).toEqual(mirrored("LineExpired"));
    expect(decide(unpause, { ...ctxDay1(), loosens: queue(15) }).verdict).toBe("NEEDS_OFFICER");
    const mixed = [...queue(13), entry(20, { expiresAt: String(NOW - 1n) }), entry(21, { status: "EXECUTED" }), entry(22, { status: "CANCELLED" })];
    expect(decide(unpause, { ...ctxDay1(), loosens: mixed }).verdict).toBe("NEEDS_OFFICER");
    expect(decide(unpause, { ...ctxDay1(), loosens: [...queue(15), entry(30, { expiresAt: String(NOW) })] })).toEqual(mirrored("CapExceeded"));
  });

  it("executeLoosen: unknown, not yet executable, executed or cancelled → TimelockActive", () => {
    const ctx = { ...ctxDay1(), loosens: [entry(1, { executableAt: String(NOW + 1n) }), entry(2, { status: "EXECUTED" }), entry(3, { status: "CANCELLED" })] };
    for (const id of [fakeHex32("test:loosen:unknown"), entry(1).loosenId, entry(2).loosenId, entry(3).loosenId]) {
      expect(evaluateProposal(execute(id), ctx)).toEqual(mirrored("TimelockActive"));
    }
  });

  it("executeLoosen: from executableAt to expiresAt inclusive → AUTO; one second later → SignatureExpired", () => {
    expect(LOOSEN_GRACE_SECONDS).toBe(7n * DAY);
    const id = entry(1).loosenId;
    const at = (now: bigint) => evaluateProposal(execute(id), { ...ctxDay1(), now, loosens: [entry(1, { executableAt: String(NOW), expiresAt: String(NOW + LOOSEN_GRACE_SECONDS) })] });
    expect(at(NOW)).toEqual({ verdict: "AUTO", reasonCode: "LOOSEN_EXECUTABLE", mirrorsRevert: false });
    expect(at(NOW + LOOSEN_GRACE_SECONDS).verdict).toBe("AUTO");
    expect(at(NOW + LOOSEN_GRACE_SECONDS + 1n)).toEqual(mirrored("SignatureExpired"));
  });

  it("executeLoosen re-checks the kind's rules at execution time (a drained reserve, a retired line)", () => {
    const tax = { payeeId: "lhdn-tax", source: "platform", lineKeys: [], paidMinor: "0" } as const;
    const w = entry(1, { request: { kind: "WITHDRAW_RESERVE", amountMinor: founder("5000"), taxPayeeId: trusted("lhdn-tax", "registry") } });
    const ctx = { ...ctxDay1(), payees: [...ctxDay1().payees, tax], loosens: [w] };
    expect(evaluateProposal(execute(w.loosenId), { ...ctx, reserveMinor: "5000" }).verdict).toBe("AUTO");
    expect(evaluateProposal(execute(w.loosenId), { ...ctx, reserveMinor: "4999" })).toEqual(mirrored("CapExceeded"));
    const u = entry(2, { request: { kind: "UNPAUSE", lineKey: "LICENSING" } });
    expect(evaluateProposal(execute(u.loosenId), { ...ctxDay1(), loosens: [u] })).toEqual(mirrored("LineExpired"));
  });

  it("an execution triggered by untrusted content is never AUTO", () => {
    const ctx = { ...ctxDay1(), loosens: [entry(1)] };
    expect(evaluateProposal(execute(entry(1).loosenId, { trust: "untrusted", sensitivity: "public" } as never), ctx).verdict).toBe("DENY");
  });

  it("the agent cannot veto (cancelLoosen → NotOwner) or queue (founder signature by the agent → NotOwner)", () => {
    expect(evaluateProposal({ kind: "DIRECT_CALL", origin, fn: "cancelLoosen" }, ctxDay1())).toEqual(mirrored("NotOwner"));
    expect([DIRECT_CALL_REVERT.queueLoosen, DIRECT_CALL_REVERT.ownerSpend, DIRECT_CALL_REVERT.releaseStage, DIRECT_CALL_REVERT.executeLoosen]).toEqual([
      "NotOwner",
      "NotOwner",
      "NotLender",
      "TimelockActive",
    ]);
  });

  it("untrusted loosen values are still refused first (taint before the rules)", () => {
    expect(decide({ kind: "ADD_PAYEE", lineKey: "SUPPLIER", payeeId: untrusted("", "reader:email") }).reasonCode).toBe("TAINTED_PAYEE");
  });
});
