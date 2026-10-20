/**
 * deriveJourney (VISION-DECISIONS §3, v-chat-server brief 1): every stage from facts alone, including the transitional
 * ones (founder key pending, plan SUBMITTED / REVERTED, order not yet bound, cooling), and malformed facts refused.
 */
import { describe, expect, it } from "vitest";
import { deriveJourney, hasOrder, planSigned, plannerStage, readHistory } from "../src/journey/index";
import { JOURNEY_STAGES, type JourneyStage } from "../src/schemas/enums";
import type { JourneyFacts } from "../src/schemas/journey";

const NOW = "2026-10-20T08:00:00Z";
const W1 = "supplier-wqk3vt7ma2xrb";
const W2 = "supplier-wabcdefgh2345";

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
  now: NOW,
};
const committed: JourneyFacts = { ...base, draftId: "draft-mei-001", planStatus: "COMMITTED" };
const ready = { searchId: "search-mei-001", status: "READY", origin: "web" } as const;
const order = (o: Partial<NonNullable<JourneyFacts["order"]>>): JourneyFacts["order"] => ({
  orderId: "order-wqk3vt7ma2xrb-001",
  supplierId: W1,
  bound: true,
  coolingEndsAt: "2026-10-20T08:02:00Z",
  firstPaid: false,
  ...o,
});
const used = { termsId: "terms-mei-001", supplierId: W1, status: "USED" } as const;

const CASES: readonly [string, JourneyFacts, JourneyStage][] = [
  ["no draft", base, "INTAKE"],
  ["a draft, key active", { ...base, draftId: "draft-mei-001" }, "NEEDS_REVIEW"],
  ["a draft awaiting its signature", { ...base, draftId: "draft-mei-001", planStatus: "PENDING_SIGNATURE" }, "NEEDS_REVIEW"],
  ["a draft, no active founder key", { ...base, draftId: "draft-mei-001", founderKeyActive: false }, "FOUNDER_KEY_PENDING"],
  ["the plan SUBMITTED", { ...base, draftId: "draft-mei-001", planStatus: "SUBMITTED" }, "PLAN_PENDING"],
  ["the chain REVERTED the plan", { ...base, draftId: "draft-mei-001", planStatus: "REVERTED" }, "NEEDS_REVIEW"],
  ["the plan COMMITTED", committed, "PLAN_ACTIVE"],
  ["a FAILED search", { ...committed, search: { ...ready, status: "FAILED" } }, "PLAN_ACTIVE"],
  ["a PENDING search", { ...committed, search: { ...ready, status: "PENDING" } }, "SEARCHING"],
  ["a READY search", { ...committed, search: ready }, "CANDIDATES"],
  ["a READY catalog list", { ...committed, search: { ...ready, origin: "catalog" } }, "CANDIDATES"],
  ["picked suppliers", { ...committed, search: ready, pickedSupplierIds: [W1, W2] }, "PICKED"],
  ["picked, but a new search runs", { ...committed, search: { ...ready, status: "PENDING" }, pickedSupplierIds: [W1] }, "SEARCHING"],
  ["a terms form open (start_terms, nothing saved)", { ...committed, search: ready, pickedSupplierIds: [W1], termsDraft: { supplierId: W1 } }, "TERMS_DRAFT"],
  ["terms CONFIRMED", { ...committed, search: ready, terms: { ...used, status: "CONFIRMED" } }, "TERMS_CONFIRMED"],
  ["a correction after CONFIRMED terms", { ...committed, search: ready, terms: { ...used, status: "CONFIRMED" }, termsDraft: { supplierId: W1 } }, "TERMS_DRAFT"],
  ["SUPERSEDED terms only", { ...committed, search: ready, pickedSupplierIds: [W1], terms: { ...used, status: "SUPERSEDED" } }, "PICKED"],
  ["terms USED, the order not in the facts yet", { ...committed, search: ready, terms: used }, "ORDER_PENDING"],
  ["the order submitted, not bound", { ...committed, terms: used, order: order({ bound: false, coolingEndsAt: null }) }, "ORDER_PENDING"],
  ["bound, cooling not over", { ...committed, terms: used, order: order({}) }, "COOLING"],
  ["bound, cooling over", { ...committed, terms: used, order: order({ coolingEndsAt: "2026-10-20T07:59:00Z" }) }, "OPERATING"],
  ["bound, cooling ends exactly now", { ...committed, terms: used, order: order({ coolingEndsAt: NOW }) }, "OPERATING"],
  ["bound, deposit paid", { ...committed, terms: used, order: order({ coolingEndsAt: "2026-10-20T07:00:00Z", firstPaid: true }) }, "OPERATING"],
  ["an order outranks a replan in flight", { ...committed, planStatus: "SUBMITTED", terms: used, order: order({}) }, "COOLING"],
  // audit run-9 critic gap 1: the payee binding never landed (the worker cancelled it): back to choosing a supplier.
  ["the binding failed: back to the list", { ...committed, search: ready, terms: used, order: order({ bound: false, coolingEndsAt: null, bindFailed: true }) }, "CANDIDATES"],
  ["the binding failed, no list", { ...committed, terms: used, order: order({ bound: false, coolingEndsAt: null, bindFailed: true }) }, "PLAN_ACTIVE"],
  ["the binding failed, another supplier picked", { ...committed, search: ready, pickedSupplierIds: [W2], terms: used, order: order({ bound: false, coolingEndsAt: null, bindFailed: true }) }, "PICKED"],
  ["bindFailed false is an ordinary order", { ...committed, terms: used, order: order({ bound: false, coolingEndsAt: null, bindFailed: false }) }, "ORDER_PENDING"],
];

