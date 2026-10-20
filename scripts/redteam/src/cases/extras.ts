/**
 * Anvil-only cases on a fresh final-1 world (the extras world): exact block timestamps and long clock jumps that
 * Sepolia's 12 s slots and real time cannot give.
 *   T22  full window cap at window end −1 s and +1 s (§13.2: "proven in forge/Anvil only")
 *   T15  the AgentExpired variant: the plan's agent expiry passes (60 days)
 */
import { iTreasuryAbi } from "@hogee/chain";
import { runAgentActions } from "@hogee/worker";
import { forcedSend, policyRefusal } from "../actions";
import { txFacts } from "../evidence";
import { chatToDraft, fundFacility, openAndRegister, payment, propose, registerInvoice, signPlan } from "../flows";
import type { CaseDef, Ctx } from "./context";
import { spendCall, spendProposal } from "./lib";

const WINDOW = 604_800n;
const ANVIL_ONLY_T22 = "proven on Anvil only (project.md §13.2 T22): Sepolia's 12 s slots cannot place blocks at window end ±1 s";
const ANVIL_ONLY_T15 = "the AgentExpired variant needs a 60-day clock jump (Anvil only); the revoked-key variant ran in the main world";

async function bootstrap(ctx: Ctx): Promise<void> {
  if (ctx.state.planActionId) return;
  await openAndRegister(ctx.s, ctx.h);
  const draftId = await chatToDraft(ctx.s, ctx.h, "01a14202-2800-7000-8000-00000000e115");
  ctx.state.planActionId = (await signPlan(ctx.s, ctx.h, draftId)).actionId;
  await fundFacility(ctx.s, ctx.h, "1000000");
}

async function blockTime(ctx: Ctx, block: number): Promise<bigint> {
  return (await ctx.s.client.getBlock({ blockNumber: BigInt(block) })).timestamp;
}

