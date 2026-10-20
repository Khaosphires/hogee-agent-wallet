/**
 * VISION-DECISIONS §9 on the live API, Postgres, Anvil and the worker's jobs: a web supplier's terms (the ONLY way a
 * payout account arrives) → every TERMS_* refusal → the founder's SupplierApproval built from the immutable row →
 * bindPayee → cooling → the deposit the agent pays by itself → the balance that waits for her release with evidence.
 * The web search row is planted as v-search stores it (support/web-search.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ApiError,
  AutonomyStats,
  Balances,
  CfoReport,
  ChainAction,
  EscrowSchedule,
  OrderTerms,
  Payment,
  Shortlist,
  SignatureRequestResponse,
  TERMS_PRESET_MILESTONES,
  PlanRecord,
  exampleShortlistSpec,
  jcs,
  payoutAccountHash,
  readWebOrderRows,
  sumMinor,
  walletFigures,
} from "@hogee/core";
import { HOGEE_KINDS, buildTighten, toBytes32Tag, toTxRequest } from "@hogee/chain";
import { runAgentActions, runSettle, sendAction } from "@hogee/worker";
import { keccak256 } from "viem";
import { z } from "zod";
import { scheduleHash } from "../../src/chain-lib";
import type { ChecksPort } from "../../src/context";
import { webQuoteHash } from "../../src/services/terms-checks";
import { scriptedAgent } from "../support/agent";
import type { SoftAuthenticator } from "../support/authenticator";
import { testChecks } from "../support/catalog";
import { LIVE, LIVE_TIMEOUT_MS, finalizeAll, openLive, warp, type Live } from "../support/live";
import { b64uToBytes, chatToDraft, json, openAndRegister, signPlan } from "../support/steps";
import { CORVANE, GLINTORA, plantWebSearch, type PlantedSearch, type WebSeller } from "../support/web-search";
import { newWorld, type World } from "../support/world";

const SESSION = "01a14202-2800-7000-8000-0000000000a7";
const SEARCH = "sl-web-0199f1aa-0000-7000-8000-000000000001";
const ORDER = "order-wcorvanetest2-001";
const P30_70 = TERMS_PRESET_MILESTONES.P30_70.map((m) => ({ ...m }));
/** A second fictional seller (TEST FIXTURE), orderable in its own search once the first order is done. */
const BRISOLA: WebSeller = { supplierId: "supplier-wbrisolatest2", sellerName: "Brisola Houseware Co., Ltd.", listingUrl: "https://brisola.en.alibaba.com/product/1600000000003.html" };
const SEARCH_2 = "sl-web-0199f1aa-0000-7000-8000-000000000002";

