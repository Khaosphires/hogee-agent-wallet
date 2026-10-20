/**
 * §26.1 step 10 and hard rule 3 on the live API: the exception console. A founder can never open a POLICY_ESCALATION;
 * a loosening needs the founder's verified signature AND the officer's approval (only a verified officer persona gets
 * the lender branch) before the worker's lender key co-signs; the timelock runs, a veto cancels; a stage release is
 * refused while its gate is not met.
 *
 * Audit run-4: a veto is reconciled with the chain. Its cancel decision comes from the row it locks; a cancel that runs
 * before the exception's in-flight queueLoosen lands waits for it instead of being refused for good; sync re-queues a
 * cancel (at most three times) for a vetoed loosening the chain still shows QUEUED, records a final cancel once, and
 * alerts once, never halts, on one the chain executed anyway (read at finalized).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError, ChainAction, Exception, MEI_IDS, RINA_IDS, SignatureRequestResponse } from "@hogee/core";
import { PERSONA_COOKIE } from "@hogee/core";
import { buildExecuteLoosen } from "@hogee/chain";
import { activeHalt, runRelay, syncFacility } from "@hogee/worker";
import { createWalletClient, http, keccak256, toHex, type Hex } from "viem";
import { anvil } from "viem/chains";
import { z } from "zod";
import { ApproveExceptionResult } from "@hogee/api-contract";
import { iTreasuryAbi } from "../../../chain/src/generated";
import { policyWorld } from "../../src/services/policy-context";
import { scriptedAgent } from "../support/agent";
import type { SoftAuthenticator } from "../support/authenticator";
import { anvilAccount, finalizeAll, LIVE, LIVE_TIMEOUT_MS, openLive, RPC_URL, warp, type Live } from "../support/live";
import { b64uToBytes, chatToDraft, json, openAndRegister, signPlan } from "../support/steps";
import { newWorld, type World } from "../support/world";

const SESSION = "01a14202-2800-7000-8000-0000000000dd";

describe.skipIf(!LIVE)("exceptions (live)", { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  let w: World;
  let auth: SoftAuthenticator;
  let agentExpiry: bigint;
  const treasury = () => w.deployment.contracts.Treasury.address;
  const extendAgent = (by: bigint) => ({ kind: "EXTEND_EXPIRY", payload: { target: "agent", newExpiresAt: (agentExpiry + by).toString() }, reason: "Launch slipped by a week" });
  const create = async (body: unknown) => json(await w.founder.post("/api/exceptions", body), Exception);
  const approveAs = async (who: "founder" | "officer", id: string) => json(await w[who].post(`/api/exceptions/${id}/approve`, {}), ApproveExceptionResult);
  const actionRow = async (kind: string) =>
    (await live.db.$client.query("select id, state, revert_reason from chain_actions where facility_id = $1 and kind = $2 order by created_at desc limit 1", [w.facilityId, kind])).rows[0];
  const founderSigns = async (id: string) => {
    const r = await approveAs("founder", id);
    if (r.outcome !== "SIGNATURE_REQUIRED") throw new Error("expected a signature request");
    return json(await w.founder.post(`/api/signatures/${r.signature.requestId}/submit`, { passkey: auth.assert(b64uToBytes(r.signature.challengeB64url)) }), ChainAction);
  };

  beforeAll(async () => {
    live = await openLive();
    const agent = scriptedAgent();
    w = await newWorld(live, { agent });
    auth = await openAndRegister(w);
    await signPlan(w, auth, await chatToDraft(w, agent, SESSION));
    agentExpiry = await live.client.readContract({ address: treasury(), abi: iTreasuryAbi, functionName: "agentExpiry" });
  }, LIVE_TIMEOUT_MS);
  afterAll(async () => {
    await live?.close();
  });

  it("refuses POLICY_ESCALATION from a founder (422): only the server's spend path opens one", async () => {
    const res = await w.founder.post("/api/exceptions", {
      kind: "POLICY_ESCALATION",
      payload: { proposal: { lineKey: "ADS", payeeId: "shopee-ads", amountMinor: "30000" } },
      reason: "please",
    });
    expect(res.status).toBe(422);
    expect((await live.db.$client.query("select count(*)::int as n from exceptions where facility_id = $1", [w.facilityId])).rows[0].n).toBe(0);
    expect((await w.officer.post("/api/exceptions", extendAgent(86_400n))).status).toBe(403);
  });

  it("opens a loosening with code-derived requirements, title and blast radius", async () => {
    const e = await create(extendAgent(86_400n));
    expect(e.status).toBe("OPEN");
    expect(e.requires).toEqual({ founder: true, lender: true });
    expect(e.requestedBy).toBe("founder");
    expect(e.title).toMatch(/agent/i);
    const listed = await json(await w.officer.get("/api/exceptions?status=OPEN"), z.array(Exception));
    expect(listed.map((x) => x.exceptionId)).toContain(e.exceptionId);
  });

  it("an MCP request (x-hogee-requester: agent) is stored and traced as the agent's; the header never raises a requester (run-8 re-check)", async () => {
    const asked = async (n: bigint, header?: string) => json(await w.founder.post("/api/exceptions", extendAgent(n), header === undefined ? {} : { "x-hogee-requester": header }), Exception);
    const stored = async (id: string) =>
      (
        await live.db.$client.query(
          `select e.requested_by, t.actor, t.summary from exceptions e join traces t on t.facility_id = e.facility_id and t.trace_id = e.trace_id
            where e.facility_id = $1 and e.id = $2 and t.kind = 'EXCEPTION' order by t.seq limit 1`,
          [w.facilityId, id],
        )
      ).rows[0] as { requested_by: string; actor: string; summary: string };
    const agent = await asked(5n * 86_400n, " Agent ");
    expect(agent.requestedBy).toBe("agent");
    expect(await stored(agent.exceptionId)).toMatchObject({ requested_by: "agent", actor: "planner", summary: expect.stringMatching(/^Agent requested: /) });
    const opened = [agent.exceptionId];
    for (const [n, header] of [[6n, "officer"], [7n, "worker"], [8n, ""], [9n, undefined]] as const) {
      const e = await asked(n * 86_400n, header);
      opened.push(e.exceptionId);
      expect(e.requestedBy, String(header)).toBe("founder");
      expect(await stored(e.exceptionId), String(header)).toMatchObject({ requested_by: "founder", actor: "founder", summary: expect.stringMatching(/^Founder requested: /) });
    }
    // The same OPEN request again is the stored one, whoever repeats it (no second row, no change of requester).
    expect((await asked(5n * 86_400n)).exceptionId).toBe(agent.exceptionId);
    expect((await asked(5n * 86_400n)).requestedBy).toBe("agent");
    const officer = await w.officer.post("/api/exceptions", extendAgent(10n * 86_400n), { "x-hogee-requester": "agent" });
    expect(officer.status).toBe(403);
    for (const id of opened) await json(await w.officer.post(`/api/exceptions/${id}/deny`, { reason: "test cleanup" }), Exception);
  });

  it("a loosening the chain would refuse is refused up front (agent expiry beyond 90 days)", async () => {
    const res = await w.founder.post("/api/exceptions", extendAgent(400n * 86_400n));
    expect(res.status).toBe(409);
    // G2: createException declares the loosening mirror's contract errors, so the code is the contract error itself.
    const err = ApiError.parse(await res.json()).error;
    expect(err.code).toBe("PlanInvariantViolated");
    expect(err.contractError?.name).toBe("PlanInvariantViolated");
  });

  it("the officer cannot approve before the founder signs; a forged officer cookie gets the founder branch", async () => {
    const e = await create(extendAgent(2n * 86_400n));
    expect((await w.officer.post(`/api/exceptions/${e.exceptionId}/approve`, {})).status).toBe(409);
    const forged = await w.anon.post(`/api/exceptions/${e.exceptionId}/approve`, {}, { cookie: `${PERSONA_COOKIE}=officer` });
    const body = ApproveExceptionResult.parse(await forged.json());
    expect(body.outcome).toBe("SIGNATURE_REQUIRED");
    if (body.outcome === "SIGNATURE_REQUIRED") {
      const sig = SignatureRequestResponse.parse(body.signature);
      expect(sig.typedData.primaryType).toBe("LoosenRequest");
      expect(sig.displayModel.rows.some((r) => r.effect === "loosen")).toBe(true);
    }
  });

  it("founder signs → waits for the officer (no lender signature) → officer approves → queued → timelock → executed", async () => {
    const e = await create(extendAgent(3n * 86_400n));
    await founderSigns(e.exceptionId);
    await w.pump();
    const parked = await actionRow("Treasury.queueLoosen");
    expect(parked.state).toBe("PENDING");
    expect(parked.revert_reason).toBeNull();
    const signedOnly = await json(await w.officer.get(`/api/exceptions?status=FOUNDER_SIGNED`), z.array(Exception));
    expect(signedOnly.map((x) => x.exceptionId)).toContain(e.exceptionId);

    const approved = await approveAs("officer", e.exceptionId);
    expect(approved.outcome).toBe("APPROVED");
    await w.pump();
    const queued = (await json(await w.officer.get("/api/exceptions"), z.array(Exception))).find((x) => x.exceptionId === e.exceptionId);
    expect(queued?.status).toBe("QUEUED");
    expect(queued?.timelock).not.toBeNull();

    await warp(live, 200n);
    await w.pump();
    await w.pump();
    const done = (await json(await w.officer.get("/api/exceptions"), z.array(Exception))).find((x) => x.exceptionId === e.exceptionId);
    expect(done?.status).toBe("EXECUTED");
    const after = await live.client.readContract({ address: treasury(), abi: iTreasuryAbi, functionName: "agentExpiry" });
    expect(after).toBe(agentExpiry + 3n * 86_400n);
    agentExpiry = after;
  });

  it("a veto inside the timelock cancels the queued loosening on-chain", async () => {
    const e = await create(extendAgent(86_400n));
    await founderSigns(e.exceptionId);
    await approveAs("officer", e.exceptionId);
    await w.pump();
    const vetoed = await json(await w.founder.post(`/api/exceptions/${e.exceptionId}/veto`, { reason: "Changed my mind" }), Exception);
    expect(vetoed.status).toBe("CANCELLED");
    await w.pump();
    const row = (await live.db.$client.query("select loosen_id from exceptions where facility_id = $1 and id = $2", [w.facilityId, e.exceptionId])).rows[0];
    const ql = await live.client.readContract({ address: treasury(), abi: iTreasuryAbi, functionName: "queuedLoosen", args: [row.loosen_id] });
    expect(Number(ql.status)).toBe(3); // LOOSEN_STATUS_CANCELLED
  });

  it("deny is officer-only and terminal; the founder's parked signature is never co-signed", async () => {
    const e = await create(extendAgent(86_400n));
    await founderSigns(e.exceptionId);
    expect((await w.founder.post(`/api/exceptions/${e.exceptionId}/deny`, { reason: "no" })).status).toBe(403);
    const denied = await json(await w.officer.post(`/api/exceptions/${e.exceptionId}/deny`, { reason: "Not justified" }), Exception);
    expect(denied.status).toBe("DENIED");
    await w.pump();
    const parked = await actionRow("Treasury.queueLoosen");
    expect(parked.revert_reason).toMatch(/REFUSED/);
    expect((await w.officer.post(`/api/exceptions/${e.exceptionId}/approve`, {})).status).toBe(409);
  });

  const loosenOf = async (id: string): Promise<Hex> =>
    (await live.db.$client.query("select loosen_id from exceptions where facility_id = $1 and id = $2", [w.facilityId, id])).rows[0].loosen_id as Hex;
  const chainStatus = async (id: string): Promise<number> =>
    Number((await live.client.readContract({ address: treasury(), abi: iTreasuryAbi, functionName: "queuedLoosen", args: [await loosenOf(id)] })).status);
  const cancelRows = async (id: string) =>
    (
      await live.db.$client.query("select state, raw_signed_tx is not null as signed, revert_reason from chain_actions where facility_id = $1 and kind = 'Treasury.cancelLoosen' and ref_id = $2 order by created_at", [
        w.facilityId,
        id,
      ])
    ).rows as { state: string; signed: boolean; revert_reason: string | null }[];
  const relayPass = async () => (await runRelay(w.workerDeps(), [w.facilityId])).flatMap((r) => r.actions);
  /** Traces with `reasonCode` on the exception's own trace. */
  const traceCount = async (exceptionId: string, reasonCode: string) =>
    (
      await live.db.$client.query(
        `select count(*)::int as n from traces t join exceptions e on e.facility_id = t.facility_id and t.trace_id = coalesce(e.trace_id, 'trace:exc:' || e.id)
          where t.facility_id = $1 and e.id = $2 and t.reason_code = $3`,
        [w.facilityId, exceptionId, reasonCode],
      )
    ).rows[0].n as number;

  it("a veto takes its cancel decision from the row it locks, not from an earlier read (audit run-4)", async () => {
    const e = await create(extendAgent(86_400n));
    await founderSigns(e.exceptionId);
    // The officer's approval commits while the veto is in flight: its transaction holds the row until the veto waits on it.
    const officer = await live.db.$client.connect();
    try {
      await officer.query("begin");
      await officer.query("update exceptions set status = 'APPROVED', updated_at = now() where facility_id = $1 and id = $2 and status = 'FOUNDER_SIGNED'", [w.facilityId, e.exceptionId]);
      const veto = w.founder.post(`/api/exceptions/${e.exceptionId}/veto`, { reason: "Changed my mind" });
      for (let i = 0; i < 100; i += 1) {
        const waiting = await live.db.$client.query("select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'");
        if (waiting.rows[0].n > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await officer.query("commit");
      expect((await veto).status).toBe(200);
    } finally {
      officer.release();
    }
    // The UPDATE moved an APPROVED row (a queueLoosen may already be co-signed): the cancel must be queued.
    expect(await cancelRows(e.exceptionId)).toHaveLength(1);
  });

  it("a veto that races the in-flight queueLoosen still cancels it on-chain (audit run-4)", async () => {
    const e = await create(extendAgent(86_400n));
    await founderSigns(e.exceptionId);
    await approveAs("officer", e.exceptionId);
    await live.test.setAutomine(false);
    try {
      expect(await relayPass()).toContainEqual(expect.objectContaining({ kind: "Treasury.queueLoosen", result: "sent" }));
      const vetoed = await json(await w.anon.post(`/api/exceptions/${e.exceptionId}/veto`, { reason: "Not this one" }), Exception);
      expect(vetoed.status).toBe("CANCELLED");
      // queueLoosen is broadcast but not mined: the cancel waits for it rather than being refused for good.
      expect(await relayPass()).toContainEqual(expect.objectContaining({ kind: "Treasury.cancelLoosen", result: "deferred" }));
      expect(await cancelRows(e.exceptionId)).toEqual([{ state: "PENDING", signed: false, revert_reason: null }]);
      await live.test.mine({ blocks: 1 });
    } finally {
      await live.test.setAutomine(true);
    }
    expect(await chainStatus(e.exceptionId)).toBe(1); // QUEUED: the in-flight queueLoosen landed after the veto
    await w.pump();
    expect(await chainStatus(e.exceptionId)).toBe(3); // CANCELLED
    expect((await cancelRows(e.exceptionId)).map((r) => r.revert_reason)).toEqual([null]);
  });

  it("sync re-queues a cancel for a vetoed loosening the chain still shows QUEUED after its cancel was refused (audit run-4)", async () => {
    const e = await create(extendAgent(86_400n));
    await founderSigns(e.exceptionId);
    await approveAs("officer", e.exceptionId);
    await w.pump();
    expect(await chainStatus(e.exceptionId)).toBe(1);
    await json(await w.founder.post(`/api/exceptions/${e.exceptionId}/veto`, { reason: "No" }), Exception);
    // A cancel refused for good (what a simulation before the queue landed used to leave behind).
    await live.db.$client.query(
      "update chain_actions set revert_reason = 'REFUSED: simulation reverts TimelockActive' where facility_id = $1 and kind = 'Treasury.cancelLoosen' and ref_id = $2 and raw_signed_tx is null",
      [w.facilityId, e.exceptionId],
    );
    await w.pump();
    await w.pump();
    expect(await chainStatus(e.exceptionId)).toBe(3);
    const rows = await cancelRows(e.exceptionId);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ signed: true, revert_reason: null });
    // Once the cancel is final the veto is recorded as reconciled, once, and never read again (M3).
    await finalizeAll(live);
    await syncFacility(w.workerDeps(), w.facilityId);
    await syncFacility(w.workerDeps(), w.facilityId);
    expect(await traceCount(e.exceptionId, "VETO_RECONCILED")).toBe(1);
  });

  it("re-queues a vetoed loosening's cancel at most three times, then alerts once (audit run-4 L2)", async () => {
    const e = await create(extendAgent(86_400n));
    await founderSigns(e.exceptionId);
    await approveAs("officer", e.exceptionId);
    await w.pump();
    expect(await chainStatus(e.exceptionId)).toBe(1);
    await json(await w.founder.post(`/api/exceptions/${e.exceptionId}/veto`, { reason: "No" }), Exception);
    for (let i = 0; i < 6; i += 1) {
      // Every cancel is refused before it is signed (a relay that keeps refusing it).
      await live.db.$client.query("update chain_actions set revert_reason = 'REFUSED: test' where facility_id = $1 and kind = 'Treasury.cancelLoosen' and ref_id = $2 and raw_signed_tx is null", [
        w.facilityId,
        e.exceptionId,
      ]);
      await syncFacility(w.workerDeps(), w.facilityId);
    }
    expect(await cancelRows(e.exceptionId)).toHaveLength(4); // the API's own + 3 re-queues
    expect(await traceCount(e.exceptionId, "VETO_CANCEL_RETRIES_EXHAUSTED")).toBe(1);
    expect(await chainStatus(e.exceptionId)).toBe(1);
  });

  it("a vetoed loosening the chain executed anyway raises one ALERT once final, and never halts (audit run-4 M2)", async () => {
    const e = await create(extendAgent(86_400n));
    await founderSigns(e.exceptionId);
    await approveAs("officer", e.exceptionId);
    await w.pump();
    await warp(live, 200n);
    // Anyone may execute a matured loosening: an unrelated account does, before the DB has seen it.
    const outsider = createWalletClient({ account: anvilAccount(9), chain: anvil, transport: http(RPC_URL) });
    const call = buildExecuteLoosen({ loosenId: await loosenOf(e.exceptionId) });
    const hash = await outsider.sendTransaction({ to: treasury(), data: call.data });
    expect((await live.client.waitForTransactionReceipt({ hash })).status).toBe("success");
    agentExpiry = await live.client.readContract({ address: treasury(), abi: iTreasuryAbi, functionName: "agentExpiry" });
    // An anonymous veto followed by a permissionless executeLoosen: the worker must not stop over it.
    expect((await json(await w.anon.post(`/api/exceptions/${e.exceptionId}/veto`, { reason: "Too late" }), Exception)).status).toBe("CANCELLED");
    await w.pump();
    expect(await chainStatus(e.exceptionId)).toBe(2); // EXECUTED at latest, not final yet: nothing concluded
    expect(await traceCount(e.exceptionId, "VETOED_LOOSEN_EXECUTED")).toBe(0);
    await finalizeAll(live);
    await w.pump();
    await w.pump();
    expect(await traceCount(e.exceptionId, "VETOED_LOOSEN_EXECUTED")).toBe(1);
    expect(await activeHalt(live.db.$client)).toBeNull();
  });

  it("refuses to approve a stage release whose gate is not met on-chain", async () => {
    const e = await create({ kind: "RELEASE_STAGE", payload: { stageId: "stage-2" }, reason: "Sales are coming" });
    expect(e.requires).toEqual({ founder: false, lender: true });
    expect((await w.founder.post(`/api/exceptions/${e.exceptionId}/approve`, {})).status).toBe(403);
    const res = await w.officer.post(`/api/exceptions/${e.exceptionId}/approve`, {});
    expect(res.status).toBe(409);
    const err = ApiError.parse(await res.json()).error;
    // G2: approveException declares CapExceeded (the stage-gate mirror), so it is no longer rewritten to CONFLICT.
    expect(err.code).toBe("CapExceeded");
    expect(err.contractError?.name).toBe("CapExceeded");
  });

  it("an executed ADD_PAYEE vendor reads as bound, not platform, and no reserve goes to it or a marketplace payee (run-8 re-check)", async () => {
    const printer = RINA_IDS.packagingPayeeId;
    const e = await create({ kind: "ADD_PAYEE", payload: { lineKey: "PACKAGING", payeeId: printer }, reason: "New box printer" });
    await founderSigns(e.exceptionId);
    await approveAs("officer", e.exceptionId);
    await w.pump();
    await warp(live, 200n);
    await w.pump();
    await w.pump();
    expect((await json(await w.officer.get("/api/exceptions"), z.array(Exception))).find((x) => x.exceptionId === e.exceptionId)?.status).toBe("EXECUTED");
    // _addPayee binds with an unlimited lifetime cap, like a platform binding: only Treasury's static registry makes a
    // payee platform (the classification itself: test/reserve-destination.test.ts). The snapshot reads the bindings of
    // the plan's listed payees only, so the vendor is not listed at all here, and certainly not as platform.
    const { ctx } = await policyWorld(w.deps, { facilityId: w.facilityId, founderId: w.founderId });
    const entries = (id: string) => ctx.payees.filter((p) => p.payeeId === id).map((p) => ({ source: p.source, lineKeys: p.lineKeys }));
    expect(entries(printer).filter((p) => p.source === "platform")).toEqual([]);
    expect(entries(RINA_IDS.adsPayeeId)).toEqual([{ source: "platform", lineKeys: ["ADS"] }]);
    expect(entries(RINA_IDS.taxPayeeId)).toEqual([{ source: "platform", lineKeys: [] }]);
    expect(entries(MEI_IDS.taxPayeeId)).toEqual([]);
    const withdraw = (taxPayeeId: string) => w.founder.post("/api/exceptions", { kind: "WITHDRAW_RESERVE", payload: { taxPayeeId, amountMinor: "1" }, reason: "SST" });
    for (const bad of [printer, RINA_IDS.adsPayeeId, MEI_IDS.adsPayeeId, MEI_IDS.taxPayeeId]) {
      const res = await withdraw(bad);
      expect(res.status, bad).toBe(409);
      expect(ApiError.parse(await res.json()).error, bad).toMatchObject({ code: "CONFLICT", message: expect.stringContaining(RINA_IDS.taxPayeeId) });
    }
    // lhdn-tax passes the destination check; this world's reserve is empty, so the chain's next refusal is the amount.
    const own = await withdraw(RINA_IDS.taxPayeeId);
    expect(own.status).toBe(409);
    expect(ApiError.parse(await own.json()).error.code).toBe("CapExceeded");
  });

  it("opens a balance release only for the inspection evidence recorded on its milestone, the hash the release signs (rcfix H-4)", async () => {
    const q = live.db.$client;
    const recorded = keccak256(toHex("inspection report: 500 units, no defects"));
    await q.query(`insert into suppliers (facility_id, supplier_id, display_name, country, record_json, evidence_tier, source_type) values ($1, 'sup-h4', 'Supplier H4', 'CN', '{}'::jsonb, 'tier3', 'mock')`, [w.facilityId]);
    await q.query(`insert into payees (id, facility_id, kind, display_name, supplier_id, payout_account_hash, status) values ('sup-h4', $1, 'supplier', 'Supplier H4 (test)', 'sup-h4', $2, 'BOUND')`, [
      w.facilityId,
      keccak256(toHex("payout:sup-h4")),
    ]);
    await q.query(`insert into escrow_orders (order_id, facility_id, supplier_id, payee_id, schedule_hash, total_minor) values ('order-h4', $1, 'sup-h4', 'sup-h4', $2, 30000)`, [w.facilityId, keccak256(toHex("schedule:order-h4"))]);
    await q.query(
      `insert into escrow_milestones (order_id, idx, facility_id, amount_minor, funded_minor, released_minor, auto_release) values ('order-h4', 0, $1, 10000, 10000, 10000, true), ('order-h4', 1, $1, 20000, 20000, 0, false)`,
      [w.facilityId],
    );
    const release = (evidenceHash: string) => w.founder.post("/api/exceptions", { kind: "RELEASE_ESCROW_BALANCE", payload: { orderId: "order-h4", idx: 1, evidenceHash }, reason: "Goods arrived" });
    const refused = async (evidenceHash: string, message: string) => {
      const res = await release(evidenceHash);
      expect(res.status).toBe(409);
      expect(ApiError.parse(await res.json()).error).toMatchObject({ code: "CONFLICT", message });
    };
    const opened = async () => (await q.query("select count(*)::int as n from exceptions where facility_id = $1 and kind = 'RELEASE_ESCROW_BALANCE'", [w.facilityId])).rows[0]?.n;
    // No inspection recorded yet: refused in the founder's release's own words.
    await refused(recorded, "Upload the inspection evidence first");
    await q.query("update escrow_milestones set evidence_hash = $2 where facility_id = $1 and order_id = 'order-h4' and idx = 1", [w.facilityId, recorded]);
    // A check code other than the recorded one would be shown to the officer but never signed: refused, nothing stored.
    await refused(keccak256(toHex("a different report")), "The delivery check code does not match the inspection evidence recorded for that milestone");
    expect(await opened()).toBe(0);
    const e = await create({ kind: "RELEASE_ESCROW_BALANCE", payload: { orderId: "order-h4", idx: 1, evidenceHash: recorded }, reason: "Goods arrived" });
    expect(e).toMatchObject({ status: "OPEN", requires: { founder: true, lender: false }, blastRadiusMinor: "20000" });
    expect(await opened()).toBe(1);
  });
});
