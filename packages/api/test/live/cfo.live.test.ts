/**
 * v-cfo on the live API + Anvil: GET /api/cfo from ONE chain snapshot and the facility's mirrored records, and the
 * worker's cfo-guard acting within bounded authority. Before a plan: a valid all-zero report. After a committed plan
 * and a recorded sale: the sale, the reserve set aside on-chain (Treasury.revenueLedger) and stage-1 cash capped by
 * what was released. A line burning > 1.5x its pace (ADS rows over three chain days): cfo-guard lowers its window cap
 * with the AGENT key (a real Treasury.tighten), the chain shows the lower cap, the report lists the agent action, and
 * a second run the same chain day sends nothing (one per line per day).
 *
 * The burning ADS rows are written straight to Postgres as FINALIZED mirrors dated by real blocks on three chain days
 * (Anvil time warp): the CFO reads the mirror, never the request. Everything the guard SENDS is real and checked on-chain.
 */
import { randomBytes } from "node:crypto";
import { iTreasuryAbi } from "@hogee/chain";
import { CfoReport, RINA_IDS } from "@hogee/core";
import { runCfoGuard } from "@hogee/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lineKeyToLineId } from "../../src/chain-lib";
import { cfoRoutes } from "../../src/routes/cfo";
import { webhookRoutes } from "../../src/routes/webhooks";
import { SALE_BUCKET_MINOR } from "../../src/services/sales";
import { uuidv7 } from "../../src/services/ids";
import { scriptedAgent, type ScriptedAgent } from "../support/agent";
import { DAY, LIVE, LIVE_TIMEOUT_MS, openLive, warp, type Live } from "../support/live";
import { chatToDraft, json, openAndRegister, signPlan } from "../support/steps";
import { paymentIntentSucceeded, postStripe } from "../support/stripe";
import { newWorld, type World } from "../support/world";

const SESSION = "01a14202-2800-7000-8000-0000000000c5";
const hex = (bytes: number): string => `0x${randomBytes(bytes).toString("hex")}`;

