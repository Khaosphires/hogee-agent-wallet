/**
 * Mei's web order and the attacks on it (variant WEB):
 *   S3   report terms (30/70 on 2,500 BU), the payout form, the inline SupplierApproval with the "not verified" row,
 *        bindPayee mined (sepolia-prep TODO S3, second half)
 *   T3   a fake page whose bank holder matches the page passes the holder check, so the schedule is the protection:
 *        one automatic milestone within the per-payment cap and at most half the total; during cooling a forced
 *        deposit reverts PayeeCooling; the balance can never be released by the agent (MilestoneLocked)
 *   S4   after cooling the agent pays the deposit by itself; the payout follows; the order card's row carries the tx
 *        (sepolia-prep TODO S4)
 *   S5   the deposit equals the signed schedule to the minor unit; right after cooling the worker escrows the whole balance
 *        (no per-payment or window cap on milestone funding), which stays locked: the agent's release reverts
 *        MilestoneLocked; one more minor unit on either milestone is refused by the worker policy and reverts
 *        AmountExceedsSchedule (sepolia-prep TODO S5: the "+1 minor" revert it never sent)
 *   T7   a button press replayed with the same actionId does nothing new
 *   T16  USED terms reused: a new SupplierApproval for them, new terms for the bound supplier, the used signature
 *        request again, the mined bindPayee again
 *   T27  what was signed is what binds: a payout hash swapped after Mei signed reverts InvalidSignature on-chain;
 *        terms corrected after prepare, or edited in the database after prepare, are refused at finalize
 */
import {
  buildBindPayee,
  buildFundMilestone,
  buildReleaseMilestone,
  hashMilestoneRelease,
  iMilestoneEscrowAbi,
  iTreasuryAbi,
  shortIdToBytes32,
  toBytes32Tag,
  type HogeeCall,
  type OnchainSig,
  type SupplierApprovalMessage,
} from "@hogee/chain";
import { ChainAction, SignatureRequestResponse, WEB_PAYOUT_CHANNEL, payoutAccountHash, type OrderTerms } from "@hogee/core";
import { fundMilestoneProposal, toMessage } from "@hogee/worker";
import { decodeFunctionData, type Hex } from "viem";
import { expectOk, forcedSend, workerPolicyRefusal } from "../actions";
import { actionRow, b64uToBytes, founderSigns, paymentRows } from "../flows";
import { SELLERS, idOf } from "../web/fixtures";
import { ATTACKER_ACCOUNT, honestPayout } from "../web/payout";
import { firstPart, partTypes } from "../web/stream";
import { DEMO_ORDER } from "../web/terms-attacks";
import type { CaseDef, Ctx } from "./context";
import { domainOf, ecdsa, rand32 } from "./lib";
import { prepare } from "./web-terms";
import { WEB_ONLY, act, action, changed, confirmed, counts, observe, readTerms, ready, refusalOf, refusalText, submitTerms, supplierLimits, termsInput } from "./web-lib";

const P0_100 = [{ bps: 10_000, trigger: "ON_DELIVERY_INSPECTED" as const }];
const BU = 100n;
const UNVERIFIED_ROW = /found by web search, not verified/i;

function order(ctx: Ctx): OrderTerms & { orderId: string } {
  const o = ready(ctx).order;
  if (!o?.orderId) throw new Error("no bound web order from S3 (WEB)");
  return o as OrderTerms & { orderId: string };
}

function searchId(ctx: Ctx): string {
  const s = ready(ctx).search;
  if (!s) throw new Error("no READY search from S3 (WEB)");
  return s.searchId;
}

/** The PENDING (or latest) product bindPayee of `orderId`, with its stored request (what the relay will sign). */
async function bindAction(ctx: Ctx, orderId: string): Promise<{ id: string; state: string; txHash: Hex | null; request: unknown } | null> {
  const r = await ctx.s.db.$client.query<{ id: string; state: string; tx_hash: Hex | null; request_json: unknown }>(
    "select id, state, tx_hash, request_json from chain_actions where facility_id = $1 and kind = 'Treasury.bindPayee' and ref_id = $2 and coalesce(ref_id, '') not like 'redteam:%' order by created_at desc limit 1",
    [ctx.s.facilityId, orderId],
  );
  const x = r.rows[0];
  return x ? { id: x.id, state: x.state, txHash: x.tx_hash, request: x.request_json } : null;
}

