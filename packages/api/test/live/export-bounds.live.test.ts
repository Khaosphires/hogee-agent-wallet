/**
 * Audit run-6 bounds on Postgres + Anvil, through the live API:
 *   v-1 founder-persona writers: an open signature request is handed out again (no new row, no new trace); the
 *       MAX_REFUSALS-th refused signature closes the request (REJECTED) and nothing more is traced for it; a facility
 *       holds at most MAX_OPEN_REQUESTS open (kind, refId) pairs, a new pair evicts the oldest, and nobody can fill
 *       the cap to lock the founder out (re-check M2);
 *   v-2 evidence export: only the newest KEEP_RUNS bundles stay on disk and in evidence_runs, and no new run starts
 *       within MIN_EXPORT_INTERVAL_S of the last one (an identical state included); afterwards an identical state is
 *       idempotent again.
 *   run-7 trace window: past MAX_ROWS_PER_TABLE trace events the export leaves the oldest unnamed traces out whole and
 *       the bundle still verifies.
 *   re-check M1: an unsettled export (a row above the finalized head, or a row in flight) is refused synchronously
 *       with its reason, before the run is claimed: no evidence_runs row, no interval.
 *   run-7 re-check H1: past MAX_ROWS_PER_TABLE unused signature requests and LLM calls the export still succeeds and
 *       verifies: unused requests are left out, and LLM calls are windowed like traces.
 * The interval is passed by moving evidence_runs.finished_at back (the database clock decides it).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError, EvidenceRunSummary, SignatureRequestResponse, ZERO_HEX32 } from "@hogee/core";
import { z } from "zod";
import { collect, MAX_ROWS_PER_TABLE } from "../../src/evidence/collect";
import { EXPORT_LOCK_KEY, exportEvidence } from "../../src/evidence/export";
import { forgetAttempts, KEEP_RUNS } from "../../src/evidence/retention";
import { MAX_OPEN_REQUESTS, MAX_REFUSALS } from "../../src/services/signing/request-bounds";
import { appendTrace } from "../../src/services/traces";
import { scriptedAgent } from "../support/agent";
import { SoftAuthenticator } from "../support/authenticator";
import { finalizeAll, LIVE, LIVE_TIMEOUT_MS, openLive, type Live } from "../support/live";
import { b64uToBytes, chatToDraft, json, openAndRegister } from "../support/steps";
import { newWorld, type World } from "../support/world";

const SESSION = "01a14202-2800-7000-8000-0000000006b0";
const RunId = z.object({ runId: z.string() });

describe.skipIf(!LIVE)("run-6 bounds: signature writers and evidence retention (live)", { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  let w: World;
  let auth: SoftAuthenticator;
  let draftId: string;
  let root: string;
  const q = async <T>(sql: string, values: unknown[] = []) => (await live.db.$client.query(sql, values)).rows as T[];
  const count = async (sql: string, values: unknown[]) => (await q<{ n: number }>(sql, values))[0]?.n ?? -1;
  const request = (method: "passkey" | "eip712" = "passkey") => w.founder.post("/api/signatures/request", { kind: "PlanApproval", refId: draftId, method });
  const forged = (req: SignatureRequestResponse) => w.founder.post(`/api/signatures/${req.requestId}/submit`, { passkey: new SoftAuthenticator().assert(b64uToBytes(req.challengeB64url)) });
  const statusOf = async (id: string) => (await q<{ status: string }>("select status from signature_requests where facility_id = $1 and id = $2", [w.facilityId, id]))[0]?.status;
  const tracesOf = (id: string, kind: string) => count("select count(*)::int as n from traces where facility_id = $1 and trace_id = $2 and kind = $3", [w.facilityId, id, kind]);
  const codeOf = async (res: Response) => ApiError.parse(await res.json()).error;
  let changes = 0;
  /** One new trace row: a new evidence state (a new runId). */
  const changeState = async () => {
    changes += 1;
    await appendTrace(live.db, { facilityId: w.facilityId, traceId: `trace-bounds-${changes}`, actor: "worker", kind: "ALERT", summary: `bounds test change ${changes}` });
  };
  const moveRunsBack = () => q("update evidence_runs set finished_at = finished_at - interval '10 minutes' where facility_id = $1", [w.facilityId]);
  /** Past both intervals: the finished runs' (database clock) and the in-process one of calls that claimed no run. */
  const passInterval = async () => {
    forgetAttempts();
    await moveRunsBack();
  };
  const runFolders = () => readdirSync(root).filter((n) => n.startsWith("ev-")).sort();
  const readyRuns = () => count("select count(*)::int as n from evidence_runs where facility_id = $1 and status = 'READY'", [w.facilityId]);
  /** Waits until the background export has released the export lock (published, marked and pruned). */
  const waitIdle = async () => {
    for (let i = 0; i < 240; i += 1) {
      const holder = await live.db.$client.connect();
      try {
        if ((await holder.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [EXPORT_LOCK_KEY])).rows[0]?.ok) {
          await holder.query("select pg_advisory_unlock($1)", [EXPORT_LOCK_KEY]);
          return;
        }
      } finally {
        holder.release();
      }
      await new Promise((done) => setTimeout(done, 250));
    }
    throw new Error("the export never finished");
  };
  const statusOfRun = async (runId: string) => (await q<{ status: string }>("select status from evidence_runs where facility_id = $1 and id = $2", [w.facilityId, runId]))[0]?.status;

  beforeAll(async () => {
    live = await openLive();
    root = mkdtempSync(join(tmpdir(), "hogee-bounds-"));
    process.env.HOGEE_GIT_COMMIT = "7ca38ca";
    const agent = scriptedAgent();
    w = await newWorld(live, { agent, evidenceDir: root });
    auth = await openAndRegister(w);
    draftId = await chatToDraft(w, agent, SESSION);
  }, LIVE_TIMEOUT_MS);
  afterAll(async () => {
    await live?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  describe("v-1 signature writers", () => {
    let first: SignatureRequestResponse;

    it("hands out the open request again: same id and digest, no new row, no new trace", async () => {
      first = await json(await request(), SignatureRequestResponse);
      const again = await json(await request(), SignatureRequestResponse);
      expect(again).toEqual(first);
      expect(await count("select count(*)::int as n from signature_requests where facility_id = $1 and ref_id = $2 and method = 'passkey'", [w.facilityId, draftId])).toBe(1);
      expect(await tracesOf(first.requestId, "SIGNATURE")).toBe(1);
      const wallet = await json(await request("eip712"), SignatureRequestResponse);
      expect(wallet.requestId).not.toBe(first.requestId);
    });

    it(`closes a request on its ${MAX_REFUSALS}th refused signature; then CONFLICT and no more ALERT traces`, async () => {
      for (let i = 1; i <= MAX_REFUSALS; i += 1) {
        const res = await forged(first);
        expect(res.status, `refusal ${i}`).toBe(409);
        expect((await codeOf(res)).code).toBe("InvalidSignature");
        expect(await statusOf(first.requestId)).toBe(i < MAX_REFUSALS ? "PENDING" : "REJECTED");
      }
      expect(await tracesOf(first.requestId, "ALERT")).toBe(MAX_REFUSALS);
      for (let i = 0; i < 3; i += 1) {
        const res = await forged(first);
        expect(res.status).toBe(409);
        expect((await codeOf(res)).code).toBe("CONFLICT");
      }
      const valid = await w.founder.post(`/api/signatures/${first.requestId}/submit`, { passkey: auth.assert(b64uToBytes(first.challengeB64url)) });
      expect((await codeOf(valid)).code).toBe("CONFLICT");
      expect(await tracesOf(first.requestId, "ALERT")).toBe(MAX_REFUSALS);
      // The founder is not locked out: the next request is a fresh one.
      const fresh = await json(await request(), SignatureRequestResponse);
      expect(fresh.requestId).not.toBe(first.requestId);
      expect(await statusOf(fresh.requestId)).toBe("PENDING");
    });

    it(`re-check M2: at most ${MAX_OPEN_REQUESTS} open (kind, refId) pairs; a new pair evicts the oldest, never CONFLICT`, async () => {
      const [open] = await q<{ id: string }>("select id from signature_requests where facility_id = $1 and ref_id = $2 and method = 'passkey' and status = 'PENDING'", [w.facilityId, draftId]);
      // MAX_OPEN_REQUESTS other open pairs, sig-fill-1 the oldest: with the founder's draft that is one over the cap.
      await q(
        `insert into signature_requests (id, facility_id, kind, ref_id, method, typed_data_json, digest, challenge_b64url, display_model_json, nonce, expires_at, status, created_at)
         select 'sig-fill-' || g, facility_id, kind, 'draft-fill-' || g, method, typed_data_json, digest, challenge_b64url, display_model_json, nonce, expires_at, 'PENDING', now() - make_interval(secs => 100 - g)
           from signature_requests, generate_series(1, $3::int) g where facility_id = $1 and id = $2`,
        [w.facilityId, open?.id, MAX_OPEN_REQUESTS],
      );
      expect((await json(await request(), SignatureRequestResponse)).requestId).toBe(open?.id);
      expect(await statusOf("sig-fill-1")).toBe("PENDING"); // a reuse evicts nothing
      // Its content no longer matches what would be built now, so a new request is needed: created, not refused.
      await q(`update signature_requests set display_model_json = jsonb_set(display_model_json, '{title}', '"stale"') where facility_id = $1 and id = $2`, [w.facilityId, open?.id]);
      const created = await json(await request(), SignatureRequestResponse);
      expect(created.requestId).not.toBe(open?.id);
      expect(await statusOf(open?.id as string)).toBe("EXPIRED"); // superseded: same kind, refId and method
      expect(await statusOf("sig-fill-1")).toBe("EXPIRED"); // evicted: the oldest other pair
      expect(await statusOf("sig-fill-2")).toBe("PENDING");
      const pairs = await count("select count(distinct (kind, ref_id))::int as n from signature_requests where facility_id = $1 and status = 'PENDING'", [w.facilityId]);
      expect(pairs).toBe(MAX_OPEN_REQUESTS);
      await q("delete from signature_requests where facility_id = $1 and id like 'sig-fill-%'", [w.facilityId]);
    });

    it("re-check M2: the 60-call lockout recipe (request, 5 bad signatures, again; ten times) leaves the founder able to sign", async () => {
      const anonRequest = () => w.anon.post("/api/signatures/request", { kind: "PlanApproval", refId: draftId, method: "passkey" });
      const anonForged = (req: SignatureRequestResponse) => w.anon.post(`/api/signatures/${req.requestId}/submit`, { passkey: new SoftAuthenticator().assert(b64uToBytes(req.challengeB64url)) });
      for (let i = 0; i < MAX_OPEN_REQUESTS; i += 1) {
        const x = await json(await anonRequest(), SignatureRequestResponse);
        for (let j = 0; j < MAX_REFUSALS; j += 1) expect((await anonForged(x)).status).toBe(409);
        expect(await statusOf(x.requestId)).toBe("REJECTED");
      }
      expect(await count("select count(*)::int as n from signature_requests where facility_id = $1 and status = 'REJECTED'", [w.facilityId])).toBeGreaterThanOrEqual(MAX_OPEN_REQUESTS);
      // REJECTED requests hold no place: the founder's next request is a fresh, open one.
      const res = await request();
      expect(res.status).toBe(200);
      const mine = await json(res, SignatureRequestResponse);
      expect(await statusOf(mine.requestId)).toBe("PENDING");
      expect(await tracesOf(mine.requestId, "ALERT")).toBe(0);
    });
  });

  describe("v-2 evidence export", () => {
    const ids: string[] = [];

    it("re-check M1: refuses an unsettled export before claiming it, with the reason; no row, no interval", async () => {
      const rowsBefore = await count("select count(*)::int as n from evidence_runs where facility_id = $1", [w.facilityId]);
      // The setup's openFacility and registerFounderKey sit in Anvil's last 64 blocks: not final yet.
      const late = await w.anon.post("/api/evidence/export");
      expect(late.status).toBe(409);
      expect((await codeOf(late)).message).toMatch(/the newest tx is in block \d+, above the finalized block \d+/);
      await finalizeAll(live);
      const [a] = await q<{ id: string; state: string }>("select id, state::text as state from chain_actions where facility_id = $1 and tx_hash is not null order by created_at desc, id limit 1", [w.facilityId]);
      await q("update chain_actions set state = 'BROADCAST' where facility_id = $1 and id = $2", [w.facilityId, a?.id]);
      try {
        const flight = await w.anon.post("/api/evidence/export");
        expect(flight.status).toBe(409);
        expect((await codeOf(flight)).message).toContain(`in flight (first: ${a?.id} is BROADCAST)`);
      } finally {
        await q("update chain_actions set state = $3 where facility_id = $1 and id = $2", [w.facilityId, a?.id, a?.state]);
      }
      expect(await count("select count(*)::int as n from evidence_runs where facility_id = $1", [w.facilityId])).toBe(rowsBefore);
      expect(runFolders()).toEqual([]);
      // Settled now, the very next call exports: neither refusal armed the interval.
      const ok = await json(await w.anon.post("/api/evidence/export"), RunId);
      await waitIdle();
      expect(await statusOfRun(ok.runId)).toBe("READY");
    });

    it(`keeps only the newest ${KEEP_RUNS} bundles on disk and in evidence_runs; folders it does not own stay`, async () => {
      // The exporter ships only final receipts (run-6 verifier fixes): make the setup's txs final first.
      await finalizeAll(live);
      mkdirSync(join(root, "ev-0000000000000000"));
      writeFileSync(join(root, "ev-0000000000000000", "note.txt"), "not this database's run");
      const scope = { facilityId: w.facilityId, founderId: w.founderId };
      for (let i = 0; i < KEEP_RUNS + 2; i += 1) {
        await changeState();
        await passInterval();
        const result = await exportEvidence(w.deps, scope, { root, wait: true });
        expect(result.created).toBe(true);
        expect((await result.done).verified).toBe(true);
        ids.push(result.runId);
      }
      expect(new Set(ids).size).toBe(KEEP_RUNS + 2);
      expect(runFolders()).toEqual([...ids.slice(2), "ev-0000000000000000"].sort());
      expect(await readyRuns()).toBe(KEEP_RUNS);
      expect(readdirSync(root).filter((n) => n.startsWith(".export-"))).toEqual([]);
      const listed = await json(await w.founder.get("/api/evidence/runs"), z.array(EvidenceRunSummary));
      expect(listed.map((r) => r.runId).sort()).toEqual(ids.slice(2).sort());
      expect((await w.founder.get(`/api/evidence/${ids[0]}`)).status).toBe(404);
    });

    it("refuses a new run inside the interval, before collecting (identical state included); idempotent again after it", async () => {
      const rowsBefore = await count("select count(*)::int as n from evidence_runs where facility_id = $1", [w.facilityId]);
      const same = await w.anon.post("/api/evidence/export");
      expect(same.status).toBe(409);
      await changeState();
      const changed = await w.anon.post("/api/evidence/export");
      expect(changed.status).toBe(409);
      const err = await codeOf(changed);
      expect(err.code).toBe("CONFLICT");
      expect(err.message).toMatch(/less than 60 s ago/);
      expect(await count("select count(*)::int as n from evidence_runs where facility_id = $1", [w.facilityId])).toBe(rowsBefore);
      expect(runFolders()).toHaveLength(KEEP_RUNS + 1);

      await passInterval();
      const next = await json(await w.anon.post("/api/evidence/export"), RunId);
      expect(ids).not.toContain(next.runId);
      await waitIdle();
      expect(await statusOfRun(next.runId)).toBe("READY");
      expect(runFolders()).toHaveLength(KEEP_RUNS + 1);
      expect(existsSync(join(root, ids[2] as string))).toBe(false);

      await passInterval();
      const again = await json(await w.anon.post("/api/evidence/export"), RunId);
      expect(again.runId).toBe(next.runId);
      expect(await readyRuns()).toBe(KEEP_RUNS);

      // re-check L1: that idempotent call wrote no row, yet it starts the interval too (no collect for 60 s).
      const rowsNow = await count("select count(*)::int as n from evidence_runs where facility_id = $1", [w.facilityId]);
      await moveRunsBack();
      const idem = await w.anon.post("/api/evidence/export");
      expect(idem.status).toBe(409);
      expect((await codeOf(idem)).message).toMatch(/less than 60 s ago/);
      expect(await count("select count(*)::int as n from evidence_runs where facility_id = $1", [w.facilityId])).toBe(rowsNow);
      forgetAttempts();
      expect((await json(await w.anon.post("/api/evidence/export"), RunId)).runId).toBe(next.runId);
    });
  });

  describe("run-7 trace window", () => {
    it(`past ${MAX_ROWS_PER_TABLE} trace events the export leaves the oldest unnamed traces out whole and still verifies`, async () => {
      // One old unnamed trace bigger than the cap (its hashes are never checked: it is left out whole).
      await live.db.$client.query(
        `insert into traces (trace_id, seq, facility_id, ts, actor, kind, summary, prev_hash, hash)
         select 'trace-run7-filler', g, $1, timestamptz '2020-01-01 00:00:00+00' + g * interval '1 second', 'worker', 'ALERT', 'run-7 filler', $2, '0x' || lpad(to_hex(g + 1), 64, '0')
           from generate_series(0, $3::int) g`,
        [w.facilityId, ZERO_HEX32, MAX_ROWS_PER_TABLE],
      );
      const scope = { facilityId: w.facilityId, founderId: w.founderId };
      const c = await collect(live.db.$client, scope);
      expect(c.omittedTraces).toEqual({ traces: 1, events: MAX_ROWS_PER_TABLE + 1 });
      expect(c.traces.some((t) => t.traceId === "trace-run7-filler")).toBe(false);
      const others = await count("select count(*)::int as n from traces where facility_id = $1 and trace_id <> 'trace-run7-filler' and summary not like '[eval %'", [w.facilityId]);
      expect(c.traces).toHaveLength(others);
      await passInterval();
      forgetAttempts();
      const result = await exportEvidence(w.deps, scope, { root, wait: true });
      expect(result.created).toBe(true);
      expect((await result.done).verified).toBe(true);
    });
  });

  describe("re-check H1: tables an anonymous caller grows never cap the export", () => {
    const UNUSED = MAX_ROWS_PER_TABLE + 10_000;

    it(`past ${MAX_ROWS_PER_TABLE} unused signature requests and LLM calls the export still succeeds and verifies`, async () => {
      const [model] = await q<{ id: string }>("select id from signature_requests where facility_id = $1 order by created_at limit 1", [w.facilityId]);
      expect(model).toBeDefined();
      // The shape anonymous request / evict / refuse cycles leave behind: EXPIRED and REJECTED, never submitted.
      await q(
        `insert into signature_requests (id, facility_id, kind, ref_id, method, typed_data_json, digest, challenge_b64url, display_model_json, nonce, expires_at, status, created_at)
         select 'sig-h1-' || g, facility_id, kind, 'draft-h1-' || (g % 7), method, typed_data_json, digest, challenge_b64url, display_model_json, nonce, expires_at,
                (case when g % 2 = 0 then 'EXPIRED' else 'REJECTED' end)::signature_request_status, now() - make_interval(secs => g)
           from signature_requests, generate_series(1, $3::int) g where facility_id = $1 and id = $2`,
        [w.facilityId, model?.id, UNUSED],
      );
      const before = await count("select count(*)::int as n from llm_calls where facility_id = $1", [w.facilityId]);
      // MAX_ROWS_PER_TABLE old LLM calls no kept trace holds (a chat flood whose traces aged out), oldest h1-1.
      await q(
        `insert into llm_calls (id, facility_id, trace_id, role, provider, model_id, params_json, prompt_hash, response_hash, redaction_report, latency_ms, tokens, created_at)
         select 'llm-h1-' || g, $1, null, 'planner', 'fixture', 'fixture-model', '{}'::jsonb, '0x' || lpad(to_hex(g), 64, '0'), null, '{"entities":[],"count":0}'::jsonb, 1, null,
                timestamptz '2021-01-01 00:00:00+00' + g * interval '1 second'
           from generate_series(1, $2::int) g`,
        [w.facilityId, MAX_ROWS_PER_TABLE],
      );
      // Two calls older than every filler that a new (kept) trace holds or names: both must stay, whatever their age.
      await q(
        `insert into llm_calls (id, facility_id, trace_id, role, provider, model_id, params_json, prompt_hash, response_hash, redaction_report, latency_ms, tokens, created_at)
         values ('llm-h1-named', $1, 'trace-h1-chat', 'planner', 'fixture', 'fixture-model', '{}'::jsonb, $2, null, '{"entities":[],"count":0}'::jsonb, 1, null, timestamptz '2019-01-01 00:00:00+00'),
                ('llm-h1-held', $1, 'trace-h1-chat', 'planner', 'fixture', 'fixture-model', '{}'::jsonb, $2, null, '{"entities":[],"count":0}'::jsonb, 1, null, timestamptz '2019-01-01 00:00:01+00')`,
        [w.facilityId, `0x${"ab".repeat(32)}`],
      );
      await appendTrace(live.db, { facilityId: w.facilityId, traceId: "trace-h1-chat", actor: "planner", kind: "LLM_CALL", summary: "re-check H1 chat turn", refs: { llmCallId: "llm-h1-named" } });

      const scope = { facilityId: w.facilityId, founderId: w.founderId };
      const c = await collect(live.db.$client, scope);
      expect(c.omittedSignatures).toBeGreaterThanOrEqual(UNUSED);
      expect(c.signatures.some((s) => s.requestId.startsWith("sig-h1-"))).toBe(false);
      expect(c.signatures.every((s) => s.status === "SUBMITTED" || s.submission !== null || s.chainActionId !== null)).toBe(true);
      const calls = new Set(c.llmCalls.map((l) => l.llmCallId));
      expect(c.llmCalls).toHaveLength(MAX_ROWS_PER_TABLE);
      expect(c.omittedLlmCalls).toBe(before + 2);
      expect(calls.has("llm-h1-named")).toBe(true);
      expect(calls.has("llm-h1-held")).toBe(true);
      expect(calls.has(`llm-h1-${MAX_ROWS_PER_TABLE}`)).toBe(true);
      expect(calls.has("llm-h1-1")).toBe(false);
      expect(c.traces.some((t) => t.traceId === "trace-h1-chat")).toBe(true);

      await passInterval();
      const result = await exportEvidence(w.deps, scope, { root, wait: true });
      expect(result.created).toBe(true);
      expect((await result.done).verified).toBe(true);
    });
  });
});
