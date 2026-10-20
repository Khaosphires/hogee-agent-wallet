/**
 * Property tests for the tighten-only re-commit rule (G0-AUDIT v-1, code 14 REPLAN_LOOSENS):
 *   1. any accepted re-commit never raises a cap, an expiry, pacing or an amount, never shortens a window,
 *      never lowers the reserve, never adds a payee and never changes stages, totals or the agent;
 *   2. any pure tightening of the current state is accepted;
 *   3. a single loosening anywhere is refused;
 *   4. the policy engine sends a REPLAN to the founder alone only when it raises nothing above the mirrored
 *      on-chain state (otherwise DENY REPLAN_LOOSENS or an earlier code);
 *   5. routeReplan is sound: every routed request is a valid LOOSEN_* exception payload, and once they all
 *      execute, the re-check leaves exactly the unsupported loosenings.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  LINE_KEYS,
  RINA_COMMIT_AT,
  RINA_CONSTITUTION_FACILITY,
  ExceptionPayloads,
  checkConstitution,
  committedPlanOf,
  evaluateProposal,
  constitutionViolations,
  examplePlanManifest,
  planHash,
  replanLoosenings,
  routeReplan,
  type CommittedLine,
  type CommittedPlan,
  type LineKey,
  type PlanManifest,
  type PolicyContext,
} from "../src/index";
import { ctxDay1, RINA_DRAFT, RINA_MANIFEST, RINA_PLAN_HASH } from "./fixtures/policy-ctx";
import { applyLoosens } from "./fixtures/replan";

const RUNS = { numRuns: 300 };
const DAY = 86_400n;
const rina = examplePlanManifest;
const V1 = committedPlanOf(rina, planHash(rina));
const big = (s: string): bigint => BigInt(s);
const max0 = (v: bigint): bigint => (v < 0n ? 0n : v);

/** A manifest that re-commits exactly `cur` (next version), keeping v1's off-chain fields. */
function manifestFrom(cur: CommittedPlan): PlanManifest {
  return {
    ...rina,
    version: cur.version + 1,
    prevPlanHash: cur.planHash,
    reserveBps: cur.reserveBps,
    agent: { ...cur.agent },
    lines: cur.lines.map((c) => {
      const l = rina.lines.find((x) => x.lineKey === c.lineKey)!;
      const { pacing: _drop, ...rest } = l;
      return {
        ...rest,
        amountMinor: c.amountMinor,
        perTxCapMinor: c.perTxCapMinor,
        windowCapMinor: c.windowCapMinor,
        windowSeconds: c.windowSeconds,
        validUntil: c.validUntil,
        escrowOnly: c.escrowOnly,
        payeeIds: [...c.payeeIds],
        ...(c.pacingMinor !== "0" ? { pacing: { period: "day" as const, amountMinor: c.pacingMinor } } : {}),
      };
    }),
  };
}

/** Mostly 0, sometimes a random signed change (`zeros` : 1), so some samples loosen nothing at all. */
const sparse = (max: bigint, zeros = 20) => fc.oneof({ arbitrary: fc.constant(0n), weight: zeros }, { arbitrary: fc.bigInt({ min: -max, max }), weight: 1 });

const lineDeltaArb = fc.record({
  amount: sparse(2_000n),
  perTx: sparse(5_000n),
  window: sparse(5_000n),
  validUntil: sparse(DAY),
  windowSeconds: sparse(3_600n),
  pacing: sparse(2_000n),
  escrow: fc.oneof({ arbitrary: fc.constant<boolean | null>(null), weight: 20 }, { arbitrary: fc.boolean(), weight: 1 }),
  payee: fc.oneof({ arbitrary: fc.constant<"keep" | "add" | "drop">("keep"), weight: 20 }, { arbitrary: fc.constantFrom("add" as const, "drop" as const), weight: 1 }),
});

