/**
 * The mock chat journey (v-chat-server brief 6): MOCK_SCENARIO=fresh (SG, Mei) runs end to end on core's journey: the
 * scripted intake, the plan reply with the needs and PlanApproval cards, then buttons and typed text (regex router).
 * The search and the terms run through the merged feature handlers: v-search's recorded search (PENDING for
 * SEARCH_DELAY_MS, then READY; the clock is skewed past it rather than waited out) and v-terms' submitOrderTerms (the
 * REST form the terms card posts), so the ids are the ones those features mint. Also: the regex router on the demo's
 * phrases, single-use action ids, and the mock half of the journey contract (core JOURNEY_CONTRACT_STEPS).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  JOURNEY_CONTRACT_STEPS,
  NEXT_STEP_TEXT,
  SupplierSearch,
  TERMS_PRESET_MILESTONES,
  TEXT,
  walletFigures,
  type Balances,
  type CandidateCard,
  type CfoReport,
  type ChatAction,
  type ChatMessage,
  type NeedsChecklist,
  type OrderTerms,
  type PlanDraft,
  type PlanRecord,
  type SignatureRequestResponse,
  type TermsPreset,
} from "@hogee/core";
import { app } from "../src/index";
import { readEnv } from "../src/env";
import { SEARCH_DELAY_MS, mockWebSupplier } from "../src/features/search";
import { classifyByRules } from "../src/journey/classify";
import { getState, resetState } from "../src/store";
import { harness, json, secret } from "./support/harness";
import { enrolFounder, submitWith } from "./support/passkey";

vi.mock("@hogee/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@hogee/core")>();
  // v-search's buildEnquiry is a stub in this worktree: a templated stand-in (no seller names, like the real one).
  return { ...core, buildEnquiry: (i: { supplierIds: readonly string[]; quantity: number }) => ({ supplierIds: [...i.supplierIds], subject: `Enquiry: ${i.quantity} units`, body: "Please quote your unit price, MOQ and lead time." }) };
});

const SESSION = "01a14202-2800-7000-8000-00000000f001";
const h = harness(app);

beforeAll(() => {
  process.env.DEMO_MODE = "1";
  process.env.PERSONA_COOKIE_SECRET = secret();
  process.env.OFFICER_TOKEN = secret();
});
beforeEach(() => {
  vi.stubEnv("MOCK_SCENARIO", "fresh");
  resetState(readEnv());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetState(readEnv());
});

interface Chunk {
  type: string;
  delta?: string;
  data?: unknown;
}
async function post(body: unknown): Promise<Chunk[]> {
  const res = await app.request("/api/chat", { ...json(body), headers: { "content-type": "application/json", cookie: await h.cookie("founder") } });
  expect(res.status).toBe(200);
  return (await res.text())
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)) as Chunk);
}
const say = (message: string) => post({ sessionId: SESSION, message });
const act = (action: ChatAction) => post({ sessionId: SESSION, action });
const types = (chunks: readonly Chunk[]) => chunks.filter((c) => c.type === "text-start" || c.type.startsWith("data-")).map((c) => (c.type === "text-start" ? "text" : c.type));
const textOf = (chunks: readonly Chunk[]) => chunks.filter((c) => c.type === "text-delta").map((c) => c.delta).join("");
const nextActions = (chunks: readonly Chunk[]) => (chunks.find((c) => c.type === "data-next")?.data as { actions: { label: string; action: ChatAction }[] } | undefined)?.actions ?? [];
let n = 0;
const id = () => `01a14202-2800-7000-8000-${String((n += 1)).padStart(12, "0")}`;

/** The search a data-search card names, READY: Date.now is skewed past the mock's PENDING window (no wall-clock wait). */
async function readySearch(chunks: readonly Chunk[]): Promise<{ searchId: string; first: CandidateCard }> {
  const searchId = (chunks.find((c) => c.type === "data-search")?.data as { searchId?: string } | undefined)?.searchId as string;
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + SEARCH_DELAY_MS + 1);
  const search = SupplierSearch.parse((await h.call(`/api/suppliers/search/${searchId}`)).body);
  expect(search.status).toBe("READY");
  const first = search.candidates.find((c) => c.rank === 1);
  expect(first?.canOrder).toBe(true);
  return { searchId, first: first as CandidateCard };
}

