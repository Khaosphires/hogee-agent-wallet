import { describe, expect, it } from "vitest";
import {
  CompileError,
  PlanDraft,
  RINA_COMMIT_AT,
  RINA_LINES,
  RINA_PLAN,
  RINA_PLATFORM_REGISTRY,
  RINA_STAGES,
  adsPacingMinor,
  blastRadius,
  ZERO_HEX32,
  checkConstitution,
  committedPlanOf,
  compilePlan,
  computeLandedCost,
  constitutionOk,
  examplePlanManifest,
  fakeHex32,
  planHash,
  rinaSupplierABinding,
  type CompileInput,
  type PlanIntent,
} from "../src/index";
import { TEST_PACK_ID } from "./fixtures/packs";
import { RINA_COMPILE_FACILITY, RINA_COMPILE_INPUT } from "./fixtures/rina-compile";

const NOW = BigInt(RINA_COMMIT_AT);
const DAY = 86_400n;
const withIntent = (patch: Partial<PlanIntent>, base: CompileInput = RINA_COMPILE_INPUT): CompileInput => ({
  ...base,
  intent: { ...base.intent, ...patch } as PlanIntent,
});
const line = (input: CompileInput, key: string) => compilePlan(input).manifest.lines.find((l) => l.lineKey === key);
const codeOf = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    return e instanceof CompileError ? e.code : `not a CompileError: ${String(e)}`;
  }
  return undefined;
};

