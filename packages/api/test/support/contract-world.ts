/**
 * TEST SUPPORT ONLY: the Rina state the api-contract route examples refer to, seeded on a live world through the real
 * routes (the worker's jobs run in-process; the worker is still the only signer). Used by
 * packages/api-contract/test/support/live-app.ts (HOGEE_API_MOCK) to run the frozen contract suite against the live API.
 *   facility opened with the example terms (left UNFUNDED, so fundFacility's example fits), passkey registered,
 *   plan v1 committed from a chat (session RINA_SESSION_ID, ADS emphasised and its per-payment cap tightened by the
 *   owner, so the RAISE_CAP example is a real loosening), the session's draft re-compiled as a tighten-only v2 stored
 *   as `draft-rina-001`, supplier A shortlisted and approved (order-a-001), one queued loosening (veto), two open ones
 *   with stable ids (approve / deny), one payment row, and one finished evidence bundle (task 1.16).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RINA_SESSION_ID, examplePlanIntent, exampleShortlistSpec, hashObject, type PlanIntent } from "@hogee/core";
import { insertRationale } from "@hogee/db";
import { createWalletClient, http, keccak256, toHex } from "viem";
import { anvil } from "viem/chains";
import { buildTighten } from "../../../chain/src/tx-builder";
import { exportEvidence } from "../../src/evidence/export";
import { forgetAttempts } from "../../src/evidence/retention";
import { scriptedAgent, type ScriptedAgent } from "./agent";
import type { SoftAuthenticator } from "./authenticator";
import { finalizeAll, openLive, RPC_URL } from "./live";
import { b64uToBytes, chatToDraft, openAndRegister, signPlan } from "./steps";
import { newWorld, type World } from "./world";

const OPEN_IDS = ["exc-contract-open-2", "exc-contract-open-1"] as const; // inserted in this order: open-1 is newest
const ADS_INTENT: PlanIntent = { ...examplePlanIntent, lineEmphasis: { SUPPLIER: "low", PACKAGING: "low", LOGISTICS: "low", ADS: "high", CONTINGENCY: "low" } };

const ok = async (res: Response, what: string): Promise<unknown> => {
  if (!res.ok) throw new Error(`live-app seed: ${what} → ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
};

/** The owner tightens ADS's per-payment cap (an owner tighten is instant and needs no backend row). */
async function tightenAdsPerTx(w: World, newCapMinor: bigint): Promise<void> {
  await w.live.test.setBalance({ address: w.founderWallet.address, value: 10n ** 19n });
  const wallet = createWalletClient({ account: w.founderWallet, chain: anvil, transport: http(RPC_URL) });
  const call = buildTighten({ kind: 1, target: toHex("ADS", { size: 32 }), newValue: newCapMinor, decisionId: keccak256(toHex("contract-tighten")) });
  const hash = await wallet.sendTransaction({ to: w.deployment.contracts.Treasury.address, data: call.data });
  await w.live.client.waitForTransactionReceipt({ hash });
}

async function founderSignsLoosening(w: World, auth: SoftAuthenticator, exceptionId: string): Promise<void> {
  const r = (await ok(await w.founder.post(`/api/exceptions/${exceptionId}/approve`, {}), "founder approve")) as { signature: { requestId: string; challengeB64url: string } };
  await ok(await w.founder.post(`/api/signatures/${r.signature.requestId}/submit`, { passkey: auth.assert(b64uToBytes(r.signature.challengeB64url)) }), "founder signs loosening");
}