/** The founder's terms form (v-terms' submitOrderTerms): the demo's 2,500 BU at 30/70 (or `preset`), paid to the listing's seller. */
async function submitTerms(searchId: string, supplierId: string, preset: TermsPreset = "P30_70"): Promise<string> {
  const sellerName = mockWebSupplier(getState(readEnv()), supplierId)?.sellerName as string;
  const res = await h.call<OrderTerms>(
    "/api/orders/terms",
    json({
      supplierId,
      searchId,
      quantity: 1000,
      totalMinor: "250000",
      milestones: TERMS_PRESET_MILESTONES[preset].map((m) => ({ ...m })),
      payout: { holderName: sellerName, bankName: "DBS Bank", accountNumber: "100200300400", payeeType: "company" },
    }),
  );
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("CONFIRMED");
  return res.body.termsId;
}

/** The plan the founder signed (the mock's PlanApproval submit commits at once; tests skip the passkey ceremony). */
function commitPlan(): void {
  const st = getState(readEnv());
  const draft = st.loaded.scenario["plan-draft.json"];
  st.plans.push({ manifest: draft.manifest, status: "COMMITTED", planHash: "0x" + "ab".repeat(32), txHash: "0x" + "cd".repeat(32) } as never);
}

async function intake(): Promise<Chunk[]> {
  for (let i = 0; i < 3; i += 1) expect(types(await say(i === 0 ? "I want to sell custom insulated tumblers on Shopee Singapore, budget S$10,000" : "yes"))).toContain("data-question");
  return say("Yes, keep the plan within S$10,000.");
}

