/**
 * G0-AUDIT (v-1): sequential plan versions (StalePlan) and tighten-only re-commits (constitution code 14,
 * REPLAN_LOOSENS), mirroring the IPlanRegistry.commitPlan NatSpec and project.md §8.3.
 */
import { describe, expect, it } from "vitest";
import {
  CONSTITUTION_CODES,
  RINA_COMMIT_AT,
  RINA_CONSTITUTION_FACILITY,
  RINA_PLATFORM_REGISTRY,
  ZERO_HEX32,
  checkConstitution,
  checkPlanSequence,
  commitPlanOutcome,
  committedPlanOf,
  constitutionViolations,
  examplePlanManifest,
  fakeAddress,
  fakeHex32,
  planHash,
  replanLoosenings,
  rinaSupplierABinding,
  type CommittedPlan,
  type ConstitutionCode,
  type ConstitutionFacility,
  type PlanLine,
  type PlanManifest,
} from "../src/index";

const NOW = BigInt(RINA_COMMIT_AT);
const DAY = 86_400n;
const rina = examplePlanManifest;
const fac = RINA_CONSTITUTION_FACILITY;
const H1 = planHash(rina);
const V1 = committedPlanOf(rina, H1);

const withLine = (m: PlanManifest, key: string, patch: Partial<PlanLine>): PlanManifest => ({
  ...m,
  lines: m.lines.map((l) => (l.lineKey === key ? { ...l, ...patch } : l)),
});
/** The next version of `m` in the CAS chain after `current`. */
const next = (m: PlanManifest, current: CommittedPlan = V1): PlanManifest => ({ ...m, version: current.version + 1, prevPlanHash: current.planHash });
const withCurrentLine = (c: CommittedPlan, key: string, patch: Partial<CommittedPlan["lines"][number]>): CommittedPlan => ({
  ...c,
  lines: c.lines.map((l) => (l.lineKey === key ? { ...l, ...patch } : l)),
});
const fails = (m: PlanManifest, current: CommittedPlan | null = V1, f: ConstitutionFacility = fac, now: bigint = NOW + DAY): ConstitutionCode[] =>
  constitutionViolations(checkConstitution(m, f, now, current));
const lineOf = (m: PlanManifest, key: string): PlanLine => {
  const l = m.lines.find((x) => x.lineKey === key);
  if (!l) throw new Error(`no line ${key}`);
  return l;
};

describe("committedPlanOf", () => {
  it("is the on-chain state right after committing v1 (stored line order, pacing 0 for invoice lines)", () => {
    expect(V1.version).toBe(1);
    expect(V1.planHash).toBe(H1);
    expect(V1.lines.map((l) => l.lineKey)).toEqual(rina.lines.map((l) => l.lineKey));
    expect(V1.lines.find((l) => l.lineKey === "ADS")?.pacingMinor).toBe("7500");
    expect(V1.lines.find((l) => l.lineKey === "LOGISTICS")?.pacingMinor).toBe("0");
    expect(V1.agent).toEqual(rina.agent);
    expect(V1.stages).toEqual(rina.stages);
  });
});

describe("checkPlanSequence (StalePlan)", () => {
  it("first commit: version 1 with prevPlanHash 0, any planId", () => {
    expect(checkPlanSequence(rina, null)).toBeNull();
    expect(checkPlanSequence({ ...rina, planId: fakeHex32("other") }, null)).toBeNull();
    expect(checkPlanSequence({ ...rina, version: 2 }, null)).toBe("StalePlan");
    expect(checkPlanSequence({ ...rina, prevPlanHash: H1 }, null)).toBe("StalePlan");
  });

  it("a stored version 0 is the same as no plan (the rule reads stored state, not the signed number)", () => {
    expect(checkPlanSequence(rina, { ...V1, version: 0, planHash: ZERO_HEX32 })).toBeNull();
  });

  it("re-commit: exactly planVersion() + 1, same planId, prevPlanHash = the stored planHash", () => {
    expect(checkPlanSequence(next(rina), V1)).toBeNull();
    expect(checkPlanSequence(rina, V1)).toBe("StalePlan"); // a re-signed version 1 cannot skip the rule
    expect(checkPlanSequence({ ...next(rina), version: 3 }, V1)).toBe("StalePlan"); // skipped version
    expect(checkPlanSequence({ ...next(rina), planId: fakeHex32("other") }, V1)).toBe("StalePlan");
    expect(checkPlanSequence({ ...next(rina), prevPlanHash: ZERO_HEX32 }, V1)).toBe("StalePlan");
  });
});