export const WEB_S3_ORDER: CaseDef = {
  id: "S3",
  variant: "WEB",
  title: "Report terms (30/70, 2,500 BU), payout form, inline SupplierApproval; bindPayee (cooling starts)",
  layers: "offchain: start_terms → data-terms; POST /api/orders/terms → CONFIRMED, deposit 750 BU auto, balance 1,750 BU after the delivery check; terms_saved → data-sign{SupplierApproval, refId termsId}; the request shows \"not verified\" · onchain_success bindPayee",
  anvilOnly: WEB_ONLY,
  async run(ctx) {
    const w = ready(ctx);
    const sid = searchId(ctx);
    const supplierId = idOf(w.fixture, SELLERS.order);
    const start = await act(ctx, w.sessionId, action({ type: "start_terms", supplierId, preset: "P30_70" }));
    const prefill = firstPart(start.stream, "data-terms");
    const t = confirmed(await submitTerms(ctx, "confirm the demo terms", termsInput({ searchId: sid, supplierId, totalMinor: DEMO_ORDER.totalMinor, milestones: DEMO_ORDER.milestones, payout: honestPayout(SELLERS.order) })), "confirm the demo terms");
    const amounts = t.schedule.map((r) => r.amountMinor);
    const autos = t.schedule.map((r) => r.autoRelease);
    const scheduleOk = t.status === "CONFIRMED" && t.origin === "web" && t.supplierId === supplierId && amounts.join() === `${DEMO_ORDER.depositMinor},${DEMO_ORDER.balanceMinor}` && autos.join() === "true,false" && t.holderName === SELLERS.order;
    await observe(ctx, { title: `start_terms → data-terms for ${prefill?.supplierId === supplierId ? "the picked supplier" : "ANOTHER supplier"}; terms ${t.status}, schedule ${amounts.join(" + ")} (auto ${autos.join("/")})`, expected: "success", ok: scheduleOk && prefill?.supplierId === supplierId, artifacts: [ctx.artifact("terms", t)] });
    const savedPress = action({ type: "terms_saved", termsId: t.termsId });
    const saved = await act(ctx, w.sessionId, savedPress);
    w.answered.push(savedPress);
    const sign = firstPart(saved.stream, "data-sign");
    if (sign?.kind !== "SupplierApproval" || sign.refId !== t.termsId) throw new Error(`terms_saved: no SupplierApproval card for ${t.termsId} (parts ${partTypes(saved.stream).join(", ")})`);
    const signed = await founderSigns(ctx.s, ctx.h, "SupplierApproval", sign.refId);
    const shown = signed.req.displayModel.rows.find((r) => UNVERIFIED_ROW.test(`${r.label} ${r.value}`));
    await observe(ctx, { title: `terms_saved → inline SupplierApproval for the termsId; the request shows "${shown ? `${shown.label}: ${shown.value}`.slice(0, 80) : "NO not-verified row"}" (${shown?.effect ?? "-"})`, expected: "success", ok: Boolean(shown), artifacts: [ctx.artifact("display-model", signed.req.displayModel)] }, signed.req.requestId);
    const submitted = ChainAction.parse(expectOk(signed.submit, "submit SupplierApproval"));
    await act(ctx, w.sessionId, action({ type: "signed", kind: "SupplierApproval", refId: t.termsId }));
    await ctx.s.pump();
    const a = await actionRow(ctx.s, submitted.actionId);
    const bound = await readTerms(ctx, t.termsId);
    w.order = bound;
    w.orderRequestId = signed.req.requestId;
    await ctx.tx({
      title: `SupplierApproval passkey-signed; bindPayee mined; terms ${bound.status}, order ${bound.orderId ?? "none"}, cooling until ${bound.coolingEndsAt ?? "?"}`,
      expected: "success",
      ok: Boolean(a?.txHash) && bound.status === "USED" && bound.orderId !== null,
      traceId: signed.req.requestId,
      ...(a?.txHash ? { hash: a.txHash } : { facts: null }),
    });
  },
};