describe("compilePlan: Rina (§26.2)", () => {
  const draft = compilePlan(RINA_COMPILE_INPUT);
  const m = draft.manifest;

  it("is a valid PlanDraft and passes every constitution rule", () => {
    expect(PlanDraft.parse(draft)).toEqual(draft);
    expect(constitutionOk(draft.constitutionReport)).toBe(true);
    expect(checkConstitution(m, RINA_COMPILE_FACILITY, NOW)).toEqual(draft.constitutionReport);
  });

  it("reproduces the §26.2 lines, caps, pacing, payees, reserve, stages and expiries", () => {
    expect(m.totalMinor).toBe("1000000");
    expect(m.reserveBps).toBe(RINA_PLAN.reserveBps);
    expect(m.lines.map((l) => [l.lineKey, l.amountMinor, l.perTxCapMinor, l.windowCapMinor, l.pacing?.amountMinor ?? null, l.escrowOnly, l.payeeIds])).toEqual(
      RINA_LINES.map((l) => [l.lineKey, l.amountMinor, l.perTxCapMinor, l.windowCapMinor, l.pacingPerDayMinor ?? null, l.escrowOnly, [...l.payeeIds]]),
    );
    expect(m.lines.every((l) => l.windowSeconds === RINA_PLAN.windowSeconds && l.validUntil === RINA_PLAN.validUntil)).toBe(true);
    expect(m.stages).toEqual(RINA_STAGES.map((s) => ({ ...s, gate: s.gate ? { ...s.gate } : null })));
    expect(m.agent.expiresAt).toBe(RINA_PLAN.agentExpiresAt);
  });

  it("on-chain values equal the frozen example manifest (core RINA): same lines, stages and agent expiry", () => {
    const onchain = (x: typeof m) => ({ ...committedPlanOf(x, ZERO_HEX32), planId: ZERO_HEX32, countryPackHash: ZERO_HEX32, agent: { ...x.agent, address: `0x${"0".repeat(40)}` } });
    expect(onchain(m)).toEqual(onchain(examplePlanManifest));
  });

  it("derives the G0 ADS pacing (§1 #1): 7,500/day = 60,000 / 8, as core RINA; 10,000 and 8,500 break the window cap", () => {
    const ads = m.lines.find((l) => l.lineKey === "ADS");
    const pacing = BigInt(ads?.pacing?.amountMinor ?? "0");
    const windowCap = BigInt(ads?.windowCapMinor ?? "0");
    expect(pacing).toBe(7_500n);
    expect((pacing * BigInt(ads?.windowSeconds ?? "0")) / DAY <= windowCap).toBe(true); // the required invariant
    expect(pacing * 8n <= windowCap).toBe(true); // 7 daily slots + 1 boundary slot from tick jitter
    expect(10_000n * 7n > windowCap).toBe(true); // §26.2 as written: the 7th slot reverts CapExceeded
    expect(8_500n * 8n > windowCap).toBe(true); // G0 proposal: fails when jitter puts 8 slots in one window
    expect(pacing <= BigInt(ads?.perTxCapMinor ?? "0")).toBe(true);
  });

  it("baseline = rules only (no emphasis, standard pacing); diff lists only what the emphasis changed", () => {
    expect(draft.baseline.aigc.model).toBe("none:rules-baseline");
    expect(draft.baseline.lines.map((l) => l.amountMinor)).toEqual(["450000", "150000", "80000", "120000", "50000", "150000"]);
    expect(draft.diff).toEqual([
      { path: "/lines/0/amountMinor", baseline: "450000", proposed: "500000" },
      { path: "/lines/0/perTxCapMinor", baseline: "112500", proposed: "125000" },
      { path: "/lines/0/windowCapMinor", baseline: "225000", proposed: "250000" },
      { path: "/lines/5/amountMinor", baseline: "150000", proposed: "100000" },
      { path: "/lines/5/perTxCapMinor", baseline: "37500", proposed: "25000" },
      { path: "/lines/5/windowCapMinor", baseline: "75000", proposed: "50000" },
    ]);
  });

  it("blast radius: 250,000 (the three platform-payee lines), 125,000 per 7-day window", () => {
    expect(draft.blastRadiusMinor).toBe("250000");
    const br = blastRadius(m, RINA_PLATFORM_REGISTRY, NOW);
    expect(br.perWindowMinor).toBe("125000");
    expect(br.stageCapMinor).toBe("400000");
    expect(br.lines.filter((l) => l.reachableMinor !== "0").map((l) => [l.lineKey, l.reachableMinor, l.perWindowMinor])).toEqual([
      ["LOGISTICS", "80000", "40000"],
      ["ADS", "120000", "60000"],
      ["PLATFORM_FEES", "50000", "25000"],
    ]);
  });

  it("blast radius after supplier A is bound adds only the pre-signed sample + deposit, capped by stage 1", () => {
    const registry = [...RINA_PLATFORM_REGISTRY, rinaSupplierABinding(NOW)];
    const v2 = compilePlan({ ...RINA_COMPILE_INPUT, facility: { ...RINA_COMPILE_FACILITY, payees: registry } });
    expect(v2.manifest.lines[0]?.payeeIds).toEqual(["supplier-a"]);
    expect(v2.blastRadiusMinor).toBe("400000"); // 80k + 120k + 50k + (30k + 120k) = 400k = stage 1
    const lowStage = { ...v2.manifest, stages: [{ ...v2.manifest.stages[0]!, releaseMinor: "300000" }, v2.manifest.stages[1]!] };
    expect(blastRadius(lowStage, registry, NOW).totalMinor).toBe("300000");
  });

  it("blast radius shrinks to one window when the line expires within the first window", () => {
    const short = { ...m, lines: m.lines.map((l) => ({ ...l, validUntil: String(NOW + 3n * DAY) })) };
    expect(blastRadius(short, RINA_PLATFORM_REGISTRY, NOW).totalMinor).toBe("125000");
    expect(blastRadius(m, RINA_PLATFORM_REGISTRY, BigInt(m.agent.expiresAt)).totalMinor).toBe("0");
  });

  it("is deterministic: same input → same draft and planHash, whatever the input key order", () => {
    const reordered = Object.fromEntries(Object.entries(RINA_COMPILE_INPUT.intent).reverse()) as PlanIntent;
    expect(compilePlan(RINA_COMPILE_INPUT)).toEqual(draft);
    expect(planHash(compilePlan({ ...RINA_COMPILE_INPUT, intent: reordered }).manifest)).toBe(planHash(m));
  });
});

