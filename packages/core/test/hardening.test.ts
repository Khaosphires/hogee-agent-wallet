/**
 * Small hardening fixes (security audit run-2, fix 7): prototype keys are not lines, a replan draft needs the plan it
 * replaces, and an unreadable mirrored lifetime cap fails closed.
 */
import { describe, expect, it } from "vitest";
import {
  CompileError,
  RINA_COMMIT_AT,
  RINA_CONSTITUTION_FACILITY,
  RINA_PLATFORM_REGISTRY,
  blastRadius,
  checkConstitution,
  compilePlan,
  constitutionViolations,
  effectiveLifetimeCap,
  evaluateProposal,
  examplePlanManifest,
  fakeHex32,
  planPacingSlot,
  rinaSupplierABinding,
  trusted,
  type LineKey,
  type PolicyProposal,
  type RegistryPayee,
} from "../src/index";
import { ctxDay1, ctxWithSupplier, DAY, PRINTER, T0, spend } from "./fixtures/policy-ctx";
import { RINA_COMPILE_INPUT } from "./fixtures/rina-compile";

const TRUSTED = { trust: "trusted", sensitivity: "public" } as const;

describe("lineState: only the context's own keys are lines", () => {
  const PROTO_KEYS = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"];
  const tighten = (action: string, lineKey: string, newValue?: string) =>
    ({ kind: "TIGHTEN", origin: TRUSTED, action, lineKey: trusted(lineKey, "plan"), ...(newValue ? { newValue: trusted(newValue, "policy") } : {}) }) as PolicyProposal;

  it.each(PROTO_KEYS)("lineKey %s → LineExpired / NOT_PACING_LINE, never a prototype value", (key) => {
    const ctx = ctxDay1();
    expect(evaluateProposal(tighten("PAUSE_LINE", key), ctx).reasonCode).toBe("LineExpired");
    expect(evaluateProposal(tighten("LOWER_PER_TX_CAP", key, "1"), ctx).reasonCode).toBe("LineExpired");
    const move = { kind: "LOOSEN", origin: TRUSTED, request: { kind: "MOVE_POCKETS", fromLineKey: key, toLineKey: "ADS", amountMinor: trusted("1", "founder") } } as PolicyProposal;
    expect(evaluateProposal(move, ctx).reasonCode).toBe("LineExpired");
    expect(evaluateProposal(spend({ lineKey: trusted(key as LineKey, "plan") }), ctx).reasonCode).toBe("LineExpired");
    expect(planPacingSlot(ctx, key as LineKey, { slots: 0, lineMinor: "0", totalMinor: "0" })).toEqual({ action: "SKIP", reason: "NOT_PACING_LINE" });
  });
});

describe("compilePlan: a replan draft needs the plan it replaces", () => {
  const codeOf = (f: () => unknown): string | undefined => {
    try {
      f();
    } catch (e) {
      return e instanceof CompileError ? e.code : `not a CompileError: ${String(e)}`;
    }
    return undefined;
  };

  it("version > 1 without `current` → INVALID_INPUT (no code-14 check could run)", () => {
    expect(codeOf(() => compilePlan({ ...RINA_COMPILE_INPUT, ids: { ...RINA_COMPILE_INPUT.ids, version: 2, prevPlanHash: fakeHex32("test:prev") } }))).toBe("INVALID_INPUT");
    expect(codeOf(() => compilePlan({ ...RINA_COMPILE_INPUT, ids: { ...RINA_COMPILE_INPUT.ids, version: 7 } }))).toBe("INVALID_INPUT");
  });

  it("a first plan with a non-zero prevPlanHash → INVALID_INPUT (commitPlan would revert StalePlan)", () => {
    expect(codeOf(() => compilePlan({ ...RINA_COMPILE_INPUT, ids: { ...RINA_COMPILE_INPUT.ids, version: 1, prevPlanHash: fakeHex32("test:prev") } }))).toBe("INVALID_INPUT");
  });

  it("a first plan (version 1 or absent) still compiles", () => {
    expect(codeOf(() => compilePlan(RINA_COMPILE_INPUT))).toBeUndefined();
    expect(codeOf(() => compilePlan({ ...RINA_COMPILE_INPUT, ids: { ...RINA_COMPILE_INPUT.ids, version: 1 } }))).toBeUndefined();
  });
});

describe("effectiveLifetimeCap fails closed on malformed mirrored values", () => {
  const base: RegistryPayee = { payeeId: "printer-kl", source: "bound", lineKeys: ["PACKAGING"] };

  it("an unreadable explicit cap or schedule amount allows nothing (0), not 'uncapped'", () => {
    expect(effectiveLifetimeCap({ ...base, lifetimeCapMinor: "12e3" })).toBe(0n);
    expect(effectiveLifetimeCap({ ...base, lifetimeCapMinor: "-5" })).toBe(0n);
    expect(effectiveLifetimeCap({ ...base, schedule: [{ amountMinor: "1,000", autoRelease: true }] })).toBe(0n);
    expect(effectiveLifetimeCap({ ...base, lifetimeCapMinor: "5000" })).toBe(5000n);
    expect(effectiveLifetimeCap(base)).toBeNull(); // genuinely uncapped
  });

  it("a spend to a payee with an unreadable cap → CapExceeded", () => {
    const ctx = { ...ctxWithSupplier(), now: T0 + 4n * DAY };
    const p = spend({ lineKey: trusted("PACKAGING", "plan"), payeeId: trusted(PRINTER.payeeId, "db:payees"), amountMinor: trusted("1000", "db") });
    expect(evaluateProposal(p, ctx).verdict).toBe("AUTO");
    const broken = { ...ctx, payees: ctx.payees.map((x) => (x.payeeId === PRINTER.payeeId ? { ...x, lifetimeCapMinor: "junk" } : x)) };
    expect(evaluateProposal(p, broken)).toMatchObject({ verdict: "DENY", reasonCode: "CapExceeded" });
  });

  it("code 11 still fails for a scheduled payee with an unreadable cap; blast radius still treats it as unbounded", () => {
    const now = BigInt(RINA_COMMIT_AT);
    const m = { ...examplePlanManifest, lines: examplePlanManifest.lines.map((l) => (l.lineKey === "SUPPLIER" ? { ...l, payeeIds: ["supplier-a"] } : l)) };
    const fac = { ...RINA_CONSTITUTION_FACILITY, payees: [...RINA_PLATFORM_REGISTRY, { ...rinaSupplierABinding(now), lifetimeCapMinor: "junk" }] };
    expect(constitutionViolations(checkConstitution(m, fac, now))).toContain("PAYEE_CAP_OVER_SCHEDULE");
    const junkAds = RINA_PLATFORM_REGISTRY.map((p) => (p.payeeId === "shopee-ads" ? { ...p, lifetimeCapMinor: "junk" } : p));
    expect(blastRadius(examplePlanManifest, junkAds, now)).toEqual(blastRadius(examplePlanManifest, RINA_PLATFORM_REGISTRY, now));
  });
});
