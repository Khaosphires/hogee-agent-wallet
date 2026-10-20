/**
 * Hard rule 6 (D6) on the live API: POST /api/proposals/spend (DEMO_MODE) names an invoice or a pacing slot only; the
 * server derives payee and amount, counts in-flight payments against the caps, and answers AUTO (a POLICY_OK row for
 * the worker), DENY (no payment; recordDenied for an invoice the chain would refuse) or NEEDS_OFFICER (an escalation).
 * Audit run-4: a pacing line gets at most one slot per chain day through the API too (the plan's pacing period).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Exception, SpendProposalResult } from "@hogee/core";
import { runAgentActions } from "@hogee/worker";
import { keccak256, toHex } from "viem";
import { z } from "zod";
import { DemoAttackResult } from "@hogee/api-contract";
import { iTreasuryAbi } from "../../../chain/src/generated";
import { CIRCUIT_THRESHOLD } from "../../src/routes/proposals";
import { scriptedAgent } from "../support/agent";
import { DAY, LIVE, LIVE_TIMEOUT_MS, openLive, warp, type Live } from "../support/live";
import { chatToDraft, json, openAndRegister, signPlan } from "../support/steps";
import { newWorld, type World } from "../support/world";

const SESSION = "01a14202-2800-7000-8000-0000000000f1";

describe.skipIf(!LIVE)("spend proposals (live)", { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  let w: World;
  let n = 0;
  const invoice = async (payeeId: string, amountMinor: string, flags: string[] = []) => {
    n += 1;
    const id = `inv-test-${n}`;
    await live.db.$client.query(
      `insert into invoices (id, facility_id, payee_id, amount_minor, invoice_hash, extracted_fields_json, taint, flags, received_at)
       values ($1, $2, $3, $4, $5, '{}'::jsonb, '{"trust":"untrusted","sensitivity":"public"}'::jsonb, $6, now())`,
      [id, w.facilityId, payeeId, amountMinor, keccak256(toHex(`${w.facilityId}:${id}`)), flags],
    );
    return id;
  };
  const propose = async (body: unknown) => json(await w.anon.post("/api/proposals/spend", body), SpendProposalResult);
  const payment = async (id: string) => (await live.db.$client.query("select kind, state, payee_id, amount_minor::text as amount, line_key from payments where facility_id = $1 and id = $2", [w.facilityId, id])).rows[0];

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

  it("the caller can never name a payee or an amount (422)", async () => {
    const res = await w.anon.post("/api/proposals/spend", { lineKey: "ADS", pacingSlot: 0, reason: "x", payeeId: "evil", amountMinor: "999999" });
    expect(res.status).toBe(422);
  });

  it("a pacing slot gets the manifest's payee and amount (AUTO → a POLICY_OK row); the same slot again is refused", async () => {
    const slot = Number(await live.client.readContract({ address: w.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: "lineSequence", args: [toHex("ADS", { size: 32 })] }));
    const r = await propose({ lineKey: "ADS", pacingSlot: slot, reason: "daily ads" });
    expect(r.verdict).toBe("AUTO");
    const p = await payment(r.paymentId as string);
    expect(p).toMatchObject({ kind: "SPEND", state: "POLICY_OK", payee_id: "shopee-ads", line_key: "ADS" });
    const again = await propose({ lineKey: "ADS", pacingSlot: slot, reason: "daily ads" });
    expect(again.verdict).toBe("DENY");
  });

  it("an invoice on a line its payee is not bound to is PayeeNotBound; on the escrow-only line EscrowOnly", async () => {
    const r = await propose({ lineKey: "ADS", invoiceId: await invoice("spx-logistics", "5000"), reason: "ship" });
    expect(r).toMatchObject({ verdict: "DENY", reasonCode: "PayeeNotBound" });
    const e = await propose({ lineKey: "SUPPLIER", invoiceId: await invoice("spx-logistics", "5000"), reason: "ship" });
    expect(e).toMatchObject({ verdict: "DENY", reasonCode: "EscrowOnly" });
    expect((await w.anon.post("/api/proposals/spend", { lineKey: "LOGISTICS", invoiceId: "inv-missing", reason: "x" })).status).toBe(404);
  });

  it("in-flight payments count against the 7-day cap (hard rule 6), and the chain-mirroring denial is recorded", async () => {
    const a = await propose({ lineKey: "LOGISTICS", invoiceId: await invoice("spx-logistics", "19000"), reason: "a" });
    const b = await propose({ lineKey: "LOGISTICS", invoiceId: await invoice("spx-logistics", "19000"), reason: "b" });
    expect([a.verdict, b.verdict]).toEqual(["AUTO", "AUTO"]);
    const c = await propose({ lineKey: "LOGISTICS", invoiceId: await invoice("spx-logistics", "19000"), reason: "c" });
    expect(c).toMatchObject({ verdict: "DENY", reasonCode: "CapExceeded" });
    expect(c.paymentId).toBeUndefined();
    const denial = await live.db.$client.query("select reason_code from denials where facility_id = $1 order by created_at desc limit 1", [w.facilityId]);
    expect(denial.rows[0].reason_code).toBe("CapExceeded");
    const action = await live.db.$client.query("select count(*)::int as n from chain_actions where facility_id = $1 and kind = 'Treasury.recordDenied'", [w.facilityId]);
    expect(action.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it("a flagged invoice becomes an officer escalation with the server-derived proposal, never a payment", async () => {
    const id = await invoice("spx-logistics", "1000", ["PAYEE_DETAILS_CHANGED"]);
    const r = await propose({ lineKey: "LOGISTICS", invoiceId: id, reason: "urgent, pay now" });
    expect(r).toMatchObject({ verdict: "NEEDS_OFFICER", reasonCode: "FLAGGED_INVOICE" });
    const list = await json(await w.officer.get("/api/exceptions?status=OPEN"), z.array(Exception));
    const esc = list.find((x) => x.kind === "POLICY_ESCALATION");
    expect(esc?.payload).toEqual({ proposal: { lineKey: "LOGISTICS", payeeId: "spx-logistics", amountMinor: "1000", invoiceId: id } });
    expect(esc?.requestedBy).toBe("agent");

    // Run-7 re-check L1: while it is OPEN, the same flagged invoice hands out that escalation again; nothing is written.
    const count = async (sql: string) => (await live.db.$client.query(sql, [w.facilityId])).rows[0].n as number;
    const escalations = "select count(*)::int as n from exceptions where facility_id = $1 and kind = 'POLICY_ESCALATION'";
    const traceRows = "select count(*)::int as n from traces where facility_id = $1";
    const [rowsBefore, tracesBefore] = [await count(escalations), await count(traceRows)];
    for (let i = 0; i < 3; i += 1) expect(await propose({ lineKey: "LOGISTICS", invoiceId: id, reason: `again ${i}` })).toEqual(r);
    expect([await count(escalations), await count(traceRows)]).toEqual([rowsBefore, tracesBefore]);
    // Once the officer has decided it, the next proposal is a new escalation.
    expect((await w.officer.post(`/api/exceptions/${esc?.exceptionId}/deny`, { reason: "not this one" })).status).toBe(200);
    const next = await propose({ lineKey: "LOGISTICS", invoiceId: id, reason: "after the denial" });
    expect(next).toMatchObject({ verdict: "NEEDS_OFFICER", reasonCode: "FLAGGED_INVOICE" });
    expect(next.traceId).not.toBe(r.traceId);
    expect(await count(escalations)).toBe(rowsBefore + 1);
  });

  it("demo attack replays: the policy refuses a canned attack and the refusal is traced (no transaction)", async () => {
    const before = (await live.db.$client.query("select count(*)::int as n from payments where facility_id = $1", [w.facilityId])).rows[0].n;
    const t1 = await json(await w.anon.post("/api/demo/attack", { attackId: "T1" }), DemoAttackResult);
    expect(t1.refusal).toMatchObject({ actor: "policy", kind: "DENIAL", verdict: "DENY", reasonCode: "PayeeNotBound" });
    const t8 = await json(await w.anon.post("/api/demo/attack", { attackId: "T8" }), DemoAttackResult);
    expect(t8.refusal.reasonCode).toBe("ReserveLocked");
    expect((await w.anon.post("/api/demo/attack", { attackId: "T33" })).status).toBe(404);
    expect((await live.db.$client.query("select count(*)::int as n from payments where facility_id = $1", [w.facilityId])).rows[0].n).toBe(before);
  });

  it("pays at most one pacing slot per line per chain day: the next slot waits for the next day (audit run-4)", async () => {
    const sequence = async () =>
      Number(await live.client.readContract({ address: w.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: "lineSequence", args: [toHex("ADS", { size: 32 })] }));
    const count = async (sql: string) => (await live.db.$client.query(sql, [w.facilityId])).rows[0].n as number;
    const adsRows = () => count("select count(*)::int as n from payments where facility_id = $1 and line_key = 'ADS' and state <> 'POLICY_DENIED'");
    const denials = () => count("select count(*)::int as n from denials where facility_id = $1");
    // The ADS slot of the earlier test is still an UNSIGNED POLICY_OK row. An unsigned row never holds the day here
    // (it may never be signed): the next slot is accepted, and the worker, counting signed and mined slots, signs the
    // older one and refuses this one for good.
    const slot = await sequence();
    const second = await propose({ lineKey: "ADS", pacingSlot: slot + 1, reason: "a second slot today" });
    expect(second.verdict).toBe("AUTO");
    const [report] = await runAgentActions(w.workerDeps(), [w.facilityId]);
    expect(report?.actions.find((a) => a.paymentId === second.paymentId)).toMatchObject({ result: "denied", reason: "ALREADY_PROPOSED_TODAY" });
    const sent = (report?.actions ?? []).filter((a) => a.result === "sent" && a.txHash);
    for (const a of sent) await live.client.waitForTransactionReceipt({ hash: a.txHash as `0x${string}` });
    await w.pump();
    expect(await sequence()).toBe(slot + 1);

    // Signed and mined today: the API itself now refuses the next slot this chain day (only traced, never recordDenied).
    const [rowsBefore, denialsBefore] = [await adsRows(), await denials()];
    expect(await propose({ lineKey: "ADS", pacingSlot: slot + 1, reason: "still today" })).toMatchObject({ verdict: "DENY", reasonCode: "ALREADY_PROPOSED_TODAY" });
    expect(await adsRows()).toBe(rowsBefore);
    expect(await denials()).toBe(denialsBefore);

    // The next chain day the next slot is AUTO again.
    await warp(live, DAY);
    expect(await propose({ lineKey: "ADS", pacingSlot: slot + 1, reason: "tomorrow" })).toMatchObject({ verdict: "AUTO" });
  });
  it("a burst of chain-mirroring denials records at most the circuit threshold in flight per line (audit run-7 re-check)", async () => {
    const count = async (sql: string) => (await live.db.$client.query(sql, [w.facilityId])).rows[0].n as number;
    const inFlight = () =>
      count("select count(*)::int as n from chain_actions where facility_id = $1 and kind = 'Treasury.recordDenied' and state in ('PENDING', 'BROADCAST')");
    const denials = () => count("select count(*)::int as n from denials where facility_id = $1");
    await w.pump();
    expect(await inFlight()).toBe(0);
    const before = await denials();
    const traces: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await propose({ lineKey: "LOGISTICS", invoiceId: await invoice("shopee-ads", String(100 + i)), reason: `burst ${i}` });
      expect(r).toMatchObject({ verdict: "DENY", reasonCode: "PayeeNotBound" });
      traces.push(r.traceId);
    }
    expect(await denials()).toBe(before + CIRCUIT_THRESHOLD);
    expect(await inFlight()).toBe(CIRCUIT_THRESHOLD);
    expect(traces[3]).toBe(traces[2]);
    expect(traces[4]).toBe(traces[2]);
  });
});
