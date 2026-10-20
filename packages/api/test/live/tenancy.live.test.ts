/**
 * T31 / hard rule 8 on the live API: two tenants on one database. Every id of tenant A (chat session, shortlist,
 * exception, signature request, escrow order, draft) is invisible to tenant B's server-configured facility: reads are
 * 404, actions are 404 and change nothing. The facility comes from server config only, never from the request.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exampleShortlistSpec, SignatureRequestResponse } from "@hogee/core";
import { z } from "zod";
import { scriptedAgent } from "../support/agent";
import { LIVE, LIVE_TIMEOUT_MS, openLive, type Live } from "../support/live";
import { b64uToBytes, chatToDraft, json, openAndRegister, signPlan } from "../support/steps";
import { newWorld, type World } from "../support/world";

const SESSION = "01a14202-2800-7000-8000-0000000000f3";

describe.skipIf(!LIVE)("tenancy (live)", { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  let a: World;
  let b: World;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    live = await openLive();
    const agentA = scriptedAgent();
    a = await newWorld(live, { agent: agentA });
    const auth = await openAndRegister(a);
    ids.draft = await chatToDraft(a, agentA, SESSION);
    await signPlan(a, auth, ids.draft);
    ids.shortlist = (await json(await a.founder.post("/api/suppliers/shortlist", { spec: exampleShortlistSpec }), z.object({ requestId: z.string() }))).requestId;
    const sa = await json(await a.founder.post("/api/signatures/request", { kind: "SupplierApproval", refId: "order-a-001", method: "passkey" }), SignatureRequestResponse);
    await json(await a.founder.post(`/api/signatures/${sa.requestId}/submit`, { passkey: auth.assert(b64uToBytes(sa.challengeB64url)) }), z.unknown());
    const expiry = (await live.db.$client.query("select manifest_json->'agent'->>'expiresAt' as e from plans where facility_id = $1", [a.facilityId])).rows[0].e as string;
    ids.exception = (
      await json(
        await a.founder.post("/api/exceptions", { kind: "EXTEND_EXPIRY", payload: { target: "agent", newExpiresAt: (BigInt(expiry) + 86_400n).toString() }, reason: "slip" }),
        z.object({ exceptionId: z.string() }),
      )
    ).exceptionId;
    ids.loosenSig = (await json(await a.founder.post(`/api/exceptions/${ids.exception}/approve`, {}), z.object({ signature: z.object({ requestId: z.string() }) }))).signature.requestId;
    b = await newWorld(live);
    await openAndRegister(b);
  }, LIVE_TIMEOUT_MS);
  afterAll(async () => {
    await live?.close();
  });

  it("tenant B cannot read tenant A's records", async () => {
    expect((await b.founder.get(`/api/chat/${SESSION}`)).status).toBe(404);
    expect((await b.founder.get(`/api/suppliers/shortlist/${ids.shortlist}`)).status).toBe(404);
    expect((await b.founder.get("/api/suppliers/supplier-a")).status).toBe(404);
    expect((await b.founder.get("/api/escrow/order-a-001")).status).toBe(404);
    const list = await json(await b.officer.get("/api/exceptions"), z.array(z.object({ exceptionId: z.string() })));
    expect(list.map((e) => e.exceptionId)).not.toContain(ids.exception);
  });

  it("tenant B cannot act on tenant A's records (404, nothing changes)", async () => {
    expect((await b.officer.post(`/api/exceptions/${ids.exception}/deny`, { reason: "x" })).status).toBe(404);
    expect((await b.founder.post(`/api/exceptions/${ids.exception}/veto`, { reason: "x" })).status).toBe(404);
    expect((await b.founder.post(`/api/signatures/request`, { kind: "PlanApproval", refId: ids.draft, method: "passkey" })).status).toBe(404);
    expect((await b.founder.post("/api/plans/preview-country", { draftId: ids.draft, country: "ID" })).status).toBe(404);
    expect((await b.founder.post(`/api/signatures/${ids.loosenSig}/submit`, { ecdsa: { signature: `0x${"11".repeat(64)}1b` } })).status).toBe(404);
    const e = (await live.db.$client.query("select status from exceptions where facility_id = $1 and id = $2", [a.facilityId, ids.exception])).rows[0];
    expect(e.status).toBe("OPEN");
    const s = (await live.db.$client.query("select status from signature_requests where facility_id = $1 and id = $2", [a.facilityId, ids.loosenSig])).rows[0];
    expect(s.status).toBe("PENDING");
  });
});
