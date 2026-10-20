/**
 * GET /api/cfo is bounded (fixr-cfo, re-check LOW 4): an in-process limiter per client address and per server (like
 * the chat limiter; 429 UPSTREAM {reason RATE_LIMITED} with Retry-After before any chain or database read), and a
 * report cache: one report per (deployment, facility, snapshot block hash) for 15 s, with concurrent requests sharing
 * one computation (single flight). A failed computation is never cached.
 */
import { ApiError, type CfoReport } from "@hogee/core";
import { describe, expect, it } from "vitest";
import { createApiApp } from "../src/app";
import { CFO_RATE, cfoRoutes } from "../src/routes/cfo";
import { CFO_REPORT_TTL_MS, ReportCache } from "../src/services/cfo-cache";
import { cfoReport } from "../src/services/cfo";
import { RATE_LIMITED } from "../src/services/refusals";
import { fakeDeps } from "./support/fake-deps";

describe("GET /api/cfo rate limit", () => {
  function world() {
    let now = 1_000_000;
    let chainReads = 0;
    const client = new Proxy({}, { get: () => () => { chainReads += 1; return Promise.reject(new Error("rpc down")); } });
    const f = fakeDeps({ deps: { client: client as never, clock: () => now } });
    const app = createApiApp(async () => f.deps, cfoRoutes());
    const get = () => app.request("/api/cfo", { headers: { cookie: f.cookie("founder:rina") } });
    return { get, logs: f.logs, reads: () => chainReads, tick: (ms: number) => void (now += ms) };
  }

  it(`admits ${CFO_RATE.perClient} reports a minute per client, then answers 429 RATE_LIMITED before any read`, async () => {
    const w = world();
    for (let i = 0; i < CFO_RATE.perClient; i += 1) expect((await w.get()).status).toBe(502); // admitted: the chain is down
    const reads = w.reads();
    const res = await w.get();
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(ApiError.parse(await res.json()).error).toMatchObject({ code: "UPSTREAM", details: { reason: RATE_LIMITED, scope: "client" } });
    expect(w.reads()).toBe(reads);
    expect(w.logs.filter((l) => l.event === "cfo_rate_limited")).toHaveLength(1);
    w.tick(60_000);
    expect((await w.get()).status).toBe(502); // the window rolled over
  });

  it("each app (server) has its own budget", async () => {
    const a = world();
    for (let i = 0; i < CFO_RATE.perClient; i += 1) await a.get();
    expect((await a.get()).status).toBe(429);
    expect((await world().get()).status).toBe(502);
  });
});

describe("ReportCache: one computation per key, kept 15 s", () => {
  const deferred = <T>() => {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  it("concurrent requests for one key share one computation", async () => {
    const c = new ReportCache<string>();
    const d = deferred<string>();
    let loads = 0;
    const load = () => {
      loads += 1;
      return d.promise;
    };
    const both = Promise.all([c.get("k", 0, load), c.get("k", 0, load)]);
    d.resolve("report");
    expect(await both).toEqual(["report", "report"]);
    expect(loads).toBe(1);
  });

  it("serves a finished report for 15 s, then computes again; another key computes at once", async () => {
    expect(CFO_REPORT_TTL_MS).toBe(15_000);
    const c = new ReportCache<number>();
    let loads = 0;
    const load = async () => (loads += 1);
    expect(await c.get("block-a", 0, load)).toBe(1);
    expect(await c.get("block-a", 14_999, load)).toBe(1);
    expect(await c.get("block-b", 14_999, load)).toBe(2);
    expect(await c.get("block-a", 15_000, load)).toBe(3);
  });

  it("never caches a failure", async () => {
    const c = new ReportCache<number>();
    await expect(c.get("k", 0, () => Promise.reject(new Error("rpc down")))).rejects.toThrow("rpc down");
    expect(await c.get("k", 1, async () => 7)).toBe(7);
  });

  it("holds at most maxEntries reports (the oldest goes first)", async () => {
    const c = new ReportCache<number>(15_000, 2);
    let loads = 0;
    const load = async () => (loads += 1);
    await c.get("a", 0, load);
    await c.get("b", 0, load);
    await c.get("c", 0, load);
    expect(c.size).toBe(2);
    expect(await c.get("a", 1, load)).toBe(4); // evicted: computed again
  });
});

describe("cfoReport: one snapshot read per block for concurrent requests", () => {
  function chain() {
    const s = { head: 10n, reads: 0 };
    const client = {
      getBlock: async (a: { blockTag?: string; blockNumber?: bigint }) => {
        if (a.blockTag === "latest") return { number: s.head, hash: `0x${s.head.toString(16).padStart(64, "0")}`, timestamp: 0n };
        s.reads += 1;
        throw new Error("rpc down");
      },
      readContract: async () => {
        s.reads += 1;
        throw new Error("rpc down");
      },
    };
    return { s, deps: fakeDeps({ deps: { client: client as never } }).deps };
  }
  const scope = { facilityId: "fac-rina", founderId: "founder-rina" };

  it("two requests at the same head share one computation (and its failure, which is not kept)", async () => {
    const one = chain();
    await cfoReport(one.deps, scope, { reports: new ReportCache<CfoReport>() }).catch(() => undefined);
    const perReport = one.s.reads;
    expect(perReport).toBeGreaterThan(0);

    const two = chain();
    const reports = new ReportCache<CfoReport>();
    const both = await Promise.allSettled([cfoReport(two.deps, scope, { reports }), cfoReport(two.deps, scope, { reports })]);
    expect(both.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(two.s.reads).toBe(perReport);
    await cfoReport(two.deps, scope, { reports }).catch(() => undefined); // a failure is not cached: read again
    expect(two.s.reads).toBe(2 * perReport);
  });
});
