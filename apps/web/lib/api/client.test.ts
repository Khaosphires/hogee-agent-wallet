/**
 * fix-cfo-load: Retry-After on the one HTTP client. The live Sepolia run logged 13 × 429 on GET /api/cfo in 20 minutes:
 * a refused GET was asked again 1.5 s later, and again. Now the 429's wait rides on the error, and the same GET is not
 * sent again before it has passed (answered locally with the remaining wait), whatever asks: a poll, a newly mounted
 * card or the refetch after a mutation.
 */
import { exampleCfoReport } from "@hogee/core";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ApiClientError, MAX_RETRY_AFTER_MS, apiCall, clearRetryAfter, retryAfterMsOf } from "./client";

const NOW = new Date("2026-10-19T12:00:00Z");
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const ok = () => json(200, exampleCfoReport);
function limited(o: { header?: string; seconds?: number } = {}) {
  const details = { reason: "RATE_LIMITED", scope: "client", ...(o.seconds === undefined ? {} : { retryAfterSeconds: o.seconds }) };
  return json(429, { error: { code: "UPSTREAM", message: "Too many CFO report requests; try again in 20 s", details } }, o.header === undefined ? {} : { "retry-after": o.header });
}
const errorOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as ApiClientError);

let fetchMock: Mock<(input: string, init?: RequestInit) => Promise<Response>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  clearRetryAfter();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the wait a 429 asks for", () => {
  it("Retry-After in seconds rides on the error", async () => {
    fetchMock.mockResolvedValueOnce(limited({ header: "20", seconds: 20 }));
    const err = await errorOf(apiCall("getCfoReport"));
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err).toMatchObject({ status: 429, code: "UPSTREAM", retryAfterMs: 20_000 });
    expect(retryAfterMsOf(err)).toBe(20_000);
  });

  it("an HTTP-date Retry-After, or the body's retryAfterSeconds when the header is missing", async () => {
    fetchMock.mockResolvedValueOnce(limited({ header: new Date(NOW.getTime() + 30_000).toUTCString() }));
    expect((await errorOf(apiCall("getCfoReport")))?.retryAfterMs).toBe(30_000);
    clearRetryAfter();
    fetchMock.mockResolvedValueOnce(limited({ seconds: 12 }));
    expect((await errorOf(apiCall("getCfoReport")))?.retryAfterMs).toBe(12_000);
  });

  it.each(["soon", "-1", "1.5", ""])("an unreadable Retry-After %j asks for no wait", async (header) => {
    fetchMock.mockResolvedValueOnce(limited({ header }));
    const err = await errorOf(apiCall("getCfoReport"));
    expect(err?.status).toBe(429);
    expect(err?.retryAfterMs).toBeUndefined();
    expect(retryAfterMsOf(err)).toBeNull();
  });

  it("a wait longer than MAX_RETRY_AFTER_MS is capped", async () => {
    fetchMock.mockResolvedValueOnce(limited({ header: "86400" }));
    expect((await errorOf(apiCall("getCfoReport")))?.retryAfterMs).toBe(MAX_RETRY_AFTER_MS);
  });

  it("only a 429 asks for a wait", async () => {
    fetchMock.mockResolvedValueOnce(json(502, { error: { code: "UPSTREAM", message: "The chain node could not be read" } }, { "retry-after": "5" }));
    const err = await errorOf(apiCall("getCfoReport"));
    expect(err?.status).toBe(502);
    expect(retryAfterMsOf(err)).toBeNull();
    expect(retryAfterMsOf(new Error("x"))).toBeNull();
  });
});

describe("a GET is not sent again before its Retry-After has passed", () => {
  it("answers locally with the remaining wait, then asks the server again", async () => {
    fetchMock.mockResolvedValueOnce(limited({ header: "20" })).mockResolvedValue(ok());
    await errorOf(apiCall("getCfoReport"));
    vi.advanceTimersByTime(5_000);
    const local = await errorOf(apiCall("getCfoReport"));
    expect(local).toMatchObject({ status: 429, code: "UPSTREAM", retryAfterMs: 15_000 });
    expect(local?.message).toBe("Too many CFO report requests; try again in 20 s");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(15_000);
    await expect(apiCall("getCfoReport")).resolves.toMatchObject({ currency: exampleCfoReport.currency });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("holds only that path: other GETs still go out", async () => {
    fetchMock.mockResolvedValueOnce(limited({ header: "20" })).mockResolvedValue(json(200, []));
    await errorOf(apiCall("getCfoReport"));
    await apiCall("listPayments", { query: {} }).catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/payments");
  });

  it("a 429 without a readable wait holds nothing, and a POST is always sent (its 429 is the caller's to show)", async () => {
    fetchMock.mockResolvedValueOnce(limited()).mockResolvedValueOnce(ok());
    await errorOf(apiCall("getCfoReport"));
    await expect(apiCall("getCfoReport")).resolves.toBeDefined();
    fetchMock.mockResolvedValue(limited({ header: "20" }));
    await errorOf(apiCall("pause"));
    await errorOf(apiCall("pause"));
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
