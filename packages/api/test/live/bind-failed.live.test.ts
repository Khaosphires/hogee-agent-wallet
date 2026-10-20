/**
 * A web supplier order whose bindPayee never lands (audit run-9, critic gap 1), on the live API, Postgres, Anvil and
 * the worker's jobs. The founder signs the order, but the chain time passes the signed SupplierApproval's expiry before
 * the relay sends it: Treasury would revert (SignatureExpired), so the relay refuses it. Re-check 9 item 2: the payee
 * stays PENDING until the approval's expiry is 2 minutes of chain time behind (BIND_EXPIRY_MARGIN_S), and only then
 * does the worker's sync cancel it (an ALERT on the bind's trace); the order stops holding SUPPLIER budget (another
 * supplier's 4,000 BU terms fit the 5,000 BU pocket again), and the chat's facts mark the order bindFailed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChainAction, OrderTerms, Shortlist, SignatureRequestResponse, TERMS_PRESET_MILESTONES, TEXT, deriveJourney, exampleShortlistSpec, partsForState } from "@hogee/core";
import { z } from "zod";
import { journeyFacts } from "../../src/journey/facts";
import { SIGNATURE_TTL_S } from "../../src/services/signing/typed";
import { scriptedAgent } from "../support/agent";
import type { SoftAuthenticator } from "../support/authenticator";
import { LIVE, LIVE_TIMEOUT_MS, openLive, warp, type Live } from "../support/live";
import { b64uToBytes, chatToDraft, json, openAndRegister, signPlan } from "../support/steps";
import { CORVANE, plantWebSearch, type WebSeller } from "../support/web-search";
import { newWorld, type World } from "../support/world";

const SESSION = "01a14202-2800-7000-8000-0000000000f9";
const SEARCH = "sl-web-0199f1aa-0000-7000-8000-0000000000f1";
const SEARCH_2 = "sl-web-0199f1aa-0000-7000-8000-0000000000f2";
const P30_70 = TERMS_PRESET_MILESTONES.P30_70.map((m) => ({ ...m }));
/** A third fictional seller (TEST FIXTURE), orderable in the second search. */
const BRISOLA: WebSeller = { supplierId: "supplier-wbrisolatest2", sellerName: "Brisola Houseware Co., Ltd.", listingUrl: "https://brisola.en.alibaba.com/product/1600000000003.html" };

describe.skipIf(!LIVE)("a web order whose payee binding never lands (live)", { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  let w: World;
  let auth: SoftAuthenticator;
  let catalog: Shortlist;

  const body = (seller: WebSeller, searchId: string) => ({
    supplierId: seller.supplierId,
    searchId,
    quantity: 500,
    totalMinor: "400000",
    milestones: P30_70,
    payout: { holderName: seller.sellerName, bankName: "Maybank", accountNumber: "0123456789", payeeType: "company" },
  });
  const q = <T>(sql: string, values: unknown[]) => live.db.$client.query(sql, values).then((r) => r.rows as T[]);

  beforeAll(async () => {
    live = await openLive();
    const agent = scriptedAgent();
    w = await newWorld(live, { agent, coolingSeconds: 120 });
    auth = await openAndRegister(w);
    await signPlan(w, auth, await chatToDraft(w, agent, SESSION));
    await json(await w.officer.post("/api/facility/fund", { amountMinor: "1000000" }), z.unknown());
    await w.pump();
    const { requestId } = await json(await w.founder.post("/api/suppliers/shortlist", { spec: exampleShortlistSpec }), z.object({ requestId: z.string() }));
    catalog = await json(await w.founder.get(`/api/suppliers/shortlist/${requestId}`), Shortlist);
    await plantWebSearch(w, catalog, SEARCH);
  }, LIVE_TIMEOUT_MS);
  afterAll(async () => {
    await live?.close();
  });

  it("the expired bind is refused, the payee is cancelled and traced, and the budget is free again", async () => {
    const terms = await json(await w.founder.post("/api/orders/terms", body(CORVANE, SEARCH)), OrderTerms);
    // As the terms card does: the session saves its terms (the journey reads only the session's own terms, fix9-chat).
    const saved = await w.founder.post("/api/chat", { sessionId: SESSION, action: { type: "terms_saved", actionId: "01a14202-2800-7000-8000-0000000001f1", termsId: terms.termsId } });
    expect(saved.status).toBe(200);
    await saved.text();
    const req = await json(await w.founder.post("/api/signatures/request", { kind: "SupplierApproval", refId: terms.termsId, method: "passkey" }), SignatureRequestResponse);
    const action = await json(await w.founder.post(`/api/signatures/${req.requestId}/submit`, { passkey: auth.assert(b64uToBytes(req.challengeB64url)) }), ChainAction);
    expect(action.state).toBe("PENDING");
    // The relay is late: chain time passes the approval's expiry (but not the margin) before it runs.
    await warp(live, SIGNATURE_TTL_S + 30n);
    await w.pump();
    const status = async () => (await q<{ status: string }>("select status from payees where facility_id = $1 and id = $2", [w.facilityId, CORVANE.supplierId]))[0]?.status;
    expect(await status()).toBe("PENDING"); // refused, but not cancelled while inside the margin after expiry
    // Past expiry + margin, in chain time: Treasury now refuses the approval for good, so the payee is cancelled.
    await warp(live, 200n);
    await w.pump();

    const [bind] = await q<{ id: string; raw_signed_tx: string | null; revert_reason: string | null }>(
      "select id, raw_signed_tx, revert_reason from chain_actions where facility_id = $1 and kind = 'Treasury.bindPayee'",
      [w.facilityId],
    );
    expect(bind).toMatchObject({ raw_signed_tx: null, revert_reason: expect.stringMatching(/^REFUSED: /) });
    expect(await status()).toBe("CANCELLED");
    const alerts = await q<{ summary: string }>("select summary from traces where facility_id = $1 and trace_id = $2 and kind = 'ALERT' and actor = 'worker'", [
      w.facilityId,
      `trace:act:${bind?.id}`,
    ]);
    // The relay's refusal, then the cancellation, on the bind's own trace (the timeline shows both).
    expect(alerts.map((a) => a.summary)).toEqual([
      "Treasury.bindPayee not signed: simulation reverts SignatureExpired",
      expect.stringMatching(/^Supplier order order-wcorvanetest2-001 never landed on-chain \(it was not sent: simulation reverts SignatureExpired\), .*budget is free again$/),
    ]);

    // The chat leaves ORDER_PENDING: the order reads as bindFailed, back to the supplier list with the reason.
    const facts = await journeyFacts(w.deps, { facilityId: w.facilityId, founderId: w.founderId }, SESSION, "founder:rina");
    expect(facts.order).toMatchObject({ bound: false, bindFailed: true });
    const state = deriveJourney(facts);
    expect(state.stage).toBe("CANDIDATES");
    expect(partsForState(state)[0]).toEqual({ type: "text", text: TEXT.bindFailed });

    // The cancelled order no longer holds 4,000 of the 5,000 BU pocket: another supplier's 4,000 BU terms fit.
    await plantWebSearch(w, catalog, SEARCH_2, { seller: BRISOLA });
    const next = await w.founder.post("/api/orders/terms", body(BRISOLA, SEARCH_2));
    expect(next.status).toBe(200);
    expect((await json(next, OrderTerms)).status).toBe("CONFIRMED");
  });
});
