/**
 * §19.1 scripted tasks 1–5 (the happy path the attacks then run against), in §26.1 order: the facility is opened and
 * Rina's keys registered (step 0), the plan is committed (task 2) BEFORE the lender funds (task 1), because funding is
 * capped at the committed plan total (Treasury.fund: CapExceeded above it), exactly as §26.1 steps 3–4 run.
 */
import { buildFund } from "@hogee/chain";
import { ChainAction, SignatureRequestResponse } from "@hogee/core";
import { forcedSend } from "../actions";
import { actionRow, b64uToBytes, chatToDraft, fundFacility, openAndRegister, paymentRows, shortlist, signPlan } from "../flows";
import { expectOk } from "../actions";
import type { CaseDef, Ctx } from "./context";

export const SESSION_ID = "01a14202-2800-7000-8000-00000000f115";

async function actionTx(ctx: Ctx, actionId: string, title: string, extra: { traceId?: string } = {}): Promise<boolean> {
  const a = await actionRow(ctx.s, actionId);
  if (!a?.txHash) {
    ctx.note(`${title}: action ${actionId} has no tx (${a?.state ?? "missing"} ${a?.revertReason ?? ""})`);
    return ctx.tx({ title, expected: "success", ok: false, facts: null });
  }
  return ctx.tx({ title, expected: "success", ok: true, hash: a.txHash, ...extra });
}

/** §26.1 step 0 (its rows are filed under S2, the task it enables). */
export const STEP0: CaseDef = {
  id: "S2",
  title: "Rina signs PlanManifest v1 with a passkey; the relayer submits commitPlan",
  layers: "onchain_success openFacility + registerFounderKey (step 0) · offchain: enrolment without the officer's one-time code refused (G2, run-4 lead 5)",
  async run(ctx) {
    const st = await openAndRegister(ctx.s, ctx.h);
    ctx.state.openActionId = st.openActionId;
    ctx.state.registerActionId = st.registerActionId;
    await actionTx(ctx, st.openActionId, "Step 0: the lender opens the facility (cap 1,000,000, reserve floor 300 bps)");
    const e = st.enrolment;
    // Its own artifact: STEP0 and S2 share the task id, so S2's transcript replaces artifacts/S2/http.json.
    const art = ctx.artifact("enrolment-refusals", { guessBeforeIssue: e.guessBeforeIssue, wrongCode: e.wrongCode, noCode: e.noCode });
    const refused = {
      title: `Step 0: no first-come enrolment: passkey options with a guessed code before any was issued ${e.guessBeforeIssue.status}, a wrong code ${e.wrongCode.status}, no code ${e.noCode.status}; only the officer's one-time code registers`,
      expected: "refused" as const,
      ok: e.guessBeforeIssue.status === 403 && e.wrongCode.status === 403 && e.noCode.status >= 400 && e.noCode.status < 500,
      layer: "offchain" as const,
      artifacts: [art],
    };
    if (e.registrationTraceId) await ctx.traced({ ...refused, traceId: e.registrationTraceId });
    else ctx.plain({ ...refused, title: `${refused.title} (no registration trace found)`, ok: false });
    await actionTx(ctx, st.registerActionId, "Step 0: the lender registers Rina's passkey (P-256) and backup EOA, read from the officer's pending-key view");
  },
};

export const S2: CaseDef = {
  id: "S2",
  title: "Rina signs PlanManifest v1 with a passkey; the relayer submits commitPlan",
  layers: "onchain_success commitPlan (PlanCommitted, stage 1 released) + the signature trace",
  async run(ctx) {
    // The compliant plan the compiler regenerated in "Poison the planner"; a fresh chat draft if that case failed.
    ctx.state.draftId ??= await chatToDraft(ctx.s, ctx.h, SESSION_ID);
    ctx.state.sessionId ??= SESSION_ID;
    const signed = await signPlan(ctx.s, ctx.h, ctx.state.draftId);
    ctx.state.planRequestId = signed.requestId;
    ctx.state.planActionId = signed.actionId;
    await actionTx(ctx, signed.actionId, "PlanManifest v1 passkey-signed (software P-256 authenticator, on-chain WebAuthn verify); commitPlan mined", {
      traceId: signed.requestId,
    });
  },
};

export const S1: CaseDef = {
  id: "S1",
  title: "Lender funds 10,000 BU (capped at the plan total)",
  layers: "onchain_success fund(1,000,000) + onchain_revert fund(+1) CapExceeded (the cap)",
  async run(ctx) {
    const r = await fundFacility(ctx.s, ctx.h, "1000000");
    const action = expectOk<ChainAction>(r, "fund");
    const a = await actionRow(ctx.s, action.actionId);
    await ctx.tx({ title: "The lender funds 1,000,000 minor (10,000 BU), the plan total", expected: "success", ok: Boolean(a?.txHash), ...(a?.txHash ? { hash: a.txHash } : { facts: null }) });
    const over = await ctx.h.post(ctx.s.officer, "fund above the plan total", "/api/facility/fund", { amountMinor: "1" });
    ctx.note(`the API answers HTTP ${over.status} to funding 1 more minor unit (no chain action); the chain's own cap is the row below`);
    const f = await forcedSend(ctx.s, "S1", buildFund({ amountMinor: 1n }), ctx.s.signers.lender);
    await ctx.forced("Forced fund(1) by the lender above the plan total: mined revert", f, "CapExceeded");
  },
};