describe("mock journey (fresh, SG)", () => {
  it("runs from intake to the signed order's terms on core's journey", { timeout: 60_000 }, async () => {
    expect(types(await intake())).toEqual(["text", "data-intent", "data-plan-draft", "data-needs", "data-sign"]);

    commitPlan();
    const signed = await act({ type: "signed", actionId: id(), kind: "PlanApproval", refId: getState(readEnv()).loaded.scenario["plan-draft.json"].draftId });
    expect(textOf(signed)).toBe(TEXT.planLive);
    expect(nextActions(signed).map((a) => a.label)).toEqual(["Find suppliers", "How are we doing?"]);

    const searching = await act(nextActions(signed)[0]?.action as ChatAction);
    expect(types(searching)).toEqual(["text", "data-search"]);
    const { searchId, first } = await readySearch(searching);
    const W1 = first.supplierId;
    const candidates = await act({ type: "show_candidates", actionId: id(), searchId });
    expect(types(candidates)).toEqual(["text", "data-candidates"]);

    const picked = await act({ type: "pick", actionId: id(), searchId, supplierIds: [W1] });
    expect(types(picked)).toEqual(["text", "data-enquiry", "data-next"]);
    expect(nextActions(picked).map((a) => a.label)).toEqual(["I've made a deal"]);

    // UX-PLAN D5: "who is the supplier?" after picking: the template and the list card (names travel only in the card).
    const who = await say("who is the supplier?");
    expect(textOf(who)).toBe(TEXT.supplier);
    expect(types(who)).toEqual(["text", "data-candidates"]);
    const form = await act(nextActions(picked)[0]?.action as ChatAction);
    expect(types(form)).toEqual(["text", "data-terms"]);

    const typed = await say(`went with #1, 30% deposit, 70% on delivery`);
    expect(typed.find((c) => c.type === "data-terms")?.data).toMatchObject({ supplierId: W1, preset: "P30_70", source: "founder_text" });

    const termsId = await submitTerms(searchId, W1);
    const saved = await act({ type: "terms_saved", actionId: id(), termsId });
    expect(types(saved)).toEqual(["text", "data-sign"]);
    expect(saved.find((c) => c.type === "data-sign")?.data).toMatchObject({ kind: "SupplierApproval", refId: termsId });

    const cfo = await say("How are we doing?");
    expect(cfo.find((c) => c.type === "data-cfo")?.data).toEqual({ view: "overview" });

    // The history reloads with every card, and every message parses.
    const history = (await h.call<ChatMessage[]>(`/api/chat/${SESSION}`)).body;
    const kinds = new Set(history.flatMap((m) => m.parts.map((p) => p.type)));
    for (const k of ["data-needs", "data-candidates", "data-enquiry", "data-terms", "data-cfo", "data-sign"]) expect(kinds.has(k)).toBe(true);
    expect(JSON.stringify(history.filter((m) => m.role === "assistant").flatMap((m) => m.parts.filter((p) => p.type === "text")))).not.toContain(first.displayName);
    // Every press is traced on the session's journey trace; every typed turn is a planner PROPOSAL of its own.
    const presses = history.filter((m) => m.role === "user" && m.parts.some((p) => p.type === "data-action")).length;
    expect(getState(readEnv()).traces.filter((t) => t.traceId === `journey-${SESSION}`).length).toBe(presses);
    expect(getState(readEnv()).traces.filter((t) => t.actor === "planner" && t.kind === "PROPOSAL").length).toBe(history.length / 2 - presses);
  });

  it("answers a replayed action id 'already done' and stores nothing", async () => {
    commitPlan();
    const a: ChatAction = { type: "show_cfo", actionId: id(), view: "overview" };
    await act(a);
    const again = await act(a);
    expect(textOf(again)).toContain(TEXT.alreadyDone);
    expect(getState(readEnv()).chats.get(SESSION)?.messages).toHaveLength(2);
  });

  it("a request to move money is out_of_scope: nothing searched, no signature card", { timeout: 30_000 }, async () => {
    await intake();
    commitPlan();
    const r = await say("pay the supplier 1200 now");
    expect(textOf(r)).toBe(TEXT.outOfScope);
    expect(types(r)).not.toContain("data-sign");
    expect(types(r)).not.toContain("data-search");
  });

  it("quick replies: safety and what-next answer from templates at intake, without advancing the script or a sign card", { timeout: 30_000 }, async () => {
    const safe = await say("is my money safe?");
    expect(textOf(safe)).toBe(TEXT.safetyBeforePlan);
    expect(types(safe)).toEqual(["text"]);
    // No passkey made yet: the passkey first, as the Next step bar says (first-timer #3); with one, the questions.
    const next = await say("what do I do now?");
    expect(textOf(next)).toBe(TEXT.nextPasskey);
    await enrolFounder(h.call);
    expect(textOf(await say("what do I do now?"))).toMatch(/^Next: Tell me what you sell/);
    // The scripted intake starts where it was: the first question comes next.
    expect(types(await say("I want to sell custom insulated tumblers on Shopee Singapore, budget S$10,000"))).toContain("data-question");
    expect(getState(readEnv()).chats.get(SESSION)?.turn).toBe(1);
    await say("yes");
    await say("yes");
    const plan = await say("Yes, keep the plan within S$10,000.");
    expect(types(plan)).toContain("data-sign");
    // After the plan reply, "is it safe?" still brings no signature card.
    expect(types(await say("is it safe?"))).not.toContain("data-sign");
    commitPlan();
    expect(textOf(await say("is my money safe?"))).toBe(TEXT.safety);
  });

  it("before the plan is signed, a search button is refused", async () => {
    const r = await act({ type: "start_search", actionId: id() });
    expect(textOf(r)).toContain(TEXT.needPlanFirst);
  });
});

/**
 * The demo video's numbers, end to end on the real signing path (passkey, PlanApproval → pockets, SupplierApproval →
 * cooling → the agent's deposit → the founder's release): the needs card lists the plan's own six lines, and
 * /api/balances (chain-raw), the CFO report and the wallet's figures (core walletFigures, what the rail and the CFO
 * page's tiles show) agree after the 750 BU deposit and again after the 1,750 BU balance.
 */
