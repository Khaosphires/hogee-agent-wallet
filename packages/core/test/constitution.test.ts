import { describe, expect, it } from "vitest";
import {
  CONSTITUTION_CODES,
  CONSTITUTION_CODE_UINT8,
  JUDGING_WINDOW_END,
  RINA_COMMIT_AT,
  RINA_CONSTITUTION_FACILITY,
  RINA_PLATFORM_REGISTRY,
  checkConstitution,
  constitutionOk,
  constitutionViolations,
  examplePlanManifest,
  firstViolation,
  lineCapsWithinConstitution,
  rinaSupplierABinding,
  stringToBytes32,
  type ConstitutionCode,
  type ConstitutionFacility,
  type PlanLine,
  type PlanManifest,
} from "../src/index";

const NOW = BigInt(RINA_COMMIT_AT);
const DAY = 86_400n;
const plus = (s: bigint): string => String(NOW + s);
const rina = examplePlanManifest;
const fac = RINA_CONSTITUTION_FACILITY;

const withLine = (m: PlanManifest, key: string, patch: Partial<PlanLine>): PlanManifest => ({
  ...m,
  lines: m.lines.map((l) => (l.lineKey === key ? { ...l, ...patch } : l)),
});

const fails = (m: PlanManifest, f: ConstitutionFacility = fac, now: string | bigint = NOW): ConstitutionCode[] =>
  constitutionViolations(checkConstitution(m, f, now));

