/**
 * fix-cfo-load: GET /api/cfo polling, run on a real QueryClient with fake timers (no React needed: the hooks are thin
 * wrappers around these options). Before the fix the wallet rail and the dashboard tiles polled the report every 1.5 s
 * and the CFO page and chat card every 10 s on the SAME key, and each query update restarts every observer's interval,
 * so the 1.5 s one won: 40 reports a minute from one tab against a fast server, over the server's 30 a minute per
 * client. A 429 was asked again 1.5 s later, and one failed refresh replaced the report with a red error.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exampleCfoReport } from "@hogee/core";
import { QueryClient, QueryObserver, environmentManager, focusManager, type QueryObserverResult } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { clearRetryAfter, type ApiClientError } from "./client";
import { CFO_POLL_MS, cfoReportQuery, queryView, retryQuery } from "./query-policy";

const MINUTE = 60_000;
/** The server's per-client budget (packages/api routes/cfo.ts CFO_RATE.perClient). */
const SERVER_PER_MINUTE = 30;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const ok = () => json(200, exampleCfoReport);
const limited = (seconds: number) =>
  json(429, { error: { code: "UPSTREAM", message: `Too many CFO report requests; try again in ${seconds} s`, details: { reason: "RATE_LIMITED", scope: "client", retryAfterSeconds: seconds } } }, { "retry-after": String(seconds) });
const outage = () => json(502, { error: { code: "UPSTREAM", message: "The CFO could not read the chain and the records; try again shortly" } });

let fetchMock: Mock<(input: string, init?: RequestInit) => Promise<Response>>;
const cfoCalls = () => fetchMock.mock.calls.filter(([url]) => url === "/api/cfo").length;

/** A tab with the four CFO consumers mounted: the wallet rail, the dashboard tiles, the CFO page and a chat card. */
function tab() {
  const client = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: retryQuery } } });
  const observers = Array.from({ length: 4 }, () => new QueryObserver(client, cfoReportQuery()));
  const last: { result?: QueryObserverResult<unknown, ApiClientError> } = {};
  const stops = observers.map((o) => o.subscribe((r) => (last.result = r as QueryObserverResult<unknown, ApiClientError>)));
  return { client, last, stop: () => stops.forEach((s) => s()) };
}

let open: ReturnType<typeof tab> | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
  environmentManager.setIsServer(() => false);
  clearRetryAfter();
  fetchMock = vi.fn(async () => ok());
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

describe("one shared CFO query, polled under the server's limit", () => {
  it("the four consumers share one key and fetch once per CFO_POLL_MS (15 s): 4 a minute, not 40", async () => {
    expect(CFO_POLL_MS).toBeGreaterThanOrEqual(15_000);
    open = tab();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(open.client.getQueryCache().getAll()).toHaveLength(1);
    const perMinute = (cfoCalls() - 1) / 10;
    expect(perMinute).toBe(MINUTE / CFO_POLL_MS);
    expect(perMinute).toBeLessThan(SERVER_PER_MINUTE / 4);
  });

  it("with a slow server (5 s a report, as on Sepolia) it polls no more often", async () => {
    fetchMock.mockImplementation(() => new Promise((r) => setTimeout(() => r(ok()), 5_000)));
    open = tab();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect((cfoCalls() - 1) / 10).toBeLessThanOrEqual(MINUTE / CFO_POLL_MS);
  });

  it("a hidden tab does not poll", async () => {
    open = tab();
    await vi.advanceTimersByTimeAsync(0);
    expect(cfoCalls()).toBe(1);
    focusManager.setFocused(false);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(cfoCalls()).toBe(1);
    focusManager.setFocused(true);
    await vi.advanceTimersByTimeAsync(CFO_POLL_MS);
    expect(cfoCalls()).toBe(2);
  });

  it("cards mounted later ask once for the current report (fresh numbers for 'How are we doing?')", async () => {
    open = tab();
    await vi.advanceTimersByTimeAsync(5_000);
    const later = [1, 2].map(() => new QueryObserver(open!.client, cfoReportQuery()).subscribe(() => undefined));
    await vi.advanceTimersByTimeAsync(0);
    expect(cfoCalls()).toBe(2);
    later.forEach((stop) => stop());
  });
});

