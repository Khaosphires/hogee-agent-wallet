/**
 * Replans in the compiler (G0-AUDIT v-1): a draft that replaces the committed plan is numbered as the next CAS
 * step and checked against it (code 14), and routeReplan splits a loosening draft into the lender-co-signed
 * LOOSEN_* exceptions it needs (plus what no kind can do).
 */
import { describe, expect, it } from "vitest";
import {
  CompileError,
  ExceptionPayloads,
  committedPlanOf,
  compilePlan,
  constitutionOk,
  constitutionViolations,
  fakeAddress,
  fakeHex32,
  replanLoosenings,
  rinaSupplierABinding,
  routeReplan,
  type CommittedPlan,
  type PlanLine,
  type PlanManifest,
} from "../src/index";
import { DAY, RINA_MANIFEST, RINA_PLAN_HASH, T0 } from "./fixtures/policy-ctx";
import { applyLoosens, withCurrentLine } from "./fixtures/replan";
import { RINA_COMPILE_INPUT } from "./fixtures/rina-compile";

const V1 = committedPlanOf(RINA_MANIFEST, RINA_PLAN_HASH);
const next = (m: PlanManifest, current: CommittedPlan = V1): PlanManifest => ({ ...m, version: current.version + 1, prevPlanHash: current.planHash });
const withLine = (m: PlanManifest, key: string, patch: Partial<PlanLine>): PlanManifest => ({
  ...m,
  lines: m.lines.map((l) => (l.lineKey === key ? { ...l, ...patch } : l)),
});
const codeOf = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    return e instanceof CompileError ? e.code : `not a CompileError: ${String(e)}`;
  }
  return undefined;
};

/** Every routed request is a valid exception payload, and after executing them only `unsupported` remains. */
function expectSound(m: PlanManifest, current: CommittedPlan): ReturnType<typeof routeReplan> {
  const route = routeReplan(m, current);
  for (const r of route.loosens) expect(ExceptionPayloads[r.kind].safeParse(r.payload).success).toBe(true);
  expect(replanLoosenings(m, applyLoosens(current, route.loosens))).toEqual(route.unsupported);
  expect(route.tightenOnly).toBe(route.loosens.length === 0 && route.unsupported.length === 0);
  return route;
}

