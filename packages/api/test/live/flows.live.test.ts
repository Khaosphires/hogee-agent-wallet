/**
 * §26.1 flows 0–11 end to end on the live API, Postgres, Anvil and the worker's jobs (run in-process; the worker is
 * the only signer). Each step goes through the same routes the UI uses; only the model is scripted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError, Balances, ChatMessage, Exception, MEI_IDS, Payment, PlanDraft, PlanRecord, RINA_IDS, Shortlist, SignatureRequestResponse, SpendProposalResult, TraceEvent, exampleShortlistSpec } from "@hogee/core";
import { ApproveExceptionResult } from "@hogee/api-contract";
import { buildExecuteLoosen } from "@hogee/chain";
import { runAgentActions, runSettle, runTick } from "@hogee/worker";
import { createWalletClient, http, keccak256, toHex, type Hex } from "viem";
import { anvil } from "viem/chains";
import { z } from "zod";
import { iPlanRegistryAbi, iTreasuryAbi } from "../../../chain/src/generated";
import { shortIdToBytes32 } from "../../src/chain-lib";
import { scriptedAgent, toolCall, type ScriptedAgent } from "../support/agent";
import type { SoftAuthenticator } from "../support/authenticator";
import { anvilAccount, finalizeAll, LIVE, LIVE_TIMEOUT_MS, openLive, RPC_URL, warp, type Live } from "../support/live";
import { b64uToBytes, chatToDraft, json, openAndRegister, signPlan, streamChunks } from "../support/steps";
import { paymentIntentSucceeded, postStripe } from "../support/stripe";
import { newWorld, type World } from "../support/world";

const SESSION = "01a14202-2800-7000-8000-0000000000f4";

describe.skipIf(!LIVE)("flows 0–11 (live)", { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  let w: World;
  let agent: ScriptedAgent;
  let auth: SoftAuthenticator;
  let draftId: string;
  const treasury = () => w.deployment.contracts.Treasury.address;
  const balances = async () => json(await w.founder.get("/api/balances"), Balances);
  const payments = async () => json(await w.founder.get("/api/payments"), z.array(Payment));
  /** One autonomous round: the agent's actions and pacing tick, the relay, then settlement once final. */
  const agentRound = async () => {
    const d = w.workerDeps();
    await runAgentActions(d, [w.facilityId]);
    await runTick(d, w.facilityId);
    await w.pump();
  };
  /** Settlement runs at finality: payout, then the oracle's confirm, then the confirm's own finality. */
  const settleRound = async () => {
    for (let i = 0; i < 5; i += 1) {
      await finalizeAll(live);
      await w.pump();
      const [r] = await runSettle(w.workerDeps(), [w.facilityId]);
      await w.pump();
      if ((r?.payments ?? []).length === 0) return; // every settled row has left the queue
    }
  };

  beforeAll(async () => {
    live = await openLive();
    agent = scriptedAgent();
    w = await newWorld(live, { agent, coolingSeconds: 120 });
  }, LIVE_TIMEOUT_MS);
  afterAll(async () => {
    await live?.close();
  });

  it("0: the officer opens the facility and registers Rina's keys on-chain", async () => {
    auth = await openAndRegister(w);
    const facility = await live.client.readContract({ address: treasury(), abi: iTreasuryAbi, functionName: "facility" });
    expect(facility.opened).toBe(true);
    const [qx] = await live.client.readContract({ address: w.deployment.contracts.PlanRegistry.address, abi: iPlanRegistryAbi, functionName: "founderKey" });
    expect(qx).toBe(auth.qx);
  });

  it("1: Rina types the prompt; the agent asks templated questions", async () => {
    agent.queue(toolCall("askClarifyingQuestions", { slots: ["residency", "productCategory"] }));
    const chunks = await streamChunks(await w.founder.post("/api/chat", { sessionId: SESSION, message: "Custom insulated tumblers on Shopee, from China, budget RM10,000." }));
    expect(chunks.filter((c) => c.type === "data-question")).toHaveLength(2);
  });

  it("2: the plan draft has rules with sources, a diff against the baseline and a blast radius", async () => {
    draftId = await chatToDraft(w, agent, SESSION);
    const draft = await json(await w.founder.post("/api/plans/draft", { sessionId: SESSION }), PlanDraft);
    expect(draft.draftId).toBe(draftId);
    expect(draft.manifest.rules.length).toBeGreaterThan(0);
    expect(BigInt(draft.blastRadiusMinor)).toBeGreaterThan(0n);
    expect(draft.constitutionReport.every((c) => c.ok)).toBe(true);
    expect((await json(await w.founder.get(`/api/chat/${SESSION}`), z.array(ChatMessage))).length).toBeGreaterThanOrEqual(4);
  });

  it("3: Rina signs the plan with a passkey; commitPlan releases stage 1", async () => {
    await signPlan(w, auth, draftId);
    expect((await json(await w.founder.get("/api/plans/current"), PlanRecord)).status).toBe("COMMITTED");
    expect((await balances()).releasedMinor).toBe("400000");
  });

  it("4: the officer funds the facility", async () => {
    await json(await w.officer.post("/api/facility/fund", { amountMinor: "1000000" }), z.unknown());
    await w.pump();
    expect((await balances()).fundedMinor).toBe("1000000");
  });

  it("5: the supplier shortlist ranks A first and keeps the planted injection out of first place", async () => {
    const { requestId } = await json(await w.founder.post("/api/suppliers/shortlist", { spec: exampleShortlistSpec }), z.object({ requestId: z.string() }));
    const s = await json(await w.founder.get(`/api/suppliers/shortlist/${requestId}`), Shortlist);
    expect(s.candidates[0]?.supplierId).toBe("supplier-a");
  });

  it("6: Rina picks supplier A and signs the schedule; the payee cools, then binds", async () => {
    const req = await json(await w.founder.post("/api/signatures/request", { kind: "SupplierApproval", refId: "order-a-001", method: "passkey" }), SignatureRequestResponse);
    await json(await w.founder.post(`/api/signatures/${req.requestId}/submit`, { passkey: auth.assert(b64uToBytes(req.challengeB64url)) }), z.unknown());
    await w.pump();
    await warp(live, 200n);
    await w.pump();
    const p = (await live.db.$client.query("select status from payees where facility_id = $1 and id = 'supplier-a'", [w.facilityId])).rows[0];
    expect(p.status).toBe("BOUND");
  });

  it("7: the agent pays sample + deposit into escrow, ads within the pacing, and a logistics invoice within caps", async () => {
    await agentRound();
    await agentRound();
    const ps = await payments();
    const funded = ps.filter((p) => p.kind === "FUND_MILESTONE");
    expect(funded.map((p) => p.amountMinor).sort()).toEqual(["120000", "30000"]);
    expect(ps.some((p) => p.kind === "SPEND" && p.lineKey === "ADS")).toBe(true);
    await live.db.$client.query(
      `insert into invoices (id, facility_id, payee_id, amount_minor, invoice_hash, extracted_fields_json, taint, flags, received_at)
       values ('inv-flow-1', $1, 'spx-logistics', 15000, $2, '{}'::jsonb, '{"trust":"untrusted","sensitivity":"public"}'::jsonb, '{}', now())`,
      [w.facilityId, keccak256(toHex(`${w.facilityId}:flow-1`))],
    );
    const r = await json(await w.anon.post("/api/proposals/spend", { lineKey: "LOGISTICS", invoiceId: "inv-flow-1", reason: "courier" }), SpendProposalResult);
    expect(r.verdict).toBe("AUTO");
    await agentRound();
    expect((await payments()).find((p) => p.paymentId === r.paymentId)?.txHash).toMatch(/^0x/);
  });

  it("8: payouts settle to the supplier and the platform payees (mock rail), confirmed on-chain", async () => {
    await settleRound();
    const settled = (await payments()).filter((p) => p.state === "SETTLED");
    expect(settled.some((p) => p.kind === "SPEND" && p.lineKey === "LOGISTICS")).toBe(true);
    expect(settled.some((p) => p.kind === "FUND_MILESTONE" || p.kind === "RELEASE_MILESTONE")).toBe(true);
  });

  it("9: a Stripe test sale arrives through the signed webhook; the oracle records it and the reserve is skimmed", async () => {
    const before = await balances();
    const res = await postStripe(w.app, paymentIntentSucceeded({ facilityId: w.facilityId, amountMinor: 250_000, currency: "myr" }), w.flags.stripeWebhookSecret as string);
    expect(res.status).toBe(200);
    await w.pump();
    const after = await balances();
    expect(BigInt(after.revenueMinor)).toBeGreaterThan(BigInt(before.revenueMinor));
    expect(BigInt(after.reserveMinor)).toBeGreaterThan(BigInt(before.reserveMinor));
  });

  it("9b: the reserve goes only to the MY server's tax payee: iras-tax and a line's platform payee are refused (run-8 hardening)", async () => {
    const amountMinor = (await balances()).reserveMinor;
    const ask = (taxPayeeId: string) => w.founder.post("/api/exceptions", { kind: "WITHDRAW_RESERVE", payload: { taxPayeeId, amountMinor }, reason: "SST" });
    // Both are static platform payees of final-1, so the chain alone would accept either as the destination.
    for (const other of [MEI_IDS.taxPayeeId, RINA_IDS.logisticsPayeeId]) {
      const res = await ask(other);
      expect(res.status, other).toBe(409);
      expect(ApiError.parse(await res.json()).error, other).toMatchObject({ code: "CONFLICT", message: expect.stringContaining(RINA_IDS.taxPayeeId) });
    }
    const e = await json(await ask(RINA_IDS.taxPayeeId), Exception);
    expect(e.status).toBe("OPEN");
    const approved = await json(await w.founder.post(`/api/exceptions/${e.exceptionId}/approve`, {}), ApproveExceptionResult);
    if (approved.outcome !== "SIGNATURE_REQUIRED") throw new Error("expected a signature request");
    expect(approved.signature.typedData.message).toMatchObject({ target: shortIdToBytes32(RINA_IDS.taxPayeeId).toLowerCase(), newValue: amountMinor });
    // A row whose destination changed since it was opened is never signed.
    await live.db.$client.query(`update exceptions set payload = jsonb_set(payload, '{taxPayeeId}', '"iras-tax"') where facility_id = $1 and id = $2`, [w.facilityId, e.exceptionId]);
    const tampered = await w.founder.post(`/api/exceptions/${e.exceptionId}/approve`, {});
    expect(tampered.status).toBe(409);
    expect(ApiError.parse(await tampered.json()).error.code).toBe("CONFLICT");
    expect((await json(await w.officer.post(`/api/exceptions/${e.exceptionId}/deny`, { reason: "Destination changed" }), Exception)).status).toBe("DENIED");
  });

  it("9c: a reserve withdrawal to lhdn-tax runs the timelock, executes on-chain and settles to the tax payee", async () => {
    const amountMinor = (await balances()).reserveMinor;
    const e = await json(await w.founder.post("/api/exceptions", { kind: "WITHDRAW_RESERVE", payload: { taxPayeeId: RINA_IDS.taxPayeeId, amountMinor }, reason: "SST" }), Exception);
    const sig = await json(await w.founder.post(`/api/exceptions/${e.exceptionId}/approve`, {}), z.object({ signature: SignatureRequestResponse }));
    await json(await w.founder.post(`/api/signatures/${sig.signature.requestId}/submit`, { passkey: auth.assert(b64uToBytes(sig.signature.challengeB64url)) }), z.unknown());
    await json(await w.officer.post(`/api/exceptions/${e.exceptionId}/approve`, {}), z.unknown());
    await w.pump();
    await warp(live, 200n);
    // The worker never sends a value-moving executeLoosen (timelock-executor.ts): anyone may, then settle-adopt takes it.
    const { loosen_id } = (await live.db.$client.query("select loosen_id from exceptions where facility_id = $1 and id = $2", [w.facilityId, e.exceptionId])).rows[0];
    const outsider = createWalletClient({ account: anvilAccount(9), chain: anvil, transport: http(RPC_URL) });
    const hash = await outsider.sendTransaction({ to: treasury(), data: buildExecuteLoosen({ loosenId: loosen_id as Hex }).data });
    expect((await live.client.waitForTransactionReceipt({ hash })).status).toBe("success");
    await w.pump();
    const done = (await json(await w.officer.get("/api/exceptions"), z.array(Exception))).find((x) => x.exceptionId === e.exceptionId);
    expect(done?.status).toBe("EXECUTED");
    expect((await balances()).reserveMinor).toBe("0");
    await settleRound();
    const withdrawal = (await payments()).find((p) => p.kind === "WITHDRAW_RESERVE");
    expect(withdrawal).toMatchObject({ payeeId: RINA_IDS.taxPayeeId, amountMinor, state: "SETTLED" });
  });

  it("10: the stage gate opens an officer decision; the officer releases stage 2; a loosening runs the timelock", async () => {
    await w.pump(); // stage-gate runs inside the pump
    const open = await json(await w.officer.get("/api/exceptions?status=OPEN"), z.array(z.object({ exceptionId: z.string(), kind: z.string() })));
    const stage = open.find((e) => e.kind === "RELEASE_STAGE");
    expect(stage).toBeDefined();
    // Audit run-7: a deny that commits after the approval read the row OPEN leaves nothing signed (rowCount checked).
    const db = live.db.$client;
    const releaseActions = async () =>
      (await db.query("select count(*)::int as n from chain_actions where facility_id = $1 and kind = 'Treasury.releaseStage' and ref_id = $2", [w.facilityId, stage?.exceptionId])).rows[0].n as number;
    const denier = await db.connect();
    try {
      await denier.query("begin");
      await denier.query("update exceptions set status = 'DENIED', updated_at = now() where facility_id = $1 and id = $2 and status = 'OPEN'", [w.facilityId, stage?.exceptionId]);
      const approving = w.officer.post(`/api/exceptions/${stage?.exceptionId}/approve`, {});
      let waited = false;
      for (let i = 0; i < 200 && !waited; i += 1) {
        const r = await db.query("select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'");
        waited = r.rows[0].n > 0;
        if (!waited) await new Promise((done) => setTimeout(done, 50));
      }
      await denier.query("commit");
      const res = await approving;
      expect(waited, "the approval reached its UPDATE while the deny held the row").toBe(true);
      expect(res.status).toBe(409);
      expect(ApiError.parse(await res.json()).error.message).toMatch(/changed meanwhile/);
    } finally {
      denier.release();
    }
    expect(await releaseActions()).toBe(0);
    await db.query("update exceptions set status = 'OPEN' where facility_id = $1 and id = $2", [w.facilityId, stage?.exceptionId]); // undo the simulated deny
    await json(await w.officer.post(`/api/exceptions/${stage?.exceptionId}/approve`, {}), z.unknown());
    expect(await releaseActions()).toBe(1);
    await w.pump();
    expect((await balances()).releasedMinor).toBe("1000000");
    const expiry = await live.client.readContract({ address: treasury(), abi: iTreasuryAbi, functionName: "agentExpiry" });
    const e = await json(await w.founder.post("/api/exceptions", { kind: "EXTEND_EXPIRY", payload: { target: "agent", newExpiresAt: (expiry + 86_400n).toString() }, reason: "slip" }), z.object({ exceptionId: z.string() }));
    const sig = await json(await w.founder.post(`/api/exceptions/${e.exceptionId}/approve`, {}), z.object({ signature: SignatureRequestResponse }));
    await json(await w.founder.post(`/api/signatures/${sig.signature.requestId}/submit`, { passkey: auth.assert(b64uToBytes(sig.signature.challengeB64url)) }), z.unknown());
    await json(await w.officer.post(`/api/exceptions/${e.exceptionId}/approve`, {}), z.unknown());
    await w.pump();
    await warp(live, 200n);
    await w.pump();
    expect(await live.client.readContract({ address: treasury(), abi: iTreasuryAbi, functionName: "agentExpiry" })).toBe(expiry + 86_400n);
  });

  it("11: evidence: every mined payment has its tx hash and decision; the trace links them (bundles: evidence.live.test.ts)", async () => {
    const mined = (await payments()).filter((p) => p.txHash);
    expect(mined.length).toBeGreaterThan(0);
    for (const p of mined.filter((x) => x.kind !== "OWNER_SPEND" && x.kind !== "WITHDRAW_RESERVE")) expect(p.decisionId).toBeTruthy();
    const traces = await json(await w.founder.get("/api/traces?limit=500"), z.array(TraceEvent));
    expect(traces.some((t) => t.kind === "TX" && t.refs.txHash)).toBe(true);
    expect(traces.some((t) => t.refs.decisionId)).toBe(true);
    expect((await w.founder.get("/api/evidence/runs")).status).toBe(200);
  });
});