describe("compilePlan: rules derived from code, never from the LLM", () => {
  it("rejects an intent that tries to carry payees or amounts (strict schema, D6)", () => {
    const smuggled = { ...RINA_COMPILE_INPUT.intent, payeeIds: ["0xevil"], perTxCapMinor: "1000000" } as unknown as PlanIntent;
    expect(codeOf(() => compilePlan({ ...RINA_COMPILE_INPUT, intent: smuggled }))).toBe("INVALID_INPUT");
  });

  it("caps the budget at the facility cap and says so", () => {
    const d = compilePlan(withIntent({ budgetCeilingMinor: "2500000" }));
    expect(d.manifest.totalMinor).toBe("1000000");
    expect(d.manifest.rules.some((r) => r.ruleId === "budget.capped")).toBe(true);
  });

  it("normalises any emphasis mix to exactly the budget, whole BU per line, remainder to contingency", () => {
    const d = compilePlan(withIntent({ budgetCeilingMinor: "987654", lineEmphasis: { SUPPLIER: "high", PACKAGING: "high", LOGISTICS: "high", ADS: "high", CONTINGENCY: "high" } }));
    const amounts = d.manifest.lines.map((l) => BigInt(l.amountMinor));
    expect(amounts.reduce((a, b) => a + b, 0n)).toBe(987_654n);
    expect(d.manifest.lines.slice(0, -1).every((l) => BigInt(l.amountMinor) % 100n === 0n)).toBe(true);
    expect(constitutionOk(d.constitutionReport)).toBe(true);
  });

  it("conservative pacing is half of standard", () => {
    expect(line(withIntent({ adsPacing: "conservative" }), "ADS")?.pacing?.amountMinor).toBe("3750");
    expect(adsPacingMinor(60_000n, 30_000n, "standard")).toBe(7_500n);
    expect(adsPacingMinor(60_000n, 5_000n, "standard")).toBe(5_000n); // never above perTxCap
  });

  it("horizon 30: lines end at day 30, the agent key outlives the judging window by a day", () => {
    const d = compilePlan(withIntent({ horizonDays: 30 }));
    expect(d.manifest.lines[0]?.validUntil).toBe(String(NOW + 30n * DAY));
    expect(d.manifest.agent.expiresAt).toBe(String(BigInt(RINA_COMPILE_FACILITY.judgingWindowEnd) + DAY));
    expect(d.manifest.stages[1]?.gate?.deadline).toBe(String(NOW + 15n * DAY));
  });

  it("horizon 90 sits exactly on the 90-day limit", () => {
    const d = compilePlan(withIntent({ horizonDays: 90 }));
    expect(d.manifest.lines[0]?.validUntil).toBe(String(NOW + 90n * DAY));
    expect(d.manifest.agent.expiresAt).toBe(String(NOW + 90n * DAY));
  });

  it("a stricter facility floor raises the reserve", () => {
    const d = compilePlan({ ...RINA_COMPILE_INPUT, facility: { ...RINA_COMPILE_FACILITY, reserveFloorBps: 800 } });
    expect(d.manifest.reserveBps).toBe(800);
  });

  it("platform payees follow the sell channel; own-site plans get no Shopee payees", () => {
    const d = compilePlan(withIntent({ sellChannel: "own_site" }));
    expect(d.manifest.lines.every((l) => l.payeeIds.length === 0)).toBe(true);
    expect(d.manifest.lines.find((l) => l.lineKey === "ADS")?.purpose).toMatch(/website/);
    expect(d.blastRadiusMinor).toBe("0");
  });

  it("payees are sorted and unrestricted platform payees apply to every channel", () => {
    const registry = [...RINA_PLATFORM_REGISTRY, { payeeId: "ads-alt", source: "platform" as const, lineKeys: ["ADS" as const] }];
    const d = compilePlan({ ...RINA_COMPILE_INPUT, facility: { ...RINA_COMPILE_FACILITY, payees: registry } });
    expect(d.manifest.lines.find((l) => l.lineKey === "ADS")?.payeeIds).toEqual(["ads-alt", "shopee-ads"]);
  });

  it("landed cost adds sourced rules but never changes an amount", () => {
    const lc = computeLandedCost({
      quantity: 6000,
      fobUnitMinor: "1250",
      freightPerUnitMinor: "180",
      fx: { value: 0.61, sourceUrl: "https://example.invalid/bnm", retrievedAt: "2026-10-16T02:00:00Z", snippetHash: fakeHex32("t:fx"), evidence: "tier1", sourceType: "mock" },
      dutyRoute: "FORM_E",
      dutyRateBps: 0,
      dutyBase: "CIF",
      importTaxRateBps: 1000,
    });
    const d = compilePlan({ ...RINA_COMPILE_INPUT, landedCost: lc });
    expect(d.manifest.lines).toEqual(compilePlan(RINA_COMPILE_INPUT).manifest.lines);
    const ids = d.manifest.rules.map((r) => r.ruleId);
    expect(ids).toContain("landed-cost.total");
    expect(ids).toContain("landed-cost.supplier-line-short"); // CIF 5,259,969 > SUPPLIER 500,000
    expect(d.manifest.rules.find((r) => r.ruleId === "landed-cost.total")?.source?.evidence).toBe("tier1");
  });

  it("numbers a replan only against the plan it replaces (test/compiler-replan.test.ts); without it, refuses", () => {
    const prev = planHash(compilePlan(RINA_COMPILE_INPUT).manifest);
    expect(() => compilePlan({ ...RINA_COMPILE_INPUT, ids: { ...RINA_COMPILE_INPUT.ids, version: 2, prevPlanHash: prev } })).toThrow(/needs `current`/);
  });
});

