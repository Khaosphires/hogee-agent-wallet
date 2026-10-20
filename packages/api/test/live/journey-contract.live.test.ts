/**
 * The journey contract, live half (v-chat-server brief 7; the mock half is api-mock test/journey.test.ts): core
 * JOURNEY_CONTRACT_STEPS on the live API over Postgres and Anvil must answer every step with the same part types as the
 * mock. Starting point, as in the mock: a committed plan (signed with the passkey, committed by the worker) and a READY
 * web search holding the contract example (exampleSupplierSearch: one candidate). The search row, the supplier row and
 * the terms row are written here the way v-search's and v-terms' services write them, so this file does not depend on
 * their Tavily / recorded pipelines; the terms row appears just before `terms_saved`, as the REST form would make it.
 * Then, on the same rows: a second session sees none of the first session's terms (critic gap 2), and a session longer
 * than the history window keeps its facts and its used action ids (audit run-9 lead 2).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CHAT_HISTORY_WINDOW, JOURNEY_CONTRACT_STEPS, TEXT, exampleOrderTerms, exampleSupplierSearch, exampleWebCandidate, fakeHex32, type ChatAction } from "@hogee/core";
import { scriptedAgent } from "../support/agent";
import { LIVE, LIVE_TIMEOUT_MS, openLive, type Live } from "../support/live";
import { chatToDraft, openAndRegister, signPlan, streamChunks, type StreamChunk } from "../support/steps";
import { newWorld, type World } from "../support/world";

vi.mock("@hogee/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@hogee/core")>();
  // The same stand-in for v-search's buildEnquiry stub as the mock half (no seller names, like the real one).
  return { ...core, buildEnquiry: (i: { supplierIds: readonly string[]; quantity: number }) => ({ supplierIds: [...i.supplierIds], subject: `Enquiry: ${i.quantity} units`, body: "Please quote your unit price, MOQ and lead time." }) };
});

const SESSION = "01a14202-2800-7000-8000-0000000c0a7c";
const W1 = exampleWebCandidate.supplierId;
const SEARCH = exampleSupplierSearch.searchId;
const TERMS = exampleOrderTerms.termsId;
let n = 0;
const id = () => `01a14202-2800-7000-8000-${String((n += 1)).padStart(12, "0")}`;
const types = (chunks: readonly StreamChunk[]) => chunks.filter((c) => c.type === "text-start" || c.type.startsWith("data-")).map((c) => (c.type === "text-start" ? "text" : c.type));
const textOf = (chunks: readonly StreamChunk[]) => chunks.filter((c) => c.type === "text-delta").map((c) => c.delta).join("");
const signOf = (chunks: readonly StreamChunk[]) => chunks.find((c) => c.type === "data-sign")?.data as { kind: string; refId: string } | undefined;
/** A pick for a search that is not the live one: refused, answered with where the session is (its stage cards). */
const stalePick = (): ChatAction => ({ type: "pick", actionId: id(), searchId: "search-stale", supplierIds: [W1] });