describe("checkConstitution (§8.3 mirror)", () => {
  it("Rina's plan v1 passes every rule; the report lists all 14 codes in code order", () => {
    const report = checkConstitution(rina, fac, NOW);
    expect(report.map((r) => r.code)).toEqual([...CONSTITUTION_CODES]);
    expect(report.map((r) => CONSTITUTION_CODE_UINT8[r.code])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(constitutionOk(report)).toBe(true);
    expect(firstViolation(report)).toBeNull();
  });

  it("accepts now as a digit string or a bigint", () => {
    expect(checkConstitution(rina, fac, RINA_COMMIT_AT)).toEqual(checkConstitution(rina, fac, NOW));
  });

  it("T21: an AI-drafted malicious plan (reserve 0, extra payee, perTxCap = line) fails; revert code is 4", () => {
    const evil = withLine(withLine({ ...rina, reserveBps: 0 }, "ADS", { perTxCapMinor: "120000" }), "PACKAGING", {
      payeeIds: ["evil-payee"],
    });
    const report = checkConstitution(evil, fac, NOW);
    expect(constitutionViolations(report)).toEqual(["PER_TX_CAP_OVER_25PCT", "RESERVE_BELOW_FLOOR", "PLAN_ADDS_PAYEE"]);
    expect(firstViolation(report)).toBe("PER_TX_CAP_OVER_25PCT");
  });

  // Each mutation breaks exactly one rule; the "edge" twin sits exactly on the limit and passes.
  const cases: readonly { name: string; code: ConstitutionCode; bad: () => string[]; edge?: () => string[] }[] = [
    {
      name: "lines exceed the facility cap",
      code: "LINES_EXCEED_FACILITY_CAP",
      bad: () => fails(rina, { ...fac, capMinor: "999999" }),
    },
    {
      name: "agent expiry after now + 90 days",
      code: "AGENT_EXPIRY_TOO_LATE",
      bad: () => fails({ ...rina, agent: { ...rina.agent, expiresAt: plus(90n * DAY + 1n) } }),
      edge: () => fails({ ...rina, agent: { ...rina.agent, expiresAt: plus(90n * DAY) } }),
    },
    {
      name: "agent expiry not later than the judging window",
      code: "AGENT_EXPIRY_TOO_EARLY",
      bad: () => fails({ ...rina, agent: { ...rina.agent, expiresAt: JUDGING_WINDOW_END } }),
      edge: () => fails({ ...rina, agent: { ...rina.agent, expiresAt: String(BigInt(JUDGING_WINDOW_END) + 1n) } }),
    },
    {
      name: "perTxCap above 25%",
      code: "PER_TX_CAP_OVER_25PCT",
      bad: () => fails(withLine(rina, "PACKAGING", { perTxCapMinor: "37501" })),
      edge: () => fails(withLine(rina, "PACKAGING", { perTxCapMinor: "37500" })),
    },
    {
      name: "window cap above 50%",
      code: "WINDOW_CAP_OVER_50PCT",
      bad: () => fails(withLine(rina, "LOGISTICS", { windowCapMinor: "40001" })),
      edge: () => fails(withLine(rina, "LOGISTICS", { windowCapMinor: "40000" })),
    },
    {
      name: "line valid beyond now + 90 days",
      code: "LINE_VALIDITY_TOO_LONG",
      bad: () => fails(withLine(rina, "ADS", { validUntil: plus(90n * DAY + 1n) })),
      edge: () => fails(withLine(rina, "ADS", { validUntil: plus(90n * DAY) })),
    },
    {
      name: "reserve below the facility floor",
      code: "RESERVE_BELOW_FLOOR",
      bad: () => fails({ ...rina, reserveBps: 299 }),
      edge: () => fails({ ...rina, reserveBps: 300 }),
    },
    {
      name: "stage 1 above 40%",
      code: "STAGE1_OVER_40PCT",
      bad: () =>
        fails({
          ...rina,
          stages: [
            { ...rina.stages[0]!, releaseMinor: "400001" },
            { ...rina.stages[1]!, releaseMinor: "599999" },
          ],
        }),
    },
    {
      name: "plan names an unknown payee",
      code: "PLAN_ADDS_PAYEE",
      bad: () => fails(withLine(rina, "PACKAGING", { payeeIds: ["printer-kl"] })),
    },
    {
      name: "plan moves a platform payee to another line (binding is per line)",
      code: "PLAN_ADDS_PAYEE",
      bad: () => fails(withLine(rina, "CONTINGENCY", { payeeIds: ["shopee-ads"] })),
    },
    {
      name: "supplier line not escrow-only",
      code: "SUPPLIER_LINE_NOT_ESCROW",
      bad: () => fails(withLine(rina, "SUPPLIER", { escrowOnly: false })),
    },
    {
      name: "bound supplier with a lifetime cap above its schedule",
      code: "PAYEE_CAP_OVER_SCHEDULE",
      bad: () =>
        fails(withLine(rina, "SUPPLIER", { payeeIds: ["supplier-a"] }), {
          ...fac,
          payees: [...RINA_PLATFORM_REGISTRY, { ...rinaSupplierABinding(NOW), lifetimeCapMinor: "430001" }],
        }),
      edge: () =>
        fails(withLine(rina, "SUPPLIER", { payeeIds: ["supplier-a"] }), {
          ...fac,
          payees: [...RINA_PLATFORM_REGISTRY, rinaSupplierABinding(NOW)],
        }),
    },
    {
      name: "escrow line names a payee without a signed schedule",
      code: "PAYEE_CAP_OVER_SCHEDULE",
      bad: () =>
        fails(withLine(rina, "SUPPLIER", { payeeIds: ["agency-x"] }), {
          ...fac,
          payees: [...RINA_PLATFORM_REGISTRY, { payeeId: "agency-x", source: "platform", lineKeys: ["SUPPLIER"] }],
        }),
    },
    {
      name: "lines do not add up to totalMinor",
      code: "TOTALS_MISMATCH",
      bad: () => fails({ ...rina, totalMinor: "1000001" }),
    },
    {
      name: "stages do not add up to totalMinor",
      code: "TOTALS_MISMATCH",
      bad: () => fails({ ...rina, stages: [rina.stages[0]!, { ...rina.stages[1]!, releaseMinor: "599999" }] }),
    },
    { name: "windowSeconds 0", code: "MALFORMED_PLAN", bad: () => fails(withLine(rina, "ADS", { windowSeconds: "0" })) },
    {
      name: "lineId does not match lineKey",
      code: "MALFORMED_PLAN",
      bad: () => fails(withLine(rina, "ADS", { lineId: stringToBytes32("LOGISTICS") })),
    },
    {
      name: "zero pacing",
      code: "MALFORMED_PLAN",
      bad: () => fails(withLine(rina, "ADS", { pacing: { period: "day", amountMinor: "0" } })),
    },
    {
      name: "stage 1 has a gate",
      code: "MALFORMED_PLAN",
      bad: () => fails({ ...rina, stages: [{ ...rina.stages[0]!, gate: rina.stages[1]!.gate }, rina.stages[1]!] }),
    },
    {
      name: "a later stage has no gate",
      code: "MALFORMED_PLAN",
      bad: () => fails({ ...rina, stages: [rina.stages[0]!, { ...rina.stages[1]!, gate: null }] }),
    },
    {
      name: "duplicate payee on one line",
      code: "MALFORMED_PLAN",
      bad: () => fails(withLine(rina, "ADS", { payeeIds: ["shopee-ads", "shopee-ads"] })),
    },
  ];

  it.each(cases.map((c) => [c.name, c] as const))("%s → only that code fails", (_name, c) => {
    expect(c.bad()).toEqual([c.code]);
    if (c.edge) expect(c.edge()).toEqual([]);
  });

  it("supplier A bound on the SUPPLIER line passes codes 1-13 (code 14 for replans: test/replan.test.ts)", () => {
    const v2 = withLine(rina, "SUPPLIER", { payeeIds: ["supplier-a"] });
    expect(fails(v2, { ...fac, payees: [...RINA_PLATFORM_REGISTRY, rinaSupplierABinding(NOW)] })).toEqual([]);
  });

  it("fails closed on malformed input (unreadable amounts, duplicate lines, no stages)", () => {
    const junk = withLine(rina, "ADS", { amountMinor: "12e4" });
    expect(fails(junk)).toEqual(
      expect.arrayContaining(["LINES_EXCEED_FACILITY_CAP", "PER_TX_CAP_OVER_25PCT", "TOTALS_MISMATCH", "MALFORMED_PLAN"]),
    );
    expect(fails({ ...rina, lines: [...rina.lines, rina.lines[0]!] })).toContain("MALFORMED_PLAN");
    expect(fails({ ...rina, stages: [] })).toEqual(["STAGE1_OVER_40PCT", "TOTALS_MISMATCH", "MALFORMED_PLAN"]);
    expect(fails({ ...rina, reserveBps: 1.5 })).toEqual(["RESERVE_BELOW_FLOOR", "MALFORMED_PLAN"]);
  });

  it("firstViolation follows the contract's precedence (13 first), not report position (test/constitution-parity.test.ts)", () => {
    expect(firstViolation([{ code: "AGENT_EXPIRY_TOO_LATE", ok: false }, { code: "MALFORMED_PLAN", ok: false }])).toBe("MALFORMED_PLAN");
  });

  it("lineCapsWithinConstitution is the executeLoosen re-check", () => {
    expect(lineCapsWithinConstitution(100n, 25n, 50n)).toBe(true);
    expect(lineCapsWithinConstitution(100n, 26n, 50n)).toBe(false);
    expect(lineCapsWithinConstitution(99n, 24n, 49n)).toBe(true);
    expect(lineCapsWithinConstitution(99n, 25n, 49n)).toBe(false);
  });
});