export const WEB_T3: CaseDef = {
  id: "T3",
  variant: "WEB",
  title: "A fake listing whose bank holder matches the page: what the schedule still bounds",
  layers: "offchain: the confirmed schedule has one automatic milestone, within the per-payment cap and at most half the total · agent_refusal: worker policy FUND_MILESTONE during cooling DENY PayeeCooling · onchain_revert: forced deposit during cooling PayeeCooling; agent-signed release of the balance MilestoneLocked",
  anvilOnly: WEB_ONLY,
  async run(ctx) {
    const o = order(ctx);
    const limits = await supplierLimits(ctx);
    const autos = o.schedule.filter((r) => r.autoRelease);
    const exposed = autos.reduce((n, r) => n + BigInt(r.amountMinor), 0n);
    const ok = autos.length === 1 && exposed <= limits.perTxCapMinor && 2n * exposed <= BigInt(o.totalMinor);
    await observe(ctx, { title: `The holder check cannot tell this seller from a fake with a matching holder, so the schedule bounds it: ${autos.length} automatic milestone(s), at most ${exposed / BU} BU of ${BigInt(o.totalMinor) / BU} BU before Mei signs again (per-payment cap ${limits.perTxCapMinor / BU} BU)`, expected: "refused", ok });
    const deposit = o.schedule[0];
    if (!deposit) throw new Error("no deposit row");
    const r = await workerPolicyRefusal(ctx.s, "T3", "fund the deposit during payee cooling", (c) => fundMilestoneProposal({ orderId: o.orderId, idx: 0, amountMinor: deposit.amountMinor, planVersion: c.planVersion }));
    await ctx.traced({ title: `Fund the deposit during cooling: worker policy ${r.decision.verdict} ${r.decision.reasonCode}`, expected: "refused", expectedError: "PayeeCooling", ok: r.decision.verdict === "DENY" && r.decision.reasonCode === "PayeeCooling", traceId: r.trace.traceId });
    const f = await forcedSend(ctx.s, "T3", buildFundMilestone({ orderId: shortIdToBytes32(o.orderId), idx: 0, amountMinor: BigInt(deposit.amountMinor), decisionId: rand32(), rationaleHash: rand32() }), ctx.s.signers.agent);
    await ctx.forced("Forced MilestoneEscrow.fundMilestone(deposit) by the agent key during payee cooling", f, "PayeeCooling");
    const balance = o.schedule[o.schedule.length - 1];
    if (!balance) throw new Error("no balance row");
    const release = { orderId: shortIdToBytes32(o.orderId), idx: balance.idx, amountMinor: BigInt(balance.amountMinor), evidenceHash: rand32(), deploymentId: toBytes32Tag(ctx.s.deployment.deploymentId), nonce: BigInt(rand32()), expiry: (await ctx.s.clock.now()) + 3_600n };
    const sig = await ecdsa(ctx.s.signers.agent, hashMilestoneRelease(domainOf(ctx.s, "MilestoneEscrow"), release));
    const g = await forcedSend(ctx.s, "T3", buildReleaseMilestone({ release, founder: sig }), ctx.s.signers.agent);
    await ctx.forced("Forced releaseMilestone(balance) signed and sent by the agent key", g, "MilestoneLocked");
  },
};

export const WEB_S4: CaseDef = {
  id: "S4",
  variant: "WEB",
  title: "After cooling the agent pays the web deposit by itself; payout; the order card shows the tx",
  layers: "onchain_success fundMilestone(deposit) (auto-release) + confirmSettlement · offchain: GET /api/orders/terms shows the deposit released with that tx hash",
  anvilOnly: WEB_ONLY,
  async run(ctx) {
    const o = order(ctx);
    await ctx.s.clock.advance(BigInt(ctx.s.infra.cfg.coolingSeconds + 10));
    await ctx.s.pump();
    await ctx.s.agentRound();
    await ctx.s.agentRound();
    await ctx.s.settleRound();
    const dep = (await paymentRows(ctx.s, "kind = 'FUND_MILESTONE' and order_id = $2", [o.orderId])).find((p) => p.milestoneIdx === 0);
    if (!dep?.txHash) {
      await ctx.tx({ title: "The agent funds the web deposit after cooling", expected: "success", ok: false, facts: null });
      return;
    }
    await ctx.tx({ title: `The agent funds the deposit (${dep.amountMinor} minor) by itself after cooling; auto-release; payout ${dep.payoutId ?? "?"}`, expected: "success", ok: dep.amountMinor === o.schedule[0]?.amountMinor, hash: dep.txHash, traceId: dep.traceId, ...(dep.decisionId ? { decisionId: dep.decisionId } : {}), ...(dep.payoutId ? { payoutId: dep.payoutId } : {}) });
    const confirm = await ctx.s.db.$client.query<{ tx_hash: Hex | null }>("select tx_hash from chain_actions where facility_id = $1 and kind = 'Treasury.confirmSettlement' and ref_id = $2 order by created_at desc limit 1", [ctx.s.facilityId, dep.id]);
    const c = confirm.rows[0]?.tx_hash;
    await ctx.tx({ title: `Simulated payout settled (${ctx.s.rail.name} rail, MOCK_ONLY payee); the oracle confirms it on-chain`, expected: "success", ok: Boolean(c) && dep.state !== "SETTLEMENT_FAILED", ...(c ? { hash: c } : { facts: null }), ...(dep.payoutId ? { payoutId: dep.payoutId } : {}) });
    const after = await readTerms(ctx, o.termsId);
    ready(ctx).order = after;
    const row = after.schedule[0];
    await observe(ctx, { title: `The order card's deposit row: released ${row?.released}, tx ${row?.txHash === dep.txHash ? "= the funding tx" : (row?.txHash ?? "none")}; the balance row released ${after.schedule[1]?.released}`, expected: "success", ok: row?.released === true && row.txHash === dep.txHash && after.schedule[1]?.released === false }, dep.traceId);
  },
};