export async function seedContractState(w: World, agent: ScriptedAgent): Promise<void> {
  const db = w.live.db.$client;
  const auth = await openAndRegister(w);
  const draftId = await chatToDraft(w, agent, RINA_SESSION_ID, ADS_INTENT);
  await signPlan(w, auth, draftId);
  await tightenAdsPerTx(w, 30_000n);
  // A tighten-only v2 of the same intent, under the example's draft id (requestSignature / previewCountry examples).
  // Compiled AFTER the owner's tighten (audit run-7): a draft compiled before it raises ADS's per-payment cap back, so
  // it is no longer current (code 14 against the chain's plan) and is never offered for signing.
  const v2 = (await ok(await w.founder.post("/api/plans/draft", { sessionId: RINA_SESSION_ID }), "draft v2")) as { draftId: string };
  await db.query("delete from plan_drafts where facility_id = $1 and id = 'draft-rina-001'", [w.facilityId]);
  await db.query(
    `insert into plan_drafts (id, facility_id, session_id, source_draft_id, country_code, intent_json, manifest_json, baseline_json, diff_json, blast_radius_minor, constitution_report_json)
     select 'draft-rina-001', facility_id, session_id, null, country_code, intent_json, manifest_json, baseline_json, diff_json, blast_radius_minor, constitution_report_json
       from plan_drafts where facility_id = $1 and id = $2`,
    [w.facilityId, v2.draftId],
  );
  // Supplier A, approved (order-a-001): escrow + inspection examples.
  await ok(await w.founder.post("/api/suppliers/shortlist", { spec: exampleShortlistSpec }), "shortlist");
  const sa = (await ok(await w.founder.post("/api/signatures/request", { kind: "SupplierApproval", refId: "order-a-001", method: "passkey" }), "supplier request")) as { requestId: string; challengeB64url: string };
  await ok(await w.founder.post(`/api/signatures/${sa.requestId}/submit`, { passkey: auth.assert(b64uToBytes(sa.challengeB64url)) }), "supplier submit");
  await w.pump();
  // One queued loosening (veto example), then two open ones with stable ids (approve / deny examples).
  const expiry = BigInt(await w.live.client.readContract({ address: w.deployment.contracts.Treasury.address, abi: [{ type: "function", name: "agentExpiry", inputs: [], outputs: [{ type: "uint64" }], stateMutability: "view" }], functionName: "agentExpiry" }));
  const extend = (days: bigint) => ({ kind: "EXTEND_EXPIRY", payload: { target: "agent", newExpiresAt: (expiry + days * 86_400n).toString() }, reason: "Launch slipped" });
  const queued = (await ok(await w.founder.post("/api/exceptions", extend(1n)), "loosening for veto")) as { exceptionId: string };
  await founderSignsLoosening(w, auth, queued.exceptionId);
  await ok(await w.officer.post(`/api/exceptions/${queued.exceptionId}/approve`, {}), "officer approve");
  await w.pump();
  for (const [i, id] of OPEN_IDS.entries()) {
    const e = (await ok(await w.founder.post("/api/exceptions", extend(BigInt(i + 2))), "open loosening")) as { exceptionId: string };
    await db.query("delete from exceptions where facility_id = $1 and id = $2", [w.facilityId, id]);
    await db.query("update exceptions set id = $3, created_at = now() where facility_id = $1 and id = $2", [w.facilityId, e.exceptionId, id]);
  }
  // One payment row (getPayment example): a policy refusal on record (nothing signed, no intent held). Like every
  // decision writer, it stores the preimage of its rationaleHash (the evidence export refuses a decision without one).
  const decisionId = "01a14202-2800-7000-8000-00000000c001";
  const rationale = { kind: "SPEND_PROPOSAL", decisionId, lineKey: "LOGISTICS", amountMinor: "1000", verdict: "DENY", reasonCode: "CapExceeded" };
  await insertRationale(db, { facilityId: w.facilityId, rationaleHash: hashObject(rationale), decisionId, rationale });
  await db.query(
    `insert into payments (id, facility_id, kind, intent_id, line_key, line_id, payee_id, amount_minor, invoice_hash, plan_version, state, decision_id, rationale_hash, trace_id)
     values ('pay-contract-0001', $1, 'SPEND', $2, 'LOGISTICS', $3, 'spx-logistics', 1000, $4, 1, 'POLICY_DENIED', '01a14202-2800-7000-8000-00000000c001', $5, 'trace-contract-0001')
     on conflict do nothing`,
    [w.facilityId, keccak256(toHex("contract:intent")), toHex("LOGISTICS", { size: 32 }), keccak256(toHex("contract:invoice")), hashObject(rationale)],
  );
}


export interface ContractWorld {
  readonly world: World;
  /** Re-seeds after POST /api/demo/reset (same stable ids). */
  reseed(): Promise<void>;
}

/** A live world seeded for the contract examples; flags follow the env the contract suite sets before importing. */
export async function contractWorld(): Promise<ContractWorld> {
  const live = await openLive();
  const agent = scriptedAgent();
  const stripe = { createTestPayment: async () => ({ paymentIntentId: `pi_test_${Date.now()}` }) };
  const evidenceDir = mkdtempSync(join(tmpdir(), "hogee-contract-evidence-"));
  const world = await newWorld(live, {
    agent,
    stripe,
    evidenceDir,
    flags: { demoMode: true, cookieSecret: process.env.PERSONA_COOKIE_SECRET, officerToken: process.env.OFFICER_TOKEN },
  });
  const seed = async () => {
    await seedContractState(world, agent);
    // The export refuses unsettled state (in-flight rows, receipts above `finalized`): settle it first.
    for (let i = 0; i < 3; i += 1) {
      await finalizeAll(world.live);
      await world.pump();
    }
    const scope = { facilityId: world.facilityId, founderId: world.founderId };
    await (await exportEvidence(world.deps, scope, { root: evidenceDir, wait: true })).done;
    // The suite's own POST /api/evidence/export follows within seconds: move the seed run out of the export interval
    // (an idempotent re-seed after a demo reset also starts the in-process one).
    await live.db.$client.query("update evidence_runs set finished_at = finished_at - interval '1 hour' where facility_id = $1", [world.facilityId]);
    forgetAttempts();
  };
  await seed();
  return { world, reseed: seed };
}