const deltaArb = fc.record({
  lines: fc.array(lineDeltaArb, { minLength: rina.lines.length, maxLength: rina.lines.length }),
  reserve: fc.oneof({ arbitrary: fc.constant(0), weight: 4 }, { arbitrary: fc.integer({ min: -200, max: 200 }), weight: 1 }),
  agentExpiry: sparse(DAY, 4),
  stage: sparse(DAY, 4),
  /** On-chain tightenings already applied to the current state (so "back to v1" can be a loosening). */
  tightenedCurrent: fc.array(sparse(5_000n, 2).map((v) => (v < 0n ? -v : v)), { minLength: rina.lines.length, maxLength: rina.lines.length }),
});
type Delta = typeof deltaArb extends fc.Arbitrary<infer T> ? T : never;

/** Current state: v1 with each line's per-tx cap lowered by `tightenedCurrent` (an earlier on-chain tighten). */
function currentOf(d: Delta): CommittedPlan {
  return { ...V1, lines: V1.lines.map((l, i) => ({ ...l, perTxCapMinor: String(max0(big(l.perTxCapMinor) - d.tightenedCurrent[i]!)) })) };
}

function applyDelta(cur: CommittedPlan, d: Delta): PlanManifest {
  const base = manifestFrom(cur);
  const lines = base.lines.map((l, i) => {
    const x = d.lines[i]!;
    const pacing = l.pacing ? max0(big(l.pacing.amountMinor) + x.pacing) : x.pacing > 0n ? x.pacing : 0n;
    const payeeIds = x.payee === "add" ? [...l.payeeIds, "extra-payee"] : x.payee === "drop" ? [] : l.payeeIds;
    const { pacing: _drop, ...rest } = l;
    return {
      ...rest,
      amountMinor: String(max0(big(l.amountMinor) + x.amount)),
      perTxCapMinor: String(max0(big(l.perTxCapMinor) + x.perTx)),
      windowCapMinor: String(max0(big(l.windowCapMinor) + x.window)),
      validUntil: String(max0(big(l.validUntil) + x.validUntil)),
      windowSeconds: String(max0(big(l.windowSeconds) + x.windowSeconds) || 1n),
      escrowOnly: x.escrow ?? l.escrowOnly,
      payeeIds,
      ...(pacing > 0n ? { pacing: { period: "day" as const, amountMinor: String(pacing) } } : {}),
    };
  });
  const [s1, s2] = base.stages;
  const stages = d.stage === 0n || !s2?.gate ? base.stages : [s1!, { ...s2, gate: { ...s2.gate, deadline: String(big(s2.gate.deadline) + d.stage) } }];
  return {
    ...base,
    lines,
    stages,
    reserveBps: Math.max(0, base.reserveBps + d.reserve),
    agent: { ...base.agent, expiresAt: String(max0(big(base.agent.expiresAt) + d.agentExpiry)) },
  };
}

/** Independent oracle: does `m` keep every value within the current state? */
function neverLoosens(m: PlanManifest, cur: CommittedPlan): boolean {
  const byKey = new Map(cur.lines.map((l) => [l.lineKey, l] as const));
  const lineOk = (l: PlanManifest["lines"][number], c: CommittedLine | undefined): boolean => {
    if (!c) return false;
    const pacing = big(l.pacing?.amountMinor ?? "0");
    const cp = big(c.pacingMinor);
    return (
      big(l.amountMinor) === big(c.amountMinor) &&
      big(l.perTxCapMinor) <= big(c.perTxCapMinor) &&
      big(l.windowCapMinor) <= big(c.windowCapMinor) &&
      big(l.validUntil) <= big(c.validUntil) &&
      big(l.windowSeconds) >= big(c.windowSeconds) &&
      pacing <= cp &&
      (pacing === 0n) === (cp === 0n) &&
      (!c.escrowOnly || l.escrowOnly) &&
      l.payeeIds.every((p) => c.payeeIds.includes(p))
    );
  };
  return (
    m.lines.length === cur.lines.length &&
    m.lines.every((l) => lineOk(l, byKey.get(l.lineKey))) &&
    JSON.stringify(m.stages) === JSON.stringify(cur.stages) &&
    m.totalMinor === cur.totalMinor &&
    m.countryPackHash === cur.countryPackHash &&
    m.reserveBps >= cur.reserveBps &&
    m.agent.address === cur.agent.address &&
    big(m.agent.expiresAt) <= big(cur.agent.expiresAt)
  );
}