describe.skipIf(!LIVE)("journey contract (live half)", { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  let w: World;
  const ids: string[] = [];
  const act = async (sessionId: string, action: ChatAction) => streamChunks(await w.founder.post("/api/chat", { sessionId, action }));

  beforeAll(async () => {
    live = await openLive();
    const agent = scriptedAgent();
    w = await newWorld(live, { agent });
    const auth = await openAndRegister(w);
    await signPlan(w, auth, await chatToDraft(w, agent, SESSION));
    const q = live.db.$client;
    await q.query(
      `insert into suppliers (facility_id, supplier_id, display_name, country, record_json, evidence_tier, source_type) values ($1, $2, $3, 'CN', '{}'::jsonb, 'tier3', 'mock')`,
      [w.facilityId, W1, exampleWebCandidate.displayName],
    );
    await q.query(`insert into shortlists (id, facility_id, status, spec_json, source, search_json) values ($1, $2, 'READY', $3::jsonb, 'web', $4::jsonb)`, [
      SEARCH,
      w.facilityId,
      JSON.stringify({ productCategory: "drinkware_food_contact", buyFrom: "CN", quantity: exampleSupplierSearch.quantity, budgetMinor: "500000" }),
      JSON.stringify(exampleSupplierSearch),
    ]);
  }, LIVE_TIMEOUT_MS);
  afterAll(async () => {
    await live?.close();
  });

  async function saveTerms(): Promise<void> {
    await live.db.$client.query(
      `insert into supplier_terms (id, facility_id, shortlist_id, supplier_id, chosen_index, currency, quote_total_minor, quantity, terms_json, schedule_json,
         payout_account_ref, payout_account_hash, bank_name, payee_type, quote_hash, status)
       values ($1, $2, $3, $4, 0, 'MYR', $9, 500, $5::jsonb, '[]'::jsonb, $6, $7, 'Example Bank', 'company', $8, 'CONFIRMED')`,
      [TERMS, w.facilityId, SEARCH, W1, JSON.stringify(exampleOrderTerms.milestones), JSON.stringify({ channel: "MOCK_ONLY" }), fakeHex32("payout"), fakeHex32("quote"), exampleOrderTerms.totalMinor],
    );
  }

  it("plays the contract script with the expected part types", async () => {
    for (const step of JOURNEY_CONTRACT_STEPS) {
      if (step.label === "terms saved") await saveTerms();
      const actionId = step.replayOf !== undefined ? (ids[step.replayOf] as string) : id();
      ids.push(actionId);
      const res = await w.founder.post("/api/chat", { sessionId: SESSION, action: step.action({ actionId, searchId: SEARCH, supplierId: W1, termsId: TERMS }) });
      expect(types(await streamChunks(res)), step.label).toEqual(step.expect);
    }
  });

  it("a second session sees none of the first session's terms: no sign card, no TERMS_CONFIRMED (critic gap 2)", async () => {
    const other = "01a14202-2800-7000-8000-0000000c0a7d";
    const fresh = await act(other, stalePick());
    expect(signOf(fresh)).toBeUndefined();
    expect(types(fresh)).toContain("data-candidates");
    expect(signOf(await act(SESSION, stalePick()))).toMatchObject({ kind: "SupplierApproval", refId: TERMS });
  });

  it("past the history window a session keeps its saved terms and its used action ids (audit run-9 lead 2)", async () => {
    const q = live.db.$client;
    const [last] = (await q.query<{ n: number }>("select max(seq)::int as n from chat_messages where facility_id = $1 and session_id = $2", [w.facilityId, SESSION])).rows;
    const from = (last?.n ?? 0) + 1;
    await q.query(
      `insert into chat_messages (id, facility_id, session_id, seq, role, parts_json)
       select 'msg-fill-' || g, $1, $2::uuid, g, (case when g % 2 = 1 then 'user' else 'assistant' end)::chat_role,
              jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'filler ' || g))
         from generate_series($3::int, $4::int) g`,
      [w.facilityId, SESSION, from, from + CHAT_HISTORY_WINDOW + 20],
    );
    expect(signOf(await act(SESSION, stalePick()))).toMatchObject({ kind: "SupplierApproval", refId: TERMS });
    const before = (await q.query<{ n: number }>("select count(*)::int as n from chat_messages where facility_id = $1 and session_id = $2", [w.facilityId, SESSION])).rows[0]?.n;
    const first = JOURNEY_CONTRACT_STEPS[0]?.action({ actionId: ids[0] as string, searchId: SEARCH, supplierId: W1, termsId: TERMS });
    expect(textOf(await act(SESSION, first as ChatAction))).toContain(TEXT.alreadyDone);
    const after = (await q.query<{ n: number }>("select count(*)::int as n from chat_messages where facility_id = $1 and session_id = $2", [w.facilityId, SESSION])).rows[0]?.n;
    expect(after).toBe(before);
  });
});
