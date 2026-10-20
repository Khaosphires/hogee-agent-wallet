// httpPostJson (VISION-DECISIONS §8): fixed host, capped request and answer, at most one retry and only on 429/5xx,
// and no API key in any error message. Mocked fetch only.
import { describe, expect, it } from "vitest";
import { CheckUnavailableError } from "../src/index";
import { HttpStatusError, httpPostJson, type HttpPostTarget } from "../src/http";
import { fakeFetch, hang, headersOf, noSleep, respond } from "./helpers";

const KEY = "tvly-test-0000-not-a-real-key";
const TARGET: HttpPostTarget = { service: "Tavily", host: "api.tavily.com", accept: "application/json", maxBytes: 1024, maxRequestBytes: 256 };
const URL_OK = new URL("https://api.tavily.com/search");
const ok = () => respond('{"ok":true}');

/** Runs `work`, returns its error message (or "" when it resolved), and checks the key is not in it. */
async function failure(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "";
  } catch (error: unknown) {
    const message = error instanceof Error ? `${error.name}: ${error.message} ${String(error.stack)}` : String(error);
    expect(message).not.toContain(KEY);
    expect(message).not.toContain("not-a-real-key");
    return message;
  }
}

describe("httpPostJson request", () => {
  it("POSTs the JSON body with the bearer key, no credentials and no redirects", async () => {
    const { fetch, calls } = fakeFetch(ok);
    const answer = await httpPostJson(URL_OK, TARGET, { query: "tumbler", max_results: 5 }, KEY, { fetch });
    expect(answer.status).toBe(200);
    expect(new TextDecoder().decode(answer.bytes)).toBe('{"ok":true}');
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url.href).toBe("https://api.tavily.com/search");
    expect(call?.init).toMatchObject({ method: "POST", redirect: "manual", credentials: "omit" });
    expect(headersOf(call)).toEqual({ accept: "application/json", "content-type": "application/json", authorization: `Bearer ${KEY}` });
    expect(new TextDecoder().decode(call?.init.body as Uint8Array)).toBe('{"query":"tumbler","max_results":5}');
  });

  it.each(["https://evil.example/search", "http://api.tavily.com/search", "https://api.tavily.com:8443/search", "https://u:p@api.tavily.com/search", "https://api.tavily.com.evil.example/search"])(
    "refuses %s without a request",
    async (href) => {
      const { fetch, calls } = fakeFetch(ok);
      await expect(httpPostJson(new URL(href), TARGET, {}, KEY, { fetch })).rejects.toThrow(CheckUnavailableError);
      expect(calls).toHaveLength(0);
    },
  );

  it("refuses a body over maxRequestBytes before sending anything", async () => {
    const { fetch, calls } = fakeFetch(ok);
    expect(await failure(httpPostJson(URL_OK, TARGET, { query: "x".repeat(300) }, KEY, { fetch }))).toContain("request larger than 256 bytes");
    // Counted in UTF-8 bytes, not characters: 100 three-byte characters are 300 bytes.
    expect(await failure(httpPostJson(URL_OK, TARGET, { q: "保".repeat(100) }, KEY, { fetch }))).toContain("request larger than 256 bytes");
    expect(calls).toHaveLength(0);
  });

  it("refuses a body that is not JSON data", async () => {
    const { fetch, calls } = fakeFetch(ok);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const body of [{ amount: 1n }, cyclic, undefined, () => 1]) {
      expect(await failure(httpPostJson(URL_OK, TARGET, body, KEY, { fetch }))).toContain("not JSON data");
    }
    expect(calls).toHaveLength(0);
  });

  it.each(["", "two words", "line\r\nX-Injected: 1", "tab\tkey", "ключ", "k".repeat(513)])("refuses a malformed key (%j) without a request or echo", async (bad) => {
    const { fetch, calls } = fakeFetch(ok);
    const message = await failure(httpPostJson(URL_OK, TARGET, {}, bad, { fetch }));
    expect(message).toContain("API key is missing or malformed");
    if (bad.length > 3) expect(message).not.toContain(bad);
    expect(calls).toHaveLength(0);
  });
});

describe("httpPostJson answer", () => {
  it("refuses to follow a redirect, without retrying", async () => {
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 307, headers: { location: "https://evil.example/" } }));
    expect(await failure(httpPostJson(URL_OK, TARGET, {}, KEY, { fetch, sleep: noSleep }))).toContain("refused to follow a redirect");
    expect(calls).toHaveLength(1);
  });

  it("caps the answer while streaming and on a declared Content-Length", async () => {
    const big = fakeFetch(() => respond(`{"pad":"${"x".repeat(2000)}"}`));
    expect(await failure(httpPostJson(URL_OK, TARGET, {}, KEY, { fetch: big.fetch }))).toContain("answer larger than 1024 bytes");
    expect(big.calls).toHaveLength(1);
    const declared = fakeFetch(() => new Response("{}", { status: 200, headers: { "content-length": "999999" } }));
    expect(await failure(httpPostJson(URL_OK, TARGET, {}, KEY, { fetch: declared.fetch }))).toContain("answer larger than 1024 bytes");
  });

  it("returns 4xx answers (other than 429) for the caller to judge, without retrying", async () => {
    const { fetch, calls } = fakeFetch(() => respond('{"detail":{"error":"Unauthorized: missing or invalid API key."}}', 401));
    await expect(httpPostJson(URL_OK, TARGET, {}, KEY, { fetch })).resolves.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(1);
  });
});

