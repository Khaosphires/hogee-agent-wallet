/**
 * The journey's replies (v-chat-server brief 2-3): button actions and classified text map to templated text plus data
 * parts that all pass ChatDataPart.parse; every reply ends in a next step; text paths never start a search or the
 * catalog list (only read-only effects); every text part is a template (so no seller name or model text can appear);
 * every founder-facing string passes the wording lint and every button label fits 40 characters.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUTTON,
  CFO_BUTTON,
  CFO_TEXT,
  FAILURE_TEXT,
  PRESET_BUTTON,
  SIGN,
  STAGE_TEXT,
  TEXT,
  actionLabel,
  alreadyDone,
  deriveJourney,
  effectOk,
  effectFailed,
  effectsForAction,
  effectsForSkill,
  partsForState,
  replyToAction,
  replyToSkill,
  textPrefill,
  type EffectOutcomes,
  type JourneyEnv,
  type JourneyPart,
  type PresetCheck,
} from "../src/journey/index";
import { agreedTermsWith, pickRanksLabel } from "../src/journey/templates";
import { ChatDataPart } from "../src/schemas/chat";
import { JOURNEY_STAGES, SKILLS, TERMS_PRESETS, type JourneyStage } from "../src/schemas/enums";
import { exampleChatActions } from "../src/schemas/example-data/journey";
import type { ChatAction, JourneyFacts, JourneyState, SkillCall } from "../src/schemas/journey";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const { checkText } = (await import(join(ROOT, "scripts/lint-wording/index.mjs"))) as { checkText: (text: string) => readonly { term: string }[] };

let n = 0;
const env: JourneyEnv = { newActionId: () => `01a14202-2800-7000-8000-${String((n += 1)).padStart(12, "0")}` };
const id = (k: number) => `01a14202-2800-7000-9000-${String(k).padStart(12, "0")}`;

const W1 = "supplier-wqk3vt7ma2xrb";
const W2 = "supplier-wabcdefgh2345";
const SEARCH = "search-mei-001";
const TERMS = "terms-mei-001";
const NOW = "2026-10-20T08:00:00Z";
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
const ready: JourneyFacts = { ...committed, search: { searchId: SEARCH, status: "READY", origin: "web" } };
const order = { orderId: "order-wqk3vt7ma2xrb-001", supplierId: W1, bound: true, coolingEndsAt: "2026-10-20T08:02:00Z", firstPaid: false };

/** One state per stage (plus variants). */
const STATES: Record<string, JourneyFacts> = {
  INTAKE: base,
  NEEDS_REVIEW: { ...base, draftId: "draft-mei-001" },
  REVERTED: { ...base, draftId: "draft-mei-001", planStatus: "REVERTED" },
  FOUNDER_KEY_PENDING: { ...base, draftId: "draft-mei-001", founderKeyActive: false },
  PLAN_PENDING: { ...base, draftId: "draft-mei-001", planStatus: "SUBMITTED" },
  PLAN_ACTIVE: committed,
  SEARCH_FAILED: { ...committed, search: { searchId: SEARCH, status: "FAILED", origin: "web" } },
  SEARCHING: { ...committed, search: { searchId: SEARCH, status: "PENDING", origin: "web" } },
  CANDIDATES: ready,
  CATALOG: { ...committed, search: { searchId: "sl-1", status: "READY", origin: "catalog" } },
  PICKED: { ...ready, pickedSupplierIds: [W1] },
  PICKED_TWO: { ...ready, pickedSupplierIds: [W1, W2], pickedRanks: [2, null] },
  TERMS_DRAFT: { ...ready, pickedSupplierIds: [W1], termsDraft: { supplierId: W1 } },
  TERMS_CONFIRMED: { ...ready, pickedSupplierIds: [W1], terms: { termsId: TERMS, supplierId: W1, status: "CONFIRMED" } },
  ORDER_PENDING: { ...ready, terms: { termsId: TERMS, supplierId: W1, status: "USED" }, order: { ...order, bound: false, coolingEndsAt: null } },
  COOLING: { ...ready, terms: { termsId: TERMS, supplierId: W1, status: "USED" }, order },
  OPERATING: { ...ready, terms: { termsId: TERMS, supplierId: W1, status: "USED" }, order: { ...order, coolingEndsAt: "2026-10-20T07:00:00Z", firstPaid: true } },
  BIND_FAILED: { ...ready, terms: { termsId: TERMS, supplierId: W1, status: "USED" }, order: { ...order, bound: false, coolingEndsAt: null, bindFailed: true } },
  BIND_FAILED_NO_LIST: { ...committed, terms: { termsId: TERMS, supplierId: W1, status: "USED" }, order: { ...order, bound: false, coolingEndsAt: null, bindFailed: true } },
};
const state = (k: keyof typeof STATES): JourneyState => deriveJourney(STATES[k] as JourneyFacts);