describe("deriveJourney", () => {
  it.each(CASES)("%s → %s", (_name, facts, stage) => {
    const state = deriveJourney(facts);
    expect(state.stage).toBe(stage);
    expect(state.facts).toEqual(facts);
  });

  it("covers every journey stage", () => {
    expect(new Set(CASES.map(([, , s]) => s))).toEqual(new Set(JOURNEY_STAGES));
  });

  it("refuses malformed facts instead of guessing a stage (fail closed)", () => {
    expect(() => deriveJourney({ ...base, planStatus: "LIVE" } as unknown as JourneyFacts)).toThrow();
    expect(() => deriveJourney({ ...base, extra: 1 } as unknown as JourneyFacts)).toThrow();
    expect(() => deriveJourney({ ...base, pickedSupplierIds: ["not a supplier"] } as unknown as JourneyFacts)).toThrow();
  });

  it("groups stages for the router and the replies", () => {
    expect(JOURNEY_STAGES.filter(plannerStage)).toEqual(["INTAKE", "NEEDS_REVIEW", "FOUNDER_KEY_PENDING"]);
    expect(JOURNEY_STAGES.filter(hasOrder)).toEqual(["ORDER_PENDING", "COOLING", "OPERATING"]);
    expect(JOURNEY_STAGES.filter((s) => !planSigned(s))).toEqual(["INTAKE", "NEEDS_REVIEW", "FOUNDER_KEY_PENDING"]);
  });
});

describe("readHistory", () => {
  const a = (n: number) => `01a14202-2800-7000-8000-${String(n).padStart(12, "0")}`;
  const user = (action: object) => ({ role: "user", parts: [{ type: "text", text: "x" }, { type: "data-action", data: { action } }] });
  const assistant = (...parts: object[]) => ({ role: "assistant", parts: [{ type: "text", text: "y" }, ...parts] });
  const prefill = (supplierId: string) => ({ type: "data-terms", data: { supplierId, searchId: "search-1", milestones: null, preset: null, source: "none", question: null, presetAvailability: [] } });

  it("collects used ids, the latest pick, button labels and the latest list", () => {
    const h = readHistory([
      assistant({ type: "data-next", data: { actions: [{ label: "Find suppliers", action: { type: "start_search", actionId: a(1) } }] } }),
      user({ type: "start_search", actionId: a(1) }),
      assistant({ type: "data-search", id: "s1", data: { searchId: "search-1" } }),
      user({ type: "pick", actionId: a(2), searchId: "search-1", supplierIds: [W1] }),
      user({ type: "pick", actionId: a(3), searchId: "search-1", supplierIds: [W2, W1] }),
    ]);
    expect([...h.usedActionIds]).toEqual([a(1), a(2), a(3)]);
    expect(h.lastPick).toEqual({ searchId: "search-1", supplierIds: [W2, W1] });
    expect(h.buttonLabel(a(1))).toBe("Find suppliers");
    expect(h.buttonLabel(a(2))).toBeNull();
    expect(h.latestList).toEqual({ origin: "web", id: "search-1" });
  });

  it("an open terms pre-fill closes on terms_saved and on a new list", () => {
    const opened = [assistant({ type: "data-search", data: { searchId: "search-1" } }), assistant(prefill(W1))];
    expect(readHistory(opened).openTermsSupplierId).toBe(W1);
    expect(readHistory([...opened, user({ type: "terms_saved", actionId: a(4), termsId: "terms-1" })]).openTermsSupplierId).toBeNull();
    expect(readHistory([...opened, assistant({ type: "data-shortlist", data: { requestId: "sl-1" } })]).openTermsSupplierId).toBeNull();
    const signCard = { type: "data-sign", data: { kind: "SupplierApproval", refId: "terms-1", title: "t", summary: "s", cta: "c" } };
    const corrected = readHistory([...opened, user({ type: "terms_saved", actionId: a(4), termsId: "terms-1" }), assistant(signCard), assistant(prefill(W2))]);
    expect(corrected.openTermsSupplierId).toBe(W2);
    expect(corrected.lastSavedTermsId).toBe("terms-1");
  });

  it("a press counts only if its reply shows it took effect (or it is being answered now)", () => {
    const refusedPick = readHistory([user({ type: "pick", actionId: a(5), searchId: "search-1", supplierIds: [W1] }), assistant()]);
    expect(refusedPick.lastPick).toBeNull();
    expect(refusedPick.usedActionIds.has(a(5))).toBe(true);
    const enquiry = { type: "data-enquiry", data: { supplierIds: [W1], subject: "s", body: "b" } };
    expect(readHistory([user({ type: "pick", actionId: a(5), searchId: "search-1", supplierIds: [W1] }), assistant(enquiry)]).lastPick).toEqual({ searchId: "search-1", supplierIds: [W1] });
    expect(readHistory([user({ type: "pick", actionId: a(5), searchId: "search-1", supplierIds: [W1] })]).lastPick).not.toBeNull();
    const opened = [assistant({ type: "data-search", data: { searchId: "search-1" } }), assistant(prefill(W1))];
    const forged = readHistory([...opened, user({ type: "terms_saved", actionId: a(6), termsId: "terms-forged" }), assistant()]);
    expect(forged.openTermsSupplierId).toBe(W1);
    expect(forged.savedTermsIds).toEqual([]);
  });

  it("ignores parts that do not parse and data-action on assistant messages", () => {
    const h = readHistory([
      { role: "assistant", parts: [{ type: "data-action", data: { action: { type: "start_search", actionId: a(9) } } }] },
      { role: "user", parts: [{ type: "data-action", data: { action: { type: "wire_money", actionId: a(8) } } }] },
      assistant({ type: "data-plan-draft", data: { draftId: "draft-1" } }),
    ]);
    expect(h.usedActionIds.size).toBe(0);
    expect(h.latestDraftId).toBe("draft-1");
  });
});