export const T22: CaseDef = {
  id: "T22",
  title: "Full cap at window end −1 s and +1 s",
  anvilOnly: ANVIL_ONLY_T22,
  layers: "onchain_success: two spends fill LOGISTICS' 7-day cap in one block · onchain_revert: a third at window end −1 s CapExceeded · agent_refusal: the proposal at −1 s DENY CapExceeded · onchain_success: at +1 s it is AUTO and lands",
  async run(ctx) {
    const s = ctx.s;
    await bootstrap(ctx);
    const a = await registerInvoice(s, { payeeId: "spx-logistics", amountMinor: "20000", label: "t22-a" });
    const b = await registerInvoice(s, { payeeId: "spx-logistics", amountMinor: "20000", label: "t22-b" });
    const pa = await propose(s, ctx.h, "fill 1", { lineKey: "LOGISTICS", invoiceId: a.id, reason: "fill the window" });
    const pb = await propose(s, ctx.h, "fill 2", { lineKey: "LOGISTICS", invoiceId: b.id, reason: "fill the window" });
    await s.clock.setAutomine?.(false);
    try {
      await runAgentActions(s.workerDeps(), [s.facilityId]);
      await s.clock.mine?.(1);
    } finally {
      await s.clock.setAutomine?.(true);
    }
    await s.pump();
    const ra = pa.paymentId ? await payment(s, pa.paymentId) : null;
    const rb = pb.paymentId ? await payment(s, pb.paymentId) : null;
    if (!ra?.txHash || !rb?.txHash) throw new Error("the two window-filling spends were not mined");
    const fa = await txFacts(s.client, s.deployment, ra.txHash);
    const fb = await txFacts(s.client, s.deployment, rb.txHash);
    const t0 = await blockTime(ctx, fa.block);
    await ctx.tx({ title: `Two 20,000 spends fill the 40,000 LOGISTICS window in block ${fa.block} (t0 = ${t0})`, expected: "success", ok: fa.block === fb.block && fa.status === "success" && fb.status === "success", facts: fa, traceId: ra.traceId });
    await ctx.tx({ title: `Second window-filling spend, same block ${fb.block}`, expected: "success", ok: fb.status === "success", facts: fb, traceId: rb.traceId });

    await s.clock.setNextTimestamp?.(t0 + WINDOW - 1n);
    const c = await registerInvoice(s, { payeeId: "spx-logistics", amountMinor: "20000", label: "t22-c" });
    const f = await forcedSend(s, "T22", await spendCall(s, { lineKey: "LOGISTICS", payeeId: "spx-logistics", amountMinor: 20_000n, invoiceHash: c.invoiceHash }), s.signers.agent);
    const tMinus = f.facts ? await blockTime(ctx, f.facts.block) : 0n;
    await ctx.forced(`Forced 20,000 spend mined at t0 + window − ${t0 + WINDOW - tMinus} s (block ts ${tMinus})`, f, "CapExceeded");
    const pc = await propose(s, ctx.h, "third at -1 s", { lineKey: "LOGISTICS", invoiceId: c.id, reason: "window end" });
    await ctx.traced({ title: `The same invoice proposed at t0 + window − 1 s: ${pc.verdict} ${pc.reasonCode}`, expected: "refused", expectedError: "CapExceeded", ok: pc.verdict === "DENY" && pc.reasonCode === "CapExceeded", traceId: pc.traceId });

    await s.clock.setNextTimestamp?.(t0 + WINDOW + 1n);
    await s.clock.mine?.(1);
    const d = await registerInvoice(s, { payeeId: "spx-logistics", amountMinor: "20000", label: "t22-d" });
    const pd = await propose(s, ctx.h, "fourth at +1 s", { lineKey: "LOGISTICS", invoiceId: d.id, reason: "next window" });
    await s.agentRound();
    const rd = pd.paymentId ? await payment(s, pd.paymentId) : null;
    const fd = rd?.txHash ? await txFacts(s.client, s.deployment, rd.txHash) : null;
    const tPlus = fd ? await blockTime(ctx, fd.block) : 0n;
    await ctx.tx({
      title: `At t0 + window + 1 s the policy is ${pd.verdict}; the 20,000 spend lands at t0 + window + ${tPlus - t0 - WINDOW} s`,
      expected: "success",
      ok: pd.verdict === "AUTO" && fd?.status === "success" && tPlus > t0 + WINDOW,
      facts: fd,
      ...(rd?.traceId ? { traceId: rd.traceId } : {}),
    });
  },
};

export const T15X: CaseDef = {
  id: "T15",
  title: "Expired/revoked agent key (AgentExpired variant)",
  anvilOnly: ANVIL_ONLY_T15,
  layers: "agent_refusal: policy SPEND DENY AgentExpired · onchain_revert: spend after agentExpiry AgentExpired",
  async run(ctx) {
    const s = ctx.s;
    await bootstrap(ctx);
    const expiry = await s.client.readContract({ address: s.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: "agentExpiry" });
    const now = await s.clock.now();
    if (expiry > now) await s.clock.advance(expiry - now + 60n);
    const r = await policyRefusal(s, "T15", "A spend after the agent's expiry", (w) => spendProposal(w, { lineKey: "LOGISTICS", payeeId: "spx-logistics", amountMinor: "1000", invoiceHash: `0x${"7".repeat(64)}` }));
    await ctx.traced({ title: `Policy after agentExpiry (${expiry}): ${r.decision.verdict} ${r.decision.reasonCode}`, expected: "refused", expectedError: "AgentExpired", ok: r.decision.reasonCode === "AgentExpired", traceId: r.trace.traceId });
    const f = await forcedSend(s, "T15", await spendCall(s, { lineKey: "LOGISTICS", payeeId: "spx-logistics", amountMinor: 1_000n }), s.signers.agent);
    await ctx.forced("Forced Treasury.spend by the agent key after its expiry", f, "AgentExpired");
  },
};
