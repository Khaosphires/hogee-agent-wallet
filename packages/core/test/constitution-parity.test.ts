/**
 * Constitution mirror parity with PlanConstitution.check (security audit run-2, fix 6): the code-13 shape limits and
 * role separation, and the revert precedence 13, then 12, then the lowest of 1-10 (docs/assurance/require-table-loop1.md).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CONSTITUTION_CODES,
  CONSTITUTION_PRECEDENCE,
  RINA_COMMIT_AT,
  RINA_CONSTITUTION_FACILITY,
  RINA_PLATFORM_REGISTRY,
  checkConstitution,
  constitutionViolations,
  examplePlanManifest,
  fakeAddress,
  firstViolation,
  stringToBytes32,
  ZERO_ADDRESS,
  type ConstitutionCode,
  type ConstitutionFacility,
  type PlanManifest,
  type RegistryPayee,
} from "../src/index";

const NOW = BigInt(RINA_COMMIT_AT);
const rina = examplePlanManifest;
const fac = RINA_CONSTITUTION_FACILITY;
const AGENT = rina.agent.address;
const fails = (m: PlanManifest, f: ConstitutionFacility = fac): ConstitutionCode[] => constitutionViolations(checkConstitution(m, f, NOW));
const first = (m: PlanManifest, f: ConstitutionFacility = fac): ConstitutionCode | null => firstViolation(checkConstitution(m, f, NOW));

/** Rina's plan plus `n` empty lines (amount 0, no payees): every cap rule still holds. */
const withEmptyLines = (n: number): PlanManifest => {
  const base = rina.lines.find((l) => l.lineKey === "CONTINGENCY")!;
  const extra = Array.from({ length: n }, (_, i) => {
    const key = `EXTRA_${i}`;
    return { ...base, lineKey: key, lineId: stringToBytes32(key), amountMinor: "0", perTxCapMinor: "0", windowCapMinor: "0", payeeIds: [] };
  });
  return { ...rina, lines: [...rina.lines, ...extra] as unknown as PlanManifest["lines"] };
};

/** Rina's plan plus `n` gated stages that release 0. */
const withEmptyStages = (n: number): PlanManifest => {
  const gated = rina.stages[1]!;
  const extra = Array.from({ length: n }, (_, i) => ({ ...gated, stageId: `stage-x${i}`, releaseMinor: "0" }));
  return { ...rina, stages: [...rina.stages, ...extra] };
};

/** CONTINGENCY lists `n` platform payees, all in the registry. */
const withPayees = (n: number): [PlanManifest, ConstitutionFacility] => {
  const ids = Array.from({ length: n }, (_, i) => `vendor-${i}`);
  const registry: RegistryPayee[] = ids.map((payeeId) => ({ payeeId, source: "platform", lineKeys: ["CONTINGENCY"] }));
  const m = { ...rina, lines: rina.lines.map((l) => (l.lineKey === "CONTINGENCY" ? { ...l, payeeIds: ids } : l)) };
  return [m, { ...fac, payees: [...RINA_PLATFORM_REGISTRY, ...registry] }];
};

describe("code 13 (MALFORMED_PLAN): contract shape limits", () => {
  it.each<[string, () => ConstitutionCode[], () => ConstitutionCode[]]>([
    ["16 lines max", () => fails(withEmptyLines(10)), () => fails(withEmptyLines(11))],
    ["8 stages max", () => fails(withEmptyStages(6)), () => fails(withEmptyStages(7))],
    ["8 payees per line max", () => fails(...withPayees(8)), () => fails(...withPayees(9))],
  ])("%s: at the limit passes, one more is MALFORMED_PLAN only", (_name, edge, over) => {
    expect(edge()).toEqual([]);
    expect(over()).toEqual(["MALFORMED_PLAN"]);
  });

  it("zero totalMinor is malformed (and reverts 13 before the totals rule)", () => {
    const zero = { ...rina, totalMinor: "0" };
    expect(fails(zero)).toContain("MALFORMED_PLAN");
    expect(first(zero)).toBe("MALFORMED_PLAN");
  });

  it("a zero or unreadable agent address is malformed", () => {
    expect(fails({ ...rina, agent: { ...rina.agent, address: `0x${"0".repeat(40)}` } })).toEqual(["MALFORMED_PLAN"]);
    expect(fails({ ...rina, agent: { ...rina.agent, address: "0x1234" } })).toEqual(["MALFORMED_PLAN"]);
  });

  it("an empty stageId or payeeId is malformed (bytes32 zero on-chain)", () => {
    expect(fails({ ...rina, stages: [rina.stages[0]!, { ...rina.stages[1]!, stageId: "" }] })).toEqual(["MALFORMED_PLAN"]);
    const [m, f] = withPayees(1);
    const emptyPayee = { ...m, lines: m.lines.map((l) => (l.lineKey === "CONTINGENCY" ? { ...l, payeeIds: [""] } : l)) };
    expect(fails(emptyPayee, f)).toContain("MALFORMED_PLAN");
  });
});

