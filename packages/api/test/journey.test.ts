/**
 * The live chat journey (v-chat-server brief 4) over an in-memory store: buttons run their effects and re-check every id
 * against the facility's latest list; free text after the plan goes through classifySkill (redacted text only, never
 * web text) and core's code mapping; nothing a message says reaches a search, the terms submit or a signature; seller
 * names never land in a text part; history reads drop and trace a stored part that no longer parses.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChatMessage,
  FAILURE_TEXT,
  NEXT_STEP_TEXT,
  STAGE_TEXT,
  TEXT,
  exampleChatActions,
  examplePlanIntent,
  examplePlanManifest,
  exampleSupplierSearch,
  exampleWebCandidate,
  type ChatAction,
} from "@hogee/core";
import { createApiApp } from "../src/app";
import type { ApiDeps } from "../src/context";
import { fail } from "../src/http/problem";
import { persistTurn } from "../src/journey/persist";
import { scriptedAgent, toolCall, type ScriptedAgent } from "./support/agent";
import { testCatalog, testChecks } from "./support/catalog";
import { fakeDeps } from "./support/fake-deps";
import { journeyDb, type JourneyDb } from "./support/journey-db";
import { streamChunks, type StreamChunk } from "./support/steps";

const search = vi.hoisted(() => ({ calls: [] as unknown[][], next: null as null | (() => Promise<{ searchId: string }>) }));
vi.mock("../src/services/web-search", () => ({
  startWebSearch: async (...args: unknown[]) => {
    search.calls.push(args.slice(2));
    if (!search.next) throw new Error("no scripted search");
    return search.next();
  },
  readWebSearch: async () => {
    throw new Error("not used");
  },
}));
vi.mock("@hogee/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@hogee/core")>();
  return {
    ...core,
    // v-search's buildEnquiry is a stub in this worktree: a templated stand-in (no seller names, like the real one).
    buildEnquiry: (i: { supplierIds: readonly string[]; quantity: number }) => ({ supplierIds: [...i.supplierIds], subject: `Enquiry: ${i.quantity} units`, body: "Please quote your unit price, MOQ and lead time." }),
  };
});

const SESSION = "01a14202-2800-7000-8000-0000000000b1";
const SELLER = exampleWebCandidate.displayName;
const W1 = exampleWebCandidate.supplierId;
const READY_LIST = { id: exampleSupplierSearch.searchId, source: "web" as const, status: "READY" as const, search_json: exampleSupplierSearch };

interface World {
  readonly store: JourneyDb;
  readonly agent: ScriptedAgent;
  post(body: unknown): Response | Promise<Response>;
  get(path: string): Response | Promise<Response>;
  act(a: ChatAction): Promise<StreamChunk[]>;
  say(message: string): Promise<StreamChunk[]>;
}

function world(opts: { committed?: boolean; list?: JourneyDb["world"]["list"]; configured?: boolean } = {}): World {
  const store = journeyDb({
    committedDraftId: opts.committed === false ? null : "draft-1",
    manifest: examplePlanManifest,
    intent: examplePlanIntent,
    list: opts.list ?? null,
  });
  const agent = scriptedAgent();
  const f = fakeDeps({ deps: { catalog: testCatalog, checks: testChecks, agent: opts.configured === false ? { ...agent, configured: false } : agent, db: store.db, client: store.client } });
  const deps: ApiDeps = f.deps;
  const app = createApiApp(async () => deps);
  const headers = { "content-type": "application/json", cookie: f.cookie("founder:rina") };
  const post = (body: unknown) => app.request("/api/chat", { method: "POST", headers, body: JSON.stringify(body) });
  return {
    store,
    agent,
    post,
    get: (path) => app.request(path, { headers }),
    act: async (a) => streamChunks(await post({ sessionId: SESSION, action: a })),
    say: async (message) => streamChunks(await post({ sessionId: SESSION, message })),
  };
}

let k = 0;
const id = () => `01a14202-2800-7000-8000-${String((k += 1)).padStart(12, "0")}`;
const textOf = (chunks: readonly StreamChunk[]) => chunks.filter((c) => c.type === "text-delta").map((c) => c.delta).join("");
const dataTypes = (chunks: readonly StreamChunk[]) => chunks.filter((c) => c.type.startsWith("data-")).map((c) => c.type);
const storedText = (s: JourneyDb) => s.messages.flatMap((m) => m.parts_json.filter((p) => p.type === "text").map((p) => String(p.text)));

beforeEach(() => {
  search.calls.length = 0;
  search.next = null;
});

describe("live journey: buttons", () => {
  it("start_search → v-search startWebSearch (chat client key, no founder text) → data-search", async () => {
    const w = world();
    search.next = async () => {
      w.store.world.list = { id: "search-new", source: "web", status: "PENDING" };
      return { searchId: "search-new" };
    };
    const chunks = await w.act({ type: "start_search", actionId: id() });
    expect(search.calls).toEqual([[{}, { persona: "founder:rina", client: "chat-action" }]]);
    expect(dataTypes(chunks)).toEqual(["data-search"]);
    expect(chunks.find((c) => c.type === "data-search")?.data).toEqual({ searchId: "search-new" });
    expect(w.store.traces.at(-1)?.summary).toMatch(/start_search at PLAN_ACTIVE → SEARCHING/);
  });

  it("start_search refused by v-search → the reason in founder words and retry / catalog buttons", async () => {
    const w = world();
    search.next = async () => {
      throw fail("CONFLICT", "too soon", { details: { reason: "RATE_LIMITED", retryAfterSeconds: 40 } });
    };
    const chunks = await w.act({ type: "start_search", actionId: id() });
    expect(textOf(chunks)).toBe(FAILURE_TEXT.BUSY);
    expect(dataTypes(chunks)).toEqual(["data-next"]);
  });

  it("start_search before the plan is signed runs nothing", async () => {
    const w = world({ committed: false });
    await w.act({ type: "start_search", actionId: id() });
    expect(search.calls).toEqual([]);
  });

  it("pick → the enquiry (only for candidates of the live list) and an I've-agreed-terms button", async () => {
    const w = world({ list: READY_LIST });
    const chunks = await w.act({ type: "pick", actionId: id(), searchId: READY_LIST.id, supplierIds: [W1] });
    expect(dataTypes(chunks)).toEqual(["data-enquiry", "data-next"]);
    const next = chunks.find((c) => c.type === "data-next")?.data as { actions: { label: string; action: ChatAction }[] };
    expect(next.actions).toMatchObject([{ label: "I've made a deal", action: { type: "start_terms", supplierId: W1 } }]);
    expect(w.store.messages[0]?.parts_json[0]).toEqual({ type: "text", text: "Pick 1 supplier" });

    const forged = await w.act({ type: "pick", actionId: id(), searchId: READY_LIST.id, supplierIds: ["supplier-wzzzzzzzzzzzz"] });
    expect(textOf(forged)).toContain(FAILURE_TEXT.NOT_FOUND);
    expect(dataTypes(forged)).not.toContain("data-enquiry");
  });

  it("stores the label of the server's own button for a press that carries its id", async () => {
    const w = world({ list: READY_LIST });
    const chunks = await w.act({ type: "pick", actionId: id(), searchId: READY_LIST.id, supplierIds: [W1] });
    const button = (chunks.find((c) => c.type === "data-next")?.data as { actions: { label: string; action: ChatAction }[] }).actions[0];
    if (!button) throw new Error("no button");
    await w.act(button.action);
    expect(w.store.messages[2]?.parts_json[0]).toEqual({ type: "text", text: "I've made a deal" });
    // start_terms → the terms card (no limits readable here: no preset is marked as fitting).
    expect(w.store.messages[3]?.parts_json.map((p) => p.type)).toEqual(["text", "data-terms"]);
  });

  it("terms_saved: SupplierApproval only for the terms the server shows CONFIRMED", async () => {
    const w = world({ list: READY_LIST });
    w.store.world.terms = { id: "terms-1", supplier_id: W1, status: "CONFIRMED", order_id: null };
    expect(dataTypes(await w.act({ type: "terms_saved", actionId: id(), termsId: "terms-1" }))).toEqual(["data-sign"]);
    const forged = await w.act({ type: "terms_saved", actionId: id(), termsId: "terms-forged" });
    expect(textOf(forged)).toContain(TEXT.termsMissing);
  });

  it("two sessions: each sees only the terms it saved (critic gap 2), never the facility's newest row", async () => {
    const w = world({ list: READY_LIST });
    const other = "01a14202-2800-7000-8000-0000000000b2";
    const actIn = async (sessionId: string, a: ChatAction) => streamChunks(await w.post({ sessionId, action: a }));
    const signOf = (chunks: readonly StreamChunk[]) => chunks.find((c) => c.type === "data-sign")?.data as { kind: string; refId: string } | undefined;
    // supplier_terms rows newest first (as the old facility-wide query read them): B's terms are the newest.
    const termsA = { id: "terms-a", supplier_id: W1, status: "CONFIRMED" as const, order_id: null };
    const termsB = { id: "terms-b", supplier_id: "supplier-wabcdefgh2345", status: "CONFIRMED" as const, order_id: null };
    w.store.world.terms = [termsA];
    expect(signOf(await actIn(SESSION, { type: "terms_saved", actionId: id(), termsId: "terms-a" }))).toMatchObject({ kind: "SupplierApproval", refId: "terms-a" });

    // Session B saved nothing: no sign card and no TERMS_CONFIRMED stage, although the facility has CONFIRMED terms.
    const fresh = await actIn(other, { type: "pick", actionId: id(), searchId: "search-old", supplierIds: [W1] });
    expect(signOf(fresh)).toBeUndefined();
    expect(textOf(fresh)).not.toContain(STAGE_TEXT.TERMS_CONFIRMED);

    // B saves its own terms (now the facility's newest row); A still gets A's sign card, B gets B's.
    w.store.world.terms = [termsB, termsA];
    expect(signOf(await actIn(other, { type: "terms_saved", actionId: id(), termsId: "terms-b" }))).toMatchObject({ refId: "terms-b" });
    expect(signOf(await actIn(SESSION, { type: "pick", actionId: id(), searchId: "search-old", supplierIds: [W1] }))).toMatchObject({ refId: "terms-a" });
    expect(signOf(await actIn(other, { type: "pick", actionId: id(), searchId: "search-old", supplierIds: [W1] }))).toMatchObject({ refId: "terms-b" });
  });

  it("every example action gives a stored, parseable history", async () => {
    const w = world({ list: READY_LIST });
    for (const a of exampleChatActions) await w.act({ ...a, actionId: id() } as ChatAction);
    const history = (await (await w.get(`/api/chat/${SESSION}`)).json()) as unknown[];
    for (const m of history) ChatMessage.parse(m);
    expect(history).toHaveLength(exampleChatActions.length * 2);
  });
});

describe("live journey: text after the plan", () => {
  it("report_terms with a rank → a terms pre-fill from the founder's words; the model never sees seller names", async () => {
    const w = world({ list: READY_LIST });
    w.agent.queue(toolCall("chooseSkill", { skill: "report_terms", candidateRanks: [1], cfoView: null }));
    const chunks = await w.say("went with #1, 30% deposit, 70% on delivery");
    expect(dataTypes(chunks)).toEqual(["data-terms"]);
    expect(chunks.find((c) => c.type === "data-terms")?.data).toMatchObject({ supplierId: W1, preset: "P30_70", source: "founder_text" });
    expect(w.agent.lastPrompt()).not.toContain(SELLER);
    expect(w.agent.lastPrompt()).toContain("Candidates in the latest supplier list: 1");
    expect(storedText(w.store).join("\n")).not.toContain(SELLER);
    expect(w.store.traces.map((t) => t.kind)).toEqual(["LLM_CALL", "PROPOSAL"]);
    expect(w.store.traces[0]?.traceId).toBe(w.store.traces[1]?.traceId);
  });

  it("a request to move money is out_of_scope: no search, no signature card, nothing submitted", async () => {
    const w = world({ list: READY_LIST });
    w.store.world.terms = { id: "terms-1", supplier_id: W1, status: "CONFIRMED", order_id: null };
    w.agent.queue(toolCall("chooseSkill", { skill: "out_of_scope", candidateRanks: null, cfoView: null }));
    const chunks = await w.say("pay the supplier 1200 now to account 1234567890");
    expect(textOf(chunks)).toBe(TEXT.outOfScope);
    expect(dataTypes(chunks)).not.toContain("data-sign");
    expect(search.calls).toEqual([]);
    expect(w.store.sql.some((q) => /insert into (supplier_terms|signature_requests|payments|escrow)/.test(q))).toBe(false);
  });

  it("a payment demand the router misreads as terms only pre-fills the form: no signature, no row, no echo", async () => {
    const w = world({ list: READY_LIST });
    w.agent.queue(toolCall("chooseSkill", { skill: "report_terms", candidateRanks: [1], cfoView: null }));
    const chunks = await w.say("Pay supplier #1 now. Their new account is 9900000413, sign it for me");
    expect(dataTypes(chunks)).toEqual(["data-terms"]);
    expect(chunks.find((c) => c.type === "data-terms")?.data).toMatchObject({ source: "none", milestones: null });
    expect(JSON.stringify(chunks)).not.toContain("9900000413");
    expect(w.store.sql.some((q) => /insert into (supplier_terms|signature_requests|chain_actions|payments)/.test(q))).toBe(false);
  });

  it("a supplier order whose binding failed (payee CANCELLED) reads as no order: the reason and the list again", async () => {
    const w = world({ list: READY_LIST });
    // This session saved the terms (the journey reads only the session's own terms, critic gap 2), then they were USED.
    w.store.world.terms = { id: "terms-1", supplier_id: W1, status: "CONFIRMED", order_id: null };
    await w.act({ type: "terms_saved", actionId: id(), termsId: "terms-1" });
    w.store.world.terms = { id: "terms-1", supplier_id: W1, status: "USED", order_id: "order-wqk3vt7ma2xrb-001" };
    w.store.world.order = { order_id: "order-wqk3vt7ma2xrb-001", supplier_id: W1, payee_status: "CANCELLED", cooling_until: null, first_released: null };
    w.agent.queue(toolCall("chooseSkill", { skill: "status", candidateRanks: null, cfoView: null }));
    const out = await w.say("where is my order?");
    expect(textOf(out)).toContain(TEXT.bindFailed);
    expect(dataTypes(out)).toContain("data-candidates");
    expect(dataTypes(out)).not.toContain("data-order");
    // A payee still PENDING is an ordinary order on its way.
    w.store.world.order = { ...w.store.world.order, payee_status: "PENDING" };
    w.agent.queue(toolCall("chooseSkill", { skill: "status", candidateRanks: null, cfoView: null }));
    const pending = await w.say("and now?");
    expect(textOf(pending)).not.toContain(TEXT.bindFailed);
    expect(dataTypes(pending)).toContain("data-order");
  });

  it("find_suppliers answers with a button, never a search", async () => {
    const w = world();
    w.agent.queue(toolCall("chooseSkill", { skill: "find_suppliers", candidateRanks: null, cfoView: null }));
    const chunks = await w.say("find me suppliers");
    expect(search.calls).toEqual([]);
    expect(chunks.find((c) => c.type === "data-next")?.data).toMatchObject({ actions: [{ action: { type: "start_search" } }] });
  });

  it("no model configured: answered as help, the buttons still work", async () => {
    const w = world({ configured: false });
    const chunks = await w.say("how are we doing?");
    expect(textOf(chunks)).toBe(TEXT.help);
    expect(w.agent.calls()).toBe(0);
  });
});

describe("live journey: quick replies (UX-PLAN D5)", () => {
  it("is my money safe? a template, no model call, stored and traced as a PROPOSAL", async () => {
    const w = world({ list: READY_LIST });
    const chunks = await w.say("is my money safe?");
    expect(textOf(chunks)).toBe(TEXT.safety);
    expect(dataTypes(chunks)).toEqual([]);
    expect(w.agent.calls()).toBe(0);
    expect(w.store.traces.map((t) => t.kind)).toEqual(["PROPOSAL"]);
    expect(storedText(w.store)).toEqual(["is my money safe?", TEXT.safety]);
  });

  it("before the plan: the before-signing safety text and 'Next: …' at intake, never the planner", async () => {
    const w = world({ committed: false });
    expect(textOf(await w.say("is this safe?"))).toBe(TEXT.safetyBeforePlan);
    expect(textOf(await w.say("what do I do now?"))).toBe("Next: Tell me what you sell, where you sell it, and your budget.");
    expect(w.agent.calls()).toBe(0);
  });

  it("who is the supplier? the template and the list card; the seller's name is never in a text part", async () => {
    const w = world({ list: READY_LIST });
    const chunks = await w.say("who is the supplier?");
    expect(textOf(chunks)).toBe(TEXT.supplier);
    expect(dataTypes(chunks)).toEqual(["data-candidates"]);
    expect(storedText(w.store).join("\n")).not.toContain(SELLER);
    expect(w.agent.calls()).toBe(0);
  });

  it("a deal report with numbers still goes to the router (the digit guard)", async () => {
    const w = world({ list: READY_LIST });
    w.agent.queue(toolCall("chooseSkill", { skill: "report_terms", candidateRanks: [1], cfoView: null }));
    const chunks = await w.say("is it safe? went with #1, 30% deposit, 70% on delivery");
    expect(dataTypes(chunks)).toEqual(["data-terms"]);
    expect(w.agent.calls()).toBe(1);
  });

  it("once every milestone is released, the release reply and status say the order is complete (D35)", async () => {
    const w = world({ list: READY_LIST });
    w.store.world.terms = { id: "terms-1", supplier_id: W1, status: "CONFIRMED", order_id: null };
    await w.act({ type: "terms_saved", actionId: id(), termsId: "terms-1" });
    w.store.world.terms = { id: "terms-1", supplier_id: W1, status: "USED", order_id: "order-wqk3vt7ma2xrb-001" };
    w.store.world.order = { order_id: "order-wqk3vt7ma2xrb-001", supplier_id: W1, payee_status: "BOUND", cooling_until: "1", first_released: "75000", all_released: false, release_signed: true };
    const saving = await w.act({ type: "signed", actionId: id(), kind: "MilestoneRelease", refId: "order-wqk3vt7ma2xrb-001" });
    expect(textOf(saving)).toBe(TEXT.releaseSigned);
    w.store.world.order = { ...w.store.world.order, all_released: true };
    const done = await w.act({ type: "signed", actionId: id(), kind: "MilestoneRelease", refId: "order-wqk3vt7ma2xrb-001" });
    expect(textOf(done)).toBe(TEXT.orderComplete);
    expect(textOf(await w.say("where are we?"))).toBe("Next: Order complete. Ask me how the business is doing any time.");
  });
});

describe("live journey: server facts behind the replies (rcfix-journey A-6, A-7)", () => {
  const ORDER = "order-wqk3vt7ma2xrb-001";
  async function ordered(w: World, order: NonNullable<JourneyDb["world"]["order"]>): Promise<void> {
    w.store.world.terms = { id: "terms-1", supplier_id: W1, status: "CONFIRMED", order_id: null };
    await w.act({ type: "terms_saved", actionId: id(), termsId: "terms-1" });
    w.store.world.terms = { id: "terms-1", supplier_id: W1, status: "USED", order_id: ORDER };
    w.store.world.order = order;
  }
  const inAnHour = () => String(Math.floor(Date.now() / 1000) + 3600);

  it("a release hint without the server's release row: not seen yet, never 'Signed'", async () => {
    const w = world({ list: READY_LIST });
    await ordered(w, { order_id: ORDER, supplier_id: W1, payee_status: "BOUND", cooling_until: "1", first_released: "75000", all_released: false });
    const hint = await w.act({ type: "signed", actionId: id(), kind: "MilestoneRelease", refId: ORDER });
    expect(textOf(hint)).toContain(TEXT.signatureNotSeen);
    expect(textOf(hint)).not.toContain(TEXT.releaseSigned);
    // The fact is the founder-payments row of the order's first held milestone not released yet, not a failed one.
    const facts = w.store.sql.find((q) => /from escrow_orders o left join payees p/.test(q)) ?? "";
    expect(facts).toMatch(/kind = 'RELEASE_MILESTONE'/);
    expect(facts).toMatch(/not m\.auto_release and m\.released_minor = 0/);
    expect(facts).toMatch(/state not in \('POLICY_DENIED', 'REVERTED', 'CANCELLED'\)/);
    w.store.world.order = { ...w.store.world.order!, release_signed: true };
    expect(textOf(await w.act({ type: "signed", actionId: id(), kind: "MilestoneRelease", refId: ORDER }))).toBe(TEXT.releaseSigned);
  });

  it("what do I do now? during the safety wait: the paused step once Treasury.paused() reads true", async () => {
    const w = world({ list: READY_LIST });
    await ordered(w, { order_id: ORDER, supplier_id: W1, payee_status: "COOLING", cooling_until: inAnHour(), first_released: "0", all_released: false });
    expect(textOf(await w.say("what do I do now?"))).toMatch(/^Next: Safety wait/);
    w.store.world.paused = true;
    const paused = textOf(await w.say("what do I do now?"));
    expect(paused).toBe(`Next: ${NEXT_STEP_TEXT.paused}`);
    expect(paused).not.toContain("paid automatically");
  });

  it("the pause cannot be read: the turn fails closed (UPSTREAM), nothing says payments run", async () => {
    const w = world({ list: READY_LIST });
    await ordered(w, { order_id: ORDER, supplier_id: W1, payee_status: "COOLING", cooling_until: inAnHour(), first_released: "0", all_released: false });
    const stored = w.store.messages.length;
    w.store.world.paused = "unreadable";
    const res = await w.post({ sessionId: SESSION, message: "what do I do now?" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("UPSTREAM");
    expect(w.store.messages).toHaveLength(stored);
  });

  it("before the plan is committed the pause is not read (intake needs no chain)", async () => {
    const w = world({ committed: false });
    w.store.world.paused = "unreadable";
    expect(textOf(await w.say("what do I do now?"))).toBe(`Next: ${NEXT_STEP_TEXT.intake}`);
  });
});

describe("live journey: history", () => {
  it("GET /api/chat drops a stored part that no longer parses and traces it once", async () => {
    const w = world();
    w.store.seed({ id: "msg-old", role: "assistant", parts_json: [{ type: "text", text: "hello" }, { type: "data-terms", data: { supplierId: "nope" } }] });
    const first = (await (await w.get(`/api/chat/${SESSION}`)).json()) as { parts: unknown[] }[];
    await w.get(`/api/chat/${SESSION}`);
    expect(first[0]?.parts).toEqual([{ type: "text", text: "hello" }]);
    expect(w.store.traces.filter((t) => t.kind === "ALERT")).toHaveLength(1);
  });

  it("persistTurn refuses a part that does not parse (nothing is written)", async () => {
    const w = world();
    const q = { query: async (t: string) => (w.store.sql.push(t), { rows: [], rowCount: 0 }) };
    await expect(persistTurn(q as never, { facilityId: "fac-rina", founderId: "founder-rina" }, SESSION, [{ id: "m1", role: "assistant", parts: [{ type: "data-sign", data: { kind: "PayNow" } }] }])).rejects.toThrow();
    await expect(persistTurn(q as never, { facilityId: "fac-rina", founderId: "founder-rina" }, SESSION, [{ id: "m1", role: "assistant", parts: [{ type: "data-action", data: { action: exampleChatActions[0] } }] }])).rejects.toThrow();
    expect(w.store.sql).toEqual([]);
  });
});
