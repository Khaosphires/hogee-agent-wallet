/**
 * Operations: "Pull the plug" (+ T19), a leaked agent key (T29) and the recovery after it, scripted task 12, a spend
 * while paused (T10) and the agent key revoked (T15). These change the treasury for good, so they run last.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HOGEE_CHAINS, HOGEE_KINDS, buildExecuteLoosen, capFees, iTreasuryAbi, withBuffer } from "@hogee/chain";
import { ChainAction } from "@hogee/core";
import { activeHalt, clearHalt, haltReasons, runAgentActions, runReconcile } from "@hogee/worker";
import { createWalletClient, fallback, http as viemHttp, type Hex } from "viem";
import { expectOk, forcedSend, policyRefusal } from "../actions";
import { txFacts } from "../evidence";
import { actionRow, balances, founderSigns, latestAction, latestTrace, officerApproves, payment, paymentRows, propose, registerInvoice } from "../flows";
import { redactErrorText } from "../redact";
import type { Stack } from "../stack";
import type { CaseDef, Ctx } from "./context";
import { queueLoosening, tightenRow } from "./governance";
import { lineSequence, pacingHash, paused, rand32, spendCall, spendProposal } from "./lib";

const PLUG_CHILD = fileURLToPath(new URL("../plug-child.ts", import.meta.url));
const PACKAGE_DIR = fileURLToPath(new URL("../../", import.meta.url));

function runPlugChild(s: Stack, paymentId: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", PLUG_CHILD], {
      cwd: PACKAGE_DIR,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ...s.childKeyEnv,
        PLUG_CHILD: JSON.stringify({
          dbUrl: s.infra.cfg.databaseUrl,
          chain: s.infra.cfg.target === "anvil" ? "local" : "sepolia",
          rpcUrls: s.infra.cfg.rpcUrls,
          deployment: s.deployment,
          facilityId: s.facilityId,
          paymentId,
          maxFeeWei: s.workerDeps().config.maxFeeWei.toString(),
        }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString()));
    child.stderr.on("data", (b: Buffer) => (err += b.toString()));
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal, out, err: err.slice(0, 2000) }));
  });
}

async function spentFor(s: Stack, intentId: Hex, fromBlock: bigint): Promise<number> {
  const logs = await s.client.getContractEvents({ address: s.deployment.contracts.Treasury.address, abi: iTreasuryAbi, eventName: "Spent", fromBlock, toBlock: "latest" });
  return logs.filter((l) => (l.args as { spendId?: string }).spendId?.toLowerCase() === intentId.toLowerCase()).length;
}

export const DPLUG: CaseDef = {
  id: "D-plug",
  title: "Pull the plug",
  layers: "offchain: the worker is SIGKILLed right after broadcast · onchain_success: exactly one Spent after restart, no second tx, FINALIZED · agent_refusal: the retry with a fresh intentId DENY DuplicateInvoice · onchain_revert: DuplicateInvoice · offchain: drift 0",
  aliases: [{ id: "T19", title: "kill -9 after broadcast, before DB write → one Spent, drift 0, no second tx" }],
  async run(ctx) {
    const s = ctx.s;
    const inv = await registerInvoice(s, { payeeId: "shopee-fees", amountMinor: "5000", label: "plug" });
    const p = await propose(s, ctx.h, "fees invoice", { lineKey: "PLATFORM_FEES", invoiceId: inv.id, reason: "October platform fees" });
    if (p.verdict !== "AUTO" || !p.paymentId) throw new Error(`the plug payment was not AUTO: ${p.verdict} ${p.reasonCode}`);
    const nonceBefore = await s.client.getTransactionCount({ address: s.signers.agent.address, blockTag: "pending" });
    const crash = await runPlugChild(s, p.paymentId);
    const killed = crash.signal === "SIGKILL";
    const afterKill = await payment(s, p.paymentId);
    const art = ctx.artifact("crash", {
      signal: crash.signal,
      code: crash.code,
      out: redactErrorText(crash.out),
      err: redactErrorText(crash.err),
      paymentStateAfterKill: afterKill?.state,
      txHashAfterKill: afterKill?.txHash,
    });
    await ctx.traced({
      title: `kill -9 of the worker right after broadcast: ${crash.signal ?? `exit ${crash.code}`}; the payment row holds the signed tx (state ${afterKill?.state ?? "?"})`,
      expected: "success",
      ok: killed && afterKill?.state === "BROADCAST" && Boolean(afterKill.txHash),
      traceId: afterKill?.traceId ?? p.traceId,
      layer: "offchain",
      artifacts: [art],
    });
    // Restart: reconcile (recovery records the receipt) and the next passes; nothing is signed twice.
    await runReconcile(s.workerDeps(), [s.facilityId]);
    await s.agentRound();
    // On Sepolia (12 s slots) the killed worker's tx can still be pending here: finalize only once it is mined, or the
    // wait covers the block before it and the row stays INCLUDED (rehearsal sep-2). Anvil mined it at broadcast.
    if (afterKill?.txHash) await s.client.waitForTransactionReceipt({ hash: afterKill.txHash, timeout: 300_000 });
    await s.clock.finalize();
    await runReconcile(s.workerDeps(), [s.facilityId]);
    const row = await payment(s, p.paymentId);
    const nonceAfter = await s.client.getTransactionCount({ address: s.signers.agent.address, blockTag: "pending" });
    const facts = row?.txHash ? await txFacts(s.client, s.deployment, row.txHash) : null;
    const spent = facts ? await spentFor(s, row?.intentId as Hex, BigInt(Math.max(0, facts.block - 2))) : 0;
    await ctx.tx({
      title: `After restart: ${spent} Spent for the intent, the agent key used ${nonceAfter - nonceBefore} time(s), payment ${row?.state ?? "?"}`,
      expected: "success",
      ok: spent === 1 && nonceAfter - nonceBefore === 1 && row?.state !== undefined && ["FINALIZED", "SETTLEMENT_REQUESTED", "SETTLED"].includes(row.state),
      facts,
      ...(row?.traceId ? { traceId: row.traceId } : {}),
      ...(row?.decisionId ? { decisionId: row.decisionId } : {}),
    });
    const amount = "5001";
    const r = await policyRefusal(s, "D-plug", "Retry of the paid fees invoice with a fresh intentId (amount 5,001)", (w) =>
      spendProposal(w, { lineKey: "PLATFORM_FEES", payeeId: "shopee-fees", amountMinor: amount, invoiceHash: inv.invoiceHash }),
    );
    await ctx.traced({ title: `Retry with a fresh intentId: policy ${r.decision.verdict} ${r.decision.reasonCode}`, expected: "refused", expectedError: "DuplicateInvoice", ok: r.decision.reasonCode === "DuplicateInvoice", traceId: r.trace.traceId });
    const f = await forcedSend(s, "D-plug", await spendCall(s, { lineKey: "PLATFORM_FEES", payeeId: "shopee-fees", amountMinor: 5_001n, invoiceHash: inv.invoiceHash }), s.signers.agent);
    await ctx.forced("Forced Treasury.spend: the same invoice under a fresh intentId", f, "DuplicateInvoice");
    await s.settleRound();
    const b = await balances(s, ctx.h);
    const settled = await payment(s, p.paymentId);
    const driftRow = { title: `Drift ${b.drift}; the payment's badge is ${settled?.state ?? "?"}`, expected: "success" as const, ok: String(b.drift) === "0" && ["FINALIZED", "SETTLED"].includes(settled?.state ?? ""), layer: "offchain" as const, artifacts: [ctx.artifact("balances", b)] };
    if (settled?.traceId) await ctx.traced({ ...driftRow, traceId: settled.traceId });
    else ctx.plain(driftRow);
    ctx.state.plug = { paymentId: p.paymentId, invoiceId: inv.id, invoiceHash: inv.invoiceHash, amountMinor: "5000", txHash: (row?.txHash ?? "0x") as Hex };
  },
};

export const T29: CaseDef = {
  id: "T29",
  title: "Leaked agent key spends outside backend",
  layers: "onchain_success: a spend by the agent key outside the worker · offchain: the reconciler flags it (halt + safety pause) within one cycle · onchain_success: Treasury.pause · recovery: operator resume + founder/lender UNPAUSE through the timelock",
  async run(ctx) {
    const s = ctx.s;
    const chain = s.infra.cfg.target === "anvil" ? HOGEE_CHAINS.local : HOGEE_CHAINS.sepolia;
    const wallet = createWalletClient({ account: s.signers.agent, chain, transport: fallback(s.infra.cfg.rpcUrls.map((u) => viemHttp(u))) });
    const call = await spendCall(s, { lineKey: "LOGISTICS", payeeId: "spx-logistics", amountMinor: 1_000n, invoiceHash: rand32() });
    const nonce = await s.client.getTransactionCount({ address: s.signers.agent.address, blockTag: "pending" });
    // The same cap as forcedSend and the worker (REDTEAM_MAX_FEE_GWEI on Sepolia): refuse rather than overpay.
    const fees = capFees(await s.client.estimateFeesPerGas(), s.workerDeps().config.maxFeeWei);
    // A wallet's estimate, as the worker's sender (+20 %): this spend must land, and a fixed 500k is OutOfGas under
    // Amsterdam's state-creation prices (EIP-8037: it needs ~654k on a Sepolia fork, ~240k on Anvil's default).
    const gas = withBuffer(await s.client.estimateGas({ account: s.signers.agent.address, to: s.deployment.contracts.Treasury.address, data: call.data }), 20n);
    const started = Date.now();
    const hash = await wallet.sendTransaction({ to: s.deployment.contracts.Treasury.address, data: call.data, gas, nonce, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
    const receipt = await s.client.waitForTransactionReceipt({ hash, timeout: 300_000 });
    await ctx.tx({ title: "The agent key, leaked, sends Treasury.spend(LOGISTICS, 1,000) outside the backend (no payment row, no allocator nonce)", expected: "success", ok: receipt.status === "success", hash });
    const since = new Date(started - 1000);
    await runReconcile(s.workerDeps(), [s.facilityId]);
    await s.pump();
    const halt = await activeHalt(s.db.$client);
    const pauseTx = await s.db.$client.query<{ tx_hash: string | null; kind: string; id: string }>(
      "select tx_hash, kind, id from chain_actions where facility_id = $1 and kind = 'Treasury.pause' and created_at >= $2 order by created_at limit 1",
      [s.facilityId, since],
    );
    await s.clock.finalize();
    await runReconcile(s.workerDeps(), [s.facilityId]);
    const reasons = halt ? await haltReasons(s.db.$client, halt.id) : [];
    const alert = await latestTrace(s, "kind = 'ALERT' and ts >= $2", [since]);
    const isPaused = await paused(s);
    const art = ctx.artifact("halt", { halt, reasons: reasons.map((r) => ({ id: r.id, reason: r.reason, raisedAt: r.raisedAt })), detectedWithinMs: Date.now() - started });
    const flagged = Boolean(halt) && reasons.some((r) => /EXTERNAL_AGENT_KEY_USE|ORPHAN/.test(r.reason));
    const rowIn = { title: `Reconciler: halt "${halt?.reason ?? "none"}" (${reasons.map((r) => r.reason).join(", ")}); treasury paused: ${isPaused}`, expected: "refused" as const, ok: flagged && isPaused, layer: "offchain" as const, artifacts: [art] };
    if (alert) await ctx.traced({ ...rowIn, traceId: alert.traceId });
    else ctx.plain(rowIn);
    const pt = pauseTx.rows[0]?.tx_hash as Hex | undefined;
    if (pt) await ctx.tx({ title: "The safety pause the reconciler queued: Treasury.pause mined (tighten-only, allowed while halted)", expected: "success", ok: true, hash: pt });
    else ctx.plain({ title: "No Treasury.pause tx was sent by the safety pause", expected: "success", ok: false });
    // Recovery, as the run-book says: an operator reviews and resumes the worker; founder + lender co-sign UNPAUSE.
    const cleared = await clearHalt(s.db.$client, s.infra.log, { by: "redteam-operator", note: "T29 drill reviewed: leaked-key spend of 1,000 to a bound payee", ackThrough: "all" });
    ctx.note(`operator resume: ${cleared.status}`);
    const q = await queueLoosening(ctx, "UNPAUSE", {}, "Resume after the T29 drill");
    await s.clock.advance(BigInt(s.infra.cfg.timelockSeconds + 10));
    await s.pump();
    const exec = await latestAction(s, "Treasury.executeLoosen");
    const unpaused = !(await paused(s));
    if (exec?.txHash) await ctx.tx({ title: `Founder + lender UNPAUSE through the timelock; executeLoosen mined; paused now ${!unpaused}`, expected: "success", ok: unpaused, hash: exec.txHash, ...(q.traceId ? { traceId: q.traceId } : {}) });
    else ctx.plain({ title: `UNPAUSE not executed (queue tx ${q.queueTx ?? "none"}); paused ${!unpaused}`, expected: "success", ok: false });
  },
};

export const S12: CaseDef = {
  id: "S12",
  title: "Agent lowers ads cap ✅; early cap raise ❌ TimelockActive; inspection + Rina signs → 70% balance ✅; pause → next spend ❌ Paused",
  layers: "onchain_success tighten · onchain_revert executeLoosen TimelockActive · onchain_success releaseStage, fundMilestone(balance), releaseMilestone · onchain_success pause · onchain_revert spend Paused",
  async run(ctx) {
    const s = ctx.s;
    await tightenRow(ctx, "The agent lowers the ADS per-tx cap 30,000 → 20,000", "LOWER_PER_TX_CAP", "ADS", 20_000n);
    const q = await queueLoosening(ctx, "RAISE_CAP", { lineKey: "ADS", cap: "perTx", newCapMinor: "30000" }, "Raise ads back");
    if (q.queueTx) await ctx.tx({ title: "Founder + lender co-sign RAISE_CAP(ADS 30,000); queueLoosen mined", expected: "success", ok: true, hash: q.queueTx });
    if (q.loosenId) {
      const f = await forcedSend(s, "S12", buildExecuteLoosen({ loosenId: q.loosenId }), s.signers.relayer);
      await ctx.forced("Forced executeLoosen of the ADS raise right away", f, "TimelockActive");
    }
    const open = expectOk<{ exceptionId: string; kind: string }[]>(await ctx.h.get(s.officer, "open exceptions", "/api/exceptions?status=OPEN"), "exceptions");
    const stage = open.find((e) => e.kind === "RELEASE_STAGE");
    if (stage) {
      await officerApproves(s, ctx.h, stage.exceptionId);
      const st = await latestAction(s, "Treasury.releaseStage");
      if (st?.txHash) await ctx.tx({ title: "Sales passed the stage-2 gate; the loan officer releases stage 2 (releaseStage mined)", expected: "success", ok: true, hash: st.txHash });
    } else {
      ctx.plain({ title: "No RELEASE_STAGE exception was opened by the stage gate", expected: "success", ok: false });
    }
    await s.agentRound();
    const balance = (await paymentRows(s, "kind = 'FUND_MILESTONE' and milestone_idx = 2"))[0];
    await ctx.tx({ title: `The agent funds the 70% balance into escrow (${balance?.amountMinor ?? "?"} minor, not released)`, expected: "success", ok: Boolean(balance?.txHash), ...(balance?.txHash ? { hash: balance.txHash, traceId: balance.traceId } : { facts: null }) });
    const form = new FormData();
    form.append("file", new Blob([new TextEncoder().encode(`inspection report ${ctx.taskId}: 500 units, no defects`)], { type: "application/pdf" }), "inspection.pdf");
    const up = await s.founder.form("/api/escrow/order-a-001/inspection", form);
    ctx.h.t.entries.push({ label: "inspection upload", method: "POST", path: "/api/escrow/order-a-001/inspection", status: up.status, response: await up.text() });
    const { req, submit } = await founderSigns(s, ctx.h, "MilestoneRelease", "order-a-001");
    void submit;
    await s.agentRound();
    const rel = (await paymentRows(s, "kind = 'RELEASE_MILESTONE'"))[0];
    await ctx.tx({ title: "Inspection evidence + Rina's passkey MilestoneRelease → the 70% balance is released (releaseMilestone mined)", expected: "success", ok: Boolean(rel?.txHash), ...(rel?.txHash ? { hash: rel.txHash, traceId: req.requestId } : { facts: null }) });
    const pr = expectOk<ChainAction>(await ctx.h.post(s.founder, "pause", "/api/control/pause", {}), "pause");
    await s.pump();
    const pa = await actionRow(s, pr.actionId);
    if (pa?.txHash) await ctx.tx({ title: "Rina pauses the treasury (tighten-only, instant): Treasury.pause mined; the queued raise is cancelled", expected: "success", ok: await paused(s), hash: pa.txHash });
    const slot = await lineSequence(s, "ADS");
    const pp = await propose(s, ctx.h, "next ads slot", { lineKey: "ADS", pacingSlot: Number(slot), reason: "daily ads" });
    await ctx.traced({ title: `The next ads slot while paused: ${pp.verdict} ${pp.reasonCode} (state refusal: traced, never anchored)`, expected: "refused", expectedError: "Paused", ok: pp.verdict === "DENY" && pp.reasonCode === "Paused", traceId: pp.traceId });
    const f = await forcedSend(s, "S12", await spendCall(s, { lineKey: "ADS", payeeId: "shopee-ads", amountMinor: 7_500n, invoiceHash: pacingHash(slot) }), s.signers.agent);
    await ctx.forced("Forced Treasury.spend of the next ads slot while paused", f, "Paused");
  },
};

export const T10: CaseDef = {
  id: "T10",
  title: "Spend while paused",
  layers: "agent_refusal: proposals/spend DENY Paused (traced, never anchored); policy SPEND DENY Paused · onchain_revert: spend while paused Paused",
  async run(ctx) {
    const s = ctx.s;
    const inv = await registerInvoice(s, { payeeId: "spx-logistics", amountMinor: "2000", label: "t10" });
    const p = await propose(s, ctx.h, "invoice while paused", { lineKey: "LOGISTICS", invoiceId: inv.id, reason: "courier" });
    await ctx.traced({ title: `A logistics invoice while the treasury is paused: ${p.verdict} ${p.reasonCode}`, expected: "refused", expectedError: "Paused", ok: p.verdict === "DENY" && p.reasonCode === "Paused", traceId: p.traceId });
    const f = await forcedSend(s, "T10", await spendCall(s, { lineKey: "LOGISTICS", payeeId: "spx-logistics", amountMinor: 2_000n, invoiceHash: inv.invoiceHash }), s.signers.agent);
    await ctx.forced("Forced Treasury.spend(LOGISTICS, 2,000) while paused", f, "Paused");
  },
};

export const T15: CaseDef = {
  id: "T15",
  title: "Expired/revoked agent key",
  layers: "onchain_success: the agent revokes itself (tighten) · agent_refusal: policy SPEND DENY NotAgent · onchain_revert: spend by the revoked key NotAgent · (Anvil extras) AgentExpired after the expiry",
  async run(ctx) {
    const s = ctx.s;
    await tightenRow(ctx, "TIGHTEN_REVOKE_AGENT: the agent key is revoked (as an operator would after a leak)", "REVOKE_AGENT", null, 0n);
    const r = await policyRefusal(s, "T15", "A spend by the revoked agent", (w) => spendProposal(w, { lineKey: "LOGISTICS", payeeId: "spx-logistics", amountMinor: "1000", invoiceHash: rand32() }));
    await ctx.traced({ title: `Policy after the revoke: ${r.decision.verdict} ${r.decision.reasonCode}`, expected: "refused", expectedError: "NotAgent", ok: r.decision.reasonCode === "NotAgent", traceId: r.trace.traceId });
    const f = await forcedSend(s, "T15", await spendCall(s, { lineKey: "LOGISTICS", payeeId: "spx-logistics", amountMinor: 1_000n }), s.signers.agent);
    await ctx.forced("Forced Treasury.spend by the revoked agent key", f, "NotAgent");
  },
};

/** For the plug child and T29: the agent's next pending nonce after recovery (diagnostics in the report). */
export async function agentNonce(s: Stack): Promise<number> {
  return s.client.getTransactionCount({ address: s.signers.agent.address, blockTag: "pending" });
}

export { runAgentActions, HOGEE_KINDS };