describe.skipIf(!LIVE)("CFO report and cfo-guard (live)", { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  let w: World;
  let agent: ScriptedAgent;
  const q = <T>(sql: string, values: unknown[]) => live.db.$client.query(sql, values).then((r) => r.rows as T[]);
  const report = async () => json(await w.founder.get("/api/cfo"), CfoReport);
  const pocket = async (lineKey: string) =>
    live.client.readContract({ address: w.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: "pocket", args: [lineKeyToLineId(lineKey as "ADS")] });
  const guardRows = () =>
    q<{ id: string; state: string; tx_hash: string | null; request_json: Record<string, unknown> }>(
      "select id, state, tx_hash, request_json from chain_actions where facility_id = $1 and kind = 'Treasury.tighten' order by created_at",
      [w.facilityId],
    );

  /** A FINALIZED ADS spend mirror at `block` (fake signed columns within every CHECK; never broadcast). */
  async function minedAdsSpend(block: bigint, amountMinor: string): Promise<void> {
    await live.db.$client.query(
      `insert into payments (id, facility_id, kind, intent_id, line_key, line_id, payee_id, amount_minor, invoice_hash, plan_version, state,
         signer_address, chain_id, raw_signed_tx, nonce, tx_hash, block, decision_id, rationale_hash, trace_id)
       values ($1, $2, 'SPEND', $3, 'ADS', $4, $5, $6, $7, 1, 'FINALIZED', $8, 31337, $9, $10, $11, $12, $13, $14, $15)`,
      [
        `pay-${uuidv7()}`,
        w.facilityId,
        hex(32),
        lineKeyToLineId("ADS").toLowerCase(),
        RINA_IDS.adsPayeeId,
        amountMinor,
        hex(32),
        hex(20),
        `0x02${randomBytes(40).toString("hex")}`,
        BigInt(`0x${randomBytes(5).toString("hex")}`).toString(),
        hex(32),
        block.toString(),
        uuidv7(),
        hex(32),
        `trace:cfo-test:${block}`,
      ],
    );
  }

  beforeAll(async () => {
    live = await openLive();
    agent = scriptedAgent();
    w = await newWorld(live, { agent, routes: { ...cfoRoutes(), ...webhookRoutes } });
  }, LIVE_TIMEOUT_MS);
  afterAll(async () => {
    await live?.close();
  });

  it("before any plan: a valid report of zeros (nothing recorded, nothing invented)", async () => {
    const r = await report();
    expect(r.overview).toEqual({ cashAvailableMinor: "0", spentMinor: "0", revenueMinor: "0", reserveMinor: "0", netMinor: "0" });
    expect(r.spending.byLine).toEqual([]);
    expect(r.sales).toMatchObject({ count: 0, stageGate: null });
    expect(r.forecast).toMatchObject({ sampleDays: 0, runwayDays: null, stage2Date: null });
    expect(r.agentActions).toEqual([]);
    expect(r.disclaimer).toBe("Estimates from your own records. Not financial advice.");
  });

  it("after a committed plan and a recorded sale: chain pockets, the sale, the reserve from revenueLedger", async () => {
    const auth = await openAndRegister(w);
    const draftId = await chatToDraft(w, agent, SESSION);
    await signPlan(w, auth, draftId);
    const sale = paymentIntentSucceeded({ facilityId: w.facilityId, amountMinor: 40_050 });
    expect((await postStripe(w.app, sale, w.flags.stripeWebhookSecret as string)).status).toBe(200);
    await w.pump();

    const r = await report();
    const bucket = (40_050n / SALE_BUCKET_MINOR) * SALE_BUCKET_MINOR;
    expect(r.sales).toMatchObject({ count: 1, revenueMinor: bucket.toString() });
    expect(r.sales.recent[0]?.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    // 5% of the sale set aside on-chain at the plan's rate.
    expect(r.reserve).toMatchObject({ rateBps: 500, skimmedMinor: ((bucket * 500n) / 10_000n).toString(), withdrawnMinor: "0", salesCount: 1, taxPayeeId: RINA_IDS.taxPayeeId });
    expect(r.spending.byLine.map((l) => l.lineKey)).toContain("ADS");
    // Stage 1 released 4,000 BU of the 10,000 BU plan: the cash the agent can move is capped by it.
    expect(BigInt(r.overview.cashAvailableMinor)).toBeLessThanOrEqual(400_000n);
    expect(r.sales.stageGate).toMatchObject({ stageId: "stage-2", targetMinor: "200000", soFarMinor: bucket.toString() });
  });

  it("cfo-guard: a line burning > 1.5x its pace gets a lower window cap, signed by the agent key and landed", async () => {
    const before = await pocket("ADS");
    const b1 = await live.client.getBlockNumber({ cacheTime: 0 });
    await warp(live, DAY);
    const b2 = await live.client.getBlockNumber({ cacheTime: 0 });
    await warp(live, DAY);
    const b3 = await live.client.getBlockNumber({ cacheTime: 0 });
    for (const b of [b1, b2, b3]) await minedAdsSpend(b, "20000"); // 60,000 in 3 days against a 7,500/day pace

    const [first] = await runCfoGuard(w.workerDeps(), [w.facilityId]);
    expect(first).toMatchObject({ facilityId: w.facilityId, status: "ok" });
    expect(first?.tightened).toHaveLength(1);
    expect(first?.tightened[0]).toMatch(/^cfo-guard:\d+:ADS$/);
    // Anvil mines a broadcast tx a moment later: wait for it, or one reconcile pass can still see it pending.
    const [sentRow] = await guardRows();
    await live.client.waitForTransactionReceipt({ hash: sentRow?.tx_hash as `0x${string}` });
    await w.pump();

    const after = await pocket("ADS");
    expect(after.windowCapMinor).toBe(52_500n); // 7 days of pace, whole BU
    expect(after.windowCapMinor).toBeLessThan(before.windowCapMinor);
    expect(after.perTxCapMinor).toBe(before.perTxCapMinor);
    const [row, ...more] = await guardRows();
    expect(more).toEqual([]);
    expect(row).toMatchObject({ state: expect.stringMatching(/^(INCLUDED|FINALIZED)$/) });
    expect(row?.request_json).toMatchObject({ source: "cfo-guard", action: "LOWER_WINDOW_CAP", lineKey: "ADS", newValue: "52500" });
    const traces = await q<{ kind: string; policy_verdict: string | null; tx_hash: string | null; summary: string }>(
      "select kind, policy_verdict, tx_hash, summary from traces where facility_id = $1 and trace_id = $2 order by seq",
      [w.facilityId, row?.request_json.traceId],
    );
    expect(traces.map((t) => [t.kind, t.policy_verdict])).toEqual([
      ["POLICY_VERDICT", "AUTO"],
      ["TX", null],
    ]);
    expect(traces[1]?.tx_hash).toBe(row?.tx_hash);
    // fixr-cfo (re-check LOW 3): the trace and the alert carry the prefilled request that raises the cap back.
    const raise = /\/dashboard\?raise=ADS&cap=window&to=[1-9][0-9]*#change-requests/;
    expect(traces[0]?.summary).toMatch(raise);

    const r = await report();
    expect(r.agentActions).toEqual([expect.objectContaining({ action: "LOWER_WINDOW_CAP", lineKey: "ADS", newValue: "52500", txHash: row?.tx_hash })]);
    const burn = r.insights.find((i) => i.kind === "BURN_ALERT" && i.lineKey === "ADS");
    expect(burn?.suggestion?.href).toMatch(raise);
  });

  it("idempotent per line per chain day: a second run sends nothing, and it never loosens", async () => {
    const [again] = await runCfoGuard(w.workerDeps(), [w.facilityId]);
    expect(again).toMatchObject({ status: "ok", tightened: [] });
    expect(await guardRows()).toHaveLength(1);
    expect((await pocket("ADS")).windowCapMinor).toBe(52_500n);
  });
});
