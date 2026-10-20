/**
 * Audit run-7 (api:founder-persona-trace-writers-unbounded) on Postgres + Anvil, through the live API WITHOUT a cookie
 * (the anonymous founder persona). N repeated calls leave the facility's trace count bounded:
 *   - inspection upload: a re-upload of the stored report writes nothing; a new report is always stored (re-check M1:
 *     never CONFLICT), and a milestone's trace takes MAX_UPLOADS_PER_MILESTONE upload events plus one final one;
 *   - shortlist: an identical spec within the window is handed out again; a new spec is never refused (re-check M2):
 *     past MAX_OPEN_SHORTLISTS open shortlists the oldest are superseded; concurrent starts of one spec run the checks
 *     once (re-check L3);
 *   - exception: the same OPEN request is handed out again; at most MAX_OPEN_FOUNDER_EXCEPTIONS are OPEN;
 *   - listExceptions lists OPEN rows first, then the newest others, LIST_EXCEPTIONS_LIMIT in all; past the limit the
 *     newest OPEN rows go first, the oldest waiting request last (re-check L1).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError, ChainAction, Exception, MAX_QUEUED_LOOSENS, SignatureRequestResponse, exampleShortlistSpec, type ShortlistSpec } from "@hogee/core";
import { keccak256 } from "viem";
import { z } from "zod";
import { iTreasuryAbi } from "../../../chain/src/generated";
import type { ApiDeps } from "../../src/context";
import { LIST_EXCEPTIONS_LIMIT, MAX_OPEN_FOUNDER_EXCEPTIONS, MAX_OPEN_SHORTLISTS, MAX_UPLOADS_PER_MILESTONE, SUPERSEDED_REASON } from "../../src/services/writer-bounds";
import { scriptedAgent } from "../support/agent";
import type { SoftAuthenticator } from "../support/authenticator";
import { LIVE, LIVE_TIMEOUT_MS, openLive, type Live } from "../support/live";
import { b64uToBytes, chatToDraft, json, openAndRegister, signPlan } from "../support/steps";
import { newWorld, type World } from "../support/world";

const SESSION = "01a14202-2800-7000-8000-0000000007b0";
const RequestId = z.object({ requestId: z.string() });

describe.skipIf(!LIVE)("run-7 bounds: founder-persona writers (live)", { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  let w: World;
  let auth: SoftAuthenticator;
  const n = async (sql: string, values: unknown[] = []) => ((await live.db.$client.query<{ n: number }>(sql, values)).rows[0]?.n ?? -1) as number;
  const traces = () => n("select count(*)::int as n from traces where facility_id = $1", [w.facilityId]);
  const codeOf = async (res: Response) => ApiError.parse(await res.json()).error.code;

  beforeAll(async () => {
    live = await openLive();
    const agent = scriptedAgent();
    w = await newWorld(live, { agent });
    auth = await openAndRegister(w);
    await signPlan(w, auth, await chatToDraft(w, agent, SESSION));
  }, LIVE_TIMEOUT_MS);
  afterAll(async () => {
    await live?.close();
  });

  it(`inspection: a re-upload of the stored report writes nothing; a new report is always stored, ${MAX_UPLOADS_PER_MILESTONE} + 1 trace events at most`, async () => {
    // Supplier A approved (order-a-001): its milestone 2 needs the founder's release, so it waits for evidence.
    await json(await w.founder.post("/api/suppliers/shortlist", { spec: exampleShortlistSpec }), RequestId);
    const req = await json(await w.founder.post("/api/signatures/request", { kind: "SupplierApproval", refId: "order-a-001", method: "passkey" }), SignatureRequestResponse);
    await json(await w.founder.post(`/api/signatures/${req.requestId}/submit`, { passkey: auth.assert(b64uToBytes(req.challengeB64url)) }), ChainAction);
    await w.pump();
    const upload = (text: string, headers: Record<string, string> = {}) => {
      const f = new FormData();
      f.append("file", new Blob([new TextEncoder().encode(text)], { type: "application/pdf" }), "inspection.pdf");
      return w.app.request("/api/escrow/order-a-001/inspection", { method: "POST", headers, body: f });
    };
    const hashOf = (text: string) => keccak256(new TextEncoder().encode(text));
    const stored = async () => (await live.db.$client.query("select evidence_hash from escrow_milestones where facility_id = $1 and order_id = 'order-a-001' and idx = 2", [w.facilityId])).rows[0]?.evidence_hash;
    const uploads = () => n("select count(*)::int as n from traces where facility_id = $1 and trace_id = 'inspection:order-a-001:2'", [w.facilityId]);

    expect((await upload("report 1")).status).toBe(200);
    const before = await traces();
    for (let i = 0; i < 5; i += 1) expect((await upload("report 1")).status).toBe(200);
    expect(await traces()).toBe(before);
    expect(await uploads()).toBe(1);

    for (let i = 2; i <= MAX_UPLOADS_PER_MILESTONE; i += 1) expect((await upload(`report ${i}`)).status).toBe(200);
    expect(await uploads()).toBe(MAX_UPLOADS_PER_MILESTONE);
    expect(await stored()).toBe(hashOf(`report ${MAX_UPLOADS_PER_MILESTONE}`));

    // Re-check M1: past the cap a new report is still stored (never CONFLICT); one final event says later ones are not traced.
    expect((await upload("one report past the cap")).status).toBe(200);
    expect(await stored()).toBe(hashOf("one report past the cap"));
    expect(await uploads()).toBe(MAX_UPLOADS_PER_MILESTONE + 1);
    const [lastEvent] = (await live.db.$client.query<{ summary: string }>("select summary from traces where facility_id = $1 and trace_id = 'inspection:order-a-001:2' order by seq desc limit 1", [w.facilityId])).rows;
    expect(lastEvent?.summary).toMatch(/not traced/);
    for (let i = 0; i < 3; i += 1) {
      expect((await upload(`flood ${i}`)).status).toBe(200);
      expect(await stored()).toBe(hashOf(`flood ${i}`));
    }
    expect(await uploads()).toBe(MAX_UPLOADS_PER_MILESTONE + 1);

    // The founder's own report after the anonymous flood is the one the MilestoneRelease signs (it reads this hash).
    const founder = { cookie: w.cookie("founder:rina") };
    expect((await upload("the founder's inspection report", founder)).status).toBe(200);
    expect(await stored()).toBe(hashOf("the founder's inspection report"));
    expect((await upload("the founder's inspection report", founder)).status).toBe(200);
    expect(await uploads()).toBe(MAX_UPLOADS_PER_MILESTONE + 1);
    expect(await traces()).toBe(before + MAX_UPLOADS_PER_MILESTONE);
  });

  it(`shortlist: an identical spec is handed out again; a new spec is never refused, past ${MAX_OPEN_SHORTLISTS} open the oldest are superseded`, async () => {
    const start = (spec: ShortlistSpec) => w.anon.post("/api/suppliers/shortlist", { spec });
    const shortlists = () => n("select count(*)::int as n from shortlists where facility_id = $1", [w.facilityId]);
    const openShortlists = () => n("select count(*)::int as n from shortlists where facility_id = $1 and status in ('PENDING', 'READY')", [w.facilityId]);
    const first = (await json(await start(exampleShortlistSpec), RequestId)).requestId;
    const [rowsBefore, before] = [await shortlists(), await traces()];
    const made: string[] = [];
    for (let i = 0; i < 5; i += 1) expect((await json(await start(exampleShortlistSpec), RequestId)).requestId).toBe(first);
    expect([await shortlists(), await traces()]).toEqual([rowsBefore, before]);

    // Re-check L3: concurrent starts of one new spec run the checks once (one catalog read) and all get one shortlist.
    const spec = (i: number): ShortlistSpec => ({ ...exampleShortlistSpec, budgetMinor: String(500_001 + i) });
    const deps = w.deps as { catalog: ApiDeps["catalog"] };
    const catalog = deps.catalog;
    let computed = 0;
    deps.catalog = { ...catalog, suppliers: async () => ((computed += 1), catalog.suppliers()) };
    try {
      const concurrent = await Promise.all(Array.from({ length: 6 }, async () => (await json(await start(spec(0)), RequestId)).requestId));
      expect(new Set(concurrent).size).toBe(1);
      expect(computed).toBe(1);
      made.push(concurrent[0] as string);
    } finally {
      deps.catalog = catalog;
    }
    expect(await shortlists()).toBe(rowsBefore + 1);

    // Re-check M2: twice the old cap of new specs, none refused; the open set stays at MAX_OPEN_SHORTLISTS.
    for (let i = 1; i < 2 * MAX_OPEN_SHORTLISTS; i += 1) {
      const res = await start(spec(i));
      expect(res.status, `spec ${i}`).toBe(200);
      made.push((await json(res, RequestId)).requestId);
    }
    expect(await shortlists()).toBe(rowsBefore + 2 * MAX_OPEN_SHORTLISTS);
    expect(await traces()).toBe(before + 2 * MAX_OPEN_SHORTLISTS);
    expect(await openShortlists()).toBe(MAX_OPEN_SHORTLISTS);
    // The oldest are superseded (FAILED with their reason); the newest is READY.
    const oldest = await json(await w.anon.get(`/api/suppliers/shortlist/${first}`), z.object({ status: z.string(), failureReason: z.string().nullable() }));
    expect(oldest).toEqual({ ...oldest, status: "FAILED", failureReason: SUPERSEDED_REASON });
    const newest = await json(await w.anon.get(`/api/suppliers/shortlist/${made.at(-1)}`), z.object({ status: z.string() }));
    expect(newest.status).toBe("READY");
    // A superseded spec is shortlisted afresh; the newest open one is still handed out again.
    expect((await json(await start(exampleShortlistSpec), RequestId)).requestId).not.toBe(first);
    expect((await json(await start(spec(2 * MAX_OPEN_SHORTLISTS - 1)), RequestId)).requestId).toBe(made.at(-1));
  });

  it(`exception: the same OPEN request is handed out again; at most ${MAX_OPEN_FOUNDER_EXCEPTIONS} are OPEN`, async () => {
    const create = (body: unknown) => w.anon.post("/api/exceptions", body);
    const unpause = (reason: string) => ({ kind: "UNPAUSE", payload: {}, reason });
    const first = await json(await create(unpause("x")), Exception);
    const before = await traces();
    for (let i = 0; i < 5; i += 1) expect((await json(await create(unpause(`again ${i}`)), Exception)).exceptionId).toBe(first.exceptionId);
    expect(await traces()).toBe(before);

    const agentExpiry = await live.client.readContract({ address: w.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: "agentExpiry" });
    const extend = (days: number) => ({ kind: "EXTEND_EXPIRY", payload: { target: "agent", newExpiresAt: (agentExpiry + BigInt(days) * 86_400n).toString() }, reason: "later" });
    const open = () => n("select count(*)::int as n from exceptions where facility_id = $1 and requested_by = 'founder' and status = 'OPEN'", [w.facilityId]);
    const start = await open();
    for (let d = 1; d <= MAX_OPEN_FOUNDER_EXCEPTIONS - start; d += 1) expect((await create(extend(d))).status).toBe(200);
    expect(await open()).toBe(MAX_OPEN_FOUNDER_EXCEPTIONS);
    const refused = await create(extend(MAX_OPEN_FOUNDER_EXCEPTIONS + 1));
    expect(refused.status).toBe(409);
    expect(await codeOf(refused)).toBe("CONFLICT");
    // A duplicate of an OPEN one is still handed out at the cap.
    expect((await json(await create(extend(1)), Exception)).status).toBe("OPEN");
    expect(await traces()).toBe(before + MAX_OPEN_FOUNDER_EXCEPTIONS - start);
  });

  it(`a loosening is refused while ${MAX_QUEUED_LOOSENS} are live on-chain (ctx.loosens, verifier run-7)`, async () => {
    const q = live.db.$client;
    const now = (await live.client.getBlock({ blockTag: "latest" })).timestamp;
    const agentExpiry = await live.client.readContract({ address: w.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: "agentExpiry" });
    // Mirrors of queued loosenings, as the worker's sync leaves them (QUEUED / EXECUTABLE with a loosenId).
    await q.query(
      `insert into exceptions (id, facility_id, kind, title, payload, requested_by, requires_founder, requires_lender, status, blast_radius_minor, trace_id, loosen_id, executable_at)
       select 'exc-run7-queued-' || g, $1, 'EXTEND_EXPIRY', 'Extend the agent''s authority', jsonb_build_object('target', 'agent', 'newExpiresAt', ($2::numeric + g * 3600)::text),
              'founder', true, true, case when g % 2 = 0 then 'QUEUED' else 'EXECUTABLE' end::exception_status, 0, 'trace-run7-queued-' || g,
              '0x' || lpad(to_hex(g), 64, '0'), $3::numeric
         from generate_series(1, $4::int) g`,
      [w.facilityId, agentExpiry.toString(), (now + 100n).toString(), MAX_QUEUED_LOOSENS],
    );
    const extend = { kind: "EXTEND_EXPIRY", payload: { target: "agent", newExpiresAt: (agentExpiry + 7n * 3600n).toString() }, reason: "one more" };
    const full = await w.anon.post("/api/exceptions", extend);
    expect(full.status).toBe(409);
    expect(await codeOf(full)).toBe("CapExceeded");
    // Past their grace end they are no longer live: the create gets as far as the OPEN cap again.
    await q.query("update exceptions set executable_at = $2 where facility_id = $1 and id like 'exc-run7-queued-%'", [w.facilityId, (now - 8n * 86_400n).toString()]);
    const open = await w.anon.post("/api/exceptions", extend);
    expect(open.status).toBe(409);
    expect(await codeOf(open)).toBe("CONFLICT");
    await q.query("delete from exceptions where facility_id = $1 and id like 'exc-run7-queued-%'", [w.facilityId]);
  });

  it("listExceptions: OPEN rows first, then the newest others; a hard limit that cuts the newest OPEN rows first (re-check L1)", async () => {
    const q = live.db.$client;
    // A worker-opened stage release, older than everything else, then more decided rows than the limit.
    await q.query(
      `insert into exceptions (id, facility_id, kind, title, payload, requested_by, requires_founder, requires_lender, status, blast_radius_minor, trace_id, created_at)
       values ('exc-run7-stage', $1, 'RELEASE_STAGE', 'Release funding stage-2', '{"stageId":"stage-2"}'::jsonb, 'worker', false, true, 'OPEN', 0, 'trace-run7-stage', now() - interval '1 day')`,
      [w.facilityId],
    );
    await q.query(
      `insert into exceptions (id, facility_id, kind, title, payload, requested_by, requires_founder, requires_lender, status, blast_radius_minor, trace_id)
       select 'exc-run7-denied-' || g, $1, 'UNPAUSE', 'Resume all payments', '{}'::jsonb, 'founder', true, true, 'DENIED', 0, 'trace-run7-denied-' || g
         from generate_series(1, $2::int) g`,
      [w.facilityId, LIST_EXCEPTIONS_LIMIT + 50],
    );
    const openRows = await n("select count(*)::int as n from exceptions where facility_id = $1 and status = 'OPEN'", [w.facilityId]);
    const list = async (query: string) => json(await w.officer.get(`/api/exceptions${query}`), z.array(Exception));

    const all = await list("");
    expect(all).toHaveLength(LIST_EXCEPTIONS_LIMIT);
    expect(all.slice(0, openRows).every((e) => e.status === "OPEN")).toBe(true);
    expect(all.slice(openRows).every((e) => e.status !== "OPEN")).toBe(true);
    expect(all[openRows - 1]?.exceptionId).toBe("exc-run7-stage"); // OPEN newest first: the oldest OPEN row ends the group

    const open = await list("?status=OPEN");
    expect(open).toHaveLength(openRows);
    expect(open.map((e) => e.exceptionId)).toContain("exc-run7-stage");
    expect(await list("?status=DENIED")).toHaveLength(LIST_EXCEPTIONS_LIMIT);

    // More OPEN rows than the limit (a flood of newer escalations): still LIMIT rows, all OPEN, the oldest kept.
    await q.query(
      `insert into exceptions (id, facility_id, kind, title, payload, requested_by, requires_founder, requires_lender, status, blast_radius_minor, trace_id)
       select 'exc-l1-flood-' || g, $1, 'POLICY_ESCALATION', 'Review a flagged payment',
              jsonb_build_object('proposal', jsonb_build_object('lineKey', 'LOGISTICS', 'payeeId', 'spx-logistics', 'amountMinor', (1000 + g)::text, 'invoiceId', 'inv-l1-flood-' || g)), 'agent', false, true, 'OPEN', 0, 'trace-l1-flood-' || g
         from generate_series(1, $2::int) g`,
      [w.facilityId, LIST_EXCEPTIONS_LIMIT],
    );
    const flooded = await list("");
    expect(flooded).toHaveLength(LIST_EXCEPTIONS_LIMIT);
    expect(flooded.every((e) => e.status === "OPEN")).toBe(true);
    expect(flooded.at(-1)?.exceptionId).toBe("exc-run7-stage");
    expect(flooded.filter((e) => e.exceptionId.startsWith("exc-l1-flood-"))).toHaveLength(LIST_EXCEPTIONS_LIMIT - openRows);
    expect(await list("?status=OPEN")).toHaveLength(LIST_EXCEPTIONS_LIMIT);
    await q.query("delete from exceptions where facility_id = $1 and id like 'exc-l1-flood-%'", [w.facilityId]);
  });
});
