/**
 * The WEB world's journey up to the candidates (EXECUTION-EVIDENCE "Scripted tasks along the chat journey"), through
 * the shipped chat-first routes, as Mei would click it:
 *   S2 (WEB)  step 0 (officer opens, one-time code, passkey, officer approves), then the intake turn answers with the
 *             needs card and an inline PlanApproval card for the compiled draft; Mei signs THAT refId and commitPlan
 *             is mined (sepolia-prep TODO S2)
 *   S1 (WEB)  the officer funds the plan total; one more minor unit reverts CapExceeded
 *   S3 (WEB)  the search: Mei types her identifiers first (T33 bait), then presses "find suppliers"; the recorded
 *             search becomes READY; she sees the candidates and picks the clean supplier; the enquiry is templated
 *             (sepolia-prep TODO S3, first half; the terms half is in web-order.ts)
 */
import { buildFund } from "@hogee/chain";
import { ChainAction } from "@hogee/core";
import { expectOk, forcedSend } from "../actions";
import { toolCall } from "../api-internals";
import { actionRow, founderSigns, fundFacility, latestTrace, openAndRegister } from "../flows";
import { errorReason } from "../redact";
import { SELLERS, idOf } from "../web/fixtures";
import { FOUNDER_CANARIES } from "../web/outbound";
import { allOk, checkSearch, findingsOf, summary } from "../web/search-expect";
import { firstPart, partTypes } from "../web/stream";
import type { CaseDef, Ctx } from "./context";
import { QUANTITY, WEB_ONLY, act, action, observe, pollSearch, ready, say, web } from "./web-lib";

async function minedRow(ctx: Ctx, actionId: string, title: string, traceId?: string): Promise<void> {
  const a = await actionRow(ctx.s, actionId);
  if (!a?.txHash || a.state === "REVERTED") throw new Error(`${title}: ${a?.state ?? "no action"} ${a?.revertReason ?? ""}`.trim());
  await ctx.tx({ title, expected: "success", ok: true, hash: a.txHash, ...(traceId ? { traceId } : {}) });
}

/** Words that must never appear in a templated enquiry: seller names, the founder, her identifiers, the budget. */
function enquiryLeaks(ctx: Ctx, subject: string, body: string): string[] {
  const w = web(ctx);
  const text = `${subject}\n${body}`.toLowerCase();
  const forbidden = [...w.fixture.listings.map((l) => l.seller), "Mei Tan", FOUNDER_CANARIES.nric, FOUNDER_CANARIES.passport, "10,000", "10000", "1,000,000"];
  return forbidden.filter((f) => text.includes(f.toLowerCase()));
}

export const WEB_S2: CaseDef = {
  id: "S2",
  variant: "WEB",
  title: "Chat intake: the needs card and an inline PlanApproval; Mei signs it; commitPlan",
  layers: "onchain_success openFacility + registerFounderKey + commitPlan · offchain: the intake turn's parts are data-needs (≥1 item) and data-sign{PlanApproval, refId = the compiled draft}, every part valid",
  anvilOnly: WEB_ONLY,
  async run(ctx) {
    const s = ctx.s;
    const w = web(ctx);
    try {
      const st = await openAndRegister(s, ctx.h);
      await minedRow(ctx, st.openActionId, "Step 0: the officer opens Mei's facility (SGD, cap 1,000,000 minor)");
      await minedRow(ctx, st.registerActionId, "Step 0: the officer registers Mei's passkey from the pending-key view (one-time code)");
      const since = new Date(Date.now() - 1000);
      const turn = await say(ctx, w.sessionId, s.country.chatMessage, [toolCall("proposePlanIntent", s.country.planIntent)]);
      const draft = firstPart(turn.stream, "data-plan-draft");
      const needs = firstPart(turn.stream, "data-needs");
      const sign = firstPart(turn.stream, "data-sign");
      const proposal = await latestTrace(s, "actor = 'planner' and kind = 'PROPOSAL' and ts >= $2", [since]);
      const parts = ctx.artifact("intake-parts", { types: partTypes(turn.stream), invalid: turn.stream.invalid, needs, sign });
      const signOk = turn.status === 200 && turn.stream.invalid.length === 0 && sign?.kind === "PlanApproval" && draft !== null && sign.refId === draft.draftId;
      await observe(ctx, { title: `Intake turn → parts ${partTypes(turn.stream).join(", ") || "none"}; inline ${sign?.kind ?? "no"} card for ${sign && sign.refId === draft?.draftId ? "the compiled draft" : "ANOTHER ref"}`, expected: "success", ok: signOk, artifacts: [parts] }, proposal?.traceId);
      // buildNeeds omits the card (never invents one) when it cannot vouch for the draft and the server's pack.
      const groups = [...new Set(needs?.items.map((i) => i.group) ?? [])];
      await observe(ctx, { title: `The needs card: ${needs ? `${needs.items.length} items in ${groups.join(", ")}` : "OMITTED"}`, expected: "success", ok: needs !== null && needs.items.length > 0, artifacts: [parts] }, proposal?.traceId);
      if (!sign || sign.kind !== "PlanApproval") throw new Error("the intake turn produced no inline PlanApproval card");
      const signed = await founderSigns(s, ctx.h, "PlanApproval", sign.refId);
      const submitted = ChainAction.parse(expectOk(signed.submit, "submit PlanApproval"));
      const hint = await act(ctx, w.sessionId, action({ type: "signed", kind: "PlanApproval", refId: sign.refId }));
      await s.pump();
      ctx.state.draftId = sign.refId;
      ctx.state.planRequestId = signed.req.requestId;
      await minedRow(ctx, submitted.actionId, `Mei signs the inline card (passkey) for refId ${sign.refId}; commitPlan mined; the "signed" hint answered HTTP ${hint.status}`, signed.req.requestId);
    } catch (error: unknown) {
      ctx.state.worldSetupError = errorReason(error, 300);
      throw error;
    }
  },
};

