/**
 * Quick replies (UX-PLAN D5): "is my money safe?", "what do I do now?", "who is the supplier?" and "what did the AI pay
 * by itself?" are answered from templates and the journey state, before the planner or the router ever sees the text. A message with a digit or a
 * percent sign, or a long one, never matches, so a deal report ("30% deposit, 70% on delivery") still reaches
 * report_terms. No reply carries model text, a seller name in a text part, or a signature card.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  NEXT_STEP_TEXT,
  QUICK_MAX_CHARS,
  TEXT,
  deriveJourney,
  fillNextStep,
  nextStepText,
  quickIntent,
  quickReply,
  stageNextStep,
  type JourneyEnv,
  type JourneyPart,
} from "../src/journey/index";
import { ChatDataPart } from "../src/schemas/chat";
import type { JourneyFacts, JourneyState } from "../src/schemas/journey";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const { checkText } = (await import(join(ROOT, "scripts/lint-wording/index.mjs"))) as { checkText: (text: string) => readonly { term: string }[] };

let n = 0;
const env: JourneyEnv = { newActionId: () => `01a14202-2800-7000-8000-${String((n += 1)).padStart(12, "0")}` };

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

const STATES: Record<string, JourneyFacts> = {
  INTAKE: base,
  NEEDS_REVIEW: { ...base, draftId: "draft-mei-001" },
  FOUNDER_KEY_PENDING: { ...base, draftId: "draft-mei-001", founderKeyActive: false },
  PLAN_PENDING: { ...base, draftId: "draft-mei-001", planStatus: "SUBMITTED" },
  PLAN_ACTIVE: committed,
  SEARCH_FAILED: { ...committed, search: { searchId: "search-1", status: "FAILED", origin: "web" } },
  SEARCHING: { ...committed, search: { searchId: "search-1", status: "PENDING", origin: "web" } },
  CANDIDATES: ready,
  CATALOG: { ...committed, search: { searchId: "sl-1", status: "READY", origin: "catalog" } },
  PICKED: { ...ready, pickedSupplierIds: [W1] },
  TERMS_DRAFT: { ...ready, pickedSupplierIds: [W1], termsDraft: { supplierId: W1 } },
  TERMS_CONFIRMED: { ...ready, pickedSupplierIds: [W1], terms: { ...used, status: "CONFIRMED" } },
  ORDER_PENDING: { ...ready, terms: used, order: { ...order, bound: false, coolingEndsAt: null } },
  COOLING: { ...ready, terms: used, order },
  OPERATING: { ...ready, terms: used, order: { ...order, coolingEndsAt: "2026-10-20T07:00:00Z", firstPaid: true } },
  DONE: { ...ready, terms: used, order: { ...order, coolingEndsAt: "2026-10-20T07:00:00Z", firstPaid: true, balancePaid: true } },
};
const state = (k: string): JourneyState => deriveJourney(STATES[k] as JourneyFacts);
const types = (parts: readonly JourneyPart[]) => parts.map((p) => p.type);
const texts = (parts: readonly JourneyPart[]) => parts.flatMap((p) => (p.type === "text" ? [p.text] : []));

describe("quickIntent", () => {
  it("matches the questions people ask, in their own words", () => {
    for (const t of ["is my money safe?", "Is this safe", "can someone steal my money?", "How is my money protected?", "is it a scam"]) expect(quickIntent(t), t).toBe("safety");
    for (const t of ["what do I do now?", "What's next?", "what next", "Now what?", "where are we?", "what should I do"]) expect(quickIntent(t), t).toBe("next");
    for (const t of ["who is the supplier?", "Who are the suppliers", "what's the supplier's name?", "which supplier did I pick?", "supplier contact details"]) {
      expect(quickIntent(t), t).toBe("supplier");
    }
    for (const t of ["What did the AI pay by itself?", "What did the AI do by itself?", "did Hogee pay anything on its own?", "what has the AI paid?", "What did Hogee's AI change?", "Does the agent pay without asking?"]) {
      expect(quickIntent(t), t).toBe("ai");
    }
  });

  it("leaves everything else to the planner and the router", () => {
    for (const t of ["How are we doing?", "Find me suppliers", "find suppliers", "I want to sell tumblers", "change my plan", "citizen", "hello", "what does Hogee do?"]) expect(quickIntent(t), t).toBeNull();
    // A deal report without digits still reaches report_terms: "automatically" alone is not a question about the AI.
    expect(quickIntent("went with the second one, deposit paid automatically, balance on delivery")).toBeNull();
  });

  it("never matches a message with a digit or %, or a long one, so deal reports reach report_terms", () => {
    expect(quickIntent("went with #2, is it safe? 30% deposit, 70% on delivery")).toBeNull();
    expect(quickIntent("what next for supplier 2")).toBeNull();
    expect(quickIntent("is it safe to pay 30 percent%")).toBeNull();
    const long = `is my money safe? ${"please tell me more ".repeat(10)}`;
    expect(long.length).toBeGreaterThan(QUICK_MAX_CHARS);
    expect(quickIntent(long)).toBeNull();
  });
});

describe("quickReply", () => {
  it("safety: the before-signing variant until the plan is signed, then the full one", () => {
    for (const k of ["INTAKE", "NEEDS_REVIEW", "FOUNDER_KEY_PENDING"]) expect(texts(quickReply("safety", state(k), env).parts), k).toEqual([TEXT.safetyBeforePlan]);
    for (const k of ["PLAN_PENDING", "PLAN_ACTIVE", "COOLING", "DONE"]) expect(texts(quickReply("safety", state(k), env).parts), k).toEqual([TEXT.safety]);
  });

  it("next: 'Next: ' and the stage's Next step sentence, then the stage's cards", () => {
    const r = quickReply("next", state("COOLING"), env);
    expect(texts(r.parts)).toEqual([`Next: ${fillNextStep(stageNextStep(state("COOLING")))}`]);
    expect(types(r.parts)).toEqual(["text", "data-order", "data-next"]);
    expect(texts(quickReply("next", state("INTAKE"), env).parts)).toEqual([nextStepText(state("INTAKE"))]);
    expect(types(quickReply("next", state("NEEDS_REVIEW"), env).parts)).toEqual(["text", "data-plan-draft"]);
  });

  it("next during the safety wait while payments are paused: the paused step, never 'paid automatically' (rcfix-journey A-7)", () => {
    const paused = deriveJourney({ ...(STATES.COOLING as JourneyFacts), paused: true });
    expect(paused.stage).toBe("COOLING");
    const r = quickReply("next", paused, env);
    expect(texts(r.parts)).toEqual([`Next: ${NEXT_STEP_TEXT.paused}`]);
    expect(texts(r.parts).join(" ")).not.toContain("paid automatically");
    expect(types(r.parts)).toEqual(["text", "data-order", "data-next"]);
  });

  it("next before the questions without a passkey: the passkey first, as the Next step bar, with Later for no code", () => {
    const noKey = deriveJourney({ ...base, founderKeyActive: false });
    expect(texts(quickReply("next", noKey, env).parts)).toEqual([TEXT.nextPasskey]);
    expect(TEXT.nextPasskey).toMatch(/^Next: set up your passkey/);
    expect(TEXT.nextPasskey).toContain("Press Later");
    // The caller's hint wins over the facts (the mock's fresh scenario counts the key as active to skip enrolment).
    expect(texts(quickReply("next", state("INTAKE"), env, { passkeySetUp: false }).parts)).toEqual([TEXT.nextPasskey]);
    expect(texts(quickReply("next", noKey, env, { passkeySetUp: true }).parts)).toEqual([nextStepText(noKey)]);
    // Once a draft exists the stage's own step speaks (the sign button shows how to make a passkey).
    expect(texts(quickReply("next", state("FOUNDER_KEY_PENDING"), env, { passkeySetUp: false }).parts)).toEqual([nextStepText(state("FOUNDER_KEY_PENDING"))]);
  });

  it("ai: nothing before a signed plan; then its rules and where the count is; the deposit once the facts show it paid", () => {
    for (const k of ["INTAKE", "NEEDS_REVIEW", "FOUNDER_KEY_PENDING"]) expect(texts(quickReply("ai", state(k), env).parts), k).toEqual([TEXT.aiBeforePlan]);
    for (const k of ["PLAN_PENDING", "PLAN_ACTIVE", "PICKED", "COOLING"]) expect(texts(quickReply("ai", state(k), env).parts), k).toEqual([TEXT.ai]);
    for (const k of ["OPERATING", "DONE"]) expect(texts(quickReply("ai", state(k), env).parts), k).toEqual([`${TEXT.aiDeposit} ${TEXT.ai}`]);
    expect(types(quickReply("ai", state("OPERATING"), env).parts)).toEqual(["text"]);
    // The facts hold no count of automatic payments and no limit changes, so the reply claims neither.
    for (const k of Object.keys(STATES)) expect(texts(quickReply("ai", state(k), env).parts).join(" "), k).not.toMatch(/\d|changed no|no limits/);
  });

  it("supplier: the list card for a ready search, the order card after an order, a button or 'plan first' before", () => {
    for (const k of ["CANDIDATES", "PICKED", "TERMS_DRAFT", "TERMS_CONFIRMED"]) {
      const r = quickReply("supplier", state(k), env);
      expect(texts(r.parts), k).toEqual([TEXT.supplier]);
      expect(r.parts[1], k).toMatchObject({ type: "data-candidates", data: { searchId: "search-1" } });
    }
    expect(types(quickReply("supplier", state("CATALOG"), env).parts)).toEqual(["text", "data-shortlist"]);
    expect(types(quickReply("supplier", state("SEARCHING"), env).parts)).toEqual(["text", "data-search"]);
    const after = quickReply("supplier", state("COOLING"), env);
    expect(texts(after.parts)).toEqual([TEXT.supplierOrder]);
    expect(after.parts[1]).toMatchObject({ type: "data-order", data: { termsId: "terms-1" } });
    const before = quickReply("supplier", state("PLAN_ACTIVE"), env);
    expect(texts(before.parts)).toEqual([TEXT.supplierBeforeSearch]);
    expect(before.parts[1]).toMatchObject({ type: "data-next", data: { actions: [{ action: { type: "start_search" } }] } });
    expect(texts(quickReply("supplier", state("INTAKE"), env).parts)).toEqual([TEXT.needPlanFirst]);
  });

  it("at every stage: templated text only, valid parts, no signature card, no seller id in a text part", () => {
    for (const k of Object.keys(STATES)) {
      for (const intent of ["safety", "next", "supplier", "ai"] as const) {
        const r = quickReply(intent, state(k), env);
        expect(types(r.parts), `${intent} at ${k}`).not.toContain("data-sign");
        expect(r.summary.length).toBeLessThanOrEqual(500);
        for (const p of r.parts) {
          if (p.type === "text") {
            expect(checkText(p.text), p.text).toEqual([]);
            expect(p.text).not.toContain(W1);
          } else expect(ChatDataPart.parse(p)).toEqual(p);
        }
      }
    }
  });
});