describe("compilePlan with the committed plan (a replan)", () => {
  it("numbers the draft as the next CAS step of the same plan series", () => {
    const d = compilePlan({ ...RINA_COMPILE_INPUT, current: V1 });
    expect([d.manifest.planId, d.manifest.version, d.manifest.prevPlanHash]).toEqual([RINA_MANIFEST.planId, 2, RINA_PLAN_HASH]);
    expect(d.constitutionReport).toHaveLength(14);
  });

  it("same intent, same clock → identical on-chain values: every code passes", () => {
    const d = compilePlan({ ...RINA_COMPILE_INPUT, current: V1 });
    expect(constitutionOk(d.constitutionReport)).toBe(true);
    expect(routeReplan(d.manifest, V1)).toEqual({ tightenOnly: true, loosens: [], unsupported: [] });
  });

  it("the same intent redrafted a day later: the tighten-only form of v1, every code passes (code 14 included)", () => {
    for (const currentIntent of [RINA_COMPILE_INPUT.intent, undefined]) {
      const d = compilePlan({ ...RINA_COMPILE_INPUT, now: String(T0 + DAY), current: V1, ...(currentIntent ? { currentIntent } : {}) });
      expect(constitutionOk(d.constitutionReport)).toBe(true);
      expect(routeReplan(d.manifest, V1)).toEqual({ tightenOnly: true, loosens: [], unsupported: [] });
      // Expiries, the stage gate and every on-chain value stay as committed (a fresh compile re-dates them a day later).
      expect(committedPlanOf(d.manifest, V1.planHash)).toEqual({ ...V1, version: 2 });
      expect(d.manifest.rules.map((r) => r.ruleId)).toContain("replan.current-state");
    }
  });

  it("redrafted after runtime changes: tightened caps, a raised reserve and an executed MOVE_POCKETS are kept", () => {
    let current = withCurrentLine(V1, "ADS", { perTxCapMinor: "20000", windowCapMinor: "40000" });
    current = withCurrentLine(current, "PACKAGING", { amountMinor: "130000", perTxCapMinor: "30000", windowCapMinor: "60000" });
    current = { ...withCurrentLine(current, "LOGISTICS", { amountMinor: "100000" }), reserveBps: 700 };
    const d = compilePlan({ ...RINA_COMPILE_INPUT, now: String(T0 + 7n * DAY), current, currentIntent: RINA_COMPILE_INPUT.intent });
    expect(constitutionOk(d.constitutionReport)).toBe(true);
    expect(committedPlanOf(d.manifest, current.planHash)).toEqual({ ...current, version: 2 });
  });

  it("an intent that moves budget a day later: only REPLAN_LOOSENS, routed to MOVE_POCKETS then RAISE_CAP (no expiry or stage loosening)", () => {
    const d = compilePlan({ ...RINA_COMPILE_INPUT, intent: { ...RINA_COMPILE_INPUT.intent, lineEmphasis: {} }, now: String(T0 + DAY), current: V1, currentIntent: RINA_COMPILE_INPUT.intent });
    expect(constitutionViolations(d.constitutionReport)).toEqual(["REPLAN_LOOSENS"]);
    const route = expectSound(d.manifest, V1);
    expect(route).toEqual({
      tightenOnly: false,
      loosens: [
        { kind: "MOVE_POCKETS", payload: { fromLineKey: "SUPPLIER", toLineKey: "CONTINGENCY", amountMinor: "50000" } },
        { kind: "RAISE_CAP", payload: { lineKey: "CONTINGENCY", cap: "perTx", newCapMinor: "37500" } },
        { kind: "RAISE_CAP", payload: { lineKey: "CONTINGENCY", cap: "window", newCapMinor: "75000" } },
      ],
      unsupported: [],
    });
  });

  it("a cap raise on a line the agent tightened raises it by the intent's increase only", () => {
    const current = withCurrentLine(V1, "CONTINGENCY", { perTxCapMinor: "20000" });
    const d = compilePlan({ ...RINA_COMPILE_INPUT, intent: { ...RINA_COMPILE_INPUT.intent, lineEmphasis: {} }, now: String(T0 + DAY), current, currentIntent: RINA_COMPILE_INPUT.intent });
    expect(expectSound(d.manifest, current).loosens).toContainEqual({ kind: "RAISE_CAP", payload: { lineKey: "CONTINGENCY", cap: "perTx", newCapMinor: "32500" } });
  });

  it("a longer horizon extends every expiry by the extra days (EXTEND_EXPIRY); a shorter one is tighten-only; the stage gate stays", () => {
    const at = (horizonDays: 30 | 90) => compilePlan({ ...RINA_COMPILE_INPUT, intent: { ...RINA_COMPILE_INPUT.intent, horizonDays }, now: String(T0 + DAY), current: V1, currentIntent: RINA_COMPILE_INPUT.intent });
    const longer = at(90);
    expect(constitutionViolations(longer.constitutionReport)).toEqual(["REPLAN_LOOSENS"]);
    const route = expectSound(longer.manifest, V1);
    expect(route.unsupported).toEqual([]);
    expect(route.loosens).toHaveLength(V1.lines.length + 1);
    expect(route.loosens).toContainEqual({ kind: "EXTEND_EXPIRY", payload: { target: "line", lineKey: "ADS", newExpiresAt: String(T0 + 90n * DAY) } });
    expect(route.loosens).toContainEqual({ kind: "EXTEND_EXPIRY", payload: { target: "agent", newExpiresAt: String(BigInt(V1.agent.expiresAt) + 30n * DAY) } });
    const shorter = at(30);
    expect(constitutionOk(shorter.constitutionReport)).toBe(true);
    expect(shorter.manifest.lines.every((l) => l.validUntil === String(T0 + 30n * DAY))).toBe(true);
    expect([longer.manifest.stages, shorter.manifest.stages]).toEqual([V1.stages, V1.stages]);
  });

  it("a supplier bound since v1 is listed iff the chain counts it on the line (signed binding); a new channel's payee is ADD_PAYEE", () => {
    const facility = { ...RINA_COMPILE_INPUT.facility, payees: [...RINA_COMPILE_INPUT.facility.payees, rinaSupplierABinding(T0)] };
    const input = { ...RINA_COMPILE_INPUT, facility, now: String(T0 + DAY), currentIntent: RINA_COMPILE_INPUT.intent };
    const bound = withCurrentLine(V1, "SUPPLIER", { payeeIds: ["supplier-a"] });
    const listed = compilePlan({ ...input, current: bound });
    expect(constitutionOk(listed.constitutionReport)).toBe(true);
    expect(listed.manifest.lines.find((l) => l.lineKey === "SUPPLIER")?.payeeIds).toEqual(["supplier-a"]);
    const unbound = compilePlan({ ...input, current: V1 }); // not bound on-chain (yet): not listed, still tighten-only
    expect(constitutionOk(unbound.constitutionReport)).toBe(true);
    expect(unbound.manifest.lines.find((l) => l.lineKey === "SUPPLIER")?.payeeIds).toEqual([]);
    const lazada = { ...facility, payees: [...facility.payees, { payeeId: "lazada-ads", source: "platform" as const, lineKeys: ["ADS" as const], channels: ["lazada" as const] }] };
    const moved = compilePlan({ ...input, facility: lazada, intent: { ...RINA_COMPILE_INPUT.intent, sellChannel: "lazada" }, current: bound });
    expect(constitutionViolations(moved.constitutionReport)).toEqual(["REPLAN_LOOSENS"]);
    expect(expectSound(moved.manifest, bound)).toEqual({ tightenOnly: false, loosens: [{ kind: "ADD_PAYEE", payload: { payeeId: "lazada-ads", lineKey: "ADS" } }], unsupported: [] });
  });

  it("a different plan series or a version that does not follow → INVALID_INPUT (StalePlan)", () => {
    expect(codeOf(() => compilePlan({ ...RINA_COMPILE_INPUT, ids: { ...RINA_COMPILE_INPUT.ids, planId: fakeHex32("other") }, current: V1 }))).toBe("INVALID_INPUT");
    expect(codeOf(() => compilePlan({ ...RINA_COMPILE_INPUT, ids: { ...RINA_COMPILE_INPUT.ids, version: 3 }, current: V1 }))).toBe("INVALID_INPUT");
    expect(codeOf(() => compilePlan({ ...RINA_COMPILE_INPUT, ids: { ...RINA_COMPILE_INPUT.ids, version: 2, prevPlanHash: fakeHex32("x") }, current: V1 }))).toBe("INVALID_INPUT");
    expect(codeOf(() => compilePlan({ ...RINA_COMPILE_INPUT, ids: { ...RINA_COMPILE_INPUT.ids, version: 2, prevPlanHash: RINA_PLAN_HASH }, current: V1 }))).toBeUndefined();
  });

});

