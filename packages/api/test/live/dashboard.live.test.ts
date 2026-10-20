/**
 * Task 1.12 dashboard routes on the live API: balances from ONE chain snapshot (pockets, reserve, escrow, agent key,
 * drift), payments newest first with an exclusive cursor, payment + traces, trace windows and autonomy stats. Every
 * body is parsed with the contract schema (the central validator would 502 otherwise). A SECOND facility's rows,
 * written straight to Postgres, never reach any of the six routes (T31): by id → 404, as cursor → 422, lists → absent,
 * counts unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AutonomyStats, Balances, Payment, PlanRecord, TraceEvent } from "@hogee/core";
import { PaymentWithTraces } from "@hogee/api-contract";
import { z } from "zod";
import { dashboardRoutes } from "../../src/routes/dashboard";
import { PAYMENTS_PAGE_SIZE, TRACES_DEFAULT_LIMIT } from "../../src/services/payments-view";
import { appendTrace } from "../../src/services/traces";
import { scriptedAgent, type ScriptedAgent } from "../support/agent";
import { deleteFacility, hex32, insertChainAction, insertCommittedPlan, insertFacility, insertPayment, insertSubmittedSignature } from "../support/dashboard-rows";
import { LIVE, LIVE_TIMEOUT_MS, openLive, type Live } from "../support/live";
import { chatToDraft, json, openAndRegister, signPlan } from "../support/steps";
import { newWorld, type World } from "../support/world";

const SESSION = "01a14202-2800-7000-8000-0000000000d1";
const Payments = z.array(Payment);
const Traces = z.array(TraceEvent);
const MARKER = "OTHER-TENANT-MARKER";

interface Seed {
  readonly id: string;
  readonly createdAt: Date;
  readonly lineKey: string | null;
  readonly state: string;
}

const newestFirst = (a: Seed, b: Seed): number => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
const ids = (ps: readonly { paymentId: string }[]): string[] => ps.map((p) => p.paymentId);
const keyOf = (e: TraceEvent): string => `${e.traceId}#${e.seq}`;

describe.skipIf(!LIVE)("dashboard (live)", { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  let w: World;
  let agent: ScriptedAgent;
  const seeds: Seed[] = [];
  const other = `fac-other-${hex32().slice(2, 10)}`;
  const q = () => live.db.$client;
  const get = async <T>(path: string, schema: { parse(v: unknown): T }): Promise<T> => json(await w.founder.get(path), schema);

  async function allPayments(query = ""): Promise<Payment[]> {
    const out: Payment[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const qs = new URLSearchParams(query);
      if (cursor) qs.set("cursor", cursor);
      const rows = await get(`/api/payments?${qs.toString()}`, Payments);
      expect(rows.length).toBeLessThanOrEqual(PAYMENTS_PAGE_SIZE);
      out.push(...rows);
      if (rows.length < PAYMENTS_PAGE_SIZE) return out;
      cursor = rows.at(-1)?.paymentId;
    }
    throw new Error("pagination did not end");
  }

  beforeAll(async () => {
    live = await openLive();
    agent = scriptedAgent();
    w = await newWorld(live, { agent, routes: dashboardRoutes });
  }, LIVE_TIMEOUT_MS);
  afterAll(async () => {
    if (live) await deleteFacility(q(), other).catch(() => undefined);
    await live?.close();
  });

  it("answers valid empty shapes before the facility or a plan exists", async () => {
    const b = await get("/api/balances", Balances);
    expect(b).toEqual({
      fundedMinor: "0",
      releasedMinor: "0",
      revenueMinor: "0",
      reserveMinor: "0",
      escrowMinor: "0",
      pockets: [],
      agent: { address: `0x${"0".repeat(40)}`, expiresAt: "0", revoked: false },
      paused: false,
      drift: 0,
    });
    expect(await get("/api/payments", Payments)).toEqual([]);
    expect(await get("/api/traces", Traces)).toEqual([]);
    const stats = await get("/api/stats/autonomy", AutonomyStats);
    expect(stats).toMatchObject({ agentTxs: 0, humanSigs: 0, autoPct: 0, escalatedPct: 0, hours: 0, drift: 0 });
  });

  it("after a committed and funded plan, shows the plan's pockets and the agent key from the chain, drift 0", async () => {
    const auth = await openAndRegister(w);
    const draftId = await chatToDraft(w, agent, SESSION);
    await signPlan(w, auth, draftId);
    await json(await w.officer.post("/api/facility/fund", { amountMinor: "500000" }));
    await w.pump();
    const plan = await get("/api/plans/current", PlanRecord);
    const b = await get("/api/balances", Balances);
    expect(b.pockets).toHaveLength(plan.manifest.lines.length);
    for (const line of plan.manifest.lines) {
      expect(b.pockets.find((p) => p.lineKey === line.lineKey)).toEqual({
        lineKey: line.lineKey,
        allocated: line.amountMinor,
        spent: "0",
        available: line.amountMinor,
        perTxCap: line.perTxCapMinor,
        windowCap: line.windowCapMinor,
        windowSpent: "0",
        validUntil: line.validUntil,
        paused: false,
        circuitOpen: false,
      });
    }
    expect(b.fundedMinor).toBe("500000");
    expect(b.agent.address).toBe(w.signers.agent.address.toLowerCase());
    expect(BigInt(b.agent.expiresAt)).toBeGreaterThan(0n);
    expect(b.agent.revoked).toBe(false);
    expect(b.paused).toBe(false);
    expect(b.drift).toBe(0);
    expect((await w.officer.get("/api/balances")).status).toBe(200);
  });

  it("lists payments newest first, a bounded page at a time, with an exclusive cursor and filters", async () => {
    const base = Date.now() - 3_600_000;
    const n = PAYMENTS_PAGE_SIZE + 7;
    for (let i = 0; i < n; i += 1) {
      // Rows 10 and 11 share a timestamp: the id breaks the tie.
      const createdAt = new Date(base + (i === 11 ? 10 : i) * 1000);
      const lineKey = i % 9 === 0 ? "PLATFORM_FEES" : "ADS";
      const state = i % 4 === 0 ? "POLICY_DENIED" : "PROPOSED";
      seeds.push({ id: await insertPayment(q(), w.facilityId, { lineKey, state, createdAt, amountMinor: String(1000 + i) }), createdAt, lineKey, state });
    }
    const ownerAt = new Date(base + 200_000);
    seeds.push({ id: await insertPayment(q(), w.facilityId, { kind: "OWNER_SPEND", createdAt: ownerAt }), createdAt: ownerAt, lineKey: "ADS", state: "PROPOSED" });
    const reserveAt = new Date(base + 201_000);
    seeds.push({ id: await insertPayment(q(), w.facilityId, { kind: "WITHDRAW_RESERVE", createdAt: reserveAt }), createdAt: reserveAt, lineKey: null, state: "PROPOSED" });
    const expected = [...seeds].sort(newestFirst).map((s) => s.id);

    const page1 = await get("/api/payments", Payments);
    expect(ids(page1)).toEqual(expected.slice(0, PAYMENTS_PAGE_SIZE));
    const last = page1.at(-1)?.paymentId as string;
    const page2 = await get(`/api/payments?cursor=${last}`, Payments);
    expect(ids(page2)).toEqual(expected.slice(PAYMENTS_PAGE_SIZE));
    expect(ids(page2)).not.toContain(last);
    const everything = await allPayments();
    expect(ids(everything)).toEqual(expected);
    const mid = expected[20] as string;
    expect(ids(await get(`/api/payments?cursor=${mid}`, Payments))).toEqual(expected.slice(21, 21 + PAYMENTS_PAGE_SIZE));

    const want = (f: (s: Seed) => boolean) => [...seeds].filter(f).sort(newestFirst).map((s) => s.id);
    expect(ids(await allPayments("state=POLICY_DENIED"))).toEqual(want((s) => s.state === "POLICY_DENIED"));
    expect(ids(await allPayments("lineKey=PLATFORM_FEES"))).toEqual(want((s) => s.lineKey === "PLATFORM_FEES"));
    expect(ids(await allPayments("state=POLICY_DENIED&lineKey=PLATFORM_FEES"))).toEqual(want((s) => s.state === "POLICY_DENIED" && s.lineKey === "PLATFORM_FEES"));

    const reserve = page1.find((p) => p.kind === "WITHDRAW_RESERVE");
    expect(reserve).toMatchObject({ lineKey: null, decisionId: null, rationaleHash: null, payout: { attempt: 0, status: "NONE" } });
    expect(page1.find((p) => p.kind === "OWNER_SPEND")?.decisionId).toBeNull();
    const spend = everything.find((p) => p.paymentId === seeds[3]?.id);
    expect(spend).toMatchObject({ kind: "SPEND", lineKey: "ADS", amountMinor: "1003", state: "PROPOSED", traceId: `trace:${seeds[3]?.id}`, planVersion: 1 });
    expect(spend?.updatedAt).toBe(seeds[3]?.createdAt.toISOString());

    expect((await w.founder.get("/api/payments?cursor=pay-missing")).status).toBe(422);
    expect((await w.founder.get("/api/payments?state=NOPE")).status).toBe(422);
    expect((await w.founder.get("/api/payments?lineKey=ads")).status).toBe(422);
  });

  it("returns a payment with its own trace and the events that reference it; NOT_FOUND otherwise", async () => {
    const id = seeds[3]?.id as string;
    const traceId = `trace:${id}`;
    const payoutTrace = `trace-payout-${hex32().slice(2, 10)}`;
    await appendTrace(live.db, { facilityId: w.facilityId, traceId, actor: "worker", kind: "TX", summary: "Spend broadcast (test)", refs: { paymentId: id } });
    await appendTrace(live.db, { facilityId: w.facilityId, traceId, actor: "worker", kind: "TX", summary: "Spend included (test)" });
    await appendTrace(live.db, { facilityId: w.facilityId, traceId: payoutTrace, actor: "worker", kind: "PAYOUT", summary: "Payout requested (test)", refs: { paymentId: id } });
    const p = await get(`/api/payments/${id}`, PaymentWithTraces);
    expect(p.paymentId).toBe(id);
    expect(p.amountMinor).toBe("1003");
    expect(new Set(p.traces.map(keyOf))).toEqual(new Set([`${traceId}#0`, `${traceId}#1`, `${payoutTrace}#0`]));
    expect(p.traces).toHaveLength(3);
    const empty = await get(`/api/payments/${seeds[4]?.id}`, PaymentWithTraces);
    expect(empty.traces).toEqual([]);
    expect((await w.founder.get("/api/payments/pay-missing")).status).toBe(404);
  });

  it("lists traces in time order: the latest `limit`, or the events after `since` (exclusive)", async () => {
    const all = await get("/api/traces?limit=500", Traces);
    expect(all.length).toBeGreaterThan(6);
    expect(all.length).toBeLessThan(500);
    for (let i = 1; i < all.length; i += 1) expect((all[i - 1] as TraceEvent).ts <= (all[i] as TraceEvent).ts).toBe(true);
    expect(await get("/api/traces?limit=5", Traces)).toEqual(all.slice(-5));
    expect(await get("/api/traces", Traces)).toEqual(all.slice(-TRACES_DEFAULT_LIMIT));
    const pivot = all[2] as TraceEvent;
    const after = await get(`/api/traces?since=${encodeURIComponent(pivot.ts)}&limit=500`, Traces);
    expect(after).toEqual(all.filter((e) => e.ts > pivot.ts));
    const firstTwo = await get(`/api/traces?since=${encodeURIComponent("2000-01-01T00:00:00Z")}&limit=2`, Traces);
    expect(firstTwo).toEqual(all.slice(0, 2));
    for (const bad of ["limit=0", "limit=501", "limit=abc", "since=yesterday"]) expect((await w.founder.get(`/api/traces?${bad}`)).status).toBe(422);
  });

  it("returns every event of one trace in seq order; NOT_FOUND for an unknown trace", async () => {
    const traceId = `trace:${seeds[3]?.id}`;
    const events = await get(`/api/traces/${encodeURIComponent(traceId)}`, Traces);
    expect(events.map((e) => e.seq)).toEqual([0, 1]);
    expect(events[1]?.prevHash).toBe(events[0]?.hash);
    expect((await w.founder.get("/api/traces/trace-missing")).status).toBe(404);
  });

  it("computes autonomy stats from this facility's rows", async () => {
    const verdicts: (readonly ("AUTO" | "NEEDS_FOUNDER" | "NEEDS_OFFICER" | "DENY")[])[] = [["AUTO"], ["AUTO"], ["AUTO"], ["NEEDS_FOUNDER", "AUTO"], ["DENY"]];
    for (const seq of verdicts) {
      const traceId = `trace-verdict-${hex32().slice(2, 10)}`;
      for (const verdict of seq) await appendTrace(live.db, { facilityId: w.facilityId, traceId, actor: "policy", kind: "POLICY_VERDICT", verdict, reasonCode: "WITHIN_PLAN", summary: `Verdict ${verdict} (test)` });
    }
    const signedAt = (await q().query("select signed_at from plans where facility_id = $1 and status = 'COMMITTED'", [w.facilityId])).rows[0]?.signed_at as Date;
    const s = await get("/api/stats/autonomy", AutonomyStats);
    // Human signatures: officer openFacility + founder key approval + the founder's PlanApproval + officer fund.
    expect(s).toMatchObject({ agentTxs: 0, humanSigs: 4, autoPct: 75, escalatedPct: 25, startedAt: new Date(signedAt).toISOString(), drift: 0 });
    expect(s.hours).toBeGreaterThanOrEqual(0);
    expect(s.hours).toBeLessThan(1);
  });

  it("counts drift when the DB mirror disagrees with the chain", async () => {
    const block = await live.client.getBlockNumber({ cacheTime: 0 });
    const ghost = await insertPayment(q(), w.facilityId, { state: "INCLUDED", block, lineKey: "ADS" });
    try {
      expect((await get("/api/balances", Balances)).drift).toBe(1);
      expect(await get("/api/stats/autonomy", AutonomyStats)).toMatchObject({ drift: 1, agentTxs: 1 });
    } finally {
      await q().query("delete from payments where facility_id = $1 and id = $2", [w.facilityId, ghost]);
    }
    const plan = (await q().query("select id, plan_hash from plans where facility_id = $1 and status = 'COMMITTED'", [w.facilityId])).rows[0] as { id: string; plan_hash: string };
    await q().query("update plans set plan_hash = $3 where facility_id = $1 and id = $2", [w.facilityId, plan.id, hex32()]);
    try {
      expect((await get("/api/balances", Balances)).drift).toBe(1);
    } finally {
      await q().query("update plans set plan_hash = $3 where facility_id = $1 and id = $2", [w.facilityId, plan.id, plan.plan_hash]);
    }
    expect((await get("/api/balances", Balances)).drift).toBe(0);
  });

  it("never lets another facility's rows, ids or counts through any of the six routes (T31)", async () => {
    const shared = seeds[3]?.id as string;
    const sharedTrace = `trace:${shared}`;
    const before = {
      balances: await get("/api/balances", Balances),
      stats: await get("/api/stats/autonomy", AutonomyStats),
      payments: ids(await allPayments()),
      payment: await get(`/api/payments/${shared}`, PaymentWithTraces),
      traces: await get("/api/traces?limit=500", Traces),
      trace: await get(`/api/traces/${encodeURIComponent(sharedTrace)}`, Traces),
    };
    const missingPayment = await (await w.founder.get("/api/payments/pay-never-existed")).json();
    const missingCursor = await (await w.founder.get("/api/payments?cursor=pay-never-existed")).json();
    const missingTrace = await (await w.founder.get("/api/traces/trace-never-existed")).json();

    // The other tenant: same deployment, a payment with the SAME id as ours, its own payments (one mined on ADS),
    // traces under our trace id and its own, verdicts, officer actions, a founder signature and an older plan.
    await insertFacility(q(), other, w.deployment.deploymentId);
    const block = await live.client.getBlockNumber({ cacheTime: 0 });
    await insertPayment(q(), other, { id: shared, amountMinor: "999999", createdAt: new Date() });
    const otherOnly = await insertPayment(q(), other, { createdAt: new Date(Date.now() + 60_000) });
    await insertPayment(q(), other, { state: "INCLUDED", block, lineKey: "ADS", amountMinor: "7500" });
    const otherTrace = `trace-other-${hex32().slice(2, 10)}`;
    await appendTrace(live.db, { facilityId: other, traceId: sharedTrace, actor: "worker", kind: "TX", summary: `${MARKER} same trace id`, refs: { paymentId: shared } });
    for (let i = 0; i < 4; i += 1) {
      await appendTrace(live.db, { facilityId: other, traceId: `${otherTrace}-${i}`, actor: "policy", kind: "POLICY_VERDICT", verdict: "AUTO", reasonCode: "WITHIN_PLAN", summary: `${MARKER} verdict` });
    }
    await insertChainAction(q(), other, "Treasury.openFacility");
    await insertChainAction(q(), other, "Treasury.fund");
    await insertSubmittedSignature(q(), other);
    await insertCommittedPlan(q(), other, new Date("2020-01-01T00:00:00Z"));

    expect(await get("/api/balances", Balances)).toEqual(before.balances);
    const { hours: _h1, ...statsBefore } = before.stats;
    const { hours: _h2, ...statsAfter } = await get("/api/stats/autonomy", AutonomyStats);
    expect(statsAfter).toEqual(statsBefore);
    expect(ids(await allPayments())).toEqual(before.payments);
    expect(ids(await allPayments())).not.toContain(otherOnly);
    expect(await get(`/api/payments/${shared}`, PaymentWithTraces)).toEqual(before.payment);
    const otherRes = await w.founder.get(`/api/payments/${otherOnly}`);
    expect(otherRes.status).toBe(404);
    expect(await otherRes.json()).toEqual(missingPayment);
    const cursorRes = await w.founder.get(`/api/payments?cursor=${otherOnly}`);
    expect(cursorRes.status).toBe(422);
    expect(await cursorRes.json()).toEqual(missingCursor);
    const traces = await get("/api/traces?limit=500", Traces);
    expect(traces).toEqual(before.traces);
    expect(JSON.stringify(await get(`/api/traces?since=${encodeURIComponent("2000-01-01T00:00:00Z")}&limit=500`, Traces))).not.toContain(MARKER);
    expect(await get(`/api/traces/${encodeURIComponent(sharedTrace)}`, Traces)).toEqual(before.trace);
    const traceRes = await w.founder.get(`/api/traces/${encodeURIComponent(`${otherTrace}-0`)}`);
    expect(traceRes.status).toBe(404);
    expect(await traceRes.json()).toEqual(missingTrace);
  });
});
