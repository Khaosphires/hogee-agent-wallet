/**
 * The chat journey on the live API (v-chat-server brief 4/7): Postgres, Anvil, the worker's jobs; the model only for the
 * intake turn (a scripted mock behind the real guard). Buttons only after that: no model key is needed.
 *   intake → plan reply with the needs and PlanApproval cards → a `signed` hint before the chain has it → the plan
 *   signed and committed by the worker → `signed` → Find suppliers (v-search's service) → the labelled catalog list
 *   (the existing shortlist service) → the CFO card → a replayed press; every press stored, traced and replayable from
 *   GET /api/chat.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChatMessage, TEXT, type ChatAction } from "@hogee/core";
import { z } from "zod";
import { scriptedAgent, type ScriptedAgent } from "../support/agent";
import type { SoftAuthenticator } from "../support/authenticator";
import { LIVE, LIVE_TIMEOUT_MS, openLive, type Live } from "../support/live";
import { chatToDraft, json, openAndRegister, signPlan, streamChunks, type StreamChunk } from "../support/steps";
import { newWorld, type World } from "../support/world";

const SESSION = "01a14202-2800-7000-8000-0000000c4a71";
let n = 0;
const id = () => `01a14202-2800-7000-8000-${String((n += 1)).padStart(12, "0")}`;
const types = (chunks: readonly StreamChunk[]) => chunks.filter((c) => c.type === "text-start" || c.type.startsWith("data-")).map((c) => (c.type === "text-start" ? "text" : c.type));
const textOf = (chunks: readonly StreamChunk[]) => chunks.filter((c) => c.type === "text-delta").map((c) => c.delta).join("");
const buttons = (chunks: readonly StreamChunk[]) => (chunks.find((c) => c.type === "data-next")?.data as { actions: { label: string; action: ChatAction }[] } | undefined)?.actions ?? [];

describe.skipIf(!LIVE)("chat journey (live)", { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  let w: World;
  let agent: ScriptedAgent;
  let auth: SoftAuthenticator;
  let draftId: string;
  let afterSign: StreamChunk[];
  const act = async (a: ChatAction) => streamChunks(await w.founder.post("/api/chat", { sessionId: SESSION, action: a }));

  beforeAll(async () => {
    live = await openLive();
    agent = scriptedAgent();
    w = await newWorld(live, { agent });
    auth = await openAndRegister(w);
  }, LIVE_TIMEOUT_MS);
  afterAll(async () => {
    await live?.close();
  });

  it("intake: the plan reply carries the needs checklist and the PlanApproval card", async () => {
    draftId = await chatToDraft(w, agent, SESSION);
    const history = await json(await w.founder.get(`/api/chat/${SESSION}`), z.array(ChatMessage));
    const reply = history.at(-1);
    expect(reply?.parts.map((p) => p.type)).toEqual(["text", "data-intent", "data-plan-draft", "data-needs", "data-sign"]);
    expect(reply?.parts.at(-1)).toMatchObject({ data: { kind: "PlanApproval", refId: draftId } });
  });

  it("a `signed` hint the chain does not reflect yet changes nothing", async () => {
    const r = await act({ type: "signed", actionId: id(), kind: "PlanApproval", refId: draftId });
    expect(textOf(r)).toContain(TEXT.signatureNotSeen);
    expect(types(r)).toContain("data-sign");
  });

  it("after the worker commits the signed plan, `signed` answers with the next steps", async () => {
    await signPlan(w, auth, draftId);
    afterSign = await act({ type: "signed", actionId: id(), kind: "PlanApproval", refId: draftId });
    expect(textOf(afterSign)).toBe(TEXT.planLive);
    expect(buttons(afterSign).map((b) => b.label)).toEqual(["Find suppliers", "How are we doing?"]);
  });

  it("Find suppliers goes to v-search's service and always ends in a next step", async () => {
    const button = buttons(afterSign)[0];
    if (!button) throw new Error("no Find suppliers button");
    const r = await act(button.action);
    // data-search once v-search's startWebSearch lands; until then its stub refuses and the reply offers the catalog.
    expect(["data-search", "data-next"]).toContain(types(r).at(-1));
  });

  it("the labelled catalog list runs the existing shortlist service", async () => {
    const r = await act({ type: "use_catalog", actionId: id() });
    expect(types(r)).toEqual(["text", "data-shortlist", "data-next"]);
    const requestId = (r.find((c) => c.type === "data-shortlist")?.data as { requestId: string }).requestId;
    const row = await live.db.$client.query("select source, status from shortlists where facility_id = $1 and id = $2", [w.facilityId, requestId]);
    expect(row.rows[0]).toMatchObject({ source: "catalog" });
  });

  it("the CFO card, then a replayed press: nothing runs or is stored twice", async () => {
    const cfo: ChatAction = { type: "show_cfo", actionId: id(), view: "overview" };
    expect(types(await act(cfo))).toEqual(["text", "data-cfo", "data-next"]);
    const before = await live.db.$client.query("select count(*)::int as n from chat_messages where facility_id = $1 and session_id = $2", [w.facilityId, SESSION]);
    expect(textOf(await act(cfo))).toContain(TEXT.alreadyDone);
    const after = await live.db.$client.query("select count(*)::int as n from chat_messages where facility_id = $1 and session_id = $2", [w.facilityId, SESSION]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("every press is stored with its label and traced; the history parses", async () => {
    const history = await json(await w.founder.get(`/api/chat/${SESSION}`), z.array(ChatMessage));
    const presses = history.filter((m) => m.role === "user" && m.parts.some((p) => p.type === "data-action"));
    expect(presses.map((m) => (m.parts[0] as unknown as { text: string }).text)).toEqual(["Signed", "Signed", "Find suppliers", "Use the sample list", "How are we doing?"]);
    const traces = await live.db.$client.query("select actor, kind, summary from traces where facility_id = $1 and trace_id = $2 order by seq", [w.facilityId, `journey-${SESSION}`]);
    expect(traces.rows).toHaveLength(6);
    expect(traces.rows.every((t: { actor: string; kind: string }) => t.actor === "founder" && t.kind === "TOOL_CALL")).toBe(true);
    expect(traces.rows.at(-1).summary).toContain("replayed id");
  });
});
