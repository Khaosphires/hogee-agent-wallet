/**
 * Founder-signed payments: the OwnerSpend manual fallback is derived from a stored invoice (payee it was registered
 * for, stored amount, the payee's single bound pocket), verified against the registered owner wallet and simulated
 * before a POLICY_OK row is written for the worker. A MilestoneRelease needs a funded milestone and evidence first.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChainAction, SignatureRequestResponse } from "@hogee/core";
import { keccak256, toHex, type Hex } from "viem";
import { scriptedAgent } from "../support/agent";
import { LIVE, LIVE_TIMEOUT_MS, openLive, type Live } from "../support/live";
import { chatToDraft, json, openAndRegister, signPlan } from "../support/steps";
import { newWorld, type World } from "../support/world";

const SESSION = "01a14202-2800-7000-8000-0000000000f2";

describe.skipIf(!LIVE)("founder-signed payments (live)", { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  let w: World;
  beforeAll(async () => {
    live = await openLive();
    const agent = scriptedAgent();
    w = await newWorld(live, { agent });
    const auth = await openAndRegister(w);
    await signPlan(w, auth, await chatToDraft(w, agent, SESSION));
    await w.officer.post("/api/facility/fund", { amountMinor: "1000000" });
    await w.pump();
  }, LIVE_TIMEOUT_MS);
  afterAll(async () => {
    await live?.close();
  });

  it("OwnerSpend: server-derived struct, owner-wallet signature, simulated, then a POLICY_OK row for the relayer", async () => {
    await live.db.$client.query(
      `insert into invoices (id, facility_id, payee_id, amount_minor, invoice_hash, extracted_fields_json, taint, flags, received_at)
       values ('inv-owner-1', $1, 'spx-logistics', 4200, $2, '{}'::jsonb, '{"trust":"untrusted","sensitivity":"public"}'::jsonb, '{}', now())`,
      [w.facilityId, keccak256(toHex(`${w.facilityId}:owner-1`))],
    );
    const req = await json(await w.founder.post("/api/signatures/request", { kind: "OwnerSpend", refId: "inv-owner-1", method: "eip712" }), SignatureRequestResponse);
    expect(req.typedData.message.amountMinor).toBe("4200");
    const t = req.typedData;
    const fields = t.types[t.primaryType] ?? [];
    const message = Object.fromEntries(fields.map((f) => [f.name, f.type.startsWith("uint") ? (Number(f.type.slice(4)) <= 32 ? Number(t.message[f.name]) : BigInt(t.message[f.name] as string)) : t.message[f.name]]));
    const signature = await w.founderWallet.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message } as never);
    const action = await json(await w.founder.post(`/api/signatures/${req.requestId}/submit`, { ecdsa: { signature: signature as Hex } }), ChainAction);
    expect(action.actionId).toBe(`owner:${req.requestId}`);
    const p = (await live.db.$client.query("select kind, state, line_key, payee_id, amount_minor::text as amount, trace_id from payments where facility_id = $1 and id = $2", [w.facilityId, action.actionId])).rows[0];
    expect(p).toEqual({ kind: "OWNER_SPEND", state: "POLICY_OK", line_key: "LOGISTICS", payee_id: "spx-logistics", amount: "4200", trace_id: req.requestId });
  });

  it("MilestoneRelease: nothing to release without a funded milestone (404 for an unknown order)", async () => {
    expect((await w.founder.post("/api/signatures/request", { kind: "MilestoneRelease", refId: "order-a-001", method: "passkey" })).status).toBe(404);
  });
});