describe("checkConstitution code 14 REPLAN_LOOSENS (tighten-only re-commit)", () => {
  it("the report has 14 codes; a first commit never fails code 14", () => {
    expect(checkConstitution(rina, fac, NOW).map((r) => r.code)).toEqual([...CONSTITUTION_CODES]);
    expect(checkConstitution(rina, fac, NOW, null).at(-1)).toEqual({ code: "REPLAN_LOOSENS", ok: true });
    expect(fails({ ...rina, reserveBps: 0 }, null)).toEqual(["RESERVE_BELOW_FLOOR"]);
  });

  it("an unchanged re-commit passes", () => {
    expect(fails(next(rina))).toEqual([]);
  });

  it("the frozen REPLAN example passes: lower the ADS caps after weak ad returns", () => {
    expect(fails(next(withLine(rina, "ADS", { perTxCapMinor: "20000", windowCapMinor: "40000" })))).toEqual([]);
  });

  it("every tightening at once passes (caps, expiries, window, pacing, escrow, payees, reserve)", () => {
    let m = withLine(rina, "ADS", {
      perTxCapMinor: "10000",
      windowCapMinor: "20000",
      validUntil: String(BigInt(lineOf(rina, "ADS").validUntil) - DAY),
      windowSeconds: String(14n * DAY),
      pacing: { period: "day", amountMinor: "5000" },
    });
    m = withLine(m, "PACKAGING", { escrowOnly: true });
    m = withLine(m, "LOGISTICS", { payeeIds: [] });
    m = { ...m, reserveBps: 900, agent: { ...m.agent, expiresAt: String(BigInt(m.agent.expiresAt) - DAY) } };
    expect(fails(next(m))).toEqual([]);
  });

  it("line order in calldata does not matter (same set of lineIds; stored order kept)", () => {
    expect(fails(next({ ...rina, lines: [...rina.lines].reverse() }))).toEqual([]);
  });

  const cur = V1;
  const ads = lineOf(rina, "ADS");
  const later = (s: string, d: bigint) => String(BigInt(s) + d);
  const cases: readonly { name: string; m: () => PlanManifest; current?: () => CommittedPlan; f?: ConstitutionFacility }[] = [
    { name: "raises a per-tx cap", m: () => withLine(rina, "ADS", { perTxCapMinor: "25000" }), current: () => withCurrentLine(cur, "ADS", { perTxCapMinor: "20000" }) },
    {
      name: "undoes an on-chain tightening (ADS per-tx cap lowered to 20,000 since)",
      m: () => rina,
      current: () => withCurrentLine(cur, "ADS", { perTxCapMinor: "20000" }),
    },
    { name: "raises a window cap", m: () => rina, current: () => withCurrentLine(cur, "ADS", { windowCapMinor: "59999" }) },
    { name: "extends a line's validUntil", m: () => withLine(rina, "ADS", { validUntil: later(ads.validUntil, 1n) }) },
    { name: "shortens windowSeconds", m: () => withLine(rina, "ADS", { windowSeconds: String(7n * DAY - 1n) }) },
    { name: "raises pacing", m: () => withLine(rina, "ADS", { pacing: { period: "day", amountMinor: "7501" } }) },
    { name: "switches pacing off (to 0)", m: () => withLine(rina, "ADS", { pacing: undefined }) },
    { name: "switches pacing on (from 0)", m: () => withLine(rina, "LOGISTICS", { pacing: { period: "day", amountMinor: "1000" } }) },
    { name: "clears escrowOnly", m: () => rina, current: () => withCurrentLine(cur, "PACKAGING", { escrowOnly: true }) },
    {
      name: "names a registry payee that is not one of the line's current payees",
      m: () => withLine(rina, "ADS", { payeeIds: ["shopee-ads", "lazada-ads"] }),
      f: { ...fac, payees: [...RINA_PLATFORM_REGISTRY, { payeeId: "lazada-ads", source: "platform", lineKeys: ["ADS"] }] },
    },
    {
      name: "keeps the v1 amounts after an executed MOVE_POCKETS (10,000 PACKAGING → ADS)",
      m: () => withLine(rina, "PACKAGING", { perTxCapMinor: "35000", windowCapMinor: "70000" }),
      current: () => withCurrentLine(withCurrentLine(cur, "PACKAGING", { amountMinor: "140000" }), "ADS", { amountMinor: "130000" }),
    },
    {
      name: "moves budget between lines (MOVE_POCKETS needs the lender)",
      m: () =>
        withLine(withLine(rina, "PACKAGING", { amountMinor: "140000", perTxCapMinor: "35000", windowCapMinor: "70000" }), "ADS", { amountMinor: "130000" }),
    },
    {
      name: "rewrites a stage (later gate deadline)",
      m: () => ({ ...rina, stages: [rina.stages[0]!, { ...rina.stages[1]!, gate: { ...rina.stages[1]!.gate!, deadline: later(rina.stages[1]!.gate!.deadline, DAY) } }] }),
    },
    {
      name: "changes totalMinor (lines and stages still add up)",
      m: () => ({
        ...withLine(rina, "CONTINGENCY", { amountMinor: "90000", perTxCapMinor: "22500", windowCapMinor: "45000" }),
        totalMinor: "990000",
        stages: [{ ...rina.stages[0]!, releaseMinor: "396000" }, { ...rina.stages[1]!, releaseMinor: "594000" }],
      }),
    },
    { name: "changes countryPackHash", m: () => ({ ...rina, countryPackHash: fakeHex32("pack:other") }) },
    { name: "has a line the current plan does not have", m: () => rina, current: () => ({ ...cur, lines: cur.lines.filter((l) => l.lineKey !== "CONTINGENCY") }) },
    { name: "lowers reserveBps below its current (raised) value", m: () => rina, current: () => ({ ...cur, reserveBps: 600 }) },
    { name: "changes the agent", m: () => ({ ...rina, agent: { ...rina.agent, address: fakeAddress("agent:other") } }) },
    { name: "extends the agent expiry", m: () => ({ ...rina, agent: { ...rina.agent, expiresAt: later(rina.agent.expiresAt, 1n) } }) },
  ];

  it.each(cases.map((c) => [c.name, c] as const))("%s → only REPLAN_LOOSENS fails", (_name, c) => {
    const current = c.current ? c.current() : cur;
    expect(fails(next(c.m(), current), current, c.f ?? fac)).toEqual(["REPLAN_LOOSENS"]);
  });

  it("a payee bound to the line since v1 (supplier A on SUPPLIER) may be named", () => {
    const current = withCurrentLine(V1, "SUPPLIER", { payeeIds: ["supplier-a"] });
    const f = { ...fac, payees: [...RINA_PLATFORM_REGISTRY, rinaSupplierABinding(NOW)] };
    expect(fails(next(withLine(rina, "SUPPLIER", { payeeIds: ["supplier-a"] }), current), current, f)).toEqual([]);
  });

  it("amounts equal to the current allocation after MOVE_POCKETS pass", () => {
    const current = withCurrentLine(withCurrentLine(V1, "PACKAGING", { amountMinor: "140000", perTxCapMinor: "35000", windowCapMinor: "70000" }), "ADS", {
      amountMinor: "130000",
    });
    const m = withLine(withLine(rina, "PACKAGING", { amountMinor: "140000", perTxCapMinor: "35000", windowCapMinor: "70000" }), "ADS", { amountMinor: "130000" });
    expect(fails(next(m, current), current)).toEqual([]);
  });

  it("codes 1-13 come first: a loosening that also breaks the reserve floor reverts code 7", () => {
    const report = checkConstitution(next({ ...rina, reserveBps: 0 }), fac, NOW + DAY, V1);
    expect(constitutionViolations(report)).toEqual(["RESERVE_BELOW_FLOOR", "REPLAN_LOOSENS"]);
    expect(commitPlanOutcome(next({ ...rina, reserveBps: 0 }), fac, NOW + DAY, V1)).toEqual({ ok: false, error: "PlanInvariantViolated", code: "RESERVE_BELOW_FLOOR" });
  });

  it("fails closed: an unreadable proposed or current value fails code 14", () => {
    expect(fails(next(withLine(rina, "ADS", { perTxCapMinor: "3e4" })))).toContain("REPLAN_LOOSENS");
    expect(fails(next(rina), withCurrentLine(V1, "ADS", { perTxCapMinor: "-1" }))).toEqual(["REPLAN_LOOSENS"]);
    expect(fails({ ...next(rina), lines: "junk" as unknown as PlanManifest["lines"] })).toContain("REPLAN_LOOSENS");
  });
});