describe("property: tighten-only re-commits (code 14)", () => {
  it("an accepted re-commit never loosens anything; a refused one loosens something", () => {
    let accepted = 0;
    let refused = 0;
    fc.assert(
      fc.property(deltaArb, (d) => {
        const cur = currentOf(d);
        const m = applyDelta(cur, d);
        const ok = replanLoosenings(m, cur).length === 0;
        if (ok) accepted += 1;
        else refused += 1;
        expect(ok).toBe(neverLoosens(m, cur));
      }),
      RUNS,
    );
    expect(accepted).toBeGreaterThan(30);
    expect(refused).toBeGreaterThan(30);
  });

  it("routeReplan is sound: valid payloads, and after executing them only `unsupported` remains", () => {
    fc.assert(
      fc.property(deltaArb, (d) => {
        const cur = currentOf(d);
        const m = applyDelta(cur, d);
        const route = routeReplan(m, cur);
        for (const r of route.loosens) expect(ExceptionPayloads[r.kind].safeParse(r.payload).success).toBe(true);
        expect(replanLoosenings(m, applyLoosens(cur, route.loosens))).toEqual(route.unsupported);
        expect(route.tightenOnly).toBe(replanLoosenings(m, cur).length === 0);
      }),
      RUNS,
    );
  });

  it("any pure tightening of the current state passes code 14", () => {
    const tightenArb = fc.record({
      lines: fc.array(
        fc.record({ perTx: fc.bigInt({ min: 0n, max: 20_000n }), window: fc.bigInt({ min: 0n, max: 20_000n }), validUntil: fc.bigInt({ min: 0n, max: 30n * DAY }), windowSeconds: fc.bigInt({ min: 0n, max: 7n * DAY }), pacing: fc.bigInt({ min: 0n, max: 7_499n }), escrow: fc.boolean(), drop: fc.boolean() }),
        { minLength: rina.lines.length, maxLength: rina.lines.length },
      ),
      reserve: fc.integer({ min: 0, max: 9_500 }),
      agentExpiry: fc.bigInt({ min: 0n, max: 10n * DAY }),
    });
    fc.assert(
      fc.property(tightenArb, (t) => {
        const base = manifestFrom(V1);
        const m: PlanManifest = {
          ...base,
          reserveBps: base.reserveBps + t.reserve,
          agent: { ...base.agent, expiresAt: String(big(base.agent.expiresAt) - t.agentExpiry) },
          lines: base.lines.map((l, i) => {
            const x = t.lines[i]!;
            return {
              ...l,
              perTxCapMinor: String(max0(big(l.perTxCapMinor) - x.perTx)),
              windowCapMinor: String(max0(big(l.windowCapMinor) - x.window)),
              validUntil: String(big(l.validUntil) - x.validUntil),
              windowSeconds: String(big(l.windowSeconds) + x.windowSeconds),
              escrowOnly: l.escrowOnly || x.escrow,
              payeeIds: x.drop ? [] : l.payeeIds,
              ...(l.pacing ? { pacing: { period: "day" as const, amountMinor: String(big(l.pacing.amountMinor) - x.pacing) } } : {}),
            };
          }),
        };
        expect(replanLoosenings(m, V1)).toEqual([]);
        expect(constitutionViolations(checkConstitution(m, RINA_CONSTITUTION_FACILITY, BigInt(RINA_COMMIT_AT) + DAY, V1))).not.toContain("REPLAN_LOOSENS");
      }),
      RUNS,
    );
  });

  it("a single loosening of any line field is refused", () => {
    const fields = ["amount", "perTx", "window", "validUntil", "windowSeconds", "pacing"] as const;
    fc.assert(
      fc.property(fc.constantFrom(...LINE_KEYS.filter((k) => V1.lines.some((l) => l.lineKey === k))), fc.constantFrom(...fields), fc.bigInt({ min: 1n, max: 10_000n }), (key, field, by) => {
        const cur = V1;
        const m = manifestFrom(cur);
        const line = (l: PlanManifest["lines"][number]): PlanManifest["lines"][number] => {
          if (l.lineKey !== key) return l;
          switch (field) {
            case "amount":
              return { ...l, amountMinor: String(big(l.amountMinor) + by) };
            case "perTx":
              return { ...l, perTxCapMinor: String(big(l.perTxCapMinor) + by) };
            case "window":
              return { ...l, windowCapMinor: String(big(l.windowCapMinor) + by) };
            case "validUntil":
              return { ...l, validUntil: String(big(l.validUntil) + by) };
            case "windowSeconds":
              return { ...l, windowSeconds: String(max0(big(l.windowSeconds) - by) || 1n) };
            case "pacing":
              return { ...l, pacing: { period: "day", amountMinor: String(big(l.pacing?.amountMinor ?? "0") + by) } };
          }
        };
        const loosened = { ...m, lines: m.lines.map(line) };
        expect(replanLoosenings(loosened, cur).some((x) => x.lineKey === key)).toBe(true);
      }),
      RUNS,
    );
  });
});