export const WEB_S1: CaseDef = {
  id: "S1",
  variant: "WEB",
  title: "The officer funds Mei's signed plan (capped at its total)",
  layers: "onchain_success fund(1,000,000) · onchain_revert fund(+1) CapExceeded",
  anvilOnly: WEB_ONLY,
  async run(ctx) {
    try {
      if (ctx.state.worldSetupError) throw new Error(`S2 (WEB) failed: ${ctx.state.worldSetupError}`);
      const r = expectOk<ChainAction>(await fundFacility(ctx.s, ctx.h, "1000000"), "fund");
      await minedRow(ctx, r.actionId, "The officer funds 1,000,000 SGD minor (10,000 BU), the plan total");
      const f = await forcedSend(ctx.s, "S1", buildFund({ amountMinor: 1n }), ctx.s.signers.lender);
      await ctx.forced("Forced fund(1) by the lender above Mei's plan total", f, "CapExceeded");
      ctx.state.worldReady = true;
    } catch (error: unknown) {
      ctx.state.worldSetupError ??= errorReason(error, 300);
      throw error;
    }
  },
};

export const WEB_S3_SEARCH: CaseDef = {
  id: "S3",
  variant: "WEB",
  title: "Find suppliers on the web (recorded), see the candidates, pick one, copy the templated enquiry",
  layers: "offchain: start_search → data-search; READY on the recorded provider, every candidate an unverified web candidate on an allow-listed host; pick → data-enquiry built from enums and the quantity only",
  anvilOnly: WEB_ONLY,
  async run(ctx) {
    const w = ready(ctx);
    // T33 bait: Mei types her identifiers before asking (the query must not carry them; T33 (WEB) checks it).
    await say(ctx, w.sessionId, `My NRIC is ${FOUNDER_CANARIES.nric} and my passport is ${FOUNDER_CANARIES.passport}. Please find me suppliers for the tumblers.`, [
      toolCall("chooseSkill", { skill: "find_suppliers", candidateRanks: null, cfoView: null }),
    ]);
    const press = action({ type: "start_search", quantity: QUANTITY });
    const start = await act(ctx, w.sessionId, press);
    w.answered.push(press);
    const sid = firstPart(start.stream, "data-search")?.searchId;
    if (start.status !== 200 || !sid) throw new Error(`start_search: HTTP ${start.status}, parts ${partTypes(start.stream).join(", ") || "none"}`);
    const search = await pollSearch(ctx, sid);
    w.search = search;
    const all = checkSearch(search, w.fixture);
    const cards = [...findingsOf(all, "cards"), ...findingsOf(all, "order")];
    const art = ctx.artifact("search", search);
    await observe(ctx, { title: `start_search → search ${sid}: ${search.status}, ${search.candidates.length} candidates; ${summary(cards)}`, expected: "success", ok: allOk(cards), artifacts: [art] }, sid);
    const shown = await act(ctx, w.sessionId, action({ type: "show_candidates", searchId: sid }));
    const orderId = idOf(w.fixture, SELLERS.order);
    const pick = await act(ctx, w.sessionId, action({ type: "pick", searchId: sid, supplierIds: [orderId] }));
    const enquiry = firstPart(pick.stream, "data-enquiry");
    const leaks = enquiry ? enquiryLeaks(ctx, enquiry.subject, enquiry.body) : ["(no enquiry)"];
    const asksCompanyAccount = enquiry ? /company/i.test(enquiry.body) && /bank account/i.test(enquiry.body) : false;
    const ok =
      firstPart(shown.stream, "data-candidates")?.searchId === sid &&
      pick.status === 200 &&
      pick.stream.invalid.length === 0 &&
      enquiry !== null &&
      enquiry.supplierIds.length === 1 &&
      enquiry.supplierIds[0] === orderId &&
      leaks.length === 0 &&
      asksCompanyAccount &&
      firstPart(pick.stream, "data-next") !== null;
    const enq = ctx.artifact("enquiry", { enquiry, leaks, asksCompanyAccount, parts: partTypes(pick.stream) });
    await observe(ctx, { title: `pick ${SELLERS.order} → templated enquiry: leaks ${leaks.join(", ") || "none"}; asks for a company bank account ${asksCompanyAccount}`, expected: "success", ok, artifacts: [enq] }, sid);
  },
};

