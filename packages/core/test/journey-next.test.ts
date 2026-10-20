/**
 * The Next step sentences (UX-PLAN §3): one per key, shared by the web bar and the server's "what next" reply. Every
 * sentence is plain, at most 100 characters once filled, passes the wording lint, and the server picks a key for every
 * journey stage without a value it can't know (the amount ready, the wait left, the balance).
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NEXT_STEP_KEYS, NEXT_STEP_TEXT, deriveJourney, fillNextStep, stageNextStep, type NextStepKey } from "../src/journey/index";
import { JOURNEY_STAGES } from "../src/schemas/enums";
import type { JourneyFacts } from "../src/schemas/journey";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const { checkText } = (await import(join(ROOT, "scripts/lint-wording/index.mjs"))) as { checkText: (text: string) => readonly { term: string }[] };

const W1 = "supplier-wqk3vt7ma2xrb";
const base: JourneyFacts = {
  facilityId: "fac-mei",
  persona: "founder:mei",
  draftId: null,
  planStatus: null,
  founderKeyActive: true,
  search: null,
  pickedSupplierIds: [],
  terms: null,
  order: null,
  now: "2026-10-20T08:00:00Z",
};
const committed: JourneyFacts = { ...base, draftId: "draft-mei-001", planStatus: "COMMITTED" };
const ready: JourneyFacts = { ...committed, search: { searchId: "search-1", status: "READY", origin: "web" } };
const used = { termsId: "terms-1", supplierId: W1, status: "USED" as const };
const order = { orderId: "order-wqk3vt7ma2xrb-001", supplierId: W1, bound: true, coolingEndsAt: "2026-10-20T08:02:00Z", firstPaid: false };

const VALUES = { ready: "4,000 BU", wait: "0:09", balance: "1,750 BU" };

describe("NEXT_STEP_TEXT", () => {
  it("has one plain sentence per key, at most 100 characters filled, and passes the wording lint", () => {
    for (const key of NEXT_STEP_KEYS) {
      const filled = fillNextStep(key, VALUES);
      expect(filled.length, key).toBeLessThanOrEqual(100);
      expect(filled, key).not.toMatch(/[{}]/);
      expect(checkText(filled), filled).toEqual([]);
      expect(checkText(fillNextStep(key)), key).toEqual([]);
      expect(filled.toLowerCase(), key).not.toContain("the agent");
    }
  });

  it("fills the amount, the wait and the balance, and falls back to a plain sentence without them", () => {
    expect(fillNextStep("find", VALUES)).toBe("4,000 BU is ready to spend. Next, find a supplier.");
    expect(fillNextStep("safety-wait", VALUES)).toBe("Safety wait: the deposit is paid automatically in 0:09. You can pause payments on the order card.");
    expect(fillNextStep("pay-balance", VALUES)).toBe("Sign to pay the balance of 1,750 BU.");
    for (const key of ["find", "safety-wait", "pay-balance"] as const) expect(fillNextStep(key), key).not.toMatch(/[{}]/);
    expect(fillNextStep("find")).toBe("Your plan is active. Next, find a supplier.");
  });

  it("keys without values ignore them", () => {
    expect(fillNextStep("passkey", VALUES)).toBe(NEXT_STEP_TEXT.passkey);
  });
});

describe("stageNextStep (the server's view: facts only)", () => {
  const key = (f: JourneyFacts): NextStepKey => stageNextStep(deriveJourney(f));

  it("names a step for every stage", () => {
    const seen = new Set(
      [
        base,
        { ...base, draftId: "d" },
        { ...base, draftId: "d", founderKeyActive: false },
        { ...base, draftId: "d", planStatus: "SUBMITTED" as const },
        committed,
        { ...committed, search: { searchId: "s", status: "PENDING" as const, origin: "web" as const } },
        ready,
        { ...ready, pickedSupplierIds: [W1] },
        { ...ready, pickedSupplierIds: [W1], termsDraft: { supplierId: W1 } },
        { ...ready, terms: { ...used, status: "CONFIRMED" as const } },
        { ...ready, terms: used, order: { ...order, bound: false, coolingEndsAt: null } },
        { ...ready, terms: used, order },
        { ...ready, terms: used, order: { ...order, coolingEndsAt: "2026-10-20T07:00:00Z" } },
      ].map((f) => deriveJourney(f).stage),
    );
    expect([...seen].sort()).toEqual([...JOURNEY_STAGES].sort());
  });

  it("maps each stage to its row of the plan's table", () => {
    expect(key(base)).toBe("intake");
    expect(key({ ...base, draftId: "d" })).toBe("sign-plan");
    expect(key({ ...base, draftId: "d", planStatus: "REVERTED" })).toBe("plan-refused");
    expect(key({ ...base, draftId: "d", founderKeyActive: false })).toBe("key-needed");
    expect(key({ ...base, draftId: "d", planStatus: "SUBMITTED" })).toBe("plan-saving");
    expect(key(committed)).toBe("find");
    expect(key({ ...committed, search: { searchId: "s", status: "FAILED", origin: "web" } })).toBe("search-failed");
    expect(key({ ...committed, search: { searchId: "s", status: "PENDING", origin: "web" } })).toBe("searching");
    expect(key(ready)).toBe("pick");
    expect(key({ ...ready, pickedSupplierIds: [W1] })).toBe("message");
    expect(key({ ...ready, termsDraft: { supplierId: W1 } })).toBe("deal");
    expect(key({ ...ready, terms: { ...used, status: "CONFIRMED" } })).toBe("sign-order");
    expect(key({ ...ready, terms: used, order: { ...order, bound: false, coolingEndsAt: null } })).toBe("order-saving");
    expect(key({ ...ready, terms: used, order })).toBe("safety-wait");
    const after = { ...order, coolingEndsAt: "2026-10-20T07:00:00Z" };
    expect(key({ ...ready, terms: used, order: after })).toBe("paying");
    expect(key({ ...ready, terms: used, order: { ...after, firstPaid: true } })).toBe("in-transit");
    expect(key({ ...ready, terms: used, order: { ...after, firstPaid: true, balancePaid: true } })).toBe("done");
  });

  it("a pause overrides every step once the plan is committed, as the web bar does (rcfix-journey A-7)", () => {
    // The safety wait no longer says the deposit is paid automatically while payments are paused.
    expect(key({ ...ready, terms: used, order, paused: true })).toBe("paused");
    expect(fillNextStep(key({ ...ready, terms: used, order, paused: true }))).toBe(NEXT_STEP_TEXT.paused);
    const after = { ...order, coolingEndsAt: "2026-10-20T07:00:00Z" };
    for (const f of [committed, ready, { ...ready, terms: used, order: after }, { ...ready, terms: used, order: { ...after, firstPaid: true } }]) {
      expect(key({ ...f, paused: true })).toBe("paused");
    }
    // Before the plan is committed nothing can be paid, so the step stays the plan's own (web: beforePlan).
    expect(key({ ...base, paused: true })).toBe("intake");
    expect(key({ ...base, draftId: "d", paused: true })).toBe("sign-plan");
    expect(key({ ...base, draftId: "d", planStatus: "SUBMITTED", paused: true })).toBe("plan-saving");
    // Not paused (or absent): unchanged.
    expect(key({ ...ready, terms: used, order, paused: false })).toBe("safety-wait");
  });
});
