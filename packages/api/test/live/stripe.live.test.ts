/**
 * §9.2 sales oracle and demo task 11 on Anvil + Postgres: a signed Stripe test webhook becomes ONE sales row, an
 * unsigned SalesOracle.recordSale action and an oracle trace; the worker (oracle key) records it on-chain and Treasury
 * skims the reserve. Everything else is refused (400) or acknowledged with no effect: replays, a second event for the
 * same payment, live mode, another facility, another currency, zero amounts. POST /api/demo/sale creates the Stripe
 * test payment whose webhook is the real path.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "@hogee/core";
import { createApiApp } from "../../src/app";
import { iSalesOracleAbi, iTreasuryAbi, utf8Keccak } from "../../src/chain-lib";
import { demoSaleRoutes } from "../../src/routes/demo-sale";
import { webhookRoutes } from "../../src/routes/webhooks";
import { SALE_BUCKET_MINOR } from "../../src/services/sales";
import { scriptedAgent, type ScriptedAgent } from "../support/agent";
import { randomSecret } from "../support/fake-deps";
import { LIVE, LIVE_TIMEOUT_MS, openLive, type Live } from "../support/live";
import { chatToDraft, openAndRegister, signPlan } from "../support/steps";
import { checkoutSessionCompleted, fakeStripe, nowSeconds, paymentIntentSucceeded, postStripe, signStripe, stripeEvent, stripeIds, type PostOptions, type TestEvent } from "../support/stripe";
import { newWorld, type World } from "../support/world";

const SESSION = "01a14202-2800-7000-8000-0000000000dd";
const ROUTES = { ...webhookRoutes, ...demoSaleRoutes() };
const errorOf = async (res: Response) => ApiError.parse(await res.json()).error;

describe.skipIf(!LIVE)("stripe webhook and demo sale (live)", { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  let w: World;
  let agent: ScriptedAgent;

  const q = <T>(sql: string, values: unknown[]) => live.db.$client.query(sql, values).then((r) => r.rows as T[]);
  const sales = () => q<{ id: string; stripe_event_id: string; sale_id_hash: string; amount_bucket: string; tx_hash: string | null }>(
    "select id, stripe_event_id, sale_id_hash, amount_bucket::text as amount_bucket, tx_hash from sales where facility_id = $1 order by created_at",
    [w.facilityId],
  );
  const saleActions = () => q<{ id: string; ref_id: string; state: string; raw_signed_tx: string | null; request_json: Record<string, unknown> }>(
    "select id, ref_id, state, raw_signed_tx, request_json from chain_actions where facility_id = $1 and kind = 'SalesOracle.recordSale' order by created_at",
    [w.facilityId],
  );
  const traceCount = async () => (await q<{ n: number }>("select count(*)::int as n from traces where facility_id = $1", [w.facilityId]))[0]?.n ?? 0;
  const secret = () => w.flags.stripeWebhookSecret as string;
  const post = (event: TestEvent | string, o: PostOptions = {}) => postStripe(w.app, event, secret(), o);
  const ours = (o: Partial<Parameters<typeof paymentIntentSucceeded>[0]> = {}) => paymentIntentSucceeded({ facilityId: w.facilityId, ...o });
  const isRecorded = (saleIdHash: string) =>
    live.client.readContract({ address: w.deployment.contracts.SalesOracle.address, abi: iSalesOracleAbi, functionName: "isSaleRecorded", args: [saleIdHash as `0x${string}`] });
  const revenue = () => live.client.readContract({ address: w.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: "revenue" });

  /** The response is a no-op acknowledgement and nothing was written but (optionally) traces. */
  async function expectNoSale(res: Response, before: { sales: number; actions: number }): Promise<void> {
    expect(res.status).toBe(200);
    expect((await sales()).length).toBe(before.sales);
    expect((await saleActions()).length).toBe(before.actions);
  }
  const counts = async () => ({ sales: (await sales()).length, actions: (await saleActions()).length });

  beforeAll(async () => {
    live = await openLive();
    agent = scriptedAgent();
    w = await newWorld(live, { agent, routes: ROUTES });
    const auth = await openAndRegister(w);
    const draftId = await chatToDraft(w, agent, SESSION);
    await signPlan(w, auth, draftId); // creditRevenue needs a committed plan (StalePlan before the first one)
  }, LIVE_TIMEOUT_MS);
  afterAll(async () => {
    await live?.close();
  });

  describe("signature", () => {
    async function expect400(res: Response): Promise<void> {
      const text = await res.clone().text();
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("VALIDATION");
      expect(text).not.toContain(secret());
      expect((await sales()).length).toBe(0);
      expect(w.jobs.filter((j) => j.job === "record-sale")).toEqual([]);
    }

    it("400s a bad signature (another secret)", async () => {
      const event = ours();
      await expect400(await post(event, { header: signStripe(randomSecret(), JSON.stringify(event)) }));
    });

    it("400s a missing Stripe-Signature header", async () => {
      await expect400(await post(ours(), { header: null }));
    });

    it("400s a stale (and a future) timestamp", async () => {
      await expect400(await post(ours(), { t: nowSeconds() - 301 }));
      await expect400(await post(ours(), { t: nowSeconds() + 301 }));
    });

    it("400s a body changed after signing", async () => {
      await expect400(await post(ours({ amountMinor: 100 }), { tamper: (raw) => raw.replaceAll(":100,", ":9999900,") }));
      await expect400(await post(ours(), { tamper: (raw) => raw.replace(w.facilityId, "fac-other") }));
    });
  });

  describe("a verified payment_intent.succeeded", () => {
    const amountMinor = 12_345;
    let event: TestEvent;
    let paymentIntentId: string;

    beforeAll(() => {
      paymentIntentId = stripeIds.paymentIntent();
      event = ours({ amountMinor, paymentIntentId });
    });

    it("writes one sales row, one unsigned recordSale action and an oracle trace, then wakes record-sale", async () => {
      const res = await post(event);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({});
      const [sale, ...more] = await sales();
      expect(more).toEqual([]);
      const bucket = (BigInt(amountMinor) / SALE_BUCKET_MINOR) * SALE_BUCKET_MINOR;
      expect(sale).toMatchObject({ stripe_event_id: event.id, sale_id_hash: utf8Keccak(event.id), amount_bucket: bucket.toString(), tx_hash: null });
      expect(sale?.id).not.toContain(paymentIntentId); // only hashes of Stripe ids are stored
      const [action, ...others] = await saleActions();
      expect(others).toEqual([]);
      expect(action).toMatchObject({ ref_id: sale?.id, state: "PENDING", raw_signed_tx: null });
      expect(action?.request_json).toMatchObject({ saleId: sale?.id, saleIdHash: sale?.sale_id_hash, amountBucket: bucket.toString() });
      const traces = await q<{ actor: string; kind: string; summary: string }>("select actor, kind, summary from traces where facility_id = $1 and trace_id = $2", [w.facilityId, sale?.id]);
      expect(traces).toEqual([expect.objectContaining({ actor: "oracle", kind: "TX" })]);
      expect(traces[0]?.summary).not.toMatch(/token|coin|usdc|defi|rwa/i);
      expect(w.jobs.map((j) => j.job)).toContain("record-sale");
    });

    it("the worker's oracle key records it on-chain and Treasury credits the bucketed revenue", async () => {
      const before = await revenue();
      await w.pump();
      const [sale] = await sales();
      expect(await isRecorded(sale?.sale_id_hash as string)).toBe(true);
      expect((await revenue()) - before).toBe(BigInt(sale?.amount_bucket as string));
      expect(sale?.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
      const [action] = await saleActions();
      expect(action?.raw_signed_tx).not.toBeNull();
    });

    it("a replay of the same event id answers {duplicate: true} with no effect", async () => {
      const before = { ...(await counts()), traces: await traceCount() };
      const res = await post(event);
      expect(await res.clone().json()).toEqual({ duplicate: true });
      await expectNoSale(res, before);
      expect(await traceCount()).toBe(before.traces);
    });

    it("checkout.session.completed for the same payment intent is the same sale: no second row", async () => {
      const before = await counts();
      const res = await post(checkoutSessionCompleted({ facilityId: w.facilityId, paymentIntentId, amountMinor }));
      expect(await res.clone().json()).toEqual({ duplicate: true });
      await expectNoSale(res, before);
    });

    it("and so is a second payment_intent.succeeded event (new event id) for that payment", async () => {
      const before = await counts();
      const res = await post(ours({ amountMinor, paymentIntentId }));
      expect(await res.clone().json()).toEqual({ duplicate: true });
      await expectNoSale(res, before);
    });
  });

  it("checkout.session.completed (paid) for a new payment records a sale; unpaid does not", async () => {
    const before = await counts();
    const unpaid = await post(checkoutSessionCompleted({ facilityId: w.facilityId, paymentStatus: "unpaid" }));
    await expectNoSale(unpaid, before);
    const paid = checkoutSessionCompleted({ facilityId: w.facilityId, amountMinor: 30_000 });
    const res = await post(paid);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect((await sales()).length).toBe(before.sales + 1);
    expect((await sales()).at(-1)).toMatchObject({ stripe_event_id: paid.id, amount_bucket: "30000" });
    // The payment_intent.succeeded for that payment later: still one sale.
    const pi = (paid.data.object as { payment_intent: string }).payment_intent;
    expect(await (await post(ours({ paymentIntentId: pi, amountMinor: 30_000 }))).json()).toEqual({ duplicate: true });
    expect((await sales()).length).toBe(before.sales + 1);
    await w.pump();
    expect(await isRecorded(utf8Keccak(paid.id))).toBe(true);
  });

  it("concurrent deliveries of one payment (the same event, and checkout + intent events) record exactly one sale", async () => {
    const before = await counts();
    const paymentIntentId = stripeIds.paymentIntent();
    const intent = ours({ paymentIntentId, amountMinor: 7_000 });
    const checkout = checkoutSessionCompleted({ facilityId: w.facilityId, paymentIntentId, amountMinor: 7_000 });
    const results = await Promise.all([intent, intent, checkout, intent, checkout].map((e) => post(e).then(async (r) => ({ status: r.status, body: await r.json() }))));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => JSON.stringify(r.body) === "{}")).toHaveLength(1);
    expect(await counts()).toEqual({ sales: before.sales + 1, actions: before.actions + 1 });
  });

  it("records nothing before the loan officer opens the facility (the scope is server config, not the event)", async () => {
    const unopened = `fac-unopened-${stripeIds.event().slice(-8)}`;
    const app = createApiApp(async () => ({ ...w.deps, config: { ...w.deps.config, facilityId: unopened } }), ROUTES);
    const res = await postStripe(app, paymentIntentSucceeded({ facilityId: unopened }), secret());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect((await q("select 1 from sales where facility_id = $1", [unopened])).length).toBe(0);
  });

  describe("acknowledged with no effect (and traced)", () => {
    const cases: [string, () => TestEvent][] = [
      ["a live-mode event", () => ours({ livemode: true })],
      ["a live-mode payment object in a test-mode event", () => {
        const e = ours();
        return { ...e, data: { object: { ...e.data.object, livemode: true } } };
      }],
      ["another facility", () => paymentIntentSucceeded({ facilityId: "fac-someone-else" })],
      ["no facility in the metadata", () => paymentIntentSucceeded({ facilityId: null })],
      ["another currency", () => ours({ currency: "usd" })],
      ["a zero amount", () => ours({ amountMinor: 0 })],
      ["a negative amount", () => ours({ amountMinor: -500 })],
      ["an amount below one bucket", () => ours({ amountMinor: Number(SALE_BUCKET_MINOR) - 1 })],
      ["a zero-total checkout", () => checkoutSessionCompleted({ facilityId: w.facilityId, amountMinor: 0, paymentStatus: "no_payment_required" })],
      ["a payment object that is not readable", () => stripeEvent("payment_intent.succeeded", { id: "pi_x", object: "payment_intent", metadata: { facilityId: w.facilityId } })],
    ];
    for (const [name, make] of cases) {
      it(name, async () => {
        const before = await counts();
        const traces = await traceCount();
        const event = make();
        const res = await post(event);
        expect(await res.clone().json()).toEqual({});
        await expectNoSale(res, before);
        expect(await traceCount()).toBe(traces + 1);
        // A replay is a duplicate and traces nothing more.
        expect(await (await post(event)).json()).toEqual({ duplicate: true });
        expect(await traceCount()).toBe(traces + 1);
      });
    }

    it("never traces the event's own text (no echo of untrusted metadata)", async () => {
      const marker = "fac-<script>alert(1)</script>";
      const res = await post(paymentIntentSucceeded({ facilityId: marker }));
      expect(res.status).toBe(200);
      const rows = await q<{ summary: string }>("select summary from traces where facility_id = $1 and summary like $2", [w.facilityId, "%script%"]);
      expect(rows).toEqual([]);
    });
  });

  it("acknowledges other event types (refunds, created intents) with no effect and no trace", async () => {
    const before = await counts();
    const traces = await traceCount();
    for (const type of ["charge.refunded", "payment_intent.created", "payment_intent.payment_failed", "checkout.session.expired"]) {
      const res = await post(stripeEvent(type, { id: stripeIds.paymentIntent(), object: "payment_intent", amount: 5000, currency: "myr", metadata: { facilityId: w.facilityId } }));
      expect(await res.clone().json()).toEqual({});
      await expectNoSale(res, before);
    }
    expect(await traceCount()).toBe(traces);
  });

  describe("POST /api/demo/sale", () => {
    it("answers 503 UPSTREAM naming STRIPE_SECRET_KEY when Stripe is not configured", async () => {
      const res = await w.founder.post("/api/demo/sale", { amountMinor: "50000" });
      expect(res.status).toBe(503);
      const error = await errorOf(res);
      expect(error.code).toBe("UPSTREAM");
      expect(error.message).toContain("STRIPE_SECRET_KEY");
    });

    it("creates a Stripe test payment for THIS facility in its currency; the sale itself waits for the webhook", async () => {
      const stripe = fakeStripe();
      const app = createApiApp(async () => ({ ...w.deps, stripe }), ROUTES);
      const before = await counts();
      const res = await app.request("/api/demo/sale", { method: "POST", headers: { "content-type": "application/json", cookie: w.cookie("founder:rina") }, body: JSON.stringify({ amountMinor: "50000" }) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { paymentIntentId: string };
      expect(body.paymentIntentId).toMatch(/^pi_/);
      expect(stripe.calls).toHaveLength(1);
      expect(stripe.calls[0]).toMatchObject({ amountMinor: 50_000n, currency: "MYR", facilityId: w.facilityId });
      expect(stripe.calls[0]?.idempotencyKey).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,}$/);
      expect(await counts()).toEqual(before);
    });

    it("refuses amounts that would never count (below one bucket) or exceed Stripe's limit (422), before calling Stripe", async () => {
      const stripe = fakeStripe();
      const app = createApiApp(async () => ({ ...w.deps, stripe }), ROUTES);
      for (const amountMinor of ["0", String(SALE_BUCKET_MINOR - 1n), "100000000"]) {
        const res = await app.request("/api/demo/sale", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amountMinor }) });
        expect(res.status, amountMinor).toBe(422);
        expect((await errorOf(res)).code).toBe("VALIDATION");
      }
      expect(stripe.calls).toEqual([]);
    });

    it("maps a Stripe failure to a generic 502 UPSTREAM", async () => {
      const leaked = `sk_test_${randomSecret()}`;
      const stripe = fakeStripe(Object.assign(new Error(`Invalid API Key provided: ${leaked}`), { code: "api_key_invalid" }));
      const logs: unknown[] = [];
      const deps = { ...w.deps, stripe, log: { ...w.deps.log, warn: (e: string, f?: unknown) => void logs.push({ e, f }), error: (e: string, f?: unknown) => void logs.push({ e, f }) } };
      const app = createApiApp(async () => deps, ROUTES);
      const res = await app.request("/api/demo/sale", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amountMinor: "50000" }) });
      const text = await res.clone().text();
      expect(res.status).toBe(502);
      expect((await errorOf(res)).code).toBe("UPSTREAM");
      expect(text).not.toContain(leaked);
      expect(JSON.stringify(logs)).not.toContain(leaked);
    });

    it("is hidden (404) without DEMO_MODE", async () => {
      const stripe = fakeStripe();
      const app = createApiApp(async () => ({ ...w.deps, stripe, flags: () => ({ ...w.flags, demoMode: false }) }), ROUTES);
      const res = await app.request("/api/demo/sale", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amountMinor: "50000" }) });
      expect(res.status).toBe(404);
      expect(stripe.calls).toEqual([]);
    });
  });
});