describe("httpPostJson retry policy (each call may cost credits)", () => {
  it("retries a 5xx once after the default backoff, then succeeds", async () => {
    const sleeps: number[] = [];
    const { fetch, calls } = fakeFetch((_u, _i, n) => (n === 1 ? respond("", 503) : ok()));
    await expect(httpPostJson(URL_OK, TARGET, {}, KEY, { fetch, sleep: async (ms) => void sleeps.push(ms) })).resolves.toMatchObject({ status: 200 });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([300]);
  });

  it("gives up after one retry on 429 with HttpStatusError(429)", async () => {
    const { fetch, calls } = fakeFetch(() => respond("", 429));
    const error = await httpPostJson(URL_OK, TARGET, {}, KEY, { fetch, sleep: noSleep }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpStatusError);
    expect(error).toBeInstanceOf(CheckUnavailableError);
    expect((error as HttpStatusError).status).toBe(429);
    expect((error as Error).message).toBe("Tavily unavailable after 2 attempts (HTTP 429)");
    expect(calls).toHaveLength(2);
  });

  it("never makes more than two calls, whatever `retries` asks", async () => {
    const many = fakeFetch(() => respond("", 500));
    await failure(httpPostJson(URL_OK, TARGET, {}, KEY, { fetch: many.fetch, sleep: noSleep, retries: 5 }));
    expect(many.calls).toHaveLength(2);
    const none = fakeFetch(() => respond("", 500));
    expect(await failure(httpPostJson(URL_OK, TARGET, {}, KEY, { fetch: none.fetch, sleep: noSleep, retries: 0 }))).toContain("after 1 attempt (HTTP 500)");
    expect(none.calls).toHaveLength(1);
  });

  it("waits a Retry-After of at most 5 s (seconds or HTTP date)", async () => {
    const now = Date.parse("2026-10-19T08:00:00Z");
    for (const [header, expected] of [
      ["2", 2000],
      ["5", 5000],
      ["0", 0],
      ["Mon, 19 Oct 2026 08:00:03 GMT", 3000],
      ["Mon, 19 Oct 2026 07:59:00 GMT", 0],
    ] as const) {
      const sleeps: number[] = [];
      const { fetch, calls } = fakeFetch((_u, _i, n) => (n === 1 ? new Response("", { status: 429, headers: { "retry-after": header } }) : ok()));
      await httpPostJson(URL_OK, TARGET, {}, KEY, { fetch, now: () => now, sleep: async (ms) => void sleeps.push(ms) });
      expect(sleeps).toEqual([expected]);
      expect(calls).toHaveLength(2);
    }
  });

  it.each(["6", "3600", "Mon, 19 Oct 2026 08:00:30 GMT", "soon", "-1", "1.5"])("fails at once on Retry-After %j instead of waiting", async (header) => {
    const { fetch, calls } = fakeFetch(() => new Response("", { status: 503, headers: { "retry-after": header } }));
    const error = await httpPostJson(URL_OK, TARGET, {}, KEY, { fetch, now: () => Date.parse("2026-10-19T08:00:00Z"), sleep: noSleep }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpStatusError);
    expect((error as Error).message).toContain("asked to wait over 5 s");
    expect(calls).toHaveLength(1);
  });

  it("does not retry a timeout", async () => {
    const { fetch, calls } = fakeFetch((_u, init) => hang(init));
    expect(await failure(httpPostJson(URL_OK, TARGET, {}, KEY, { fetch, timeoutMs: 15, sleep: noSleep }))).toContain("(timeout, not retried)");
    expect(calls).toHaveLength(1);
  });

  it("does not retry a network error or a body lost while reading", async () => {
    const net = fakeFetch(() => Promise.reject(new TypeError(`fetch failed for Bearer ${KEY}`)));
    expect(await failure(httpPostJson(URL_OK, TARGET, {}, KEY, { fetch: net.fetch, sleep: noSleep }))).toContain("(network error, not retried)");
    expect(net.calls).toHaveLength(1);
    const broken = fakeFetch(() => new Response(new ReadableStream({ pull: (c) => c.error(new TypeError("socket hang up")) }), { status: 200 }));
    expect(await failure(httpPostJson(URL_OK, TARGET, {}, KEY, { fetch: broken.fetch, sleep: noSleep }))).toContain("(connection lost while reading, not retried)");
    expect(broken.calls).toHaveLength(1);
  });

  it("stops on the caller's signal, before or during a call", async () => {
    const before = fakeFetch(ok);
    const aborted = AbortSignal.abort();
    expect(await failure(httpPostJson(URL_OK, TARGET, {}, KEY, { fetch: before.fetch, signal: aborted }))).toContain("request cancelled");
    expect(before.calls).toHaveLength(0);
    const during = fakeFetch((_u, init) => hang(init));
    const controller = new AbortController();
    const work = httpPostJson(URL_OK, TARGET, {}, KEY, { fetch: during.fetch, signal: controller.signal, timeoutMs: 10_000 });
    setTimeout(() => controller.abort(), 5);
    expect(await failure(work)).toContain("(cancelled, not retried)");
    expect(during.calls).toHaveLength(1);
  });
});
