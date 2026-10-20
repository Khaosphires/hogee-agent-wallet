/**
 * Task 1.16 end to end on Postgres + Anvil: a real money-path flow (plan, funding, supplier escrow, ads pacing, an API
 * spend proposal, an anchored denial, settlement, a sale, stage 2 and the founder's balance release), then
 *   - each decision writer stored a preimage that re-hashes to its row's rationale_hash and to the chain's commitment;
 *   - POST /api/evidence/export builds evidence/<runId>/ that verifyBundle accepts on every check, read back through the
 *     contained file route; the `make verify` CLI exits 0 on it and non-zero once one byte of a receipt changes;
 *   - the export is idempotent, one at a time, and the file route never leaves a bundle or another facility's runs.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EvidenceBundle, EvidenceRunSummary, SignatureRequestResponse, SpendProposalResult, exampleShortlistSpec, hashObject } from "@hogee/core";
import { runAgentActions, runSettle, runTick } from "@hogee/worker";
import { receiptPath, verifyBundle, type BundleFiles } from "@hogee/verify-evidence";
import { main as verifyCli } from "../../../../tools/verify-evidence/src/cli";
import { decodeEventLog, keccak256, toHex, type Hex } from "viem";
import { z } from "zod";
import { iMilestoneEscrowAbi, iTreasuryAbi } from "../../../chain/src/generated";
import { scriptedAgent } from "../support/agent";
import type { SoftAuthenticator } from "../support/authenticator";
import { finalizeAll, LIVE, LIVE_TIMEOUT_MS, openLive, warp, type Live } from "../support/live";
import { b64uToBytes, chatToDraft, json, openAndRegister, signPlan } from "../support/steps";
import { paymentIntentSucceeded, postStripe } from "../support/stripe";
import { newWorld, type World } from "../support/world";

const SESSION = "01a14202-2800-7000-8000-0000000001e6";

describe.skipIf(!LIVE)("evidence export + verifyBundle on a real flow (live)", { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  let w: World;
  let auth: SoftAuthenticator;
  let root: string;
  let runId: string;
  const q = async <T>(sql: string, values: unknown[] = []) => (await live.db.$client.query(sql, values)).rows as T[];
  const agentRound = async () => {
    const d = w.workerDeps();
    await runAgentActions(d, [w.facilityId]);
    await runTick(d, w.facilityId);
    await w.pump();
  };
  const settleRound = async () => {
    for (let i = 0; i < 5; i += 1) {
      await finalizeAll(live);
      await w.pump();
      const [r] = await runSettle(w.workerDeps(), [w.facilityId]);
      await w.pump();
      if ((r?.payments ?? []).length === 0) return;
    }
  };
  let invoices = 0;
  const invoice = async (amountMinor: string) => {
    invoices += 1;
    const id = `inv-ev-${invoices}`;
    await q(
      `insert into invoices (id, facility_id, payee_id, amount_minor, invoice_hash, extracted_fields_json, taint, flags, received_at)
       values ($1, $2, 'spx-logistics', $3, $4, '{}'::jsonb, '{"trust":"untrusted","sensitivity":"public"}'::jsonb, '{}', now())`,
      [id, w.facilityId, amountMinor, keccak256(toHex(`${w.facilityId}:${id}`))],
    );
    return id;
  };
  /** The stored preimage of `hash` re-hashes to it (and names `decisionId`). */
  const expectPreimage = async (hash: string, decisionId: string | null) => {
    const [r] = await q<{ rationale_json: unknown; decision_id: string | null; salt: string | null }>(
      "select rationale_json, decision_id::text as decision_id, salt from rationales where facility_id = $1 and rationale_hash = $2",
      [w.facilityId, hash],
    );
    expect(r, `preimage of ${hash}`).toBeDefined();
    expect(r?.salt).toBeNull();
    expect(hashObject(r?.rationale_json)).toBe(hash);
    if (decisionId) expect(r?.decision_id).toBe(decisionId);
  };
  const eventOf = async (txHash: string, abi: typeof iTreasuryAbi | typeof iMilestoneEscrowAbi, name: string) => {
    const receipt = await live.client.getTransactionReceipt({ hash: txHash as Hex });
    for (const log of receipt.logs) {
      try {
        const ev = decodeEventLog({ abi, data: log.data, topics: log.topics });
        if (ev.eventName === name) return ev.args as Record<string, unknown>;
      } catch {
        // another contract's event
      }
    }
    throw new Error(`no ${name} in ${txHash}`);
  };
  const payment = async (where: string) =>
    (await q<{ id: string; tx_hash: string; rationale_hash: string; decision_id: string }>(`select id, tx_hash, rationale_hash, decision_id::text as decision_id from payments where facility_id = $1 and ${where} order by created_at limit 1`, [w.facilityId]))[0];

  beforeAll(async () => {
    live = await openLive();
    root = mkdtempSync(join(tmpdir(), "hogee-evidence-"));
    process.env.HOGEE_GIT_COMMIT = "7ca38ca";
    const agent = scriptedAgent();
    w = await newWorld(live, { agent, coolingSeconds: 120, evidenceDir: root });
  }, LIVE_TIMEOUT_MS);
  afterAll(async () => {
    await live?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("runs the money path: plan, funding, supplier escrow, pacing, a proposal, a denial, settlement, a sale, stage 2, the balance release", async () => {
    auth = await openAndRegister(w);
    await signPlan(w, auth, await chatToDraft(w, scriptedAgentOf(w), SESSION));
    await w.officer.post("/api/facility/fund", { amountMinor: "1000000" });
    await w.pump();
    await json(await w.founder.post("/api/suppliers/shortlist", { spec: exampleShortlistSpec }), z.unknown());
    const sa = await json(await w.founder.post("/api/signatures/request", { kind: "SupplierApproval", refId: "order-a-001", method: "passkey" }), SignatureRequestResponse);
    await json(await w.founder.post(`/api/signatures/${sa.requestId}/submit`, { passkey: auth.assert(b64uToBytes(sa.challengeB64url)) }), z.unknown());
    await w.pump();
    await warp(live, 200n);
    await w.pump();
    await agentRound();
    await agentRound();
    const auto = await json(await w.anon.post("/api/proposals/spend", { lineKey: "LOGISTICS", invoiceId: await invoice("15000"), reason: "courier" }), SpendProposalResult);
    expect(auto.verdict).toBe("AUTO");
    const deny = await json(await w.anon.post("/api/proposals/spend", { lineKey: "LOGISTICS", invoiceId: await invoice("25000"), reason: "over the cap" }), SpendProposalResult);
    expect(deny).toMatchObject({ verdict: "DENY", reasonCode: "CapExceeded" });
    await agentRound();
    await settleRound();
    expect((await postStripe(w.app, paymentIntentSucceeded({ facilityId: w.facilityId, amountMinor: 250_000, currency: "myr" }), w.flags.stripeWebhookSecret as string)).status).toBe(200);
    await w.pump();
    const open = await json(await w.officer.get("/api/exceptions?status=OPEN"), z.array(z.object({ exceptionId: z.string(), kind: z.string() })));
    const stage = open.find((e) => e.kind === "RELEASE_STAGE");
    expect(stage).toBeDefined();
    await json(await w.officer.post(`/api/exceptions/${stage?.exceptionId}/approve`, {}), z.unknown());
    await w.pump();
    await agentRound();
    const inspection = (text: string, headers: Record<string, string> = {}) => {
      const f = new FormData();
      f.append("file", new Blob([new TextEncoder().encode(text)], { type: "application/pdf" }), "inspection.pdf");
      return w.app.request("/api/escrow/order-a-001/inspection", { method: "POST", headers, body: f });
    };
    // Run-7 re-check M1: an anonymous caller's uploads past the per-milestone trace cap do not lock the founder out.
    for (let i = 0; i < 7; i += 1) expect((await inspection(`junk ${i}`)).status).toBe(200);
    expect((await inspection("inspection: 500 units ok", { cookie: w.cookie("founder:rina") })).status).toBe(200);
    const mr = await json(await w.founder.post("/api/signatures/request", { kind: "MilestoneRelease", refId: "order-a-001", method: "passkey" }), SignatureRequestResponse);
    expect(mr.typedData.message.evidenceHash).toBe(keccak256(new TextEncoder().encode("inspection: 500 units ok")));
    await json(await w.founder.post(`/api/signatures/${mr.requestId}/submit`, { passkey: auth.assert(b64uToBytes(mr.challengeB64url)) }), z.unknown());
    await agentRound(); // the worker relays founder-signed payments (agent-actions)
    await settleRound();
    expect((await q<{ n: number }>("select count(*)::int as n from payments where facility_id = $1 and kind = 'RELEASE_MILESTONE' and tx_hash is not null and state <> 'REVERTED'", [w.facilityId]))[0]?.n).toBeGreaterThan(0);
  });

  describe("each decision writer stores a preimage that re-hashes to its row and the chain", () => {
    it("pacing.ts (worker autonomous tick, ADS)", async () => {
      const p = await payment("line_key = 'ADS' and kind = 'SPEND' and tx_hash is not null and id like 'pacing:ADS:%'");
      expect(p).toBeDefined();
      await expectPreimage(p?.rationale_hash as string, p?.decision_id ?? null);
      expect(String((await eventOf(p?.tx_hash as string, iTreasuryAbi, "Spent")).rationaleHash).toLowerCase()).toBe(p?.rationale_hash);
    });

    it("agent-actions-sign.ts (worker escrow funding, FUND_MILESTONE)", async () => {
      const p = await payment("kind = 'FUND_MILESTONE' and tx_hash is not null");
      await expectPreimage(p?.rationale_hash as string, p?.decision_id ?? null);
      expect(String((await eventOf(p?.tx_hash as string, iMilestoneEscrowAbi, "MilestoneFunded")).rationaleHash).toLowerCase()).toBe(p?.rationale_hash);
    });

    it("proposals.ts (API spend proposal, AUTO)", async () => {
      const p = await payment("line_key = 'LOGISTICS' and kind = 'SPEND' and tx_hash is not null");
      await expectPreimage(p?.rationale_hash as string, p?.decision_id ?? null);
      expect(String((await eventOf(p?.tx_hash as string, iTreasuryAbi, "Spent")).rationaleHash).toLowerCase()).toBe(p?.rationale_hash);
    });

    it("proposals.ts (a denial anchored with recordDenied)", async () => {
      const [d] = await q<{ proposal_hash: string; decision_id: string; recorded_tx: string | null }>("select proposal_hash, decision_id::text as decision_id, recorded_tx from denials where facility_id = $1", [w.facilityId]);
      await expectPreimage(d?.proposal_hash as string, d?.decision_id ?? null);
      const [a] = await q<{ tx_hash: string }>("select tx_hash from chain_actions where facility_id = $1 and kind = 'Treasury.recordDenied' and tx_hash is not null", [w.facilityId]);
      expect(String((await eventOf(a?.tx_hash as string, iTreasuryAbi, "Denied")).proposalHash).toLowerCase()).toBe(d?.proposal_hash);
    });

    it("founder-payments.ts (founder MilestoneRelease; releaseMilestone records no rationale on-chain)", async () => {
      const p = await payment("kind = 'RELEASE_MILESTONE' and id like 'release:%'");
      await expectPreimage(p?.rationale_hash as string, p?.decision_id ?? null);
    });
  });

  it("POST /api/evidence/export builds a bundle that verifyBundle accepts on every check", async () => {
    // The export is refused (409) while any row's tx is above the finalized head: settle the last round's txs first.
    await finalizeAll(live);
    runId = (await json(await w.anon.post("/api/evidence/export"), z.object({ runId: z.string() }))).runId;
    let listed: EvidenceRunSummary | undefined;
    for (let i = 0; i < 120 && !listed; i += 1) {
      listed = (await json(await w.founder.get("/api/evidence/runs"), z.array(EvidenceRunSummary))).find((r) => r.runId === runId);
      if (!listed) await new Promise((r) => setTimeout(r, 250));
    }
    expect(listed).toBeDefined();
    const bundle = await json(await w.founder.get(`/api/evidence/${runId}`), EvidenceBundle);
    const files: Record<string, string> = {};
    for (const path of bundle.files) {
      const res = await w.founder.get(`/api/evidence/${runId}/files/${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      files[path] = await res.text();
    }
    const result = verifyBundle(files as BundleFiles);
    expect(result.checks.filter((c) => !c.ok)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(bundle.rows.map((r) => r.taskId)).toEqual(expect.arrayContaining(["S1", "S2", "S3", "S4", "S5", "S11", "T4"]));
    expect(Object.keys(files).filter((p) => p.startsWith("receipts/")).length).toBeGreaterThan(10);
    const run = await q<{ status: string; row_count: number }>("select status, row_count from evidence_runs where facility_id = $1 and id = $2", [w.facilityId, runId]);
    expect(run[0]).toEqual({ status: "READY", row_count: bundle.rows.length });
  });

  it("make verify (the CLI) exits 0 on the bundle, and non-zero once one byte of a receipt changes", async () => {
    const quiet = () => undefined;
    expect(verifyCli([join(root, runId)], quiet)).toBe(0);
    expect(verifyCli(["--root", root], quiet)).toBe(0);
    const copy = mkdtempSync(join(tmpdir(), "hogee-tampered-"));
    try {
      cpSync(join(root, runId), join(copy, runId), { recursive: true });
      const spend = (await payment("line_key = 'LOGISTICS' and kind = 'SPEND' and tx_hash is not null"))?.tx_hash as string;
      const file = join(copy, runId, receiptPath(spend));
      const text = readFileSync(file, "utf8");
      const at = text.indexOf('"gasUsed": "0x') + '"gasUsed": "0x'.length;
      writeFileSync(file, `${text.slice(0, at)}${text[at] === "f" ? "e" : "f"}${text.slice(at + 1)}`);
      const lines: string[] = [];
      expect(verifyCli([join(copy, runId)], (l) => lines.push(l))).toBe(1);
      expect(lines.join("\n")).toMatch(/FAIL file hashes/);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  it("is idempotent (same evidence → same run, never rewritten) and one export at a time", async () => {
    const before = readFileSync(join(root, runId, "hashes.json"), "utf8");
    // Inside the minimum interval every export is refused before anything is collected (audit run-6).
    const soon = await w.anon.post("/api/evidence/export");
    expect(soon.status).toBe(409);
    await q("update evidence_runs set finished_at = finished_at - interval '1 hour' where facility_id = $1", [w.facilityId]);
    const holder = await live.db.$client.connect();
    try {
      await holder.query("select pg_advisory_lock($1)", [0x45564944]);
      const busy = await w.anon.post("/api/evidence/export");
      expect(busy.status).toBe(409);
      const err = ((await busy.json()) as { error: { code: string; message: string } }).error;
      expect(err.code).toBe("CONFLICT");
      expect(err.message).toMatch(/already running/);
    } finally {
      await holder.query("select pg_advisory_unlock($1)", [0x45564944]);
      holder.release();
    }
    const again = await json(await w.anon.post("/api/evidence/export"), z.object({ runId: z.string() }));
    expect(again.runId).toBe(runId);
    expect(readFileSync(join(root, runId, "hashes.json"), "utf8")).toBe(before);
    // The idempotent call claimed no run, yet it starts the interval too (run-6 re-check L1).
    expect((await w.anon.post("/api/evidence/export")).status).toBe(409);
  });

  it("the file route stays inside the bundle and the facility", async () => {
    expect([404, 422]).toContain((await w.founder.get(`/api/evidence/${runId}/files/..%2F..%2Fetc%2Fpasswd`)).status);
    expect([404, 422]).toContain((await w.founder.get(`/api/evidence/${runId}/files/../manifest.json`)).status);
    expect((await w.founder.get("/api/evidence/ev-0000000000000000")).status).toBe(404);
    const outside = join(mkdtempSync(join(tmpdir(), "hogee-outside-")), "secret.json");
    writeFileSync(outside, '{"secret":true}');
    symlinkSync(outside, join(root, runId, "link.json"));
    expect((await w.founder.get(`/api/evidence/${runId}/files/link.json`)).status).toBe(404);
    rmSync(join(root, runId, "link.json"));
    const other = "ev-otherfacility1";
    cpSync(join(root, runId), join(root, other), { recursive: true });
    const contracts = JSON.parse(readFileSync(join(root, other, "contracts.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(root, other, "contracts.json"), JSON.stringify({ ...contracts, runId: other, facilityId: "fac-someone-else" }));
    expect((await w.founder.get(`/api/evidence/${other}`)).status).toBe(404);
    expect((await json(await w.founder.get("/api/evidence/runs"), z.array(EvidenceRunSummary))).map((r) => r.runId)).not.toContain(other);
  });
});

/** The world's scripted agent (newWorld keeps the one it was given). */
function scriptedAgentOf(w: World) {
  return w.deps.agent as ReturnType<typeof scriptedAgent>;
}