describe("replanLoosenings (what code 14 found)", () => {
  it("is empty for a tighten-only re-commit", () => {
    expect(replanLoosenings(next(withLine(rina, "ADS", { perTxCapMinor: "20000" })), V1)).toEqual([]);
  });

  it("names each loosening with its current and proposed value", () => {
    const m = next({ ...withLine(rina, "ADS", { perTxCapMinor: "30001", pacing: undefined }), reserveBps: 400 });
    expect(replanLoosenings(m, { ...V1, reserveBps: 500 })).toEqual([
      { rule: "RESERVE_LOWERED", current: 500, proposed: 400 },
      { rule: "PER_TX_CAP_RAISED", lineKey: "ADS", current: "30000", proposed: "30001" },
      { rule: "PACING_SWITCHED", lineKey: "ADS", current: "7500", proposed: "0" },
    ]);
  });
});

describe("commitPlanOutcome (the revert commitPlan gets)", () => {
  it("first commit ok; replay of v1 → StalePlan; loosening v2 → PlanInvariantViolated(REPLAN_LOOSENS); tighten-only v2 ok", () => {
    expect(commitPlanOutcome(rina, fac, NOW, null)).toEqual({ ok: true });
    expect(commitPlanOutcome(rina, fac, NOW + DAY, V1)).toEqual({ ok: false, error: "StalePlan" });
    const loosen = next(withLine(rina, "ADS", { validUntil: String(BigInt(lineOf(rina, "ADS").validUntil) + DAY) }));
    expect(commitPlanOutcome(loosen, fac, NOW + DAY, V1)).toEqual({ ok: false, error: "PlanInvariantViolated", code: "REPLAN_LOOSENS" });
    expect(commitPlanOutcome(next(withLine(rina, "ADS", { perTxCapMinor: "20000" })), fac, NOW + DAY, V1)).toEqual({ ok: true });
  });
});