describe("routeReplan", () => {
  it("the frozen REPLAN example (lower the ADS caps) is tighten-only: the founder signs it alone", () => {
    expect(expectSound(next(withLine(RINA_MANIFEST, "ADS", { perTxCapMinor: "20000", windowCapMinor: "40000" })), V1)).toEqual({ tightenOnly: true, loosens: [], unsupported: [] });
  });

  it("cap raises above the current (tightened) caps → RAISE_CAP perTx / window", () => {
    const current = withCurrentLine(V1, "ADS", { perTxCapMinor: "20000", windowCapMinor: "40000" });
    expect(expectSound(next(RINA_MANIFEST, current), current).loosens).toEqual([
      { kind: "RAISE_CAP", payload: { lineKey: "ADS", cap: "perTx", newCapMinor: "30000" } },
      { kind: "RAISE_CAP", payload: { lineKey: "ADS", cap: "window", newCapMinor: "60000" } },
    ]);
  });

  it("a new payee on a line → ADD_PAYEE for that line", () => {
    expect(expectSound(next(withLine(RINA_MANIFEST, "PACKAGING", { payeeIds: ["printer-kl"] })), V1).loosens).toEqual([
      { kind: "ADD_PAYEE", payload: { payeeId: "printer-kl", lineKey: "PACKAGING" } },
    ]);
  });

  it("budget moves are paired greedily in stored line order", () => {
    let m = withLine(RINA_MANIFEST, "SUPPLIER", { amountMinor: "480000", perTxCapMinor: "120000", windowCapMinor: "240000" });
    m = withLine(m, "PACKAGING", { amountMinor: "140000", perTxCapMinor: "35000", windowCapMinor: "70000" });
    m = withLine(m, "LOGISTICS", { amountMinor: "85000" });
    m = withLine(m, "ADS", { amountMinor: "145000" });
    expect(expectSound(next(m), V1).loosens).toEqual([
      { kind: "MOVE_POCKETS", payload: { fromLineKey: "SUPPLIER", toLineKey: "LOGISTICS", amountMinor: "5000" } },
      { kind: "MOVE_POCKETS", payload: { fromLineKey: "SUPPLIER", toLineKey: "ADS", amountMinor: "15000" } },
      { kind: "MOVE_POCKETS", payload: { fromLineKey: "PACKAGING", toLineKey: "ADS", amountMinor: "10000" } },
    ]);
  });

  it("loosenings with no LOOSEN_* kind are unsupported (new additive kind or new deployment)", () => {
    let m = withLine(RINA_MANIFEST, "ADS", { pacing: { period: "day", amountMinor: "8000" }, windowSeconds: String(6n * DAY) });
    m = { ...m, reserveBps: 400, agent: { ...m.agent, address: fakeAddress("agent:new") } };
    const route = expectSound(next(m), { ...V1, reserveBps: 500 });
    expect(route.loosens).toEqual([]);
    expect(route.unsupported.map((u) => u.rule)).toEqual(["RESERVE_LOWERED", "AGENT_CHANGED", "WINDOW_SHORTENED", "PACING_RAISED"]);
  });

  it("an amount change MOVE_POCKETS cannot balance (total changed) stays unsupported for the leftover", () => {
    const m = { ...withLine(RINA_MANIFEST, "CONTINGENCY", { amountMinor: "90000", perTxCapMinor: "22500", windowCapMinor: "45000" }), totalMinor: "990000" };
    const route = expectSound(next(m), V1);
    expect(route.loosens).toEqual([]);
    expect(route.unsupported).toEqual([
      { rule: "TOTAL_CHANGED", current: "1000000", proposed: "990000" },
      { rule: "AMOUNT_CHANGED", lineKey: "CONTINGENCY", current: "100000", proposed: "90000" },
    ]);
  });
});
