import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NEXT_STEP_KEYS, NEXT_STEP_TEXT } from "@hogee/core";
import { STRIP_TEXT, nextStep, repeatsBar, stepTarget, waitLeft, type NextStepInput } from "./next-step";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..", "..");
const { checkText } = (await import(join(ROOT, "scripts/lint-wording/index.mjs"))) as { checkText: (text: string) => readonly unknown[] };

const NOW = Date.parse("2026-10-19T06:00:00Z");
const ORDER = "order-wqk3vt7ma2xrb-001";
const fresh: NextStepInput = {
  thread: { latestSearchId: null, pickedSupplierIds: [], termsFormOpen: false, openQuestion: false, latestDraftId: null },
  waiting: null,
  passkeyOnDevice: false,
  passkeyCardDismissed: false,
  planStatus: null,
  searchStatus: null,
  order: null,
  fundedMinor: null,
  readyMinor: null,
  paused: false,
  nowMs: NOW,
};
const withKey: NextStepInput = { ...fresh, passkeyOnDevice: true };
const committed: NextStepInput = { ...withKey, planStatus: "COMMITTED", fundedMinor: "1000000", readyMinor: "400000", thread: { ...fresh.thread, latestDraftId: "draft-1" } };
const searched: NextStepInput = { ...committed, thread: { ...committed.thread, latestSearchId: "search-1" } };
const order = (o: Partial<NonNullable<NextStepInput["order"]>>): NextStepInput => ({
  ...searched,
  order: { orderId: ORDER, phase: "waiting", coolingEndsAt: "2026-10-19T06:00:09Z", goodsArrived: false, balance: { amountMinor: "175000", evidenceHash: null }, ...o },
});