describe("property: the policy engine never lets the founder alone loosen a plan", () => {
  const n = RINA_MANIFEST.lines.length;
  /** Mostly a tightening (≤ 0), sometimes a loosening (> 0). */
  const change = (max: bigint) => fc.oneof({ arbitrary: fc.bigInt({ min: -max, max: 0n }), weight: 10 }, { arbitrary: fc.bigInt({ min: 1n, max }), weight: 1 });
  const arb = fc.record({
    onchain: fc.array(fc.record({ perTx: fc.bigInt({ min: 0n, max: 5_000n }), window: fc.bigInt({ min: 0n, max: 5_000n }) }), { minLength: n, maxLength: n }),
    proposed: fc.array(fc.record({ perTx: change(5_000n), window: change(5_000n), validUntil: change(DAY) }), { minLength: n, maxLength: n }),
  });
  it("NEEDS_FOUNDER ⇒ every proposed cap and expiry ≤ the mirrored on-chain value", () => {
    let toFounder = 0;
    let denied = 0;
    fc.assert(
      fc.property(arb, ({ onchain, proposed }) => {
        const base = ctxDay1();
        // Earlier on-chain tightenings (TIGHTEN_LOWER_*), mirrored into the policy context.
        const lines = Object.fromEntries(
          RINA_MANIFEST.lines.map((l, i) => {
            const s = base.lines[l.lineKey]!;
            const t = onchain[i]!;
            return [l.lineKey, { ...s, perTxCapMinor: String(max0(big(s.perTxCapMinor) - t.perTx)), windowCapMinor: String(max0(big(s.windowCapMinor) - t.window)) }];
          }),
        ) as Partial<Record<LineKey, NonNullable<PolicyContext["lines"][LineKey]>>>;
        const ctx: PolicyContext = { ...base, lines };
        // The founder's v2 starts from the mirrored state and mostly tightens it further.
        const manifest: PlanManifest = {
          ...RINA_MANIFEST,
          version: 2,
          prevPlanHash: RINA_PLAN_HASH,
          lines: RINA_MANIFEST.lines.map((l, i) => {
            const s = lines[l.lineKey]!;
            const d = proposed[i]!;
            return {
              ...l,
              perTxCapMinor: String(max0(big(s.perTxCapMinor) + d.perTx)),
              windowCapMinor: String(max0(big(s.windowCapMinor) + d.window)),
              validUntil: String(big(s.validUntil) + d.validUntil),
            };
          }),
        };
        const decision = evaluateProposal({ kind: "REPLAN", origin: { trust: "trusted", sensitivity: "public" }, draft: { ...RINA_DRAFT, manifest } }, ctx);
        if (decision.verdict !== "NEEDS_FOUNDER") {
          expect(decision).toMatchObject({ verdict: "DENY", reasonCode: "PlanInvariantViolated" });
          denied += 1;
          return;
        }
        toFounder += 1;
        for (const l of manifest.lines) {
          const s = ctx.lines[l.lineKey]!;
          expect(big(l.perTxCapMinor) <= big(s.perTxCapMinor)).toBe(true);
          expect(big(l.windowCapMinor) <= big(s.windowCapMinor)).toBe(true);
          expect(big(l.validUntil) <= big(s.validUntil)).toBe(true);
          expect(l.amountMinor).toBe(s.allocatedMinor);
        }
        expect(manifest.stages).toEqual(RINA_MANIFEST.stages);
      }),
      RUNS,
    );
    expect(toFounder).toBeGreaterThan(20);
    expect(denied).toBeGreaterThan(20);
  });
});
