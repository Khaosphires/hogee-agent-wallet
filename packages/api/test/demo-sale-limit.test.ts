/**
 * POST /api/demo/sale is rate limited per server (audit run-9 lead 4): every demo sale becomes a recorded sale that the
 * oracle key signs on the nonce sequence settlement shares, and wakes cfo-guard. Six a minute (in-process, like the
 * chat limiter); past that a 429 UPSTREAM {reason RATE_LIMITED} with Retry-After, before the database or Stripe.
 */
import { ApiError } from "@hogee/core";
import type { Db } from "@hogee/db";
import { describe, expect, it } from "vitest";
import { createApiApp } from "../src/app";
import { DEMO_SALE_RATE_PER_MIN, demoSaleRoutes } from "../src/routes/demo-sale";
import { RATE_LIMITED } from "../src/services/refusals";
import { fakeDeps } from "./support/fake-deps";
import { fakeStripe } from "./support/stripe";

function world() {
  const sql: string[] = [];
  const query = async (text: string) => {
    sql.push(text);
    return { rows: /from facilities/.test(text) ? [{ facility_id: "fac-rina", currency: "MYR" }] : [], rowCount: 1 };
  };
  const db = { $client: { query, connect: async () => ({ query, release: () => undefined }) } } as unknown as Db;
  let now = 1_000_000;
  const stripe = fakeStripe();
  const f = fakeDeps({ deps: { db, stripe, clock: () => now } });
  const app = createApiApp(async () => f.deps, demoSaleRoutes());
  const post = (amountMinor: string) =>
    app.request("/api/demo/sale", { method: "POST", headers: { "content-type": "application/json", cookie: f.cookie("founder:rina") }, body: JSON.stringify({ amountMinor }) });
  return { post, stripe, sql, logs: f.logs, tick: (ms: number) => void (now += ms) };
}

describe("POST /api/demo/sale rate limit", () => {
  it(`admits ${6} demo sales a minute per server, then answers 429 RATE_LIMITED before the database or Stripe`, async () => {
    expect(DEMO_SALE_RATE_PER_MIN).toBe(6);
    const w = world();
    for (let i = 0; i < DEMO_SALE_RATE_PER_MIN; i += 1) expect((await w.post("50000")).status).toBe(200);
    expect(w.stripe.calls).toHaveLength(DEMO_SALE_RATE_PER_MIN);
    const reads = w.sql.length;
    const res = await w.post("50000");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(ApiError.parse(await res.json()).error).toMatchObject({ code: "UPSTREAM", details: { reason: RATE_LIMITED, scope: "server" } });
    expect(w.stripe.calls).toHaveLength(DEMO_SALE_RATE_PER_MIN);
    expect(w.sql.length).toBe(reads);
    expect(w.logs.filter((l) => l.event === "demo_sale_rate_limited")).toHaveLength(1);
    w.tick(60_000);
    expect((await w.post("50000")).status).toBe(200); // the window rolled over
  });

  it("an amount refused as invalid uses none of the budget", async () => {
    const w = world();
    for (let i = 0; i < 10; i += 1) expect((await w.post("1")).status).toBe(422);
    for (let i = 0; i < DEMO_SALE_RATE_PER_MIN; i += 1) expect((await w.post("50000")).status).toBe(200);
  });

  it("each app (server) has its own budget", async () => {
    const a = world();
    for (let i = 0; i < DEMO_SALE_RATE_PER_MIN; i += 1) await a.post("50000");
    expect((await a.post("50000")).status).toBe(429);
    expect((await world().post("50000")).status).toBe(200);
  });
});
