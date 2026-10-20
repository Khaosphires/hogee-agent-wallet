import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CFO_VIEWS, ChatAction, DataAction, NEEDS_GROUPS, NEEDS_STATUSES, SIGNATURE_KINDS, exampleChatActions, exampleNeedsChecklist, examplePlanIntent, type OrderTerms, type PlanRecord } from "@hogee/core";
import {
  actionEventText,
  actionLabel,
  actionMessageParts,
  actionOf,
  announcementFor,
  budgetBar,
  buFigure,
  chatRequestBody,
  chosenActionIds,
  enquiryClipboardText,
  heardLine,
  isOwnSeal,
  keptSignature,
  needsAmountText,
  needsCounts,
  needsGroups,
  needsSourceLabel,
  needsStatusLabel,
  newActionId,
  optionLabels,
  pageOwnsSeal,
  parseSignedLocally,
  partAnchor,
  partViews,
  percentOfBps,
  signKey,
  signPollInterval,
  signProgress,
  signedKeys,
  stopPaymentsView,
  threadFacts,
  threadLatch,
  userBubbleText,
  waitingSign,
  waitingSignKey,
  walletSummary,
  withSignedTx,
  type JourneyMessage,
} from "./journey-client";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..", "..");
const { checkText } = (await import(join(ROOT, "scripts/lint-wording/index.mjs"))) as { checkText: (text: string) => readonly unknown[] };

