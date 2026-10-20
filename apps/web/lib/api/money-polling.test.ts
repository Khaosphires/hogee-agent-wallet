/**
 * fix-cfo-load, follow-up (P1 decision): the money reads poll at their own pace instead of every 1.5 s. Each
 * GET /api/balances and GET /api/stats/autonomy is a full chain snapshot on the server (no cache), so at 1.5 s a tab
 * sent 40 of each a minute, most of the public RPC's traffic. Now: balances every 5 s, autonomy every 15 s, neither
 * while the tab is hidden, and every query refetches at once after an action that changes money (sign, fund, release,
 * pause), so the founder never waits for a poll to see their own action.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exampleAutonomyStats, exampleBalances, exampleCfoReport } from "@hogee/core";
import { QueryClient, QueryObserver, environmentManager, focusManager } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { clearRetryAfter } from "./client";
import { refreshAfterAction } from "./hooks";
import { AUTONOMY_POLL_MS, BALANCES_POLL_MS, autonomyQuery, balancesQuery, cfoReportQuery, retryQuery } from "./query-policy";

const MINUTE = 60_000;
const BODIES: Readonly<Record<string, unknown>> = { "/api/balances": exampleBalances, "/api/stats/autonomy": exampleAutonomyStats, "/api/cfo": exampleCfoReport };

let fetchMock: Mock<(input: string, init?: RequestInit) => Promise<Response>>;
const calls = (path: string) => fetchMock.mock.calls.filter(([url]) => url === path).length;

/** A tab with the money reads mounted as the pages mount them: balances three times (rail, tiles, plan), autonomy once. */
function tab() {
  const client = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: retryQuery } } });
  const observers = [balancesQuery(), balancesQuery(), balancesQuery(), autonomyQuery(), cfoReportQuery()].map((o) => new QueryObserver(client, o as never));
  const stops = observers.map((o) => o.subscribe(() => undefined));
  return { client, stop: () => stops.forEach((s) => s()) };
}

let open: ReturnType<typeof tab> | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
  environmentManager.setIsServer(() => false);
  clearRetryAfter();
  fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(BODIES[url]), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  open?.stop();
  open?.client.clear();
  open = undefined;
  focusManager.setFocused(undefined);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("balances every 5 s, autonomy every 15 s", () => {
  it("one query each, whatever mounts them: 12 balances and 4 autonomy reads a minute", async () => {
    expect(BALANCES_POLL_MS).toBe(5_000);
    expect(AUTONOMY_POLL_MS).toBe(15_000);
    open = tab();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect((calls("/api/balances") - 1) / 10).toBe(MINUTE / BALANCES_POLL_MS);
    expect((calls("/api/stats/autonomy") - 1) / 10).toBe(MINUTE / AUTONOMY_POLL_MS);
  });

  it("neither polls while the tab is hidden", async () => {
    open = tab();
    await vi.advanceTimersByTimeAsync(0);
    focusManager.setFocused(false);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(calls("/api/balances")).toBe(1);
    expect(calls("/api/stats/autonomy")).toBe(1);
  });
});

describe("an action that changes money refetches at once", () => {
  it("balances, autonomy and the CFO report are read again right after the action, not at the next poll", async () => {
    open = tab();
    await vi.advanceTimersByTimeAsync(1_000);
    const before = ["/api/balances", "/api/stats/autonomy", "/api/cfo"].map(calls);
    await refreshAfterAction(open.client);
    expect(["/api/balances", "/api/stats/autonomy", "/api/cfo"].map(calls)).toEqual(before.map((n) => n + 1));
  });

  const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const source = (file: string) => readFileSync(join(WEB, file), "utf8");

  it("every mutation (fund, pause, release requests, …) and every signature ends with refreshAfterAction", () => {
    expect(source("lib/api/hooks.ts")).toMatch(/onSuccess: \(\) => refreshAfterAction\(queryClient\)/);
    expect(source("components/sign/sign-dialog.tsx")).toMatch(/await refreshAfterAction\(queryClient\)/);
    expect(source("components/sign/sign-dialog.tsx")).not.toMatch(/invalidateQueries\(\)/);
  });

  it.each(['"getBalances"', '"getAutonomyStats"'])("%s is queried only by its shared options (lib/api/query-policy.ts)", (route) => {
    const sources = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return name === "node_modules" || name.startsWith(".") ? [] : sources(path);
        return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
      });
    const users = ["app", "components", "lib"].flatMap((d) => sources(join(WEB, d))).filter((f) => readFileSync(f, "utf8").includes(route));
    expect(users.map((f) => relative(WEB, f))).toEqual(["lib/api/query-policy.ts"]);
  });
});