describe("mock journey numbers (fresh, SG)", () => {
  let now = Date.parse("2026-10-19T06:00:00Z");
  const tick = (ms: number) => {
    now += ms;
    vi.setSystemTime(now);
  };
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    vi.stubEnv("DEMO_TIMELOCK_SECONDS", "5");
    resetState(readEnv());
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const sign = async (key: Awaited<ReturnType<typeof enrolFounder>>, kind: string, refId: string) => {
    const req = await h.call<SignatureRequestResponse>("/api/signatures/request", json({ kind, refId, method: "passkey" }));
    expect(req.status, `${kind} request`).toBe(200);
    expect((await submitWith(h.call, key, req.body)).body.state, `${kind} submit`).toBe("BROADCAST");
  };
  const wallet = async () => {
    const [balances, report, plan] = await Promise.all([h.call<Balances>("/api/balances"), h.call<CfoReport>("/api/cfo"), h.call<PlanRecord>("/api/plans/current")]);
    const figures = walletFigures({ planTotalMinor: plan.body.manifest.totalMinor, pockets: balances.body.pockets, escrowMinor: balances.body.escrowMinor, supplierPaidMinor: report.body.pnl.supplierCostMinor });
    return { balances: balances.body, report: report.body, figures, supplier: balances.body.pockets.find((p) => p.lineKey === "SUPPLIER") };
  };

  it("needs card = the plan's six lines; after the deposit and after the release every surface agrees", { timeout: 60_000 }, async () => {
    const key = await enrolFounder(h.call);
    const planReply = await intake();
    const { draftId } = planReply.find((c) => c.type === "data-plan-draft")?.data as { draftId: string };
    const draft = getState(readEnv()).drafts.get(draftId) as PlanDraft;
    const needs = planReply.find((c) => c.type === "data-needs")?.data as NeedsChecklist;
    // The needs card is core buildNeeds over a really compiled plan: the same six lines and amounts the plan card shows.
    expect(needs.draftId).toBe(draft.draftId);
    expect(needs.totalMinor).toBe(draft.manifest.totalMinor);
    const lines = needs.items.filter((i) => i.group === "BUDGET_LINE").map((i) => [i.lineKey, i.amountMinor]);
    expect(lines).toEqual(draft.manifest.lines.map((l) => [l.lineKey, l.amountMinor]));
    expect(lines).toHaveLength(6);
    expect(needs.items.map((i) => i.group)).toEqual(expect.arrayContaining(["REGISTRATION", "SUPPLIER", "ACCOUNT", "TAX_RESERVE"]));

    await sign(key, "PlanApproval", draft.draftId);
    await act({ type: "signed", actionId: id(), kind: "PlanApproval", refId: draft.draftId });
    const before = await wallet();
    expect(before.figures).toMatchObject({ totalMinor: "1000000", leftMinor: "1000000", escrowCommittedMinor: "0", supplierPaidMinor: "0", escrowHeldMinor: "0", spentMinor: "0" });

    const searching = await act({ type: "start_search", actionId: id() });
    const searchId = (searching.find((c) => c.type === "data-search")?.data as { searchId: string }).searchId;
    tick(SEARCH_DELAY_MS + 1);
    const search = SupplierSearch.parse((await h.call(`/api/suppliers/search/${searchId}`)).body);
    const first = search.candidates.find((c) => c.rank === 1) as CandidateCard;
    await act({ type: "show_candidates", actionId: id(), searchId });
    await act({ type: "pick", actionId: id(), searchId, supplierIds: [first.supplierId] });
    const termsId = await submitTerms(searchId, first.supplierId);
    expect(types(await act({ type: "terms_saved", actionId: id(), termsId }))).toEqual(["text", "data-sign"]);
    await sign(key, "SupplierApproval", termsId);
    expect(types(await act({ type: "signed", actionId: id(), kind: "SupplierApproval", refId: termsId }))).toContain("data-order");

    // Cooling, then the agent's 750 BU deposit and the 1,750 BU balance escrowed; both mined.
    tick(6_000);
    await h.call(`/api/orders/terms/${termsId}`);
    tick(6_000);
    const paid = await wallet();
    // Chain-raw, as live: 2,500 BU moved into escrow; the paid-out deposit stays counted there, never in the pocket's spent.
    expect(paid.balances.escrowMinor).toBe("250000");
    expect(paid.supplier).toMatchObject({ allocated: "500000", spent: "0", available: "250000" });
    expect(paid.report.pnl.supplierCostMinor).toBe("75000");
    expect(paid.figures).toMatchObject({ leftMinor: "750000", escrowCommittedMinor: "250000", supplierPaidMinor: "75000", escrowHeldMinor: "175000", spentMinor: "75000" });
    // The CFO card's spent and the wallet's spent are one number.
    expect(paid.report.overview.spentMinor).toBe(paid.figures.spentMinor);

    // The founder's release with evidence: the balance pays out; nothing moves in the pocket or the escrow total.
    const orderId = (await h.call<OrderTerms>(`/api/orders/terms/${termsId}`)).body.orderId as string;
    const form = new FormData();
    form.append("file", new Blob([new TextEncoder().encode("delivery check: 1000 tumblers ok")], { type: "application/pdf" }), "check.pdf");
    expect((await h.call(`/api/escrow/${orderId}/inspection`, { method: "POST", body: form })).status).toBe(200);
    await sign(key, "MilestoneRelease", orderId);
    tick(6_000);
    const released = await wallet();
    expect(released.balances.escrowMinor).toBe("250000");
    expect(released.supplier).toMatchObject({ spent: "0", available: "250000" });
    expect(released.figures).toMatchObject({ leftMinor: "750000", supplierPaidMinor: "250000", escrowHeldMinor: "0", spentMinor: "250000" });
    expect(released.report.overview.spentMinor).toBe(released.figures.spentMinor);

    // UX-PLAN D35: the release reply and every later reply say the order is complete, never "the balance waits".
    const done = await act({ type: "signed", actionId: id(), kind: "MilestoneRelease", refId: orderId });
    expect(textOf(done)).toBe(TEXT.orderComplete);
    expect(textOf(await say("where are we?"))).toBe("Next: Order complete. Ask me how the business is doing any time.");
    expect(textOf(await say("status of my order"))).toContain(TEXT.orderComplete);
  });
});