describe("compilePlan: refusals", () => {
  it.each([
    ["budget below 100 BU", withIntent({ budgetCeilingMinor: "9999" }), "BUDGET_TOO_SMALL"],
    ["intent country differs from the pack", { ...RINA_COMPILE_INPUT, countryPack: TEST_PACK_ID }, "COUNTRY_MISMATCH"],
    ["facility currency differs from the pack", { ...RINA_COMPILE_INPUT, facility: { ...RINA_COMPILE_FACILITY, currency: "SGD" } }, "CURRENCY_MISMATCH"],
    ["judging window beyond now + 90 days", { ...RINA_COMPILE_INPUT, now: String(BigInt(RINA_COMPILE_FACILITY.judgingWindowEnd) - 90n * DAY) }, "AGENT_EXPIRY_INFEASIBLE"],
    ["entity not valid for the country", withIntent({ entityType: "cv" }), "INVALID_INPUT"],
    ["facility floor above 100%", { ...RINA_COMPILE_INPUT, facility: { ...RINA_COMPILE_FACILITY, reserveFloorBps: 10_001 } }, "INVALID_INPUT"],
    ["approval fee larger than the contingency share", withIntent({ budgetCeilingMinor: "20000", productCategory: "electrical" }), "LICENSING_EXCEEDS_CONTINGENCY"],
  ] as const)("%s → %s", (_name, input, code) => {
    expect(codeOf(() => compilePlan(input as CompileInput))).toBe(code);
  });

  it("never emits a plan that would violate code 11: an unscheduled payee is kept off the escrow line", () => {
    const registry = [...RINA_PLATFORM_REGISTRY, { payeeId: "agency-x", source: "platform" as const, lineKeys: ["SUPPLIER" as const] }];
    const d = compilePlan({ ...RINA_COMPILE_INPUT, facility: { ...RINA_COMPILE_FACILITY, payees: registry } });
    expect(d.manifest.lines[0]?.payeeIds).toEqual([]);
    expect(constitutionOk(d.constitutionReport)).toBe(true);
  });

  it("regression (found by fast-check): a scheduled payee whose lifetime cap exceeds its schedule is kept off every line", () => {
    const odd = { payeeId: "a", source: "platform" as const, lineKeys: ["ADS" as const], schedule: [{ amountMinor: "100", autoRelease: true }], lifetimeCapMinor: "101" };
    const d = compilePlan({ ...RINA_COMPILE_INPUT, facility: { ...RINA_COMPILE_FACILITY, payees: [...RINA_PLATFORM_REGISTRY, odd] } });
    expect(d.manifest.lines.find((l) => l.lineKey === "ADS")?.payeeIds).toEqual(["shopee-ads"]);
    expect(constitutionOk(d.constitutionReport)).toBe(true);
  });

  it("a facility cap below the minimum budget is refused before compiling", () => {
    const tiny = { ...RINA_COMPILE_INPUT, facility: { ...RINA_COMPILE_FACILITY, capMinor: "5000" } };
    expect(codeOf(() => compilePlan(tiny))).toBe("BUDGET_TOO_SMALL");
  });
});
