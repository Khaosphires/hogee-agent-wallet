/**
 * The HTTP paths of @hogee/checks: https only, one fixed host per call (a redirect fails the call, no credentials, no
 * cookies), a timeout per attempt that covers the body too, and a response size cap. Error messages never carry the
 * URL (it may hold a supplier name), a response body or an API key.
 * - httpGet: retries with backoff on network errors, timeouts, 429 and 5xx.
 * - httpPostJson (web search, VISION-DECISIONS §8): a JSON body capped before sending and a bearer API key; at most
 *   one retry, and only on 429 or 5xx (honouring a Retry-After of at most 5 s). Never on a timeout or a network
 *   error: the request may have reached the provider, and each call costs credits.
 */
import { CheckUnavailableError } from "./types";

export interface HttpOptions {
  /** fetch implementation (tests inject recorded responses). Default: global fetch. */
  readonly fetch?: typeof fetch;
  /** Per-attempt timeout, ms. Default 8000. */
  readonly timeoutMs?: number;
  /** Extra attempts after the first. Default 2. */
  readonly retries?: number;
  /** First backoff, ms (doubles each retry). Default 300. */
  readonly backoffMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Clock for `retrievedAt`. Default Date.now. */
  readonly now?: () => number;
}

export interface HttpTarget {
  /** Service name for error messages, e.g. "BNM". */
  readonly service: string;
  /** The only host this call may reach. */
  readonly host: string;
  readonly accept: string;
  readonly maxBytes: number;
}

/** A POST target: also caps the serialised request body. */
export interface HttpPostTarget extends HttpTarget {
  readonly maxRequestBytes: number;
}

export interface HttpAnswer {
  readonly status: number;
  /** Raw body bytes (sha256 of these = snippetHash for API data, §26.3). */
  readonly bytes: Uint8Array;
}

/** The service kept answering 429 or 5xx (after the retries allowed), or asked to wait too long. */
export class HttpStatusError extends CheckUnavailableError {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const DEFAULTS = { timeoutMs: 8_000, retries: 2, backoffMs: 300 } as const;
const MAX_RETRIES = 5;
/** POST: at most one retry (each call may cost credits). */
const MAX_POST_RETRIES = 1;
/** POST: a Retry-After longer than this fails the call instead of waiting. */
export const MAX_RETRY_AFTER_MS = 5_000;
/** A bearer API key: printable ASCII, no spaces (so it cannot break the header). */
const BEARER_RE = /^[\x21-\x7e]{1,512}$/;
const IMF_FIXDATE_RE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/** A failed attempt that may be retried. `status` is null for a network error, a timeout or a lost body. */
class Retryable extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly retryAfter: string | null = null,
  ) {
    super(message);
  }
}