describe("a 429 backs off for its Retry-After (no retry storm)", () => {
  it("nothing is sent before the wait has passed, not even by a refetch after a mutation; then 15 s polling resumes", async () => {
    fetchMock.mockImplementationOnce(async () => ok()).mockImplementationOnce(async () => limited(50));
    open = tab();
    await vi.advanceTimersByTimeAsync(CFO_POLL_MS); // t = 15 s: the second poll is refused for 50 s
    expect(cfoCalls()).toBe(2);
    await open.client.invalidateQueries(); // what every mutation does
    await vi.advanceTimersByTimeAsync(49_000);
    expect(cfoCalls()).toBe(2);
    expect(open.last.result?.data).toEqual(exampleCfoReport);
    await vi.advanceTimersByTimeAsync(1_000); // t = 65 s
    expect(cfoCalls()).toBe(3);
    await vi.advanceTimersByTimeAsync(CFO_POLL_MS);
    expect(cfoCalls()).toBe(4);
  });
});

describe("the last good report stays on screen", () => {
  it("a failed refresh keeps the report, flagged; the next good poll clears the flag", async () => {
    fetchMock.mockImplementationOnce(async () => ok()).mockImplementation(async () => outage());
    open = tab();
    await vi.advanceTimersByTimeAsync(CFO_POLL_MS + 5_000); // the poll, then its two 5xx retries (1 s, 2 s)
    const failed = queryView(open.last.result!);
    expect(failed).toMatchObject({ kind: "data", data: exampleCfoReport });
    expect(failed.kind === "data" && failed.refreshFailed?.status).toBe(502);

    fetchMock.mockImplementation(async () => ok());
    await vi.advanceTimersByTimeAsync(CFO_POLL_MS);
    expect(queryView(open.last.result!)).toMatchObject({ kind: "data", refreshFailed: null });
  });

  it("the error shows only when there is no report at all", async () => {
    fetchMock.mockImplementation(async () => limited(20));
    open = tab();
    await vi.advanceTimersByTimeAsync(0);
    expect(queryView(open.last.result!)).toMatchObject({ kind: "error", error: { status: 429 } });
  });

  it("queryView: loading, error without data, data with or without a failed refresh", () => {
    const error = { status: 502 } as ApiClientError;
    expect(queryView({ data: undefined, error: null })).toEqual({ kind: "loading" });
    expect(queryView({ data: undefined, error })).toEqual({ kind: "error", error });
    expect(queryView({ data: 1, error })).toEqual({ kind: "data", data: 1, refreshFailed: error });
    expect(queryView({ data: 1, error: null })).toEqual({ kind: "data", data: 1, refreshFailed: null });
  });
});

describe("every consumer reads the one shared query", () => {
  const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === "node_modules" || name.startsWith(".") ? [] : sources(path);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  const files = ["app", "components", "lib"].flatMap((d) => sources(join(WEB, d)));

  it('"getCfoReport" is queried only by cfoReportQuery', () => {
    const users = files.filter((f) => readFileSync(f, "utf8").includes('"getCfoReport"')).map((f) => relative(WEB, f));
    expect(users).toEqual(["lib/api/query-policy.ts"]);
  });

  // ux-money: the wallet tiles (dashboard-view.tsx) left the Money page (UX-PLAN D8); the page and the card remain.
  it.each(["components/chat/wallet-rail.tsx", "components/cfo/cfo-page.tsx", "components/chat/cards/cfo-card.tsx"])(
    "%s uses useCfoReport()",
    (file) => {
      expect(readFileSync(join(WEB, file), "utf8")).toContain("useCfoReport()");
    },
  );
});