describe.skipIf(!LIVE)("web supplier terms → SupplierApproval → escrow (live)", { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  let w: World;
  let auth: SoftAuthenticator;
  let planted: PlantedSearch;
  let sanctions: "clear" | "hit" | "down" | "no-verdict" = "clear";
  let termsId = "";
  let catalog: Shortlist;

  const body = (over: Record<string, unknown> = {}, payout: Record<string, unknown> = {}) => ({
    supplierId: CORVANE.supplierId,
    searchId: SEARCH,
    quantity: 500,
    totalMinor: "250000",
    milestones: P30_70,
    payout: { holderName: CORVANE.sellerName, bankName: "Maybank", accountNumber: "0123456789", payeeType: "company", ...payout },
    ...over,
  });
  const rowCount = async () => (await live.db.$client.query("select count(*)::int as n from supplier_terms where facility_id = $1", [w.facilityId])).rows[0].n as number;
  const refusal = async (res: Response) => ({ status: res.status, reason: ApiError.parse(await res.json()).error.details?.reason });
  const confirm = (b: unknown) => w.founder.post("/api/orders/terms", b);
  const requestApproval = (refId: string) => w.founder.post("/api/signatures/request", { kind: "SupplierApproval", refId, method: "passkey" });
  const submit = (req: SignatureRequestResponse) => w.founder.post(`/api/signatures/${req.requestId}/submit`, { passkey: auth.assert(b64uToBytes(req.challengeB64url)) });
  const terms = async (id: string) => json(await w.founder.get(`/api/orders/terms/${id}`), OrderTerms);
  const agentRound = async () => {
    await runAgentActions(w.workerDeps(), [w.facilityId]);
    await w.pump();
  };
  /** The Wallet's "What the AI did alone" counters, and this facility's mined payments the agent decided (W-4). */
  const autonomyNow = async () => {
    const stats = await json(await w.founder.get("/api/stats/autonomy"), AutonomyStats);
    const all = await json(await w.founder.get("/api/payments"), z.array(Payment));
    const mined = all.filter((p) => ["INCLUDED", "FINALIZED", "SETTLEMENT_REQUESTED", "SETTLED", "SETTLEMENT_FAILED"].includes(p.state));
    return { stats, agentPaid: mined.filter((p) => p.kind === "SPEND" || p.kind === "FUND_MILESTONE").length };
  };
  /** What the wallet shows (core walletFigures, the chat rail and the CFO page's tiles), from the same three reads as the web. */
  const walletNow = async () => {
    const [balances, report, plan] = await Promise.all([json(await w.founder.get("/api/balances"), Balances), json(await w.founder.get("/api/cfo"), CfoReport), json(await w.founder.get("/api/plans/current"), PlanRecord)]);
    const figures = walletFigures({ planTotalMinor: plan.manifest.totalMinor, pockets: balances.pockets, escrowMinor: balances.escrowMinor, supplierPaidMinor: report.pnl.supplierCostMinor });
    const rawSpent = BigInt(sumMinor(balances.pockets.map((p) => p.spent)));
    return { balances, report, figures, rawSpent, total: BigInt(plan.manifest.totalMinor), supplier: balances.pockets.find((p) => p.lineKey === "SUPPLIER") };
  };

  beforeAll(async () => {
    live = await openLive();
    const agent = scriptedAgent();
    w = await newWorld(live, { agent, coolingSeconds: 120 });
    // Sanctions the test can switch (a hit on the founder's holder, or screening down); the rest are the test checks.
    const checks: ChecksPort = {
      ...testChecks,
      screenSanctions: async (name) => {
        if (sanctions === "down") throw new Error("sanctions list unreachable");
        if (sanctions === "no-verdict") return {} as { hit: boolean };
        return { hit: sanctions === "hit" && name === CORVANE.sellerName };
      },
    };
    Object.assign(w.deps as { checks: ChecksPort }, { checks });
    auth = await openAndRegister(w);
    await signPlan(w, auth, await chatToDraft(w, agent, SESSION));
    await json(await w.officer.post("/api/facility/fund", { amountMinor: "1000000" }), z.unknown());
    await w.pump();
    const { requestId } = await json(await w.founder.post("/api/suppliers/shortlist", { spec: exampleShortlistSpec }), z.object({ requestId: z.string() }));
    catalog = await json(await w.founder.get(`/api/suppliers/shortlist/${requestId}`), Shortlist);
    planted = await plantWebSearch(w, catalog, SEARCH);
    await plantWebSearch(w, catalog, "sl-web-stale", { ageDays: 8 });
  }, LIVE_TIMEOUT_MS);
  afterAll(async () => {
    await live?.close();
  });

  it("refuses the candidate, currency, payee, account and holder checks with their TERMS_* reasons, writing nothing", async () => {
    expect((await w.officer.post("/api/orders/terms", body())).status).toBe(403);
    expect(await refusal(await confirm(body({ searchId: "sl-web-unknown" })))).toEqual({ status: 404, reason: "TERMS_CANDIDATE" });
    expect(await refusal(await confirm(body({ searchId: "sl-web-stale" })))).toEqual({ status: 409, reason: "TERMS_CANDIDATE" });
    expect(await refusal(await confirm(body({ supplierId: GLINTORA.supplierId }, { holderName: GLINTORA.sellerName })))).toEqual({ status: 409, reason: "TERMS_CANDIDATE" });
    expect(await refusal(await confirm(body({ supplierId: "supplier-a" })))).toEqual({ status: 409, reason: "TERMS_CANDIDATE" });
    const q = live.db.$client;
    // run-9: the search must have been made under the CURRENT committed plan, for its category and sourcing country.
    const plan = (await q.query("select id, signed_at::text as signed_at from plans where facility_id = $1 and status = 'COMMITTED' order by version desc limit 1", [w.facilityId])).rows[0];
    await q.query("update plans set signed_at = now() + interval '1 minute' where facility_id = $1 and id = $2", [w.facilityId, plan.id]);
    try {
      expect(await refusal(await confirm(body()))).toEqual({ status: 409, reason: "TERMS_CANDIDATE" });
    } finally {
      await q.query("update plans set signed_at = $3::timestamptz where facility_id = $1 and id = $2", [w.facilityId, plan.id, plan.signed_at]);
    }
    for (const [key, other] of [["productCategory", "cosmetics"], ["buyFrom", "VN"]] as const) {
      const original = (await q.query("select spec_json->>$3 as v from shortlists where facility_id = $1 and id = $2", [w.facilityId, SEARCH, key])).rows[0].v as string;
      const set = (v: string) => q.query("update shortlists set spec_json = jsonb_set(spec_json, array[$3::text], to_jsonb($4::text)) where facility_id = $1 and id = $2", [w.facilityId, SEARCH, key, v]);
      await set(other);
      try {
        expect(await refusal(await confirm(body())), key).toEqual({ status: 409, reason: "TERMS_CANDIDATE" });
      } finally {
        await set(original);
      }
    }
    await q.query("update facilities set currency = 'SGD' where facility_id = $1", [w.facilityId]);
    try {
      expect(await refusal(await confirm(body()))).toEqual({ status: 409, reason: "TERMS_CURRENCY" });
    } finally {
      await q.query("update facilities set currency = 'MYR' where facility_id = $1", [w.facilityId]);
    }
    expect(await refusal(await confirm(body({}, { payeeType: "personal" })))).toEqual({ status: 422, reason: "TERMS_PAYEE_PERSONAL" });
    expect(await refusal(await confirm(body({}, { accountNumber: "000000" })))).toEqual({ status: 422, reason: "TERMS_ACCOUNT_FORMAT" });
    expect(await refusal(await confirm(body({}, { holderName: "Harbourline Pte. Ltd." })))).toEqual({ status: 422, reason: "TERMS_HOLDER_MISMATCH" });
    expect(await refusal(await confirm(body({}, { holderName: "Corvane Drinkware" })))).toEqual({ status: 422, reason: "TERMS_HOLDER_MISMATCH" });
    expect(await rowCount()).toBe(0);
  });

  it("screens the holder and the seller: a hit is 403 TERMS_SANCTIONS, unscreenable is 503; nothing is stored", async () => {
    sanctions = "hit";
    expect(await refusal(await confirm(body()))).toEqual({ status: 403, reason: "TERMS_SANCTIONS" });
    sanctions = "down";
    const down = await confirm(body());
    expect(down.status).toBe(503);
    expect(ApiError.parse(await down.json()).error.details).toEqual({ reason: "TERMS_SANCTIONS", unavailable: true });
    sanctions = "no-verdict";
    expect((await confirm(body())).status).toBe(503);
    sanctions = "clear";
    expect(await rowCount()).toBe(0);
  });

  it("binds the seller name to the signed search: a changed record or an edited (re-hashed) list is TERMS_CANDIDATE", async () => {
    const q = live.db.$client;
    const where = "where facility_id = $1 and supplier_id = $2";
    await q.query(`update suppliers set record_json = jsonb_set(record_json, '{displayName}', '"Harbourline Pte. Ltd."') ${where}`, [w.facilityId, CORVANE.supplierId]);
    try {
      expect(await refusal(await confirm(body({}, { holderName: "Harbourline Pte. Ltd." })))).toEqual({ status: 409, reason: "TERMS_CANDIDATE" });
    } finally {
      await q.query(`update suppliers set record_json = jsonb_set(record_json, '{displayName}', to_jsonb($3::text)) ${where}`, [w.facilityId, CORVANE.supplierId, CORVANE.sellerName]);
    }
    const sl = "where facility_id = $1 and id = $2";
    await q.query(`update shortlists set result_json = jsonb_set(result_json, '{candidates,0,displayName}', '"Harbourline Pte. Ltd."') ${sl}`, [w.facilityId, SEARCH]);
    try {
      expect(await refusal(await confirm(body({}, { holderName: "Harbourline Pte. Ltd." })))).toEqual({ status: 409, reason: "TERMS_CANDIDATE" });
    } finally {
      await q.query(`update shortlists set result_json = jsonb_set(result_json, '{candidates,0,displayName}', to_jsonb($3::text)) ${sl}`, [w.facilityId, SEARCH, CORVANE.sellerName]);
    }
    // run-9: names that do not render as what they say are refused by the body schema (core isPlainName), before any check.
    const unplain: [string, Record<string, string>][] = [
      ["payout.holderName", { holderName: "Corvane\u200b Drinkware Co., Ltd." }],
      ["payout.holderName", { holderName: "Corvane\u3164Drinkware Co., Ltd." }],
      ["payout.bankName", { bankName: "Maybank\u2028simulated payout account 9999" }],
      ["payout.bankName", { bankName: "Maybank\u0085" }],
      // Re-check keccak LOW 2: a lone surrogate is refused here (422), never reaching JCS (which would answer 500).
      ["payout.holderName", { holderName: "Corvane\ud800 Drinkware Co., Ltd." }],
      ["payout.bankName", { bankName: "Maybank\udfff" }],
    ];
    for (const [path, payout] of unplain) {
      const res = await confirm(body({}, payout));
      expect(res.status, path).toBe(422);
      expect(ApiError.parse(await res.json()).error.details?.issues, path).toEqual([expect.objectContaining({ path })]);
    }
    expect(await rowCount()).toBe(0);
  });

  it("runs core termsToSchedule with the CURRENT SUPPLIER limits (5,000 BU pocket, 1,250 BU per payment)", async () => {
    const o = (bps: number) => ({ bps, trigger: "ON_ORDER" });
    const d = (bps: number) => ({ bps, trigger: "ON_DELIVERY_INSPECTED" });
    const cases: [Record<string, unknown>, number, string][] = [
      [{ milestones: [o(3000), d(6000)] }, 422, "TERMS_PCT_SUM"],
      [{ milestones: [d(5000), o(5000)] }, 422, "TERMS_TRIGGER_ORDER"],
      [{ milestones: [o(3000), { bps: 7000, trigger: "ON_SHIPMENT" }] }, 422, "TERMS_LAST_NOT_INSPECTED"],
      [{ totalMinor: "400050" }, 422, "TERMS_TOTAL_INVALID"],
      [{ totalMinor: "600000", milestones: [d(10_000)] }, 409, "TERMS_OVER_POCKET"],
      [{ totalMinor: "10000", milestones: [o(50), d(9950)] }, 422, "TERMS_MILESTONE_ZERO"],
      [{ milestones: [o(1000), o(1000), d(8000)] }, 422, "TERMS_WEB_AUTO_COUNT"],
      [{ totalMinor: "430000" }, 409, "TERMS_AUTO_OVER_PER_TX"],
      [{ totalMinor: "200000", milestones: [o(6000), d(4000)] }, 422, "TERMS_UPFRONT_OVER_HALF"],
    ];
    for (const [over, status, reason] of cases) expect(await refusal(await confirm(body(over))), reason).toEqual({ status, reason });
    expect(await rowCount()).toBe(0);
  });

  it("confirms the demo terms: 2,500 BU at 30/70, MOCK_ONLY destination, immutable row; a replay returns the same row", async () => {
    const t = await json(await confirm(body()), OrderTerms);
    termsId = t.termsId;
    expect(t).toMatchObject({ status: "CONFIRMED", supplierId: CORVANE.supplierId, origin: "web", currency: "MYR", totalMinor: "250000", orderId: null, coolingEndsAt: null });
    expect(t.displayName).toBe(CORVANE.sellerName);
    expect(t.schedule.map((r) => [r.trigger, r.amountMinor, r.autoRelease, r.released])).toEqual([
      ["ON_ORDER", "75000", true, false],
      ["ON_DELIVERY_INSPECTED", "175000", false, false],
    ]);
    const account = { channel: "MOCK_ONLY", accountNumber: "0123456789", holderName: CORVANE.sellerName };
    expect(t.payoutAccountHash).toBe(payoutAccountHash(account));
    const r = (await live.db.$client.query("select payout_account_ref, quote_hash, chosen_index from supplier_terms where facility_id = $1 and id = $2", [w.facilityId, termsId])).rows[0];
    expect(r.payout_account_ref).toBe(jcs(account));
    expect(r.quote_hash).toBe(
      webQuoteHash({ termsId, supplierId: CORVANE.supplierId, shortlistHash: planted.shortlistHash, chosenIndex: 0, currency: "MYR", totalMinor: "250000", milestones: P30_70, payeeType: "company", payoutAccountHash: t.payoutAccountHash }),
    );
    expect((await json(await confirm(body()), OrderTerms)).termsId).toBe(termsId);
    expect(await terms(termsId)).toEqual(t);
    expect((await w.founder.get("/api/orders/terms/terms-unknown")).status).toBe(404);
  });

  it("a correction supersedes the live row; the old terms can no longer be signed (TERMS_SUPERSEDED)", async () => {
    const old = termsId;
    const fifty = await json(await confirm(body({ milestones: TERMS_PRESET_MILESTONES.P50_50.map((m) => ({ ...m })), totalMinor: "200000" })), OrderTerms);
    expect(fifty.termsId).not.toBe(old);
    expect((await terms(old)).status).toBe("SUPERSEDED");
    expect(await refusal(await requestApproval(old))).toEqual({ status: 409, reason: "TERMS_SUPERSEDED" });
    termsId = (await json(await confirm(body()), OrderTerms)).termsId;
    expect((await terms(fifty.termsId)).status).toBe("SUPERSEDED");
    expect((await terms(termsId)).status).toBe("CONFIRMED");
  });

  it("prepare builds the struct and the panel from the row; a web supplier id alone is refused", async () => {
    expect((await requestApproval(CORVANE.supplierId)).status).toBe(409);
    expect((await requestApproval(ORDER)).status).toBe(409);
    const req = await json(await requestApproval(termsId), SignatureRequestResponse);
    const m = req.typedData.message;
    const t = await terms(termsId);
    expect(m).toMatchObject({ payoutAccountHash: t.payoutAccountHash, shortlistHash: planted.shortlistHash, chosenIndex: "0", totalMinor: "250000", inspectionRequired: true });
    const rows = req.displayModel.rows;
    expect(rows.find((r) => r.label === "Found by web search, not verified")?.value).toContain("corvane.en.alibaba.com");
    // run-9: holder, whole account and bank in rows of their own; the account and milestones recompute to the message.
    expect(rows.find((r) => r.label === "Account number (simulated payout)")?.value).toBe("0123 4567 89");
    expect(rows.find((r) => r.label === "Bank")?.value).toBe("Maybank");
    const shown = readWebOrderRows(rows);
    expect(shown?.holderName).toBe(CORVANE.sellerName);
    expect(payoutAccountHash({ channel: "MOCK_ONLY", accountNumber: shown?.accountNumber ?? "", holderName: shown?.holderName ?? "" })).toBe(m.payoutAccountHash);
    expect(scheduleHash(shown?.schedule.map((x) => x.amountMinor) ?? [], shown?.schedule.map((x) => x.autoRelease) ?? [])).toBe(m.scheduleHash);
    expect(rows.filter((r) => r.label.startsWith("Milestone")).map((r) => r.label)).toEqual(["Milestone 1: Deposit on order", "Milestone 2: Balance after delivery check"]);
    sanctions = "hit";
    expect(await refusal(await requestApproval(termsId))).toEqual({ status: 403, reason: "TERMS_SANCTIONS" });
    sanctions = "down";
    expect((await requestApproval(termsId)).status).toBe(503);
    sanctions = "clear";
  });

  it("refuses a signature when the row was tampered between prepare and finalize (CONFLICT); nothing is queued", async () => {
    const q = live.db.$client;
    const req = await json(await requestApproval(termsId), SignatureRequestResponse);
    const tamper = async (sql: string, restore: string) => {
      await q.query(sql, [w.facilityId, termsId]);
      try {
        const res = await submit(req);
        expect(res.status).toBe(409);
        expect(ApiError.parse(await res.json()).error.code).toBe("CONFLICT");
      } finally {
        await q.query(restore, [w.facilityId, termsId]);
      }
    };
    const original = (await q.query("select terms_json::text as t, payout_account_ref as a from supplier_terms where facility_id = $1 and id = $2", [w.facilityId, termsId])).rows[0];
    await tamper(
      `update supplier_terms set terms_json = '[{"bps":5000,"trigger":"ON_ORDER"},{"bps":5000,"trigger":"ON_DELIVERY_INSPECTED"}]'::jsonb where facility_id = $1 and id = $2`,
      `update supplier_terms set terms_json = '${original.t}'::jsonb where facility_id = $1 and id = $2`,
    );
    const other = jcs({ accountNumber: "9999000011", channel: "MOCK_ONLY", holderName: CORVANE.sellerName });
    await tamper(`update supplier_terms set payout_account_ref = '${other}' where facility_id = $1 and id = $2`, `update supplier_terms set payout_account_ref = '${original.a}' where facility_id = $1 and id = $2`);
    await tamper("update supplier_terms set quote_total_minor = 250100 where facility_id = $1 and id = $2", "update supplier_terms set quote_total_minor = 250000 where facility_id = $1 and id = $2");
    const queued = await q.query("select count(*)::int as n from chain_actions where facility_id = $1 and kind = 'Treasury.bindPayee'", [w.facilityId]);
    expect(queued.rows[0].n).toBe(0);
    expect((await q.query("select count(*)::int as n from payees where facility_id = $1 and id = $2", [w.facilityId, CORVANE.supplierId])).rows[0].n).toBe(0);
  });

  it("signs: payee, order and milestones written, terms USED; bindPayee lands and cooling starts; a replay is refused", async () => {
    const req = await json(await requestApproval(termsId), SignatureRequestResponse);
    const action = await json(await submit(req), ChainAction);
    expect(action.state).toBe("PENDING");
    const q = live.db.$client;
    const payee = (await q.query("select xendit_account_ref, payout_account_hash from payees where facility_id = $1 and id = $2", [w.facilityId, CORVANE.supplierId])).rows[0];
    expect(payee.xendit_account_ref).toBe(jcs({ channel: "MOCK_ONLY", accountNumber: "0123456789", holderName: CORVANE.sellerName }));
    expect(payee.payout_account_hash).toBe(req.typedData.message.payoutAccountHash);
    const used = await terms(termsId);
    expect(used).toMatchObject({ status: "USED", orderId: ORDER, bindTxHash: null });
    expect((await submit(req)).status).toBe(409);
    expect(await refusal(await requestApproval(termsId))).toEqual({ status: 409, reason: "TERMS_ALREADY_BOUND" });
    // The open order now holds 2,500 BU of the 5,000 BU pocket: the pocket is checked before the binding (brief order).
    expect(await refusal(await confirm(body({ totalMinor: "300000" })))).toEqual({ status: 409, reason: "TERMS_OVER_POCKET" });
    expect(await refusal(await confirm(body({ totalMinor: "100000" })))).toEqual({ status: 409, reason: "TERMS_ALREADY_BOUND" });
    // run-9: a catalog order counts the open web order too (its free pocket is 1,000 BU now, not 5,000 BU).
    const catalog = await w.founder.post("/api/signatures/request", { kind: "SupplierApproval", refId: "supplier-a", method: "passkey" });
    expect(catalog.status).toBe(409);
    expect(ApiError.parse(await catalog.json()).error.message).toMatch(/supplier pocket cannot hold this order/);
    await w.pump();
    const bound = await terms(termsId);
    expect(bound.coolingEndsAt).not.toBeNull();
    // The seal on the order card: the landed bindPayee transaction of this order.
    const bind = (await q.query("select tx_hash from chain_actions where facility_id = $1 and kind = 'Treasury.bindPayee' and ref_id = $2", [w.facilityId, ORDER])).rows[0];
    expect(bound.bindTxHash).toBe(String(bind.tx_hash).toLowerCase());
    const schedule = await json(await w.founder.get(`/api/escrow/${ORDER}`), EscrowSchedule);
    expect(schedule.map((x) => [x.amountMinor, x.autoRelease])).toEqual([
      ["75000", true],
      ["175000", false],
    ]);
  });

  it("pays nothing during cooling; then the agent pays the deposit by itself and the balance waits for the founder", async () => {
    const payments = async () => (await json(await w.founder.get("/api/payments"), z.array(Payment))).filter((p) => p.payeeId === CORVANE.supplierId);
    await agentRound();
    expect((await payments()).filter((p) => p.txHash)).toEqual([]);
    await warp(live, 200n);
    await w.pump();
    await agentRound();
    await agentRound();
    const deposit = (await payments()).find((p) => p.kind === "FUND_MILESTONE" && p.amountMinor === "75000");
    expect(deposit).toMatchObject({ amountMinor: "75000" });
    expect(deposit?.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    const t = await terms(termsId);
    expect(t.schedule[0]).toMatchObject({ released: true, txHash: deposit?.txHash });
    expect(t.schedule[1]).toMatchObject({ released: false, txHash: null });
    // The wallet's numbers (as the mock's journey test checks them): the chain keeps the paid-out deposit in escrow and
    // out of the pocket's spent; the CFO report's supplier cost is the paid-out part.
    const wallet = await walletNow();
    expect(wallet.balances.escrowMinor).toBe("250000");
    expect(wallet.supplier?.spent).toBe("0");
    expect(wallet.report.pnl.supplierCostMinor).toBe("75000");
    expect(wallet.figures).toMatchObject({
      leftMinor: (wallet.total - wallet.rawSpent - 250_000n).toString(),
      escrowCommittedMinor: "250000",
      supplierPaidMinor: "75000",
      escrowHeldMinor: "175000",
      spentMinor: (wallet.rawSpent + 75_000n).toString(),
    });
    expect(wallet.report.overview.spentMinor).toBe(wallet.figures.spentMinor);
    // The balance: never released by the agent; the founder's release needs the inspection evidence first.
    expect((await requestApproval(termsId)).status).toBe(409);
    const early = await w.founder.post("/api/signatures/request", { kind: "MilestoneRelease", refId: ORDER, method: "passkey" });
    expect(early.status).toBe(409);
  });

  it("releases the balance with the founder's signature and the inspection evidence; the deposit settles to MOCK_ONLY", async () => {
    const report = new TextEncoder().encode("inspection report: 500 tumblers, no defects");
    const form = new FormData();
    form.append("file", new Blob([report], { type: "application/pdf" }), "inspection.pdf");
    const up = await w.app.request(`/api/escrow/${ORDER}/inspection`, { method: "POST", headers: { cookie: w.cookie("founder:rina") }, body: form });
    expect(await json(up, z.object({ evidenceHash: z.string() }))).toEqual({ evidenceHash: keccak256(report) });
    const req = await json(await w.founder.post("/api/signatures/request", { kind: "MilestoneRelease", refId: ORDER, method: "passkey" }), SignatureRequestResponse);
    expect(req.typedData.message).toMatchObject({ idx: "1", amountMinor: "175000" });
    const before = await autonomyNow();
    await json(await submit(req), z.unknown());
    await agentRound();
    const t = await terms(termsId);
    expect(t.schedule.map((r) => r.released)).toEqual([true, true]);
    expect(t.schedule[1]?.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    for (let i = 0; i < 4; i += 1) {
      await finalizeAll(live);
      await w.pump();
      await runSettle(w.workerDeps(), [w.facilityId]);
      await w.pump();
    }
    const settled = (await json(await w.founder.get("/api/payments"), z.array(Payment))).filter((p) => p.payeeId === CORVANE.supplierId && p.state === "SETTLED");
    expect(settled.map((p) => `${p.kind}:${p.amountMinor}`).sort()).toEqual(["FUND_MILESTONE:75000", "RELEASE_MILESTONE:175000"]);
    // W-4: her release is one signature by a person, never also an AI payment; AI payments moved only by the agent's own
    // payments mined meanwhile (an escrow funding still landing), not by the mined RELEASE_MILESTONE.
    const after = await autonomyNow();
    expect(after.stats.humanSigs - before.stats.humanSigs).toBe(1);
    expect(after.stats.agentTxs - before.stats.agentTxs).toBe(after.agentPaid - before.agentPaid);
    // After the release: the escrow total does not move on chain; the whole order is paid out and nothing is held.
    const wallet = await walletNow();
    expect(wallet.balances.escrowMinor).toBe("250000");
    expect(wallet.supplier?.spent).toBe("0");
    expect(wallet.figures).toMatchObject({ leftMinor: (wallet.total - wallet.rawSpent - 250_000n).toString(), supplierPaidMinor: "250000", escrowHeldMinor: "0", spentMinor: (wallet.rawSpent + 250_000n).toString() });
    expect(wallet.report.overview.spentMinor).toBe(wallet.figures.spentMinor);
  });

  it("re-check 9: a deposit paid this week counts against the SUPPLIER window for the next order's deposit", async () => {
    // The agent may only tighten: the SUPPLIER window drops to 1,000 BU. The 750 BU deposit above landed this week.
    const call = buildTighten({ kind: HOGEE_KINDS.TIGHTEN_LOWER_WINDOW_CAP, target: toBytes32Tag("SUPPLIER"), newValue: 100_000n, decisionId: keccak256(new TextEncoder().encode("test-window")) });
    const ctx = { db: live.db, client: live.client, deployment: w.deployment, chainId: w.deployment.chainId, capWei: 1_000n * 1_000_000_000n };
    const { stored } = await sendAction(ctx, { facilityId: w.facilityId, id: "test:tighten:supplier-window", kind: call.kind, refId: "SUPPLIER", request: toTxRequest(call, w.deployment.contracts) }, w.signers.agent);
    expect((await live.client.waitForTransactionReceipt({ hash: stored.txHash })).status).toBe("success");
    await plantWebSearch(w, catalog, SEARCH_2, { seller: BRISOLA });
    const brisola = (totalMinor: string) => ({
      ...body({ supplierId: BRISOLA.supplierId, searchId: SEARCH_2, totalMinor }),
      payout: { holderName: BRISOLA.sellerName, bankName: "Maybank", accountNumber: "0123456789", payeeType: "company" },
    });
    // 1,000 BU at 30/70 asks for a 300 BU deposit; only 1,000 − 750 = 250 BU of the window is left (the pocket has 2,500 BU free).
    expect(await refusal(await confirm(brisola("100000")))).toEqual({ status: 409, reason: "TERMS_UPFRONT_OVER_WINDOW" });
    const fits = await confirm(brisola("80000"));
    expect(fits.status).toBe(200);
    expect((await json(fits, OrderTerms)).schedule.map((r) => [r.amountMinor, r.autoRelease])).toEqual([
      ["24000", true],
      ["56000", false],
    ]);
  });
});