/** rcfix-journey A-6, A-7: the release reply and the Next step answer from the store's own facts. */
describe("mock journey: server facts behind the replies (fresh, SG)", () => {
  let now = Date.parse("2026-10-19T06:00:00Z");
  const tick = (ms: number) => {
    now += ms;
    vi.setSystemTime(now);
  };
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    vi.stubEnv("DEMO_TIMELOCK_SECONDS", "5");
    resetState(readEnv());
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const sign = async (key: Awaited<ReturnType<typeof enrolFounder>>, kind: string, refId: string) => {
    const req = await h.call<SignatureRequestResponse>("/api/signatures/request", json({ kind, refId, method: "passkey" }));
    expect(req.status, `${kind} request`).toBe(200);
    expect((await submitWith(h.call, key, req.body)).body.state, `${kind} submit`).toBe("BROADCAST");
  };

  /** Intake → signed plan → search → pick → saved terms (`preset`) → signed order: the safety wait has started. */
  async function ordered(preset: TermsPreset) {
    const key = await enrolFounder(h.call);
    const { draftId } = (await intake()).find((c) => c.type === "data-plan-draft")?.data as { draftId: string };
    await sign(key, "PlanApproval", draftId);
    await act({ type: "signed", actionId: id(), kind: "PlanApproval", refId: draftId });
    const searching = await act({ type: "start_search", actionId: id() });
    const searchId = (searching.find((c) => c.type === "data-search")?.data as { searchId: string }).searchId;
    tick(SEARCH_DELAY_MS + 1);
    const search = SupplierSearch.parse((await h.call(`/api/suppliers/search/${searchId}`)).body);
    const first = search.candidates.find((c) => c.rank === 1) as CandidateCard;
    await act({ type: "show_candidates", actionId: id(), searchId });
    await act({ type: "pick", actionId: id(), searchId, supplierIds: [first.supplierId] });
    const termsId = await submitTerms(searchId, first.supplierId, preset);
    await act({ type: "terms_saved", actionId: id(), termsId });
    await sign(key, "SupplierApproval", termsId);
    await act({ type: "signed", actionId: id(), kind: "SupplierApproval", refId: termsId });
    const orderId = (await h.call<OrderTerms>(`/api/orders/terms/${termsId}`)).body.orderId as string;
    return { key, termsId, orderId };
  }

  it("what do I do now? in the safety wait: the paused step once payments are paused (A-7)", { timeout: 60_000 }, async () => {
    await ordered("P30_70");
    expect(textOf(await say("what do I do now?"))).toMatch(/^Next: Safety wait/);
    expect((await h.call("/api/control/pause", { method: "POST" })).status).toBe(200);
    expect(getState(readEnv()).balances.paused).toBe(true);
    const paused = textOf(await say("what do I do now?"));
    expect(paused).toBe(`Next: ${NEXT_STEP_TEXT.paused}`);
    expect(paused).not.toContain("paid automatically");
  });

  it("a release hint says 'Signed' only once the store holds the founder's release; else not seen (A-6)", { timeout: 60_000 }, async () => {
    const { key, termsId, orderId } = await ordered("P30_40_30");
    const hint = () => act({ type: "signed", actionId: id(), kind: "MilestoneRelease", refId: orderId });
    // Nothing released or signed yet: the browser's hint alone is not a signature.
    const early = textOf(await hint());
    expect(early).toContain(TEXT.signatureNotSeen);
    expect(early).not.toContain(TEXT.releaseSigned);
    // After the safety wait the agent pays the deposit and escrows both held milestones; still nothing released.
    tick(6_000);
    await h.call(`/api/orders/terms/${termsId}`);
    tick(6_000);
    await h.call(`/api/orders/terms/${termsId}`);
    expect(textOf(await hint())).toContain(TEXT.signatureNotSeen);
    // The founder releases the shipment milestone (the delivery one still waits): their signed release is the fact.
    const form = new FormData();
    form.append("file", new Blob([new TextEncoder().encode("shipment check: 1000 tumblers loaded")], { type: "application/pdf" }), "check.pdf");
    expect((await h.call(`/api/escrow/${orderId}/inspection`, { method: "POST", body: form })).status).toBe(200);
    await sign(key, "MilestoneRelease", orderId);
    expect(textOf(await hint())).toBe(TEXT.releaseSigned);
  });
});