/** The order's milestones as MilestoneEscrow holds them (funded, released), read from the chain. */
async function chainMilestones(ctx: Ctx, orderId: string): Promise<readonly { amountMinor: bigint; fundedMinor: bigint; autoRelease: boolean; released: boolean }[]> {
  return ctx.s.client.readContract({ address: ctx.s.deployment.contracts.MilestoneEscrow.address, abi: iMilestoneEscrowAbi, functionName: "milestones", args: [shortIdToBytes32(orderId)] });
}

export const WEB_S5: CaseDef = {
  id: "S5",
  variant: "WEB",
  title: "The web order is funded exactly as signed: deposit paid, balance escrowed but locked; +1 minor reverts",
  layers: "onchain_success: the deposit funded and released equals schedule[0] to the minor unit; right after cooling the agent escrows the whole balance (schedule[1]), not released (MilestoneEscrow.milestones) · agent_refusal: worker policy FUND_MILESTONE(balance, +1 minor) DENY AmountExceedsSchedule · onchain_revert: fundMilestone(deposit, +1) and fundMilestone(balance, +1) AmountExceedsSchedule; releaseMilestone(balance) by the agent key MilestoneLocked",
  anvilOnly: WEB_ONLY,
  async run(ctx) {
    const o = order(ctx);
    const deposit = o.schedule[0];
    const balance = o.schedule[o.schedule.length - 1];
    if (!deposit || !balance || deposit.idx === balance.idx) throw new Error("the web order has no deposit and balance rows");
    const ms = await paymentRows(ctx.s, "kind = 'FUND_MILESTONE' and order_id = $2", [o.orderId]);
    const fundedOf = (idx: number): bigint => ms.filter((p) => p.milestoneIdx === idx).reduce((n, p) => n + BigInt(p.amountMinor), 0n);
    const onChain = await chainMilestones(ctx, o.orderId);
    const dep = ms.find((p) => p.milestoneIdx === deposit.idx);
    const cd = onChain[deposit.idx];
    await ctx.tx({
      title: `The deposit funded: ${fundedOf(deposit.idx)} minor (signed ${deposit.amountMinor}); on-chain funded ${cd?.fundedMinor ?? "?"}, released ${cd?.released ?? "?"}`,
      expected: "success",
      ok: dep?.amountMinor === deposit.amountMinor && fundedOf(deposit.idx) === BigInt(deposit.amountMinor) && cd?.fundedMinor === BigInt(deposit.amountMinor) && cd.released && Boolean(dep.txHash),
      ...(dep?.txHash ? { hash: dep.txHash, traceId: dep.traceId } : { facts: null }),
    });
    const bal = ms.filter((p) => p.milestoneIdx === balance.idx);
    const lastBal = bal[bal.length - 1];
    const cb = onChain[balance.idx];
    const escrowed = fundedOf(balance.idx);
    await ctx.tx({
      title: `The balance escrowed by the agent right after cooling: ${escrowed} minor in ${bal.length} funding(s) (signed ${balance.amountMinor}); on-chain funded ${cb?.fundedMinor ?? "?"}, released ${cb?.released ?? "?"} (waits for the delivery check and Mei)`,
      expected: "success",
      ok: bal.length >= 1 && bal.every((p) => p.txHash) && escrowed === BigInt(balance.amountMinor) && cb?.fundedMinor === BigInt(balance.amountMinor) && cb.amountMinor === BigInt(balance.amountMinor) && !cb.autoRelease && !cb.released,
      ...(lastBal?.txHash ? { hash: lastBal.txHash, traceId: lastBal.traceId } : { facts: null }),
    });
    const r = await workerPolicyRefusal(ctx.s, "S5", "fund the escrowed balance with one more minor unit", (c) => fundMilestoneProposal({ orderId: o.orderId, idx: balance.idx, amountMinor: "1", planVersion: c.planVersion }));
    await ctx.traced({ title: `Fund the balance with +1 minor (already escrowed in full): worker policy ${r.decision.verdict} ${r.decision.reasonCode}`, expected: "refused", expectedError: "AmountExceedsSchedule", ok: r.decision.verdict === "DENY" && r.decision.reasonCode === "AmountExceedsSchedule", traceId: r.trace.traceId });
    const id = shortIdToBytes32(o.orderId);
    const f = await forcedSend(ctx.s, "S5", buildFundMilestone({ orderId: id, idx: deposit.idx, amountMinor: 1n, decisionId: rand32(), rationaleHash: rand32() }), ctx.s.signers.agent);
    await ctx.forced("Forced fundMilestone(deposit, +1 minor) after the deposit was funded in full", f, "AmountExceedsSchedule");
    const g = await forcedSend(ctx.s, "S5", buildFundMilestone({ orderId: id, idx: balance.idx, amountMinor: 1n, decisionId: rand32(), rationaleHash: rand32() }), ctx.s.signers.agent);
    await ctx.forced(`Forced fundMilestone(balance, +1 minor) after the balance was escrowed in full (signed ${balance.amountMinor}) by the agent key`, g, "AmountExceedsSchedule");
    const release = { orderId: id, idx: balance.idx, amountMinor: BigInt(balance.amountMinor), evidenceHash: rand32(), deploymentId: toBytes32Tag(ctx.s.deployment.deploymentId), nonce: BigInt(rand32()), expiry: (await ctx.s.clock.now()) + 3_600n };
    const sig = await ecdsa(ctx.s.signers.agent, hashMilestoneRelease(domainOf(ctx.s, "MilestoneEscrow"), release));
    const h = await forcedSend(ctx.s, "S5", buildReleaseMilestone({ release, founder: sig }), ctx.s.signers.agent);
    await ctx.forced("Forced releaseMilestone(escrowed balance) signed and sent by the agent key", h, "MilestoneLocked");
  },
};