describe("code 13 (MALFORMED_PLAN): role separation", () => {
  const OTHER = fakeAddress("test:someone-else");

  it.each(["ownerEOA", "lender", "oracle"] as const)("agent equal to the facility's %s → MALFORMED_PLAN", (role) => {
    expect(fails(rina, { ...fac, [role]: AGENT })).toEqual(["MALFORMED_PLAN"]);
    expect(fails(rina, { ...fac, [role]: AGENT.toUpperCase().replace("0X", "0x") })).toEqual(["MALFORMED_PLAN"]);
    expect(fails(rina, { ...fac, [role]: OTHER })).toEqual([]);
  });

  it("agent equal to the facility's observer → MALFORMED_PLAN (audit run-3); no observer, or the zero address, is none", () => {
    expect(fails(rina, { ...fac, observer: AGENT })).toEqual(["MALFORMED_PLAN"]);
    expect(fails(rina, { ...fac, observer: AGENT.toUpperCase().replace("0X", "0x") })).toEqual(["MALFORMED_PLAN"]);
    expect(fails(rina, { ...fac, observer: OTHER })).toEqual([]);
    expect(fails(rina, { ...fac, observer: ZERO_ADDRESS })).toEqual([]);
    expect(fails(rina, fac)).toEqual([]);
    expect(fails(rina, { ...fac, observer: "not-an-address" })).toEqual(["MALFORMED_PLAN"]); // present: fails closed
  });

  it("role addresses are required; the zero address (unknown, or a passkey-only owner) never matches a valid agent", () => {
    // @ts-expect-error ownerEOA, lender and oracle are required: pass ZERO_ADDRESS explicitly when unknown
    const noRoles: ConstitutionFacility = { capMinor: fac.capMinor, reserveFloorBps: fac.reserveFloorBps, judgingWindowEnd: fac.judgingWindowEnd, payees: fac.payees };
    expect(fails(rina, { ...fac, ownerEOA: ZERO_ADDRESS, lender: ZERO_ADDRESS, oracle: ZERO_ADDRESS })).toEqual([]);
    expect(fails(rina, noRoles)).toEqual(["MALFORMED_PLAN"]); // a missing role fails closed at run time too
    expect(fails(rina, { ...fac, oracle: "not-an-address" })).toEqual(["MALFORMED_PLAN"]);
  });
});

describe("firstViolation follows the contract's precedence: 13, then 12, then the lowest of 1-10", () => {
  const report = (failed: readonly ConstitutionCode[]) => CONSTITUTION_CODES.map((code) => ({ code, ok: !failed.includes(code) }));

  it.each<[ConstitutionCode[], ConstitutionCode]>([
    [["AGENT_EXPIRY_TOO_LATE", "MALFORMED_PLAN"], "MALFORMED_PLAN"],
    [["LINES_EXCEED_FACILITY_CAP", "TOTALS_MISMATCH"], "TOTALS_MISMATCH"],
    [["TOTALS_MISMATCH", "MALFORMED_PLAN"], "MALFORMED_PLAN"],
    [["SUPPLIER_LINE_NOT_ESCROW", "PER_TX_CAP_OVER_25PCT"], "PER_TX_CAP_OVER_25PCT"],
    [["PAYEE_CAP_OVER_SCHEDULE", "SUPPLIER_LINE_NOT_ESCROW"], "SUPPLIER_LINE_NOT_ESCROW"],
    [["REPLAN_LOOSENS", "PAYEE_CAP_OVER_SCHEDULE"], "PAYEE_CAP_OVER_SCHEDULE"],
    [["REPLAN_LOOSENS"], "REPLAN_LOOSENS"],
  ])("%j → %s", (failed, expected) => {
    expect(firstViolation(report(failed))).toBe(expected);
  });

  it("a real plan that breaks the totals and a cap reverts 12, not 4", () => {
    const m = { ...rina, totalMinor: "1000001", lines: rina.lines.map((l) => (l.lineKey === "ADS" ? { ...l, perTxCapMinor: "120000" } : l)) };
    expect(fails(m)).toEqual(expect.arrayContaining(["PER_TX_CAP_OVER_25PCT", "TOTALS_MISMATCH"]));
    expect(first(m)).toBe("TOTALS_MISMATCH");
  });

  it("the precedence lists every code once", () => {
    expect([...CONSTITUTION_PRECEDENCE].sort()).toEqual([...CONSTITUTION_CODES].sort());
  });

  it("property: the first failing code in precedence order, whatever the report order", () => {
    fc.assert(
      fc.property(fc.subarray([...CONSTITUTION_CODES], { minLength: 1 }), fc.boolean(), (failed, reverse) => {
        const r = report(failed);
        const expected = failed.includes("MALFORMED_PLAN")
          ? "MALFORMED_PLAN"
          : failed.includes("TOTALS_MISMATCH")
            ? "TOTALS_MISMATCH"
            : (["LINES_EXCEED_FACILITY_CAP", "AGENT_EXPIRY_TOO_LATE", "AGENT_EXPIRY_TOO_EARLY", "PER_TX_CAP_OVER_25PCT", "WINDOW_CAP_OVER_50PCT", "LINE_VALIDITY_TOO_LONG", "RESERVE_BELOW_FLOOR", "STAGE1_OVER_40PCT", "PLAN_ADDS_PAYEE", "SUPPLIER_LINE_NOT_ESCROW", "PAYEE_CAP_OVER_SCHEDULE", "REPLAN_LOOSENS"] as const).find((c) => failed.includes(c));
        expect(firstViolation(reverse ? [...r].reverse() : r)).toBe(expected);
      }),
      { numRuns: 300 },
    );
  });
});
