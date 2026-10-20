/**
 * VISION-DECISIONS §9 in the mock (fresh scenario, Mei): web supplier terms with the live API's checks and TERMS_*
 * reasons, the SupplierApproval built from the terms, cooling (DEMO_TIMELOCK_SECONDS), the deposit the agent pays by
 * itself after it, and the balance that waits for the founder's release with evidence. The web search is the contract
 * example until v-search's mock lands (features/orders.ts webSearchOf).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ROUTE_EXAMPLES } from "@hogee/api-contract";
import {
  TERMS_PRESET_MILESTONES,
  hashObject,
  payoutAccountHash,
  readWebOrderRows,
  shortlistHashOf,
  webQuoteHash,
  type Balances,
  type EscrowSchedule,
  type OrderTerms,
  type Payment,
  type Shortlist,
  type SignatureRequestResponse,
  type TraceEvent,
} from "@hogee/core";
import { scheduleHash } from "../src/eip712";
import { app } from "../src/index";
import { readEnv } from "../src/env";
import { MAX_TERMS_PER_WINDOW } from "../src/features/orders";
import { SEARCH_DELAY_MS, mockWebSearch, mockWebSupplier } from "../src/features/search";
import { getState, pocketOf, resetState, updatePocket } from "../src/store";
import { harness, json, profile, secret } from "./support/harness";
import { enrolFounder, submitWith, type SoftPasskey } from "./support/passkey";

type Err = { error: { code: string; message: string; details?: { reason?: string } } };
const SEARCH = ROUTE_EXAMPLES.getSupplierSearch.res;
const CANDIDATE = SEARCH.candidates[0] as (typeof SEARCH.candidates)[number];
const ORDER = `order-${CANDIDATE.supplierId.slice("supplier-".length)}-001`;
const P30_70 = TERMS_PRESET_MILESTONES.P30_70.map((m) => ({ ...m }));

beforeAll(() => {
  process.env.DEMO_MODE = "1";
  process.env.PERSONA_COOKIE_SECRET = secret();
  process.env.OFFICER_TOKEN = secret();
});

const { call } = harness(app);

describe("web supplier terms in the mock (fresh scenario)", () => {
  let key: SoftPasskey;
  let now = Date.parse("2026-10-19T06:00:00Z");
  const tick = (ms: number) => {
    now += ms;
    vi.setSystemTime(now);
  };
  const body = (over: Record<string, unknown> = {}, payout: Record<string, unknown> = {}) => ({
    supplierId: CANDIDATE.supplierId,
    searchId: SEARCH.searchId,
    quantity: 500,
    totalMinor: "250000",
    milestones: P30_70,
    payout: { holderName: CANDIDATE.displayName, bankName: "DBS Bank", accountNumber: "100200300400", payeeType: "company", ...payout },
    ...over,
  });
  const confirm = (b: unknown) => call<OrderTerms & Partial<Err>>("/api/orders/terms", json(b));
  const reasonOf = async (b: unknown) => {
    const r = await confirm(b);
    return { status: r.status, reason: r.body.error?.details?.reason };
  };
  const signApproval = async (refId: string) => {
    const req = await call<SignatureRequestResponse & Partial<Err>>("/api/signatures/request", json({ kind: "SupplierApproval", refId, method: "passkey" }));
    return req;
  };
  const submit = (req: SignatureRequestResponse) => submitWith(call, key, req);
  const terms = async (id: string) => (await call<OrderTerms>(`/api/orders/terms/${id}`)).body;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    vi.stubEnv("MOCK_SCENARIO", "fresh");
    vi.stubEnv("DEMO_TIMELOCK_SECONDS", "5");
    resetState(readEnv());
    key = await enrolFounder(call);
    const draftId = (await call<{ draftId: string }>("/api/plans/draft", json({ sessionId: profile().sessionId }))).body.draftId;
    const plan = (await call<SignatureRequestResponse>("/api/signatures/request", json({ kind: "PlanApproval", refId: draftId, method: "passkey" }))).body;
    expect((await submit(plan)).body.state).toBe("BROADCAST");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetState(readEnv());
  });

  it("refuses with the live TERMS_* reasons, and confirms the demo terms (2,500 BU at 30/70) once", async () => {
    expect((await call("/api/orders/terms", json(body()), "officer")).status).toBe(403);
    expect(await reasonOf(body({ searchId: "search-unknown" }))).toEqual({ status: 404, reason: "TERMS_CANDIDATE" });
    expect(await reasonOf(body({}, { payeeType: "personal" }))).toEqual({ status: 422, reason: "TERMS_PAYEE_PERSONAL" });
    expect(await reasonOf(body({}, { accountNumber: "000000" }))).toEqual({ status: 422, reason: "TERMS_ACCOUNT_FORMAT" });
    expect(await reasonOf(body({}, { holderName: "Harbourline Pte. Ltd." }))).toEqual({ status: 422, reason: "TERMS_HOLDER_MISMATCH" });
    expect(await reasonOf(body({ totalMinor: "430000" }))).toEqual({ status: 409, reason: "TERMS_AUTO_OVER_PER_TX" });
    expect(await reasonOf(body({ milestones: [{ bps: 3000, trigger: "ON_ORDER" }, { bps: 7000, trigger: "ON_SHIPMENT" }] }))).toEqual({ status: 422, reason: "TERMS_LAST_NOT_INSPECTED" });
    const t = await confirm(body());
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ status: "CONFIRMED", orderId: null, coolingEndsAt: null, totalMinor: "250000", origin: "web" });
    expect(t.body.schedule.map((r) => [r.trigger, r.amountMinor, r.autoRelease])).toEqual([
      ["ON_ORDER", "75000", true],
      ["ON_DELIVERY_INSPECTED", "175000", false],
    ]);
    expect((await confirm(body())).body.termsId).toBe(t.body.termsId);
    const fifty = await confirm(body({ milestones: TERMS_PRESET_MILESTONES.P50_50.map((m) => ({ ...m })), totalMinor: "200000" }));
    expect((await terms(t.body.termsId)).status).toBe("SUPERSEDED");
    expect((await signApproval(t.body.termsId)).body.error?.details?.reason).toBe("TERMS_SUPERSEDED");
    expect((await terms(fifty.body.termsId)).status).toBe("CONFIRMED");
  });

  it("signs the terms, cools, pays the deposit by itself after cooling, and the balance waits for the founder's release", async () => {
    const before = (await call<Balances>("/api/balances")).body;
    const escrowBefore = before.escrowMinor;
    const supplierPocket = (b: Balances) => b.pockets.find((k) => k.lineKey === "SUPPLIER");
    const availableBefore = supplierPocket(before)?.available ?? "0";
    const spentBefore = supplierPocket(before)?.spent ?? "0";
    const t = (await confirm(body())).body;
    const req = await signApproval(t.termsId);
    expect(req.status).toBe(200);
    const rows = req.body.displayModel.rows;
    expect(rows.find((r) => r.label === "Found by web search, not verified")?.value).toContain(CANDIDATE.listingHost);
    // run-9: holder, whole account and bank apart; the account and milestones recompute to the signed hashes (as the browser does).
    expect(rows.find((r) => r.label === "Account number (simulated payout)")?.value).toBe("1002 0030 0400");
    expect(rows.find((r) => r.label === "Bank")?.value).toBe("DBS Bank");
    const shown = readWebOrderRows(rows);
    const m = req.body.typedData.message;
    expect(payoutAccountHash({ channel: "MOCK_ONLY", accountNumber: shown?.accountNumber ?? "", holderName: shown?.holderName ?? "" })).toBe(m.payoutAccountHash);
    expect(scheduleHash(shown?.schedule.map((x) => x.amountMinor) ?? [], shown?.schedule.map((x) => x.autoRelease) ?? [])).toBe(m.scheduleHash);
    expect(req.body.typedData.message).toMatchObject({ totalMinor: "250000", inspectionRequired: true, payoutAccountHash: t.payoutAccountHash });
    expect(t.bindTxHash).toBeNull();
    const sent = (await submit(req.body)).body;
    expect(sent.state).toBe("BROADCAST");
    const used = await terms(t.termsId);
    expect(used).toMatchObject({ status: "USED", orderId: ORDER });
    // The order card's seal: the bindPayee transaction the founder's SupplierApproval sent.
    expect(used.bindTxHash).toBe(sent.txHash);
    expect(Date.parse(used.coolingEndsAt as string)).toBe(now + 5000);
    expect((await signApproval(t.termsId)).body.error?.details?.reason).toBe("TERMS_ALREADY_BOUND");
    expect((await reasonOf(body({ totalMinor: "50000" }))).reason).toBe("TERMS_ALREADY_BOUND");

    // Cooling: nothing is paid, and the balance cannot be released yet.
    tick(2000);
    expect((await terms(t.termsId)).schedule.map((r) => r.released)).toEqual([false, false]);
    expect((await call<Payment[]>("/api/payments")).body.filter((p) => p.payeeId === CANDIDATE.supplierId)).toEqual([]);
    expect((await call<Partial<Err>>("/api/signatures/request", json({ kind: "MilestoneRelease", refId: ORDER, method: "passkey" }))).body.error?.code).toBe("PayeeCooling");

    // After cooling the agent pays the deposit by itself; once mined it shows released with its tx.
    tick(4000);
    await terms(t.termsId);
    tick(6000);
    const paid = await terms(t.termsId);
    expect(paid.schedule[0]).toMatchObject({ released: true, txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    expect(paid.schedule[1]).toMatchObject({ released: false, txHash: null });
    const supplierPays = (await call<Payment[]>("/api/payments")).body.filter((p) => p.payeeId === CANDIDATE.supplierId);
    const deposit = supplierPays.find((p) => p.kind === "FUND_MILESTONE" && p.amountMinor === "75000");
    expect(deposit?.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await terms(t.termsId)).schedule[0]?.txHash).toBe(deposit?.txHash);
    // As the live worker: at the same moment the balance is escrowed in full (FUND_MILESTONE, never released by the agent).
    const escrowed = supplierPays.find((p) => p.kind === "FUND_MILESTONE" && p.amountMinor === "175000");
    expect(escrowed?.state).toBe("FINALIZED");
    expect(supplierPays.map((p) => p.kind).sort()).toEqual(["FUND_MILESTONE", "FUND_MILESTONE"]);
    const funded = (await call<EscrowSchedule>(`/api/escrow/${ORDER}`)).body;
    expect(funded.map((m) => [m.amountMinor, m.funded, m.released])).toEqual([
      ["75000", "75000", true],
      ["175000", "175000", false],
    ]);
    // As the chain: both fundings move the pocket into escrow; the paid-out deposit stays counted in escrow and never in
    // the pocket's spent (Treasury.escrowRelease only counts the payee's paid amount).
    const balances = (await call<Balances>("/api/balances")).body;
    expect(balances.escrowMinor).toBe(String(BigInt(escrowBefore) + 250_000n));
    expect(supplierPocket(balances)?.available).toBe(String(BigInt(availableBefore) - 250_000n));
    expect(supplierPocket(balances)?.spent).toBe(spentBefore);
    // A web payee's payout reads "Sample payout" (MOCK_ONLY), never the country's rail wording.
    tick(6000);
    const detail = (await call<{ payment: Payment; traces: TraceEvent[] }>(`/api/payments/${deposit?.paymentId}`)).body;
    const payout = detail.traces.find((e) => e.kind === "PAYOUT");
    expect(payout?.summary).toMatch(/^Sample payout succeeded: no real bank transfer/);
    expect(payout?.summary).not.toMatch(/PayNow|Test-mode/);

    // The balance: evidence first, then the founder's release.
    expect((await call<Partial<Err>>("/api/signatures/request", json({ kind: "MilestoneRelease", refId: ORDER, method: "passkey" }))).status).toBe(409);
    const form = new FormData();
    form.append("file", new Blob([new TextEncoder().encode("delivery check: 500 tumblers ok")], { type: "application/pdf" }), "check.pdf");
    expect((await call(`/api/escrow/${ORDER}/inspection`, { method: "POST", body: form })).status).toBe(200);
    const release = (await call<SignatureRequestResponse>("/api/signatures/request", json({ kind: "MilestoneRelease", refId: ORDER, method: "passkey" }))).body;
    expect(release.typedData.message).toMatchObject({ idx: "1", amountMinor: "175000" });
    expect((await submit(release)).body.state).toBe("BROADCAST");
    tick(6000);
    const done = await terms(t.termsId);
    expect(done.schedule.map((r) => r.released)).toEqual([true, true]);
    expect(done.schedule[1]?.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    const escrow = (await call<EscrowSchedule>(`/api/escrow/${ORDER}`)).body;
    expect(escrow.map((m) => [m.amountMinor, m.released])).toEqual([
      ["75000", true],
      ["175000", true],
    ]);
    const releasePay = (await call<Payment[]>("/api/payments")).body.find((p) => p.kind === "RELEASE_MILESTONE");
    expect(releasePay?.payeeId).toBe(CANDIDATE.supplierId);
    // As the chain: the founder's release of a funded milestone moves nothing in the pocket or the escrow total.
    const released = (await call<Balances>("/api/balances")).body;
    expect(released.escrowMinor).toBe(String(BigInt(escrowBefore) + 250_000n));
    expect(supplierPocket(released)?.available).toBe(String(BigInt(availableBefore) - 250_000n));
    expect(supplierPocket(released)?.spent).toBe(spentBefore);
  });

  it("holds the deposit while payments are paused (the stop during cooling)", async () => {
    const t = (await confirm(body())).body;
    const req = (await signApproval(t.termsId)).body;
    expect((await submit(req)).body.state).toBe("BROADCAST");
    expect((await call("/api/control/pause", json({}))).status).toBe(200);
    tick(7000);
    await terms(t.termsId);
    tick(6000);
    expect((await terms(t.termsId)).schedule[0]?.released).toBe(false);
    expect((await call<Payment[]>("/api/payments")).body.filter((p) => p.payeeId === CANDIDATE.supplierId)).toEqual([]);
    expect((await call<EscrowSchedule>(`/api/escrow/${ORDER}`)).body.map((m) => m.funded)).toEqual(["0", "0"]);
  });

  it("refuses names that do not render as typed, and bounds new terms rows per 10 minutes (as live)", async () => {
    for (const payout of [{ holderName: `${CANDIDATE.displayName}\u200b` }, { bankName: "DBS\u2028Bank" }, { bankName: "DBS\u3164Bank" }]) {
      expect((await confirm(body({}, payout))).status, JSON.stringify(payout)).toBe(422);
    }
    for (let i = 0; i < MAX_TERMS_PER_WINDOW; i += 1) expect((await confirm(body({ quantity: 100 + i }))).status).toBe(200);
    const over = await confirm(body({ quantity: 99 }));
    expect(over.status).toBe(409);
    expect(over.body.error?.code).toBe("CONFLICT");
    // The newest identical body still answers its row; after the window, a new row is accepted again.
    expect((await confirm(body({ quantity: 100 + MAX_TERMS_PER_WINDOW - 1 }))).status).toBe(200);
    tick(600_001);
    expect((await confirm(body({ quantity: 99 }))).status).toBe(200);
  });

  it("re-plans a catalog SupplierApproval at submit: a supplier pocket changed meanwhile refuses it, nothing is written (run-9 lead 5)", async () => {
    const req = await signApproval("supplier-a");
    expect(req.status).toBe(200);
    const st = getState(readEnv());
    const allocated = pocketOf(st, "SUPPLIER")?.allocated ?? "0";
    updatePocket(st, "SUPPLIER", (k) => ({ ...k, allocated: "100000" }));
    const refused = await submit(req.body);
    expect(refused.status).toBe(409);
    expect(refused.body.error?.code).toBe("CONFLICT");
    expect([...st.escrow.keys()]).toEqual([]);
    expect((await call<Payment[]>("/api/payments")).body.filter((p) => p.kind === "FUND_MILESTONE")).toEqual([]);
    updatePocket(st, "SUPPLIER", (k) => ({ ...k, allocated }));
    const again = (await signApproval("supplier-a")).body;
    expect((await submit(again)).body.state).toBe("BROADCAST");
    const written = st.escrow.get("order-a-001") ?? [];
    expect(written.reduce((sum, m) => sum + BigInt(m.amountMinor), 0n).toString()).toBe(again.typedData.message.totalMinor);
  });

  it("signs the real shortlist hash and the live WEB_TERMS quoteHash for a computed search (re-check keccak LOW 3)", async () => {
    const started = (await call<{ searchId: string }>("/api/suppliers/search", json({ quantity: 500 }))).body;
    tick(SEARCH_DELAY_MS + 1);
    const st = getState(readEnv());
    const found = mockWebSearch(st, started.searchId);
    const top = found?.search.candidates[0];
    const seller = mockWebSupplier(st, top?.supplierId ?? "");
    expect(found?.shortlist && top && seller).toBeTruthy();
    const b = body({ supplierId: top?.supplierId, searchId: started.searchId }, { holderName: seller?.sellerName });
    const t = (await confirm(b)).body;
    expect(t.status).toBe("CONFIRMED");
    const m = (await signApproval(t.termsId)).body.typedData.message;
    const shortlistHash = shortlistHashOf(found?.shortlist as Shortlist);
    expect(m.shortlistHash).toBe(shortlistHash);
    expect(m.shortlistHash).not.toBe(hashObject({ searchId: started.searchId }));
    expect(m.quoteHash).toBe(
      webQuoteHash({
        termsId: t.termsId,
        supplierId: t.supplierId,
        shortlistHash,
        chosenIndex: Number(m.chosenIndex),
        currency: t.currency,
        totalMinor: "250000",
        milestones: P30_70,
        payeeType: "company",
        payoutAccountHash: t.payoutAccountHash,
      }),
    );
  });
});