export const WEB_T7: CaseDef = {
  id: "T7",
  variant: "WEB",
  title: "A chat button replayed with the same actionId",
  layers: "offchain: start_search and terms_saved replayed with their actionIds: HTTP 200, no new search, terms, signature request or chain action, no sign card, no other search",
  anvilOnly: WEB_ONLY,
  async run(ctx) {
    const w = ready(ctx);
    const sid = w.search?.searchId;
    for (const press of w.answered) {
      const before = await counts(ctx);
      const turn = await act(ctx, w.sessionId, press, `replay ${press.type} ${press.actionId}`);
      const after = await counts(ctx);
      const searches = turn.stream.parts.filter((p) => p.type === "data-search").map((p) => (p.data as { searchId: string }).searchId);
      const signs = turn.stream.parts.filter((p) => p.type === "data-sign").length;
      const ok = turn.status === 200 && after.webSearches === before.webSearches && after.supplierTerms === before.supplierTerms && after.signatureRequests === before.signatureRequests && after.chainActions === before.chainActions && signs === 0 && searches.every((x) => x === sid);
      await observe(ctx, { title: `Replayed ${press.type} (same actionId): HTTP ${turn.status}; new rows ${changed(before, after).join(", ") || "none"}; sign cards ${signs}; parts ${partTypes(turn.stream).join(", ") || "text only"}`, expected: "refused", ok });
    }
    if (w.answered.length < 2) await observe(ctx, { title: `Only ${w.answered.length} answered action(s) to replay (S3 (WEB) did not finish)`, expected: "refused", ok: false });
  },
};