export const S3: CaseDef = {
  id: "S3",
  title: "Shortlist → Rina picks A, signs SupplierApproval; bindPayee (cooling)",
  layers: "offchain shortlist (A first) + onchain_success bindPayee (PayeeBound, coolingUntil)",
  async run(ctx) {
    const sl = await shortlist(ctx.s, ctx.h);
    ctx.state.shortlistRequestId = sl.requestId;
    const first = (sl.shortlist as { candidates?: { supplierId: string }[] }).candidates?.[0]?.supplierId;
    await ctx.traced({ title: `Shortlist ranks ${first ?? "nobody"} first (expected supplier-a)`, expected: "success", ok: first === "supplier-a", layer: "offchain", traceId: sl.requestId, artifacts: [ctx.artifact("shortlist", sl.shortlist)] });
    const req = SignatureRequestResponse.parse(
      expectOk(await ctx.h.post(ctx.s.founder, "request SupplierApproval", "/api/signatures/request", { kind: "SupplierApproval", refId: "order-a-001", method: "passkey" }), "request SupplierApproval"),
    );
    ctx.state.supplierRequestId = req.requestId;
    const submitted = expectOk<ChainAction>(
      await ctx.h.post(ctx.s.founder, "submit SupplierApproval", `/api/signatures/${req.requestId}/submit`, { passkey: ctx.s.auth.assert(b64uToBytes(req.challengeB64url)) }),
      "submit SupplierApproval",
    );
    await ctx.s.pump();
    const a = await actionRow(ctx.s, submitted.actionId);
    await ctx.tx({
      title: "SupplierApproval passkey-signed; bindPayee mined (payee cooling starts)",
      expected: "success",
      ok: Boolean(a?.txHash),
      traceId: req.requestId,
      ...(a?.txHash ? { hash: a.txHash } : { facts: null }),
      artifacts: [ctx.artifact("display-model", req.displayModel)],
    });
  },
};

/** Cooling, then one agent round: agent-actions funds the auto-release sample + deposit; the tick pays an ADS slot. */
async function coolAndPay(ctx: Ctx): Promise<void> {
  await ctx.s.clock.advance(BigInt(ctx.s.infra.cfg.coolingSeconds + 10));
  await ctx.s.pump();
  await ctx.s.agentRound();
  await ctx.s.agentRound();
}

export const S4: CaseDef = {
  id: "S4",
  title: "Agent pays the sample → payout referencing the tx hash",
  layers: "onchain_success fundMilestone(0) (MilestoneFunded + MilestoneReleased) + payout + confirmSettlement",
  async run(ctx) {
    await coolAndPay(ctx);
    await ctx.s.settleRound();
    const ms = await paymentRows(ctx.s, "kind = 'FUND_MILESTONE'");
    const sample = ms.find((p) => p.milestoneIdx === 0);
    if (!sample?.txHash) {
      await ctx.tx({ title: "The agent funds the sample (30,000) into escrow", expected: "success", ok: false, facts: null });
      return;
    }
    await ctx.tx({
      title: "The agent funds the sample (30,000); auto-release; payout requested with the tx hash as reference",
      expected: "success",
      ok: true,
      hash: sample.txHash,
      traceId: sample.traceId,
      ...(sample.decisionId ? { decisionId: sample.decisionId } : {}),
      ...(sample.payoutId ? { payoutId: sample.payoutId } : {}),
    });
    const confirm = await ctx.s.db.$client.query<{ tx_hash: string | null; state: string }>(
      "select tx_hash, state from chain_actions where facility_id = $1 and kind = 'Treasury.confirmSettlement' and ref_id = $2 order by created_at desc limit 1",
      [ctx.s.facilityId, sample.id],
    );
    const c = confirm.rows[0];
    const payout = sample.payoutId
      ? await ctx.s.db.$client.query("select * from hogee_worker.mock_payouts where payout_id = $1", [sample.payoutId]).then((r) => r.rows[0] ?? null, () => null)
      : null;
    await ctx.tx({
      title: `Payout ${sample.payoutId ?? "?"} settled (${ctx.s.rail.name} rail); the oracle confirms the settlement on-chain`,
      expected: "success",
      ok: Boolean(c?.tx_hash) && sample.state !== "SETTLEMENT_FAILED",
      ...(c?.tx_hash ? { hash: c.tx_hash as `0x${string}` } : { facts: null }),
      ...(sample.payoutId ? { payoutId: sample.payoutId } : {}),
      ...(payout ? { artifacts: [ctx.artifact("payout", payout)] } : {}),
    });
  },
};

export const S5: CaseDef = {
  id: "S5",
  title: "Agent funds the 30% deposit exactly as pre-signed",
  layers: "onchain_success fundMilestone(1, 120,000) + onchain_revert fundMilestone(1, +1) AmountExceedsSchedule",
  async run(ctx) {
    const ms = await paymentRows(ctx.s, "kind = 'FUND_MILESTONE'");
    const dep = ms.find((p) => p.milestoneIdx === 1);
    await ctx.tx({
      title: `The agent funds the deposit: ${dep?.amountMinor ?? "?"} minor (pre-signed 120,000)`,
      expected: "success",
      ok: dep?.amountMinor === "120000" && Boolean(dep?.txHash),
      ...(dep?.txHash ? { hash: dep.txHash, traceId: dep.traceId } : { facts: null }),
      ...(dep?.decisionId ? { decisionId: dep.decisionId } : {}),
    });
  },
};

/** Step 0, then "Poison the planner" (before the first commit, as in the demo), then tasks 2, 1, 3, 4, 5. */
export const SETUP_BEFORE_PLAN: readonly CaseDef[] = [STEP0];
export const SETUP_AFTER_PLAN: readonly CaseDef[] = [S2, S1, S3, S4, S5];