const types = (parts: readonly JourneyPart[]) => parts.map((p) => p.type);
const texts = (parts: readonly JourneyPart[]) => parts.flatMap((p) => (p.type === "text" ? [p.text] : []));
const NEXT_STEP = new Set(["data-next", "data-sign", "data-search", "data-candidates", "data-terms", "data-question"]);

const AVAILABILITY: PresetCheck[] = TERMS_PRESETS.map((preset) => ({ preset, ok: preset !== "P50_50", code: preset === "P50_50" ? "TERMS_AUTO_OVER_PER_TX" : null }));
const enquiry = { supplierIds: [W1], subject: "Enquiry: 1,000 insulated drinkware units", body: "Hello, please quote your unit price, MOQ and lead time." };

const TEMPLATE_STRINGS = new Set<string>([
  ...Object.values(STAGE_TEXT),
  ...Object.values(TEXT),
  ...Object.values(FAILURE_TEXT),
  ...Object.values(CFO_TEXT),
]);

function expectWellFormed(parts: readonly JourneyPart[]): void {
  for (const p of parts) {
    if (p.type === "text") expect(TEMPLATE_STRINGS.has(p.text)).toBe(true);
    else expect(ChatDataPart.parse(p)).toEqual(p);
  }
}

describe("partsForState", () => {
  it.each(Object.keys(STATES))("%s: templated text first, valid parts, a next step (but at intake)", (k) => {
    const s = state(k);
    const parts = partsForState(s, env);
    expect(parts[0]?.type).toBe("text");
    expectWellFormed(parts);
    if (s.stage !== "INTAKE") expect(parts.some((p) => NEXT_STEP.has(p.type) || p.type === "data-order")).toBe(true);
  });

  it("shows the right cards per stage", () => {
    expect(types(partsForState(state("NEEDS_REVIEW"), env))).toEqual(["text", "data-plan-draft", "data-sign"]);
    expect(texts(partsForState(state("REVERTED"), env))).toEqual([TEXT.planRefused]);
    expect(types(partsForState(state("SEARCHING"), env))).toEqual(["text", "data-search"]);
    expect(types(partsForState(state("CANDIDATES"), env))).toEqual(["text", "data-candidates"]);
    expect(types(partsForState(state("CATALOG"), env))).toEqual(["text", "data-shortlist", "data-next"]);
    expect(types(partsForState(state("TERMS_CONFIRMED"), env))).toEqual(["text", "data-sign"]);
    expect(types(partsForState(state("COOLING"), env))).toEqual(["text", "data-order", "data-next"]);
    expect(texts(partsForState(state("OPERATING"), env))).toEqual([TEXT.firstPaid]);
    const failed = partsForState(state("SEARCH_FAILED"), env);
    expect(texts(failed)).toEqual([TEXT.searchFailed]);
    expect(failed.at(-1)).toMatchObject({ type: "data-next", data: { actions: [{ label: BUTTON.retrySearch }, { label: BUTTON.useCatalog }] } });
  });

  it("a supplier order whose binding failed says so and goes back to choosing a supplier (audit run-9 critic gap 1)", () => {
    const listed = partsForState(state("BIND_FAILED"), env);
    expect(texts(listed)).toEqual([TEXT.bindFailed]);
    expect(types(listed)).toEqual(["text", "data-candidates"]);
    const unlisted = partsForState(state("BIND_FAILED_NO_LIST"), env);
    expect(texts(unlisted)).toEqual([TEXT.bindFailed]);
    expect(types(unlisted)).toEqual(["text", "data-next"]);
    expect(checkText(TEXT.bindFailed)).toEqual([]);
  });

  it("labels several picks by rank (or by position when the rank is gone)", () => {
    const next = partsForState(state("PICKED_TWO"), env).at(-1);
    expect(next).toMatchObject({ type: "data-next", data: { actions: [{ label: "I made a deal with #2" }, { label: "I made a deal (pick 2)" }] } });
  });

  it("gives every button a fresh action id", () => {
    const ids = [partsForState(state("PLAN_ACTIVE"), env), partsForState(state("PLAN_ACTIVE"), env)].flatMap((ps) =>
      ps.flatMap((p) => (p.type === "data-next" ? p.data.actions.map((a) => a.action.actionId) : [])),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});

const act = <T extends ChatAction["type"]>(type: T, extra: Omit<Extract<ChatAction, { type: T }>, "type" | "actionId">, k = 1) =>
  ({ type, actionId: id(k), ...extra }) as Extract<ChatAction, { type: T }>;

describe("actions", () => {
  it("start_search: one START_SEARCH once the plan is signed, then data-search", () => {
    expect(effectsForAction(act("start_search", {}), state("NEEDS_REVIEW"))).toEqual([]);
    expect(effectsForAction(act("start_search", { quantity: 500 }), state("PLAN_ACTIVE"))).toEqual([{ kind: "START_SEARCH", quantity: 500 }]);
    const r = replyToAction(act("start_search", {}), state("SEARCHING"), { search: effectOk({ searchId: SEARCH }) }, env);
    expect(types(r.parts)).toEqual(["text", "data-search"]);
    expectWellFormed(r.parts);
  });

  it("start_search refused: says why, offers to retry or use the catalog; not allowed: says plan first", () => {
    const r = replyToAction(act("start_search", {}), state("PLAN_ACTIVE"), { search: effectFailed("BUSY") }, env);
    expect(texts(r.parts)).toEqual([FAILURE_TEXT.BUSY]);
    expect(r.parts.at(-1)?.type).toBe("data-next");
    expect(texts(replyToAction(act("start_search", {}), state("INTAKE"), {}, env).parts)[0]).toBe(TEXT.needPlanFirst);
  });

  it("use_catalog: the labelled catalog list and a way back to the web", () => {
    const r = replyToAction(act("use_catalog", {}), state("CATALOG"), { catalog: effectOk({ requestId: "sl-1", status: "READY" }) }, env);
    expect(types(r.parts)).toEqual(["text", "data-shortlist", "data-next"]);
    expect(texts(r.parts)).toEqual([TEXT.catalogReady]);
  });

  it("show_candidates: candidates when READY, the search card while PENDING, stale for another search", () => {
    expect(types(replyToAction(act("show_candidates", { searchId: SEARCH }), state("CANDIDATES"), {}, env).parts)).toEqual(["text", "data-candidates"]);
    expect(types(replyToAction(act("show_candidates", { searchId: SEARCH }), state("SEARCHING"), {}, env).parts)).toEqual(["text", "data-search"]);
    expect(texts(replyToAction(act("show_candidates", { searchId: "search-old" }), state("CANDIDATES"), {}, env).parts)[0]).toBe(TEXT.stale);
  });

  it("pick: ENQUIRY only for the live READY web search, then the enquiry and an I've-agreed-terms button", () => {
    const pick = act("pick", { searchId: SEARCH, supplierIds: [W1] });
    expect(effectsForAction(pick, state("CANDIDATES"))).toEqual([{ kind: "ENQUIRY", searchId: SEARCH, supplierIds: [W1] }]);
    expect(effectsForAction({ ...pick, searchId: "search-old" }, state("CANDIDATES"))).toEqual([]);
    expect(effectsForAction(act("pick", { searchId: "sl-1", supplierIds: ["supplier-a"] }), state("CATALOG"))).toEqual([]);
    const r = replyToAction(pick, state("PICKED"), { enquiry: effectOk(enquiry) }, env);
    expect(types(r.parts)).toEqual(["text", "data-enquiry", "data-next"]);
    expect(r.parts.at(-1)).toMatchObject({ data: { actions: [{ label: BUTTON.agreedTerms, action: { type: "start_terms", supplierId: W1 } }] } });
    expect(texts(replyToAction(act("pick", { searchId: "sl-1", supplierIds: ["supplier-a"] }), state("CATALOG"), {}, env).parts)[0]).toBe(TEXT.catalogPick);
  });

  it("start_terms: the named preset pre-filled (flagged when it may not fit), else nothing", () => {
    const start = act("start_terms", { supplierId: W1, preset: "P30_70" });
    expect(effectsForAction(start, state("PICKED"))).toEqual([{ kind: "TERMS_PREFILL", searchId: SEARCH, supplier: { supplierId: W1 } }]);
    expect(effectsForAction(start, state("COOLING"))).toEqual([]);
    const outcomes: EffectOutcomes = { prefill: effectOk({ supplierId: W1, availability: AVAILABILITY }) };
    const r = replyToAction(start, state("TERMS_DRAFT"), outcomes, env);
    expect(types(r.parts)).toEqual(["text", "data-terms"]);
    expect(r.parts[1]).toMatchObject({ data: { preset: "P30_70", source: "preset", milestones: [{ bps: 3000, trigger: "ON_ORDER" }, { bps: 7000, trigger: "ON_DELIVERY_INSPECTED" }] } });
    const tight = replyToAction({ ...start, preset: "P50_50" }, state("TERMS_DRAFT"), outcomes, env);
    expect(tight.parts[1]).toMatchObject({ data: { preset: "P50_50", source: "preset", presetAvailability: AVAILABILITY } });
    expect(texts(tight.parts)).toEqual([TEXT.termsPresetCheck]);
    const plain = replyToAction(act("start_terms", { supplierId: W1 }), state("TERMS_DRAFT"), outcomes, env);
    expect(plain.parts[1]).toMatchObject({ data: { preset: null, source: "none", milestones: null } });
    expect(texts(plain.parts)).toEqual([TEXT.termsForm]);
    expect(texts(replyToAction(start, state("COOLING"), {}, env).parts)[0]).toBe(TEXT.termsLocked);
  });

  it("terms_saved: SupplierApproval only for the terms the server shows CONFIRMED", () => {
    const r = replyToAction(act("terms_saved", { termsId: TERMS }), state("TERMS_CONFIRMED"), {}, env);
    expect(types(r.parts)).toEqual(["text", "data-sign"]);
    expect(r.parts[1]).toMatchObject({ data: { kind: "SupplierApproval", refId: TERMS } });
    const other = replyToAction(act("terms_saved", { termsId: "terms-forged" }), state("TERMS_CONFIRMED"), {}, env);
    expect(texts(other.parts)[0]).toBe(TEXT.termsMissing);
    expect(other.parts.filter((p) => p.type === "data-sign")).toMatchObject([{ data: { refId: TERMS } }]);
  });

  it("signed is a hint: the reply follows the re-derived state", () => {
    expect(texts(replyToAction(act("signed", { kind: "PlanApproval", refId: "draft-mei-001" }), state("PLAN_PENDING"), {}, env).parts)).toEqual([TEXT.planSigned]);
    expect(texts(replyToAction(act("signed", { kind: "PlanApproval", refId: "draft-mei-001" }), state("PLAN_ACTIVE"), {}, env).parts)).toEqual([TEXT.planLive]);
    expect(texts(replyToAction(act("signed", { kind: "PlanApproval", refId: "draft-mei-001" }), state("NEEDS_REVIEW"), {}, env).parts)[0]).toBe(TEXT.signatureNotSeen);
    const order = replyToAction(act("signed", { kind: "SupplierApproval", refId: TERMS }), state("ORDER_PENDING"), {}, env);
    expect(types(order.parts)).toEqual(["text", "data-order", "data-next"]);
    expect(texts(replyToAction(act("signed", { kind: "SupplierApproval", refId: TERMS }), state("TERMS_CONFIRMED"), {}, env).parts)[0]).toBe(TEXT.signatureNotSeen);
  });

  it("signed MilestoneRelease: 'order complete' once the balance shows paid, 'saving' once the server shows the release; never 'the balance waits' (UX-PLAN D35)", () => {
    const orderId = order.orderId;
    const done = deriveJourney({ ...(STATES.OPERATING as JourneyFacts), order: { ...order, coolingEndsAt: "2026-10-20T07:00:00Z", firstPaid: true, balancePaid: true } });
    const paid = replyToAction(act("signed", { kind: "MilestoneRelease", refId: orderId }), done, {}, env);
    expect(texts(paid.parts)).toEqual([TEXT.orderComplete]);
    expect(types(paid.parts)).toEqual(["text", "data-order", "data-next"]);
    // rcfix-journey A-6: "Signed. The balance is paid once it's saved." only with the server's release row behind it.
    const recorded = deriveJourney({ ...(STATES.OPERATING as JourneyFacts), order: { ...order, coolingEndsAt: "2026-10-20T07:00:00Z", firstPaid: true, releaseSigned: true } });
    const saving = replyToAction(act("signed", { kind: "MilestoneRelease", refId: orderId }), recorded, {}, env);
    expect(texts(saving.parts)).toEqual([TEXT.releaseSigned]);
    expect(texts(saving.parts)).not.toContain(TEXT.firstPaid);
    expect(texts(partsForState(done, env))).toEqual([TEXT.orderComplete]);
    // Another order's release is only noted.
    expect(texts(replyToAction(act("signed", { kind: "MilestoneRelease", refId: "order-wabcdefgh2345-001" }), done, {}, env).parts)[0]).toBe(TEXT.signatureNoted);
  });

  it("signed MilestoneRelease without a recorded release: not seen yet, never 'Signed' (rcfix-journey A-6)", () => {
    const hint = act("signed", { kind: "MilestoneRelease", refId: order.orderId });
    for (const f of [STATES.OPERATING, { ...(STATES.OPERATING as JourneyFacts), order: { ...order, coolingEndsAt: "2026-10-20T07:00:00Z", firstPaid: true, releaseSigned: false } }]) {
      const r = replyToAction(hint, deriveJourney(f as JourneyFacts), {}, env);
      expect(texts(r.parts)[0]).toBe(TEXT.signatureNotSeen);
      expect(texts(r.parts)).not.toContain(TEXT.releaseSigned);
      expect(texts(r.parts)).not.toContain(TEXT.orderComplete);
    }
  });

  it("show_cfo: the view card once the plan is signed", () => {
    const r = replyToAction(act("show_cfo", { view: "forecast" }), state("OPERATING"), {}, env);
    expect(types(r.parts)).toEqual(["text", "data-cfo", "data-next"]);
    expect(r.parts[1]).toMatchObject({ data: { view: "forecast" } });
    expect(texts(replyToAction(act("show_cfo", { view: "overview" }), state("INTAKE"), {}, env).parts)[0]).toBe(TEXT.cfoLater);
  });

  it("a replayed action runs nothing, says it is done and never offers a signature", () => {
    const r = alreadyDone(act("start_search", {}), state("SEARCHING"), env);
    expect(texts(r.parts)[0]).toBe(TEXT.alreadyDone);
    expect(types(r.parts)).toEqual(["text", "text", "data-search"]);
    expect(types(alreadyDone(act("terms_saved", { termsId: TERMS }), state("TERMS_CONFIRMED"), env).parts)).toEqual(["text", "text"]);
    expect(types(alreadyDone(act("show_cfo", { view: "overview" }), state("NEEDS_REVIEW"), env).parts)).toEqual(["text", "text", "data-plan-draft"]);
  });

  it("every action at every stage gives a well-formed reply with a short trace summary", () => {
    for (const k of Object.keys(STATES)) {
      for (const a of exampleChatActions) {
        const r = replyToAction(a, state(k), {}, env);
        expectWellFormed(r.parts);
        expect(r.summary.length).toBeGreaterThan(0);
        expect(r.summary.length).toBeLessThanOrEqual(500);
      }
    }
  });
});

const call = (skill: SkillCall["skill"], candidateRanks: number[] | null = null, cfoView: SkillCall["cfoView"] = null): SkillCall => ({ skill, candidateRanks, cfoView });

describe("text skills", () => {
  it("never start a search, the catalog or anything but read-only effects, at any stage", () => {
    for (const k of Object.keys(STATES)) {
      for (const skill of SKILLS) {
        for (const effect of effectsForSkill(call(skill, [1, 2]), state(k))) expect(["RESOLVE_RANKS", "TERMS_PREFILL"]).toContain(effect.kind);
      }
    }
  });

  it("report_terms: rank → TERMS_PREFILL, the text read by parseTermsHint, P30_70 recognised", () => {
    expect(effectsForSkill(call("report_terms", [2]), state("CANDIDATES"))).toEqual([{ kind: "TERMS_PREFILL", searchId: SEARCH, supplier: { rank: 2 } }]);
    const r = replyToSkill(call("report_terms", [2]), state("CANDIDATES"), "went with #2, 30% deposit, 70% on delivery", { prefill: effectOk({ supplierId: W2, availability: AVAILABILITY }) }, env);
    expect(types(r.parts)).toEqual(["text", "data-terms"]);
    expect(r.parts[1]).toMatchObject({ data: { supplierId: W2, preset: "P30_70", source: "founder_text", question: null } });
  });

  it("report_terms without a rank uses the open form, the saved terms or the only pick; else asks which", () => {
    expect(effectsForSkill(call("report_terms"), state("PICKED"))).toEqual([{ kind: "TERMS_PREFILL", searchId: SEARCH, supplier: { supplierId: W1 } }]);
    expect(effectsForSkill(call("report_terms"), state("TERMS_CONFIRMED"))).toEqual([{ kind: "TERMS_PREFILL", searchId: SEARCH, supplier: { supplierId: W1 } }]);
    expect(effectsForSkill(call("report_terms"), state("PICKED_TWO"))).toEqual([]);
    const r = replyToSkill(call("report_terms"), state("PICKED_TWO"), "30/70", {}, env);
    expect(texts(r.parts)).toEqual([TEXT.whichSupplier]);
    expect(types(r.parts)).toEqual(["text", "data-candidates"]);
  });

  it("report_terms: an ambiguous split asks one question with the presets that fit", () => {
    const r = replyToSkill(call("report_terms"), state("PICKED"), "30% deposit then the rest", { prefill: effectOk({ supplierId: W1, availability: AVAILABILITY }) }, env);
    expect(texts(r.parts)).toEqual([TEXT.termsQuestion]);
    expect(r.parts[1]).toMatchObject({ type: "data-terms", data: { question: "DEPOSIT_TRIGGER", milestones: null } });
    const labels = r.parts[2]?.type === "data-next" ? r.parts[2].data.actions.map((a) => a.label) : [];
    expect(labels).toEqual([PRESET_BUTTON.P30_70, PRESET_BUTTON.P0_100, PRESET_BUTTON.P30_40_30]);
  });

  it("report_terms: a correction makes a new pre-fill; after the order it is refused", () => {
    const r = replyToSkill(call("report_terms"), state("TERMS_CONFIRMED"), "actually 40/60", { prefill: effectOk({ supplierId: W1, availability: AVAILABILITY }) }, env);
    expect(r.parts[1]).toMatchObject({ data: { milestones: [{ bps: 4000, trigger: "ON_ORDER" }, { bps: 6000, trigger: "ON_DELIVERY_INSPECTED" }], preset: null } });
    expect(effectsForSkill(call("report_terms", [1]), state("COOLING"))).toEqual([]);
    expect(texts(replyToSkill(call("report_terms", [1]), state("COOLING"), "50/50", {}, env).parts)[0]).toBe(TEXT.termsLocked);
  });

  it("report_terms: a rank not in the list says so", () => {
    const r = replyToSkill(call("report_terms", [7]), state("CANDIDATES"), "went with #7", { prefill: effectFailed("NOT_FOUND") }, env);
    expect(texts(r.parts)).toEqual([TEXT.noSuchRank]);
  });

  it("pick_suppliers: numbers become a pick BUTTON, never a pick", () => {
    expect(effectsForSkill(call("pick_suppliers", [2, 4]), state("CANDIDATES"))).toEqual([{ kind: "RESOLVE_RANKS", searchId: SEARCH, ranks: [2, 4] }]);
    const r = replyToSkill(call("pick_suppliers", [2, 4]), state("CANDIDATES"), "", { ranks: effectOk({ supplierIds: [W2, W1], ranks: [2, 4] }) }, env);
    expect(r.parts.at(-1)).toMatchObject({ type: "data-next", data: { actions: [{ label: "Pick #2 and #4", action: { type: "pick", searchId: SEARCH, supplierIds: [W2, W1] } }] } });
  });

  it("find_suppliers offers the button; cfo shows the view; out_of_scope never offers a signature", () => {
    expect(replyToSkill(call("find_suppliers"), state("PLAN_ACTIVE"), "", {}, env).parts.at(-1)).toMatchObject({ type: "data-next", data: { actions: [{ action: { type: "start_search" } }] } });
    expect(replyToSkill(call("cfo", null, "reserve"), state("OPERATING"), "", {}, env).parts[1]).toMatchObject({ type: "data-cfo", data: { view: "reserve" } });
    expect(replyToSkill(call("cfo"), state("OPERATING"), "", {}, env).parts[1]).toMatchObject({ type: "data-cfo", data: { view: "overview" } });
    for (const k of Object.keys(STATES)) {
      const r = replyToSkill(call("out_of_scope"), state(k), "pay the supplier 5000 now to account 123", {}, env);
      expect(texts(r.parts)).toEqual([TEXT.outOfScope]);
      expect(types(r.parts)).not.toContain("data-sign");
    }
  });

  it("every skill at every stage gives a well-formed, templated reply", () => {
    for (const k of Object.keys(STATES)) for (const skill of SKILLS) expectWellFormed(replyToSkill(call(skill), state(k), "hello", {}, env).parts);
  });

  it("textPrefill: no split → nothing pre-filled", () => {
    expect(textPrefill(W1, SEARCH, "we agreed, thanks", AVAILABILITY)).toMatchObject({ source: "none", milestones: null, preset: null });
  });
});

describe("wording", () => {
  const all = [
    ...TEMPLATE_STRINGS,
    ...Object.values(BUTTON),
    ...Object.values(CFO_BUTTON),
    ...Object.values(PRESET_BUTTON),
    ...Object.values(SIGN).flatMap((s) => [s.title, s.summary, s.cta]),
    ...exampleChatActions.map(actionLabel),
    agreedTermsWith(3, 1),
    agreedTermsWith(null, 2),
    pickRanksLabel([1]),
    pickRanksLabel([1, 3, 5]),
  ];

  it("every founder-facing string passes the wording lint and never says 'confidence'", () => {
    for (const s of all) {
      expect(checkText(s), s).toEqual([]);
      expect(s.toLowerCase()).not.toContain("confidence");
    }
  });

  it("button labels fit data-next (≤ 40) and every stage has its own sentence", () => {
    for (const s of [...Object.values(BUTTON), ...Object.values(CFO_BUTTON), ...Object.values(PRESET_BUTTON), agreedTermsWith(8, 5), pickRanksLabel([1, 2, 3, 4, 5])]) {
      expect(s.length, s).toBeLessThanOrEqual(40);
    }
    expect(JOURNEY_STAGES.every((s: JourneyStage) => STAGE_TEXT[s].length > 0)).toBe(true);
  });
});