interface RequestSpec {
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array<ArrayBuffer>;
  /** The caller's cancel signal (POST only). */
  readonly signal?: AbortSignal;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function assertFixedHost(url: URL, host: string, service: string): void {
  if (url.protocol !== "https:" || url.hostname !== host || url.port !== "" || url.username !== "" || url.password !== "") {
    throw new CheckUnavailableError(`${service}: refused a request outside https://${host}`);
  }
}

async function readCapped(res: Response, maxBytes: number, service: string): Promise<Uint8Array> {
  const declared = res.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    void res.body?.cancel().catch(() => undefined);
    throw new CheckUnavailableError(`${service}: answer larger than ${maxBytes} bytes`);
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => undefined);
      throw new CheckUnavailableError(`${service}: answer larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** Resolves with `work`, or rejects as soon as `signal` aborts (so a stalled body read also times out). */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal, cancel?: AbortSignal): Promise<T> {
  work.catch(() => undefined); // a late rejection after the timeout is expected, not unhandled
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Retryable(cancel?.aborted ? "cancelled" : "timeout"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function attempt(url: URL, target: HttpTarget, f: typeof fetch, timeoutMs: number, req: RequestSpec): Promise<HttpAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onCancel = () => controller.abort();
  req.signal?.addEventListener("abort", onCancel, { once: true });
  if (req.signal?.aborted) controller.abort();
  try {
    const work = (async () => {
      let res: Response;
      try {
        const init: RequestInit = { method: req.method, headers: req.headers, redirect: "manual", credentials: "omit", signal: controller.signal };
        res = await f(url.href, req.body ? { ...init, body: req.body } : init);
      } catch {
        throw new Retryable("network error");
      }
      if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
        void res.body?.cancel().catch(() => undefined);
        throw new CheckUnavailableError(`${target.service}: refused to follow a redirect`);
      }
      if (res.status === 429 || res.status >= 500) {
        void res.body?.cancel().catch(() => undefined);
        throw new Retryable(`HTTP ${res.status}`, res.status, res.headers.get("retry-after"));
      }
      try {
        return { status: res.status, bytes: await readCapped(res, target.maxBytes, target.service) };
      } catch (error: unknown) {
        if (error instanceof CheckUnavailableError) throw error;
        throw new Retryable("connection lost while reading");
      }
    })();
    return await untilAborted(work, controller.signal, req.signal);
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", onCancel);
  }
}

/** GET `url` (which must be on `target.host`) with timeout, retries and a size cap. Any status below 500 except 429 is returned. */
export async function httpGet(url: URL, target: HttpTarget, opts: HttpOptions = {}): Promise<HttpAnswer> {
  assertFixedHost(url, target.host, target.service);
  const f = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const retries = Math.min(Math.max(opts.retries ?? DEFAULTS.retries, 0), MAX_RETRIES);
  const sleep = opts.sleep ?? defaultSleep;
  let last = "no attempt";
  for (let i = 0; i <= retries; i += 1) {
    if (i > 0) await sleep((opts.backoffMs ?? DEFAULTS.backoffMs) * 2 ** (i - 1));
    try {
      return await attempt(url, target, f, timeoutMs, { method: "GET", headers: { accept: target.accept } });
    } catch (error: unknown) {
      if (!(error instanceof Retryable)) throw error;
      last = error.message;
    }
  }
  throw new CheckUnavailableError(`${target.service} unavailable after ${retries + 1} attempts (${last})`);
}

/** Milliseconds to wait before the POST retry, or null when Retry-After asks for more than 5 s (or is unreadable). */
function retryDelayMs(retryAfter: string | null, fallbackMs: number, now: () => number): number | null {
  if (retryAfter === null) return fallbackMs;
  const v = retryAfter.trim();
  let ms: number;
  if (/^\d{1,10}$/.test(v)) ms = Number(v) * 1000;
  else if (IMF_FIXDATE_RE.test(v) && !Number.isNaN(Date.parse(v))) ms = Math.max(0, Date.parse(v) - now());
  else return null;
  return ms <= MAX_RETRY_AFTER_MS ? ms : null;
}

/** UTF-8 JSON of `body`, refused when it is not JSON data or larger than `maxRequestBytes`. */
function encodeJsonBody(body: unknown, target: HttpPostTarget): Uint8Array<ArrayBuffer> {
  let text: string | undefined;
  try {
    text = JSON.stringify(body);
  } catch {
    text = undefined;
  }
  if (text === undefined) throw new CheckUnavailableError(`${target.service}: the request body is not JSON data`);
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > target.maxRequestBytes) throw new CheckUnavailableError(`${target.service}: request larger than ${target.maxRequestBytes} bytes`);
  return bytes;
}

/**
 * POST `body` as JSON to `url` (which must be on `t.host`) with `Authorization: Bearer <bearer>`. The body is
 * serialised and size-checked before anything is sent. At most one retry, only on 429 or 5xx; a timeout, a network
 * error, a lost body or the caller's `signal` fails at once. Any status below 500 except 429 and 3xx is returned.
 * Every failure throws CheckUnavailableError (HttpStatusError when a status ended it); no message holds the key.
 */
export async function httpPostJson(url: URL, t: HttpPostTarget, body: unknown, bearer: string, opts: HttpOptions & { signal?: AbortSignal } = {}): Promise<HttpAnswer> {
  assertFixedHost(url, t.host, t.service);
  if (typeof bearer !== "string" || !BEARER_RE.test(bearer)) throw new CheckUnavailableError(`${t.service}: the API key is missing or malformed`);
  const bytes = encodeJsonBody(body, t);
  const f = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const retries = Math.min(Math.max(opts.retries ?? MAX_POST_RETRIES, 0), MAX_POST_RETRIES);
  const sleep = opts.sleep ?? defaultSleep;
  const req: RequestSpec = {
    method: "POST",
    headers: { accept: t.accept, "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: bytes,
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
  for (let i = 0; ; i += 1) {
    if (opts.signal?.aborted) throw new CheckUnavailableError(`${t.service}: request cancelled`);
    try {
      return await attempt(url, t, f, timeoutMs, req);
    } catch (error: unknown) {
      if (!(error instanceof Retryable)) throw error;
      if (error.status === null) throw new CheckUnavailableError(`${t.service} unavailable (${error.message}, not retried)`);
      if (i >= retries) throw new HttpStatusError(`${t.service} unavailable after ${i + 1} attempt${i === 0 ? "" : "s"} (HTTP ${error.status})`, error.status);
      const wait = retryDelayMs(error.retryAfter, opts.backoffMs ?? DEFAULTS.backoffMs, opts.now ?? Date.now);
      if (wait === null) throw new HttpStatusError(`${t.service} unavailable (HTTP ${error.status}, asked to wait over ${MAX_RETRY_AFTER_MS / 1000} s)`, error.status);
      await sleep(wait);
    }
  }
}

/** Strict UTF-8 JSON of a body; a malformed body fails closed. */
export function parseJsonBody(bytes: Uint8Array, service: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CheckUnavailableError(`${service}: answer is not valid JSON`);
  }
}

/** retrievedAt for a Sourced leaf: ISO-8601 UTC, whole seconds. */
export function isoNow(now: () => number = Date.now): string {
  return new Date(now()).toISOString().replace(/\.\d{3}Z$/, "Z");
}