export const WEB_T16: CaseDef = {
  id: "T16",
  variant: "WEB",
  title: "USED web terms reused",
  layers: "agent_refusal: a new SupplierApproval for the USED terms 409 TERMS_ALREADY_BOUND; new terms for the bound supplier 409 TERMS_ALREADY_BOUND; the used signature request again 409 · onchain_revert: the mined bindPayee replayed InvalidSignature (nonce used) or SignatureExpired",
  anvilOnly: WEB_ONLY,
  async run(ctx) {
    const w = ready(ctx);
    const o = order(ctx);
    const again = refusalOf(await prepare(ctx, "SupplierApproval for USED terms", o.termsId));
    await observe(ctx, { title: `A new SupplierApproval for the USED terms: ${refusalText(again)}`, expected: "refused", ok: again.status === 409 && again.reason === "TERMS_ALREADY_BOUND" }, again.traceId);
    const more = refusalOf(await submitTerms(ctx, "new terms for the bound supplier", termsInput({ searchId: searchId(ctx), supplierId: o.supplierId, totalMinor: 500n * BU, milestones: P0_100, payout: honestPayout(SELLERS.order, ATTACKER_ACCOUNT) })));
    await observe(ctx, { title: `New terms (another account) for the supplier already bound: ${refusalText(more)} (one order per web supplier)`, expected: "refused", ok: more.status === 409 && more.reason === "TERMS_ALREADY_BOUND" }, more.traceId);
    if (w.orderRequestId) {
      const r = await ctx.h.post(ctx.s.founder, "resubmit the used request", `/api/signatures/${w.orderRequestId}/submit`, { passkey: ctx.s.auth.assert(new Uint8Array(32)) });
      await observe(ctx, { title: `The used SupplierApproval request submitted again: HTTP ${r.status}`, expected: "refused", ok: r.status === 409 }, w.orderRequestId);
    }
    const bind = await bindAction(ctx, o.orderId);
    if (!bind?.txHash) throw new Error("no mined bindPayee for the web order");
    const tx = await ctx.s.client.getTransaction({ hash: bind.txHash });
    const [approval] = decodeFunctionData({ abi: iTreasuryAbi, data: tx.input }).args as unknown as [SupplierApprovalMessage];
    const expired = approval.expiry < (await ctx.s.clock.now());
    const f = await forcedSend(ctx.s, "T16", { contract: "Treasury", functionName: "bindPayee", kind: "Treasury.bindPayee", data: tx.input } as HogeeCall, ctx.s.signers.relayer);
    await ctx.forced(`The web order's mined bindPayee replayed by the relayer (${expired ? "past its expiry" : "same nonce"})`, f, expired ? "SignatureExpired" : "InvalidSignature");
  },
};

/** request_json of a bindPayee row → the call with the payout hash swapped (Mei's signature kept). */
function tamperedBind(request: unknown, payoutAccountHash: Hex): HogeeCall {
  const r = request as { approval: Record<string, string | boolean>; schedule: string[]; autoRelease: boolean[]; founder: OnchainSig };
  const approval = toMessage("SupplierApproval", r.approval) as unknown as SupplierApprovalMessage;
  return buildBindPayee({ approval: { ...approval, payoutAccountHash }, schedule: r.schedule.map((x) => BigInt(x)), autoRelease: [...r.autoRelease], founder: r.founder });
}

/** Confirm + prepare terms for Ashmere at `bu` (P0_100); returns the terms and the prepared request. */
async function preparedAshmere(ctx: Ctx, label: string, bu: bigint): Promise<{ t: OrderTerms; req: SignatureRequestResponse }> {
  const w = ready(ctx);
  const t = confirmed(await submitTerms(ctx, label, termsInput({ searchId: searchId(ctx), supplierId: idOf(w.fixture, SELLERS.prepare), totalMinor: bu * BU, milestones: P0_100, payout: honestPayout(SELLERS.prepare) })), label);
  const req = SignatureRequestResponse.parse(expectOk(await prepare(ctx, `prepare ${label}`, t.termsId), `prepare ${label}`));
  return { t, req };
}

const bindCount = async (ctx: Ctx): Promise<number> =>
  (await ctx.s.db.$client.query<{ n: number }>("select count(*)::int as n from chain_actions where facility_id = $1 and kind = 'Treasury.bindPayee' and coalesce(ref_id, '') not like 'redteam:%'", [ctx.s.facilityId])).rows[0]?.n ?? -1;