describe("regex router", () => {
  it.each([
    ["How are we doing?", { skill: "cfo", cfoView: "overview", candidateRanks: null }],
    ["went with #2, 30% deposit, 70% on delivery", { skill: "report_terms", candidateRanks: [2] }],
    ["went with #7, 50/50", { skill: "report_terms", candidateRanks: [7] }],
    ["actually 40/60", { skill: "report_terms", candidateRanks: null }],
    ["I like #2 and #4", { skill: "pick_suppliers", candidateRanks: [2, 4] }],
    ["pay the supplier now", { skill: "out_of_scope" }],
    ["transfer 500 to this account", { skill: "out_of_scope" }],
    ["release the balance", { skill: "out_of_scope" }],
    ["pay 30% deposit, 70% on delivery", { skill: "report_terms" }],
    ["find me other suppliers", { skill: "find_suppliers" }],
    ["what's the forecast?", { skill: "cfo", cfoView: "forecast" }],
    ["how much tax have we set aside", { skill: "cfo", cfoView: "reserve" }],
    ["where are we?", { skill: "status" }],
    ["hello", { skill: "help" }],
    ["tell me a joke", { skill: "out_of_scope" }],
  ])("%s", (text, expected) => {
    expect(classifyByRules(text, 8)).toMatchObject(expected);
  });

  it("drops ranks outside the list", () => {
    expect(classifyByRules("went with #5, 30/70", 3)).toEqual({ skill: "report_terms", candidateRanks: null, cfoView: null });
  });
});

describe("journey contract (mock half)", () => {
  it("plays the contract script with the expected part types", { timeout: 60_000 }, async () => {
    commitPlan();
    // The live half starts from a READY web search in the database; here the search is started through the button.
    const { searchId, first } = await readySearch(await act({ type: "start_search", actionId: id() }));
    const ids: string[] = [];
    let termsId = "";
    for (const step of JOURNEY_CONTRACT_STEPS) {
      // As in the live half, the terms appear just before terms_saved, as the REST form would make them.
      if (step.label === "terms saved") termsId = await submitTerms(searchId, first.supplierId);
      const actionId = step.replayOf !== undefined ? (ids[step.replayOf] as string) : id();
      ids.push(actionId);
      const chunks = await act(step.action({ actionId, searchId, supplierId: first.supplierId, termsId }));
      expect(types(chunks), step.label).toEqual(step.expect);
    }
  });
});