const ID = (n: number) => `0199f000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const TX_A = `0x${"a1".repeat(32)}`;
const TX_B = `0x${"b2".repeat(32)}`;
/** The Sample business's made-up commit of the same draft (another store build). */
const TX_S = `0x${"5e".repeat(32)}`;

const user = (id: string, parts: JourneyMessage["parts"]): JourneyMessage => ({ id, role: "user", parts });
const bot = (id: string, parts: JourneyMessage["parts"]): JourneyMessage => ({ id, role: "assistant", parts });
const pressed = (action: ChatAction, label = actionLabel(action)): JourneyMessage => user(`u-${action.actionId}`, actionMessageParts(action, label));

describe("threadLatch", () => {
  const msg = user("u1", [{ type: "text", text: "hi" }]);
  it("waits for the history, then mounts with it (or empty for a new conversation)", () => {
    expect(threadLatch(null, undefined, undefined, false)).toBeNull();
    expect(threadLatch(null, "s1", undefined, false)).toBeNull();
    expect(threadLatch(null, "s1", [msg], false)).toEqual({ sessionId: "s1", initial: [msg] });
    expect(threadLatch(null, "s1", undefined, true)).toEqual({ sessionId: "s1", initial: [] });
  });
  it("stays mounted, with its first history, while GET /api/chat refetches (pending, error or new data)", () => {
    const mounted = threadLatch<JourneyMessage>(null, "s1", undefined, true);
    expect(threadLatch(mounted, "s1", undefined, false)).toBe(mounted);
    expect(threadLatch(mounted, "s1", [msg], false)).toBe(mounted);
  });
  it("starts over for another session", () => {
    const mounted = threadLatch<JourneyMessage>(null, "s1", undefined, true);
    expect(threadLatch(mounted, "s2", undefined, false)).toBeNull();
    expect(threadLatch(mounted, "s2", [msg], false)).toEqual({ sessionId: "s2", initial: [msg] });
  });
});

describe("newActionId", () => {
  it("makes a fresh lowercase UUIDv7 the ChatAction schema accepts", () => {
    const a = newActionId();
    const b = newActionId();
    expect(a).not.toBe(b);
    expect(ChatAction.safeParse({ type: "use_catalog", actionId: a }).success).toBe(true);
  });
});

describe("actionLabel", () => {
  // The same labels v-chat-server stores as the user text (core journey/templates actionLabel, after the merge).
  it("names every action the way the server stores it", () => {
    expect(actionLabel({ type: "start_search", actionId: ID(1) })).toBe("Find suppliers");
    expect(actionLabel({ type: "use_catalog", actionId: ID(1) })).toBe("Use the sample list");
    expect(actionLabel({ type: "show_candidates", actionId: ID(1), searchId: "search-1" })).toBe("Show the suppliers");
    expect(actionLabel({ type: "pick", actionId: ID(1), searchId: "s", supplierIds: ["supplier-a"] })).toBe("Pick 1 supplier");
    expect(actionLabel({ type: "pick", actionId: ID(1), searchId: "s", supplierIds: ["supplier-a", "supplier-b"] })).toBe("Pick 2 suppliers");
    expect(actionLabel({ type: "start_terms", actionId: ID(1), supplierId: "supplier-a" })).toBe("Fill in the deal");
    expect(actionLabel({ type: "terms_saved", actionId: ID(1), termsId: "terms-1" })).toBe("Deal saved");
    expect(actionLabel({ type: "signed", actionId: ID(1), kind: "PlanApproval", refId: "draft-1" })).toBe("Signed");
    const views = Object.fromEntries(CFO_VIEWS.map((view) => [view, actionLabel({ type: "show_cfo", actionId: ID(1), view })]));
    expect(views).toEqual({
      overview: "How are we doing?",
      spending: "Show spending",
      sales: "Show sales",
      pnl: "Show profit and loss",
      forecast: "Show the forecast",
      reserve: "Show my tax money",
    });
  });
});

describe("actionMessageParts", () => {
  it("is the button's label plus a data-action part that the schema accepts", () => {
    const action: ChatAction = { type: "start_search", actionId: ID(2), quantity: 500 };
    const parts = actionMessageParts(action, "  Find suppliers for 500  ");
    expect(parts).toEqual([
      { type: "text", text: "Find suppliers for 500" },
      { type: "data-action", data: { action } },
    ]);
    expect(DataAction.safeParse(parts[1]?.type === "data-action" ? parts[1].data : null).success).toBe(true);
  });

  it("falls back to the stored label when the button has none", () => {
    const action: ChatAction = { type: "use_catalog", actionId: ID(3) };
    expect(actionMessageParts(action, " ")[0]).toEqual({ type: "text", text: "Use the sample list" });
  });

  it("refuses an action the schema refuses (fail closed: nothing is sent)", () => {
    expect(() => actionMessageParts({ type: "use_catalog", actionId: "not-a-uuid" } as ChatAction, "Go")).toThrow(/didn.t work/);
    const dup = { type: "pick", actionId: ID(4), searchId: "s", supplierIds: ["supplier-a", "supplier-a"] } as ChatAction;
    expect(() => actionMessageParts(dup, "Pick")).toThrow();
  });
});

describe("chatRequestBody", () => {
  const action: ChatAction = { type: "show_cfo", actionId: ID(5), view: "overview" };

  it("sends {sessionId, action} for a button press and never its label", () => {
    const body = chatRequestBody("sess", pressed(action, "How are we doing?"));
    expect(body).toEqual({ sessionId: "sess", action });
    expect(JSON.stringify(body)).not.toContain("How are we doing");
  });

  it("sends {sessionId, message} for typed text", () => {
    expect(chatRequestBody("sess", user("u1", [{ type: "text", text: " hello " }, { type: "text", text: "there" }]))).toEqual({ sessionId: "sess", message: "hello  there" });
  });

  it("sends an empty message when there is nothing to send (the server refuses it)", () => {
    expect(chatRequestBody("sess", undefined)).toEqual({ sessionId: "sess", message: "" });
  });

  it("ignores a data-action on an assistant message", () => {
    const odd = bot("b1", [{ type: "text", text: "hi" }, { type: "data-action", data: { action } }]);
    expect(actionOf(odd)).toBeUndefined();
  });
});

describe("userBubbleText", () => {
  it("shows the answered chip's label, the typed text, or the stored action label", () => {
    const labels = new Map([["sg", "Singapore"]]);
    expect(userBubbleText(user("u1", [{ type: "text", text: "sg" }]), labels)).toBe("Singapore");
    expect(userBubbleText(user("u2", [{ type: "text", text: "Find me suppliers" }]), labels)).toBe("Find me suppliers");
    const action: ChatAction = { type: "terms_saved", actionId: ID(6), termsId: "terms-1" };
    expect(userBubbleText(user("u3", [{ type: "data-action", data: { action } }]), labels)).toBe("Deal saved");
  });

  it("reads option labels from every question part", () => {
    const q = bot("b1", [
      { type: "data-question", data: { questionId: "q1", slot: "residency", text: "Where?", options: [{ value: "sg", label: "Singapore" }, { value: "my", label: "Malaysia" }] } },
    ]);
    expect(optionLabels([q]).get("my")).toBe("Malaysia");
  });
});

describe("chosenActionIds and signedKeys", () => {
  it("collect the buttons pressed and the signatures sent, from user messages only", () => {
    const a: ChatAction = { type: "start_search", actionId: ID(7) };
    const s: ChatAction = { type: "signed", actionId: ID(8), kind: "PlanApproval", refId: "draft-1" };
    const msgs = [pressed(a), pressed(s), bot("b", [{ type: "data-action", data: { action: { type: "use_catalog", actionId: ID(9) } } }])];
    expect([...chosenActionIds(msgs)]).toEqual([ID(7), ID(8)]);
    expect([...signedKeys(msgs)]).toEqual([signKey("PlanApproval", "draft-1")]);
  });
});

describe("waitingSignKey", () => {
  const needs = bot("b1", [
    { type: "data-needs", data: exampleNeedsChecklist },
    { type: "data-sign", data: { kind: "PlanApproval", refId: exampleNeedsChecklist.draftId, title: "Approve", summary: "Sign it", cta: "Sign" } },
  ]);
  it("is the latest unsigned needs or sign card, once", () => {
    expect(waitingSignKey([])).toBeNull();
    expect(waitingSignKey([needs])).toBe(signKey("PlanApproval", exampleNeedsChecklist.draftId));
    const supplier = bot("b2", [{ type: "data-sign", data: { kind: "SupplierApproval", refId: "terms-1", title: "Sign the order", summary: "Sign it", cta: "Sign" } }]);
    expect(waitingSignKey([needs, supplier])).toBe(signKey("SupplierApproval", "terms-1"));
  });
  it("names the waiting card for the wallet rail", () => {
    expect(waitingSign([needs])).toEqual({ key: signKey("PlanApproval", exampleNeedsChecklist.draftId), kind: "PlanApproval", refId: exampleNeedsChecklist.draftId, title: "Sign your plan" });
  });

  it("is null once that signature was sent", () => {
    expect(waitingSignKey([needs, pressed({ type: "signed", actionId: ID(20), kind: "PlanApproval", refId: exampleNeedsChecklist.draftId })])).toBeNull();
  });
});

describe("walletSummary", () => {
  const pockets = [
    { spent: "120000", available: "280000" },
    { spent: "0", available: "120000" },
  ];
  it("is total minus spent minus escrow, and the sum of what is free now", () => {
    expect(walletSummary("1000000", { pockets, escrowMinor: "0" })).toMatchObject({ totalMinor: "1000000", leftMinor: "880000", freeMinor: "400000" });
  });
  it("caps what is free now by the released stage, as the chain does: 1,200 BU spent and 2,500 BU in escrow under a 4,000 BU stage leave 300 BU", () => {
    const f = walletSummary("1000000", { pockets, escrowMinor: "250000", releasedMinor: "400000", fundedMinor: "1000000" });
    expect(f).toMatchObject({ leftMinor: "630000", freeMinor: "30000" });
  });
  it("counts a signed order's escrow at once: 2,500 BU committed on a 10,000 BU plan leaves 7,500 BU, whatever is paid out", () => {
    const supplier = [{ spent: "0", available: "250000" }];
    expect(walletSummary("1000000", { pockets: supplier, escrowMinor: "250000" }, "75000")).toMatchObject({
      leftMinor: "750000",
      escrowCommittedMinor: "250000",
      supplierPaidMinor: "75000",
      escrowHeldMinor: "175000",
      spentMinor: "75000",
    });
    expect(walletSummary("1000000", { pockets: supplier, escrowMinor: "250000" })).toMatchObject({ leftMinor: "750000", supplierPaidMinor: null, spentMinor: null });
  });
  it("is null without a plan or balances, never a made-up zero", () => {
    expect(walletSummary(undefined, { pockets: [], escrowMinor: "0" })).toBeNull();
    expect(walletSummary("1000000", undefined)).toBeNull();
  });
});

describe("threadFacts", () => {
  const needs = bot("b1", [{ type: "data-needs", data: exampleNeedsChecklist }]);
  const search = bot("b2", [{ type: "data-search", data: { searchId: "s1" } }]);
  const candidates = bot("b3", [{ type: "data-candidates", data: { searchId: "s1" } }]);
  const enquiry = bot("b4", [{ type: "data-enquiry", data: { supplierIds: ["supplier-a"], subject: "s", body: "b" } }]);
  const terms = bot("b5", [{ type: "data-terms", data: { supplierId: "supplier-a", searchId: "s1", milestones: null, preset: null, source: "none", question: null, presetAvailability: [] } }]);
  const saved = pressed({ type: "terms_saved", actionId: ID(30), termsId: "terms-1" });

  it("is empty for a new conversation", () => {
    expect(threadFacts([])).toEqual({ latestSearchId: null, pickedSupplierIds: [], termsFormOpen: false, savedTermsId: null, openQuestion: false, latestDraftId: null });
  });

  it("follows the plan, the search, the pick, the deal form and the saved deal", () => {
    expect(threadFacts([needs]).latestDraftId).toBe(exampleNeedsChecklist.draftId);
    expect(threadFacts([needs, search, candidates])).toMatchObject({ latestSearchId: "s1", pickedSupplierIds: [] });
    expect(threadFacts([needs, search, candidates, enquiry]).pickedSupplierIds).toEqual(["supplier-a"]);
    expect(threadFacts([needs, search, candidates, enquiry, terms]).termsFormOpen).toBe(true);
    expect(threadFacts([needs, search, candidates, enquiry, terms, saved])).toMatchObject({ termsFormOpen: false, savedTermsId: "terms-1" });
    // A new search starts over: the old pick and form no longer count.
    const again = bot("b6", [{ type: "data-search", data: { searchId: "s2" } }]);
    expect(threadFacts([search, enquiry, terms, again])).toMatchObject({ latestSearchId: "s2", pickedSupplierIds: [], termsFormOpen: false });
  });

  it("an open question is the newest message's", () => {
    const q = bot("b7", [{ type: "data-question", data: { questionId: "q1", slot: "residency", text: "Where?", options: [{ value: "sg", label: "Singapore" }] } }]);
    expect(threadFacts([q]).openQuestion).toBe(true);
    expect(threadFacts([q, user("u1", [{ type: "text", text: "sg" }])]).openQuestion).toBe(false);
  });
});

describe("actionEventText (UX-PLAN D4)", () => {
  it("says what Mei did, in the past tense, and nothing for the press the search card sends by itself", () => {
    expect(actionEventText({ type: "signed", actionId: ID(1), kind: "PlanApproval", refId: "d" })).toBe("You signed your plan");
    expect(actionEventText({ type: "signed", actionId: ID(1), kind: "SupplierApproval", refId: "t" })).toBe("You signed the order");
    expect(actionEventText({ type: "signed", actionId: ID(1), kind: "MilestoneRelease", refId: "o" })).toBe("You signed to pay the balance");
    expect(actionEventText({ type: "start_search", actionId: ID(1) })).toBe("You asked Hogee to find suppliers");
    expect(actionEventText({ type: "pick", actionId: ID(1), searchId: "s", supplierIds: ["a", "b"] })).toBe("You picked 2 suppliers");
    expect(actionEventText({ type: "terms_saved", actionId: ID(1), termsId: "t" })).toBe("You saved the deal");
    expect(actionEventText({ type: "show_candidates", actionId: ID(1), searchId: "s" })).toBeNull();
  });

  it("is wording-clean for every example action", () => {
    for (const a of exampleChatActions) {
      const t = actionEventText(a);
      if (t !== null) expect(checkText(t), t).toEqual([]);
    }
    for (const view of CFO_VIEWS) expect(checkText(actionEventText({ type: "show_cfo", actionId: ID(1), view }) ?? "")).toEqual([]);
  });
});

describe("partViews (UX-PLAN D7: one card per thing)", () => {
  const order = (id: string) => bot(id, [{ type: "text", text: "x" }, { type: "data-order", data: { termsId: "terms-1" } }]);
  const signPlan = { type: "data-sign" as const, data: { kind: "PlanApproval" as const, refId: exampleNeedsChecklist.draftId, title: "t", summary: "s", cta: "c" } };

  it("shows the newest copy in full and turns older ones into a line pointing down to it", () => {
    const v = partViews([order("b1"), order("b2"), order("b3")]);
    expect(v.get("2:1")).toEqual({ mode: "full" });
    expect(v.get("0:1")).toEqual({ mode: "moved", to: partAnchor(2, 1), below: true });
    expect(v.get("1:1")).toEqual({ mode: "moved", to: partAnchor(2, 1), below: true });
    expect(v.get("0:0")).toBeUndefined();
  });

  it("keeps the needs card as the plan's sign surface: a later bare plan sign card points up to it", () => {
    const v = partViews([bot("b1", [{ type: "data-needs", data: exampleNeedsChecklist }, signPlan]), bot("b2", [signPlan])]);
    expect(v.get("0:0")).toEqual({ mode: "full" });
    expect(v.get("0:1")).toEqual({ mode: "moved", to: partAnchor(1, 0), below: true });
    expect(v.get("1:0")).toEqual({ mode: "moved", to: partAnchor(0, 0), below: false });
  });

  it("hides the plan-draft link beside a needs card, and shows only its newest copy elsewhere", () => {
    const draft = { type: "data-plan-draft" as const, data: { draftId: "d1" } };
    const v = partViews([bot("b1", [{ type: "data-needs", data: { ...exampleNeedsChecklist, draftId: "d1" } }, draft]), bot("b2", [draft]), bot("b3", [draft])]);
    expect(v.get("0:1")).toEqual({ mode: "hidden" });
    expect(v.get("1:0")).toEqual({ mode: "hidden" });
    expect(v.get("2:0")).toEqual({ mode: "full" });
  });

  it("never touches the founder's own messages", () => {
    expect(partViews([user("u1", [{ type: "data-action", data: { action: { type: "start_search", actionId: ID(2) } } }])]).size).toBe(0);
  });
});

describe("heardLine", () => {
  it("is the intent in plain words, with no codes", () => {
    const line = heardLine({ ...examplePlanIntent, countryCode: "SG", residency: "citizen", entityType: "sole_prop", productCategory: "drinkware_food_contact", sellChannel: "shopee", budgetCeilingMinor: "1000000" } as typeof examplePlanIntent);
    expect(line).toBe("Singapore citizen · cups and bottles · Shopee · up to 10,000 BU");
    expect(heardLine({ ...examplePlanIntent, residency: "pr" })).toMatch(/^permanent resident in /);
    expect(checkText(line)).toEqual([]);
  });
});

describe("announcementFor", () => {
  it("names the cards of a reply once each, in order", () => {
    const reply = bot("b1", [
      { type: "text", text: "Here is your plan." },
      { type: "data-needs", data: exampleNeedsChecklist },
      { type: "data-sign", data: { kind: "PlanApproval", refId: "draft-1", title: "Approve", summary: "Sign it", cta: "Sign" } },
      { type: "data-next", data: { actions: [{ label: "Find suppliers", action: { type: "start_search", actionId: ID(12) } }] } },
    ]);
    expect(announcementFor(reply)).toBe("Hogee replied with what your business needs, something to sign and next steps.");
    expect(announcementFor(bot("b2", [{ type: "text", text: "Hi" }]))).toBe("Hogee replied.");
    expect(checkText(announcementFor(reply))).toEqual([]);
  });
});

describe("signProgress", () => {
  const plan = (status: PlanRecord["status"], txHash: string | null) => ({ status, txHash }) as Pick<PlanRecord, "status" | "txHash">;
  const terms = (status: OrderTerms["status"], orderId: string | null, rowTx: string | null = null) =>
    ({ status, orderId, schedule: [{ txHash: rowTx }] }) as unknown as Pick<OrderTerms, "status" | "orderId" | "schedule">;

  it("is idle until the founder submitted a signature", () => {
    expect(signProgress({ kind: "PlanApproval", submitted: false, submittedTx: null, baselineTx: null, plan: plan("COMMITTED", TX_A) })).toEqual({ state: "idle", txHash: null });
  });

  it("PlanApproval: confirmed once the plan is COMMITTED with a new tx", () => {
    const base = { kind: "PlanApproval" as const, submitted: true, submittedTx: TX_B, baselineTx: null };
    expect(signProgress({ ...base, plan: undefined })).toEqual({ state: "submitted", txHash: TX_B });
    expect(signProgress({ ...base, plan: plan("SUBMITTED", null) })).toEqual({ state: "submitted", txHash: TX_B });
    expect(signProgress({ ...base, plan: plan("COMMITTED", TX_B) })).toEqual({ state: "confirmed", txHash: TX_B });
  });

  it("PlanApproval: the plan committed before this signature is not a confirmation", () => {
    expect(signProgress({ kind: "PlanApproval", submitted: true, submittedTx: null, baselineTx: TX_A, plan: plan("COMMITTED", TX_A) })).toEqual({ state: "submitted", txHash: null });
  });

  it("PlanApproval: a new revert is a failure", () => {
    expect(signProgress({ kind: "PlanApproval", submitted: true, submittedTx: TX_B, baselineTx: null, plan: plan("REVERTED", TX_B) })).toEqual({ state: "failed", txHash: TX_B });
    expect(signProgress({ kind: "PlanApproval", submitted: true, submittedTx: null, baselineTx: TX_A, plan: plan("REVERTED", TX_A) }).state).toBe("submitted");
  });

  it("SupplierApproval: confirmed once the terms are USED by an order", () => {
    const base = { kind: "SupplierApproval" as const, submitted: true, submittedTx: TX_B, baselineTx: null };
    expect(signProgress({ ...base, terms: terms("CONFIRMED", null) })).toEqual({ state: "submitted", txHash: TX_B });
    expect(signProgress({ ...base, terms: terms("USED", "order-wabcdefghijkl-001") })).toEqual({ state: "confirmed", txHash: TX_B });
    expect(signProgress({ ...base, submittedTx: null, terms: terms("USED", "order-wabcdefghijkl-001", TX_A) })).toEqual({ state: "confirmed", txHash: TX_A });
  });

  it("other kinds stay submitted with the submit's tx (no reader for them here)", () => {
    expect(signProgress({ kind: "MilestoneRelease", submitted: true, submittedTx: TX_A, baselineTx: null })).toEqual({ state: "submitted", txHash: TX_A });
  });

  // run-10 v-1: the mock reuses the seeded draftId in every store build, and the Sample business commits that same
  // draft with its own made-up tx. A plan committed with another tx than this page's submit is not this signature.
  // RCFIX10 W-5: nor is it on its way (the mock commits before it answers the submit): the store was rebuilt from
  // elsewhere, so the stub says so (superseded) instead of "This updates by itself in a moment" forever.
  it("PlanApproval: a plan committed with another tx than the one this page submitted is not a confirmation", () => {
    const base = { kind: "PlanApproval" as const, submitted: true, submittedTx: TX_A, baselineTx: null };
    expect(signProgress({ ...base, plan: plan("COMMITTED", TX_S) })).toEqual({ state: "superseded", txHash: TX_A });
    expect(signProgress({ ...base, plan: plan("REVERTED", TX_S) })).toEqual({ state: "superseded", txHash: TX_A });
    expect(signProgress({ ...base, baselineTx: TX_B, plan: plan("COMMITTED", TX_S) })).toEqual({ state: "superseded", txHash: TX_A });
    expect(signProgress({ ...base, plan: plan("COMMITTED", TX_A) })).toEqual({ state: "confirmed", txHash: TX_A });
  });

  it("PlanApproval: superseded only when the record carries a tx that is not this page's submit", () => {
    const base = { kind: "PlanApproval" as const, submitted: true, submittedTx: TX_A, baselineTx: null };
    // The rebuilt store's plan is the sample's commit made before this tab opened its dialog: still not this signature.
    expect(signProgress({ ...base, baselineTx: TX_S, plan: plan("COMMITTED", TX_S) })).toEqual({ state: "superseded", txHash: TX_A });
    // No plan read yet, or no tx on it: nothing says another signature changed it, so it is still on its way.
    expect(signProgress({ ...base, plan: undefined })).toEqual({ state: "submitted", txHash: TX_A });
    expect(signProgress({ ...base, plan: null })).toEqual({ state: "submitted", txHash: TX_A });
    expect(signProgress({ ...base, plan: plan("SUBMITTED", null) })).toEqual({ state: "submitted", txHash: TX_A });
  });

  it("a submit queued without a tx (live) is never superseded", () => {
    const live = { submitted: true, submittedTx: null, baselineTx: TX_A } as const;
    expect(signProgress({ ...live, kind: "PlanApproval", plan: plan("COMMITTED", TX_A) })).toEqual({ state: "submitted", txHash: null });
    expect(signProgress({ ...live, kind: "PlanApproval", baselineTx: null, plan: plan("SUBMITTED", null) })).toEqual({ state: "submitted", txHash: null });
    const used = { ...terms("USED", "order-wabcdefghijkl-001"), bindTxHash: TX_S };
    expect(signProgress({ ...live, kind: "SupplierApproval", terms: used })).toEqual({ state: "confirmed", txHash: TX_S });
    expect(signProgress({ ...live, kind: "SupplierApproval", terms: { ...terms("CONFIRMED", null), bindTxHash: null } })).toEqual({ state: "submitted", txHash: null });
  });

  it("PlanApproval: a submit queued without a tx (live) still confirms on the plan's first new commit", () => {
    expect(signProgress({ kind: "PlanApproval", submitted: true, submittedTx: null, baselineTx: TX_A, plan: plan("COMMITTED", TX_B) })).toEqual({ state: "confirmed", txHash: TX_B });
  });

  it("SupplierApproval: confirmed with the order's bindPayee tx; another bind tx than the submitted one is not this signature", () => {
    const used = (bindTxHash: string | null, rowTx: string | null = null) => ({ ...terms("USED", "order-wabcdefghijkl-001", rowTx), bindTxHash });
    const base = { kind: "SupplierApproval" as const, submitted: true, baselineTx: null };
    expect(signProgress({ ...base, submittedTx: TX_A, terms: used(TX_A) })).toEqual({ state: "confirmed", txHash: TX_A });
    expect(signProgress({ ...base, submittedTx: TX_A, terms: used(TX_S) })).toEqual({ state: "superseded", txHash: TX_A });
    // Terms not used yet, or used with no bind tx known: nothing says another signature changed them.
    expect(signProgress({ ...base, submittedTx: TX_A, terms: { ...terms("CONFIRMED", null), bindTxHash: null } })).toEqual({ state: "submitted", txHash: TX_A });
    expect(signProgress({ ...base, submittedTx: TX_A, terms: used(null) })).toEqual({ state: "confirmed", txHash: TX_A });
    // After a reload (no submit tx on this page) the seal is the order's bind tx, not a later payment's.
    expect(signProgress({ ...base, submittedTx: null, terms: used(TX_A, TX_B) })).toEqual({ state: "confirmed", txHash: TX_A });
  });
});

describe("signPollInterval", () => {
  const every = 1_500;
  it("re-reads the record only while a signature is out and the record does not show it yet", () => {
    expect(signPollInterval({ state: "submitted", txHash: TX_A }, every)).toBe(every);
    expect(signPollInterval({ state: "submitted", txHash: null }, every)).toBe(every);
    for (const state of ["idle", "confirmed", "failed"] as const) expect(signPollInterval({ state, txHash: null }, every)).toBe(false);
  });

  it("stops once superseded: the store was rebuilt, so polling would never see this signature", () => {
    const progress = signProgress({ kind: "PlanApproval", submitted: true, submittedTx: TX_A, baselineTx: null, plan: { status: "COMMITTED", txHash: TX_S } });
    expect(progress.state).toBe("superseded");
    expect(signPollInterval(progress, every)).toBe(false);
  });
});

// RCFIX10 A-4: the order card said "Automatic payments paused" as soon as the API took the request, before the chain paused.
describe("stopPaymentsView (the order card's pause link)", () => {
  it("a request the API accepted is pausing, never paused, until the chain says paused", () => {
    expect(stopPaymentsView(false, true)).toBe("pausing");
    expect(stopPaymentsView(false, true)).not.toBe("paused");
  });

  it("is paused only when the balances say so (as the wallet rail), whoever paused", () => {
    expect(stopPaymentsView(true, true)).toBe("paused");
    expect(stopPaymentsView(true, false)).toBe("paused");
  });

  it("offers the link while nothing is paused or requested", () => {
    expect(stopPaymentsView(false, false)).toBe("offer");
  });
});

describe("this browser's seals (hogee.signedAt)", () => {
  const AT = Date.parse("2026-10-19T05:32:00.000Z");

  it("reads a well-formed entry, with its tx when it has one", () => {
    expect(parseSignedLocally({ at: AT, method: "passkey", txHash: TX_A })).toEqual({ at: AT, method: "passkey", txHash: TX_A });
    expect(parseSignedLocally({ at: AT, method: "wallet", txHash: TX_A })).toEqual({ at: AT, method: "wallet", txHash: TX_A });
    expect(parseSignedLocally({ at: AT, method: "passkey", txHash: null })).toEqual({ at: AT, method: "passkey", txHash: null });
  });

  it("an entry written before the tx was kept reads with no tx", () => {
    expect(parseSignedLocally({ at: AT, method: "passkey" })).toEqual({ at: AT, method: "passkey", txHash: null });
    expect(parseSignedLocally({ at: AT, method: "passkey", txHash: 7 })).toEqual({ at: AT, method: "passkey", txHash: null });
    expect(parseSignedLocally({ at: AT, method: "passkey", txHash: "" })).toEqual({ at: AT, method: "passkey", txHash: null });
  });

  it("anything malformed reads as nothing kept", () => {
    for (const bad of [undefined, null, "x", 3, [], {}, { at: "1", method: "passkey" }, { at: Number.NaN, method: "passkey" }, { at: 9e15, method: "passkey" }, { at: AT, method: "sms" }]) {
      expect(parseSignedLocally(bad)).toBeUndefined();
    }
  });

  it("a seal is this browser's only when the tx this browser recorded is the seal's own", () => {
    expect(isOwnSeal(TX_A, TX_A)).toBe(true);
    expect(isOwnSeal(TX_A, TX_S)).toBe(false);
    expect(isOwnSeal(TX_A, null)).toBe(false);
    expect(isOwnSeal(null, TX_A)).toBe(false);
    expect(isOwnSeal(undefined, TX_A)).toBe(false);
    expect(isOwnSeal("", "")).toBe(false);
  });

  it("pageOwnsSeal: this page's record owns a seal only with its submit's tx, or (queued live, no tx) the seal it confirmed", () => {
    expect(pageOwnsSeal(TX_A, TX_A)).toBe(true);
    expect(pageOwnsSeal(TX_A, TX_S)).toBe(false);
    expect(pageOwnsSeal(TX_A, null)).toBe(false);
    expect(pageOwnsSeal(null, TX_B)).toBe(true);
    expect(pageOwnsSeal(null, null)).toBe(false);
  });

  it("keptSignature: the stamp's method and time only for the seal this browser signed (fail closed otherwise)", () => {
    expect(keptSignature({ at: AT, method: "passkey", txHash: TX_A }, TX_A)).toEqual({ signedAt: "2026-10-19T05:32:00.000Z", method: "passkey" });
    // The Sample business's commit of the same draftId: another tx, so not this browser's.
    expect(keptSignature({ at: AT, method: "passkey", txHash: TX_A }, TX_S)).toBeUndefined();
    // An entry from before the tx was kept is never this browser's, whatever the seal.
    expect(keptSignature({ at: AT, method: "passkey" }, TX_S)).toBeUndefined();
    expect(keptSignature({ at: AT, method: "passkey" }, TX_A)).toBeUndefined();
    expect(keptSignature({ at: AT, method: "passkey", txHash: TX_A }, null)).toBeUndefined();
    expect(keptSignature(undefined, TX_A)).toBeUndefined();
  });

  it("withSignedTx: fills the tx of this page's own entry once, never another signing's", () => {
    const entries = { "PlanApproval:d1": { at: AT, method: "passkey", txHash: null }, other: 1 };
    expect(withSignedTx(entries, "PlanApproval:d1", AT, TX_A)).toEqual({ "PlanApproval:d1": { at: AT, method: "passkey", txHash: TX_A }, other: 1 });
    expect(entries["PlanApproval:d1"].txHash).toBeNull();
    // Another signing (another time), an entry that already has a tx, or no entry: nothing is written.
    expect(withSignedTx(entries, "PlanApproval:d1", AT + 1, TX_A)).toBeUndefined();
    expect(withSignedTx({ k: { at: AT, method: "passkey", txHash: TX_B } }, "k", AT, TX_A)).toBeUndefined();
    expect(withSignedTx({}, "k", AT, TX_A)).toBeUndefined();
  });
});

describe("needs helpers", () => {
  it("groups items in the fixed group order, skipping empty groups", () => {
    const groups = needsGroups(exampleNeedsChecklist);
    expect(groups.map((g) => g.group)).toEqual(NEEDS_GROUPS.filter((g) => exampleNeedsChecklist.items.some((i) => i.group === g)));
    expect(groups.flatMap((g) => g.items).length).toBe(exampleNeedsChecklist.items.length);
    for (const g of groups) expect(checkText(g.label), g.label).toEqual([]);
  });

  it("labels statuses and sources in plain words", () => {
    for (const s of NEEDS_STATUSES) expect(checkText(needsStatusLabel(s))).toEqual([]);
    expect(needsSourceLabel("/registrations/0")).toBe("Country pack");
    expect(needsSourceLabel("compiler:line.supplier")).toBe("Plan compiler");
    expect(needsSourceLabel("constitution:RESERVE_BELOW_FLOOR")).toBe("On-chain constitution");
    expect(needsSourceLabel(null)).toBe("No source yet");
  });

  it("shows amounts in whole BU, a zero fee as free, and no amount as nothing", () => {
    expect(needsAmountText("11500")).toBe("115 BU");
    expect(needsAmountText("0")).toBe("Free");
    expect(needsAmountText(null)).toBeNull();
  });

  it("shows the reserve rate as a short percentage", () => {
    expect(percentOfBps(500)).toBe("5%");
    expect(percentOfBps(250)).toBe("2.5%");
  });

  it("splits a BU figure from its unit", () => {
    expect(buFigure("1000000")).toEqual({ figure: "10,000", unit: "BU" });
  });

  it("sizes the allocation bar from the budget lines with amounts", () => {
    const bar = budgetBar({
      ...exampleNeedsChecklist,
      items: [
        ...exampleNeedsChecklist.items,
        { itemId: "need-line-ads", group: "BUDGET_LINE", title: "Ads", detail: null, amountMinor: "500000", lineKey: "ADS", sourceRef: "compiler:line-split", status: "IN_PLAN" },
      ],
    });
    expect(bar.map((b) => [b.lineKey, b.pct])).toEqual([
      ["SUPPLIER", 50],
      ["ADS", 50],
    ]);
  });

  it("counts items by status", () => {
    expect(needsCounts(exampleNeedsChecklist)).toEqual({ TODO: 2, IN_PLAN: 4, DONE: 0 });
  });
});

describe("enquiryClipboardText", () => {
  it("is the subject line, a blank line, then the body", () => {
    expect(enquiryClipboardText({ subject: "Enquiry: 500 tumblers", body: "Hello" })).toBe("Subject: Enquiry: 500 tumblers\n\nHello");
  });
});

describe("signature kinds", () => {
  it("has a confirmation reader decision for every kind", () => {
    for (const kind of SIGNATURE_KINDS) expect(signProgress({ kind, submitted: true, submittedTx: null, baselineTx: null }).state).toBe("submitted");
  });
});