export const WEB_T27: CaseDef = {
  id: "T27",
  variant: "WEB",
  title: "What Mei signed is what binds: payout hash swapped, terms changed after prepare",
  layers: "onchain_revert: bindPayee with Mei's signature and another payout hash InvalidSignature; the honest bind then succeeds · agent_refusal: terms corrected after prepare → finalize 409 TERMS_SUPERSEDED; terms edited in the database after prepare → finalize 409 CONFLICT; neither creates a bindPayee",
  anvilOnly: WEB_ONLY,
  async run(ctx) {
    const w = ready(ctx);
    const tidelume = idOf(w.fixture, SELLERS.limits);
    const t = confirmed(await submitTerms(ctx, "terms for the payout-swap probe", termsInput({ searchId: searchId(ctx), supplierId: tidelume, totalMinor: 500n * BU, milestones: P0_100, payout: honestPayout(SELLERS.limits) })), "confirm Tidelume");
    const signed = await founderSigns(ctx.s, ctx.h, "SupplierApproval", t.termsId);
    expectOk(signed.submit, "submit SupplierApproval (Tidelume)");
    const used = await readTerms(ctx, t.termsId);
    const pending = used.orderId ? await bindAction(ctx, used.orderId) : null;
    if (!pending || pending.txHash) throw new Error(`no unsent bindPayee for ${used.orderId ?? "?"} (${pending?.state ?? "none"})`);
    // Core payoutAccountHash (keccak256 of the JCS preimage), exactly as the API would hash the attacker's account.
    const attacker = payoutAccountHash({ channel: WEB_PAYOUT_CHANNEL, accountNumber: ATTACKER_ACCOUNT, holderName: SELLERS.limits }) as Hex;
    const f = await forcedSend(ctx.s, "T27", tamperedBind(pending.request, attacker), ctx.s.signers.relayer);
    await ctx.forced("bindPayee with Mei's SupplierApproval signature but the attacker's payout hash (sent by the relayer before the honest bind)", f, "InvalidSignature");
    await ctx.s.pump();
    const honest = await actionRow(ctx.s, pending.id);
    await ctx.tx({ title: `The honest bindPayee (the account Mei typed, hash ${used.payoutAccountHash.slice(0, 10)}…) then binds`, expected: "success", ok: Boolean(honest?.txHash) && honest?.state !== "REVERTED", ...(honest?.txHash ? { hash: honest.txHash } : { facts: null }), traceId: signed.req.requestId });

    const a = await preparedAshmere(ctx, "terms A (300 BU)", 300n);
    const binds = await bindCount(ctx);
    confirmed(await submitTerms(ctx, "corrected terms A' (350 BU)", termsInput({ searchId: searchId(ctx), supplierId: a.t.supplierId, totalMinor: 350n * BU, milestones: P0_100, payout: honestPayout(SELLERS.prepare) })), "corrected terms");
    const lateA = refusalOf(await ctx.h.post(ctx.s.founder, "submit A's signature after the correction", `/api/signatures/${a.req.requestId}/submit`, { passkey: ctx.s.auth.assert(b64uToBytes(a.req.challengeB64url)) }));
    const bindsA = (await bindCount(ctx)) - binds;
    await observe(ctx, { title: `Terms corrected after prepare, then the first request signed: ${refusalText(lateA)}; new bindPayee ${bindsA}`, expected: "refused", ok: lateA.status === 409 && lateA.reason === "TERMS_SUPERSEDED" && bindsA === 0 }, lateA.traceId ?? a.req.requestId);

    const b = await preparedAshmere(ctx, "terms B (300 BU)", 300n);
    await ctx.s.db.$client.query(`update supplier_terms set terms_json = '[{"bps":5000,"trigger":"ON_ORDER"},{"bps":5000,"trigger":"ON_DELIVERY_INSPECTED"}]'::jsonb where facility_id = $1 and id = $2`, [ctx.s.facilityId, b.t.termsId]);
    const before = await counts(ctx);
    const lateB = refusalOf(await ctx.h.post(ctx.s.founder, "submit B's signature after a database edit", `/api/signatures/${b.req.requestId}/submit`, { passkey: ctx.s.auth.assert(b64uToBytes(b.req.challengeB64url)) }));
    const after = await counts(ctx);
    await observe(ctx, { title: `Terms edited in the database after prepare (a 50% automatic deposit added), then signed: ${refusalText(lateB)}; new chain actions ${after.chainActions - before.chainActions}`, expected: "refused", ok: lateB.status === 409 && lateB.code === "CONFLICT" && after.chainActions === before.chainActions }, lateB.traceId ?? b.req.requestId);
  },
};