describe("nextStep: one row of UX-PLAN §3 each", () => {
  it("INTAKE: the passkey first, unless one is on this device or the founder pressed Later", () => {
    const s = nextStep(fresh);
    expect(s).toMatchObject({ key: "passkey", stage: "INTAKE", text: NEXT_STEP_TEXT.passkey, action: { kind: "focus-passkey", label: "Create passkey" }, who: null });
    expect(nextStep({ ...fresh, passkeyCardDismissed: true }).key).toBe("intake");
  });

  it("INTAKE: an open question, else tell me what you sell (no button: the composer and the starter chip)", () => {
    expect(nextStep({ ...withKey, thread: { ...withKey.thread, openQuestion: true } })).toMatchObject({ key: "answer", action: { kind: "scroll", target: "question" } });
    expect(nextStep(withKey)).toMatchObject({ key: "intake", action: null });
  });

  it("NEEDS_REVIEW: sign the plan from the bar (the same SignHost request the card opens)", () => {
    const s = nextStep({ ...withKey, waiting: { kind: "PlanApproval", refId: "draft-1" } });
    expect(s).toMatchObject({ key: "sign-plan", stage: "NEEDS_REVIEW", action: { kind: "sign", request: { kind: "PlanApproval", refId: "draft-1" }, label: "Sign the plan" } });
  });

  it("NEEDS_REVIEW without a passkey on this device: key-needed opens the sign sheet (its code field first)", () => {
    const s = nextStep({ ...fresh, waiting: { kind: "PlanApproval", refId: "draft-1" } });
    expect(s).toMatchObject({ key: "key-needed", stage: "FOUNDER_KEY_PENDING", action: { kind: "sign", request: { kind: "PlanApproval" }, label: "Create passkey" } });
  });

  it("a refused plan: sign again; a submitted one: saving (who: Hogee)", () => {
    expect(nextStep({ ...withKey, planStatus: "REVERTED", thread: { ...withKey.thread, latestDraftId: "draft-1" } })).toMatchObject({
      key: "plan-refused",
      action: { kind: "sign", request: { kind: "PlanApproval", refId: "draft-1" }, label: "Sign again" },
    });
    expect(nextStep({ ...withKey, planStatus: "SUBMITTED" })).toMatchObject({ key: "plan-saving", stage: "PLAN_PENDING", action: null, who: "hogee" });
    // Signed in this thread, the record not caught up yet: still saving, never "tell me what you sell".
    expect(nextStep({ ...withKey, thread: { ...withKey.thread, latestDraftId: "draft-1" } }).key).toBe("plan-saving");
  });

  it("PLAN_ACTIVE unfunded: the loan officer is adding the money; Find suppliers as a secondary button", () => {
    const s = nextStep({ ...committed, fundedMinor: "0", readyMinor: "0" });
    expect(s).toMatchObject({ key: "funding", stage: "PLAN_ACTIVE", who: "officer", action: { kind: "send", action: { type: "start_search" }, secondary: true } });
  });

  it("PLAN_ACTIVE funded: the amount ready, then Find suppliers", () => {
    const s = nextStep(committed);
    expect(s.text).toBe("4,000 BU is ready to spend. Next, find a supplier.");
    expect(s.action).toEqual({ kind: "send", action: { type: "start_search" }, label: "Find suppliers" });
    // Balances still loading: the plain sentence, never a placeholder or a made-up zero.
    expect(nextStep({ ...committed, readyMinor: null, fundedMinor: null }).text).toBe("Your plan is active. Next, find a supplier.");
  });

  it("the search: failed → try again; pending (or not loaded) → Hogee is looking; ready → pick from the list", () => {
    expect(nextStep({ ...searched, searchStatus: "FAILED" })).toMatchObject({ key: "search-failed", action: { kind: "send", action: { type: "start_search" }, label: "Try again" } });
    expect(nextStep({ ...searched, searchStatus: "PENDING" })).toMatchObject({ key: "searching", stage: "SEARCHING", who: "hogee", action: null });
    expect(nextStep({ ...searched, searchStatus: null }).key).toBe("searching");
    expect(nextStep({ ...searched, searchStatus: "READY" })).toMatchObject({ key: "pick", stage: "CANDIDATES", action: { kind: "scroll", target: "candidates" } });
  });

  it("PICKED: one pick → I've made a deal (start_terms); several → show the message", () => {
    const one = nextStep({ ...searched, searchStatus: "READY", thread: { ...searched.thread, pickedSupplierIds: ["supplier-w1"] } });
    expect(one).toMatchObject({ key: "message", stage: "PICKED", action: { kind: "send", action: { type: "start_terms", supplierId: "supplier-w1" }, label: "I've made a deal" } });
    const two = nextStep({ ...searched, searchStatus: "READY", thread: { ...searched.thread, pickedSupplierIds: ["supplier-w1", "supplier-w2"] } });
    expect(two.action).toMatchObject({ kind: "scroll", target: "enquiry" });
  });

  it("TERMS_DRAFT: show the form; TERMS_CONFIRMED: sign the order", () => {
    expect(nextStep({ ...searched, thread: { ...searched.thread, termsFormOpen: true } })).toMatchObject({ key: "deal", stage: "TERMS_DRAFT", action: { kind: "scroll", target: "terms" } });
    expect(nextStep({ ...searched, waiting: { kind: "SupplierApproval", refId: "terms-1" } })).toMatchObject({
      key: "sign-order",
      stage: "TERMS_CONFIRMED",
      action: { kind: "sign", request: { kind: "SupplierApproval", refId: "terms-1" }, label: "Sign the order" },
    });
  });

  it("the order: saving, the safety wait with what is left, paying (all Hogee's turn, no button)", () => {
    expect(nextStep(order({ phase: "binding" }))).toMatchObject({ key: "order-saving", stage: "ORDER_PENDING", who: "hogee", action: null });
    const cooling = nextStep(order({ phase: "cooling" }));
    expect(cooling).toMatchObject({ key: "safety-wait", stage: "COOLING", who: "hogee", action: null });
    expect(cooling.text).toBe("Safety wait: the deposit is paid automatically in 0:09. You can pause payments on the order card.");
    expect(nextStep(order({ phase: "paying" }))).toMatchObject({ key: "paying", who: "hogee", action: null });
  });

  it("after the deposit: Goods arrived → upload the report → sign to pay the balance; an existing check code skips the gate", () => {
    expect(nextStep(order({}))).toMatchObject({ key: "in-transit", stage: "OPERATING", action: { kind: "goods-arrived", orderId: ORDER, label: "Goods arrived" } });
    expect(nextStep(order({ goodsArrived: true }))).toMatchObject({ key: "upload", action: { kind: "scroll", target: "evidence" } });
    const pay = nextStep(order({ balance: { amountMinor: "175000", evidenceHash: `0x${"ab".repeat(32)}` } }));
    expect(pay).toMatchObject({ key: "pay-balance", action: { kind: "sign", request: { kind: "MilestoneRelease", refId: ORDER }, label: "Pay the balance" } });
    expect(pay.text).toBe("Sign to pay the balance of 1,750 BU.");
  });

  it("every payment made: order complete, and How are we doing?", () => {
    expect(nextStep(order({ phase: "done", balance: null }))).toMatchObject({ key: "done", action: { kind: "send", action: { type: "show_cfo", view: "overview" } } });
  });

  it("stopped payments override every step after signing, keeping the stage", () => {
    const s = nextStep({ ...order({ phase: "cooling" }), paused: true });
    expect(s).toMatchObject({ key: "paused", stage: "COOLING", action: null });
    expect(nextStep({ ...withKey, paused: true }).key).toBe("intake");
  });

  it("a replaced or unsigned order falls back to the earlier steps", () => {
    expect(nextStep({ ...order({ phase: "replaced" }), searchStatus: "READY" }).key).toBe("pick");
  });
});

