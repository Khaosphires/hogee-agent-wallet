/**
 * §26.1 step 3 and hard rule 5 on the live API: typed data built with @hogee/chain and a server-side displayModel;
 * every signature VERIFIED server-side (HogeeSigs rules) before anything is relayed; random 256-bit nonces; expiry
 * and single use; the relayer commits the plan and the worker mirrors it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError, ChainAction, PlanRecord, SignatureRequestResponse } from "@hogee/core";
import { hashTypedData, type Hex } from "viem";
import { z } from "zod";
import { scriptedAgent, type ScriptedAgent } from "../support/agent";
import { SoftAuthenticator } from "../support/authenticator";
import { LIVE, LIVE_TIMEOUT_MS, openLive, warp, type Live } from "../support/live";
import { b64uToBytes, chatToDraft, json, openAndRegister } from "../support/steps";
import { newWorld, type World } from "../support/world";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const SESSION = "01a14202-2800-7000-8000-0000000000cc";

/** viem message from the API's JSON message (uint ≤ 32 bits → number, wider → bigint). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function viemTyped(t: SignatureRequestResponse["typedData"]): any {
  const fields = t.types[t.primaryType] ?? [];
  const message = Object.fromEntries(
    fields.map((f) => {
      const v = t.message[f.name];
      if (f.type.startsWith("uint")) return [f.name, Number(f.type.slice(4)) <= 32 ? Number(v) : BigInt(v as string)];
      return [f.name, v];
    }),
  );
  return { domain: t.domain, types: t.types, primaryType: t.primaryType, message };
}

describe.skipIf(!LIVE)("signatures (live)", { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  let w: World;
  let agent: ScriptedAgent;
  let auth: SoftAuthenticator;
  let draftId: string;
  const request = (method: "passkey" | "eip712" = "passkey") =>
    w.founder.post("/api/signatures/request", { kind: "PlanApproval", refId: draftId, method }).then((r) => json(r, SignatureRequestResponse));
  const submitPasskey = (req: SignatureRequestResponse, a = auth, opts = {}) => w.founder.post(`/api/signatures/${req.requestId}/submit`, { passkey: a.assert(b64uToBytes(req.challengeB64url), opts) });
  const requestStatus = async (id: string) => (await live.db.$client.query("select status from signature_requests where facility_id = $1 and id = $2", [w.facilityId, id])).rows[0]?.status;
  const commitActions = async () => (await live.db.$client.query("select count(*)::int as n from chain_actions where facility_id = $1 and kind = 'PlanRegistry.commitPlan'", [w.facilityId])).rows[0].n;

  beforeAll(async () => {
    live = await openLive();
    agent = scriptedAgent();
    w = await newWorld(live, { agent });
    auth = await openAndRegister(w);
    draftId = await chatToDraft(w, agent, SESSION);
  }, LIVE_TIMEOUT_MS);
  afterAll(async () => {
    await live?.close();
  });

  it("builds PlanApproval typed data with @hogee/chain: digest, challenge and panel agree; nonces are random 256-bit", async () => {
    // Two open requests (one per method): asking again for the same one hands out the open request (audit run-6).
    const [a, b] = [await request(), await request("eip712")];
    expect(b.requestId).not.toBe(a.requestId);
    expect((await request()).requestId).toBe(a.requestId);
    expect(a.typedData.primaryType).toBe("PlanApproval");
    expect(a.typedData.domain.verifyingContract.toLowerCase()).toBe(w.deployment.contracts.PlanRegistry.address.toLowerCase());
    expect(hashTypedData(viemTyped(a.typedData))).toBe(a.digest);
    expect(Buffer.from(a.challengeB64url, "base64url").toString("hex")).toBe(a.digest.slice(2));
    expect(a.displayModel.digest).toBe(a.digest);
    expect(a.displayModel.rows.some((r) => r.label === "Total budget")).toBe(true);
    const [na, nb] = [BigInt(a.typedData.message.nonce as string), BigInt(b.typedData.message.nonce as string)];
    expect(na).not.toBe(nb);
    expect(na > 2n ** 128n || nb > 2n ** 128n).toBe(true);
    expect(nb - na).not.toBe(1n);
    expect(a.typedData.message.agent).toBe(w.signers.agent.address.toLowerCase());
  });

  it("refuses to sign a country preview, a stage release (lender-only) and an unknown draft", async () => {
    const preview = await json(await w.founder.post("/api/plans/preview-country", { draftId, country: "ID" }), z.object({ draftId: z.string() }));
    const r1 = await w.founder.post("/api/signatures/request", { kind: "PlanApproval", refId: preview.draftId, method: "passkey" });
    expect(r1.status).toBe(409);
    const r2 = await w.founder.post("/api/signatures/request", { kind: "StageRelease", refId: "exc-stage-1", method: "passkey" });
    expect(r2.status).toBe(403);
    const r3 = await w.founder.post("/api/signatures/request", { kind: "PlanApproval", refId: "draft-missing", method: "passkey" });
    expect(r3.status).toBe(404);
    expect((await w.officer.post("/api/signatures/request", { kind: "PlanApproval", refId: draftId, method: "passkey" })).status).toBe(403);
  });

  it("refuses a forged passkey (another authenticator), no UV, a foreign origin and a high-s twin; nothing is relayed", async () => {
    const req = await request();
    const forged = await submitPasskey(req, new SoftAuthenticator());
    expect(forged.status).toBe(409);
    expect(ApiError.parse(await forged.json()).error.code).toBe("InvalidSignature");
    expect((await submitPasskey(req, auth, { uv: false })).status).toBe(409);
    expect((await submitPasskey(req, auth, { origin: "https://evil.example" })).status).toBe(409);
    expect((await submitPasskey(req, auth, { highS: true })).status).toBe(422);
    expect(await requestStatus(req.requestId)).toBe("PENDING");
    expect(await commitActions()).toBe(0);
    const alerts = await live.db.$client.query("select count(*)::int as n from traces where facility_id = $1 and kind = 'ALERT' and summary like '%signature%'", [w.facilityId]);
    expect(alerts.rows[0].n).toBeGreaterThanOrEqual(3);
  });

  it("refuses an ECDSA signature from any key but the registered owner EOA, and a method mismatch", async () => {
    const req = await request("eip712");
    const stranger = privateKeyToAccount(generatePrivateKey());
    const bad = await stranger.signTypedData(viemTyped(req.typedData));
    const res = await w.founder.post(`/api/signatures/${req.requestId}/submit`, { ecdsa: { signature: bad } });
    expect(ApiError.parse(await res.json()).error.code).toBe("InvalidSignature");
    const mismatch = await submitPasskey(req);
    expect(mismatch.status).toBe(422);
  });

  it("expires: past the struct expiry the request is dead (SignatureExpired)", async () => {
    const req = await request("eip712");
    await warp(live, 3_600n);
    const sig = await w.founderWallet.signTypedData(viemTyped(req.typedData));
    const res = await w.founder.post(`/api/signatures/${req.requestId}/submit`, { ecdsa: { signature: sig as Hex } });
    expect(ApiError.parse(await res.json()).error.code).toBe("SignatureExpired");
    expect(await requestStatus(req.requestId)).toBe("EXPIRED");
  });

  it("commits a valid passkey signature through the relayer, once", async () => {
    const req = await request();
    const action = await json(await submitPasskey(req), ChainAction);
    expect(action.state).toBe("PENDING");
    const replay = await submitPasskey(req);
    expect(replay.status).toBe(409);
    expect(await commitActions()).toBe(1);
    await w.pump();
    const current = await json(await w.founder.get("/api/plans/current"), PlanRecord);
    expect(current.status).toBe("COMMITTED");
    expect(current.manifest.version).toBe(1);
    expect(await json(await w.founder.get("/api/plans/versions"), z.array(PlanRecord))).toHaveLength(1);
    // The same draft cannot be signed again: the plan moved on.
    expect((await w.founder.post("/api/signatures/request", { kind: "PlanApproval", refId: draftId, method: "passkey" })).status).toBe(409);
  });
});