describe("waitLeft", () => {
  it("is m:ss, never negative, and unknown without an end or a clock", () => {
    expect(waitLeft("2026-10-19T06:02:05Z", NOW)).toBe("2:05");
    expect(waitLeft("2026-10-19T05:00:00Z", NOW)).toBe("0:00");
    expect(waitLeft(null, NOW)).toBeUndefined();
    expect(waitLeft("2026-10-19T06:02:05Z", null)).toBeUndefined();
  });
});

describe("wording", () => {
  it("every step's sentence and button is wording-clean and fits the bar", () => {
    for (const key of NEXT_STEP_KEYS) expect(checkText(NEXT_STEP_TEXT[key]), key).toEqual([]);
    for (const label of ["Create passkey", "Show me", "Sign the plan", "Sign the order", "Pay the balance", "Sign again", "Find suppliers", "Try again", "Show the list", "I've made a deal", "Show the message", "Show the form", "Goods arrived", "How are we doing?"]) {
      expect(checkText(label), label).toEqual([]);
      expect(label.length).toBeLessThanOrEqual(24);
    }
  });
});

describe("the phone strip's short line (UX round 3)", () => {
  it("is a few words for every step, wording-clean, and never cut at 390 px", () => {
    for (const key of NEXT_STEP_KEYS) {
      expect(checkText(STRIP_TEXT[key]), key).toEqual([]);
      expect(STRIP_TEXT[key].length, key).toBeLessThanOrEqual(24);
    }
  });

  it("fills its value, and falls back to plain words while the value loads", () => {
    expect(nextStep(committed).short).toBe("4,000 BU ready");
    expect(nextStep({ ...committed, readyMinor: null }).short).toBe("Your plan is active");
    expect(nextStep(order({ phase: "cooling" })).short).toBe("Safety wait 0:09");
    expect(nextStep(order({})).short).toBe("Waiting for the goods");
  });
});

describe("stepTarget and repeatsBar: each action says itself once (UX round 3)", () => {
  it("points the bar at the card its button acts on", () => {
    expect(stepTarget(nextStep(fresh).action)).toEqual({ kind: "passkey" });
    expect(stepTarget(nextStep({ ...withKey, waiting: { kind: "PlanApproval", refId: "draft-1" } }).action)).toEqual({ kind: "sign", signKind: "PlanApproval", refId: "draft-1" });
    expect(stepTarget(nextStep(order({})).action)).toEqual({ kind: "order", orderId: ORDER });
    const pay = nextStep(order({ balance: { amountMinor: "175000", evidenceHash: `0x${"ab".repeat(32)}` } }));
    expect(stepTarget(pay.action)).toEqual({ kind: "order", orderId: ORDER });
    expect(stepTarget(nextStep({ ...searched, searchStatus: "READY" }).action)).toEqual({ kind: "scroll", target: "candidates" });
    expect(stepTarget(nextStep(committed).action)).toBeNull();
    expect(stepTarget(null)).toBeNull();
  });

  it("a card's chat button repeats the bar only for the same action (and the same supplier for a deal)", () => {
    const find = nextStep(committed).action;
    expect(repeatsBar(find, { type: "start_search" })).toBe(true);
    expect(repeatsBar(find, { type: "show_cfo", view: "overview" })).toBe(false);
    const deal = nextStep({ ...searched, thread: { ...searched.thread, pickedSupplierIds: ["supplier-w1"] } }).action;
    expect(repeatsBar(deal, { type: "start_terms", supplierId: "supplier-w1" })).toBe(true);
    expect(repeatsBar(deal, { type: "start_terms", supplierId: "supplier-w2" })).toBe(false);
    expect(repeatsBar(nextStep(order({})).action, { type: "start_search" })).toBe(false);
    expect(repeatsBar(null, { type: "start_search" })).toBe(false);
  });
});
