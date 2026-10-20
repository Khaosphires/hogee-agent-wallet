/**
 * The one HTTP client for every page (ROLE-P2 A.3 rule 1). Routes, paths and response schemas come from the frozen
 * @hogee/api-contract, so the same call works against the live API, the mock and replay (project.md §26.7).
 * Every 2xx body is parsed with route.res; every non-2xx becomes an ApiClientError carrying the ApiError code.
 *
 * Retry-After (fix-cfo-load): a 429's wait rides on the error (retryAfterMs, from the header or the body's
 * details.retryAfterSeconds). A GET answered 429 with a wait is not sent again until it has passed: until then the
 * same GET fails locally with the remaining wait, whoever asks (a poll, a newly mounted card, the refetch after a
 * mutation). POSTs are always sent; their 429 is the caller's to show.
 */
import { ApiError, buildPath, routes, type RouteDef, type RouteName, type RouteReq, type RouteRes } from "@hogee/api-contract";
import type { ApiErrorCode, ContractErrorInfo } from "@hogee/core";

export class ApiClientError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status: number,
    readonly contractError?: ContractErrorInfo,
    readonly traceId?: string,
    readonly details?: Record<string, unknown>,
    /** A 429's wait in ms (Retry-After), when the server gave a readable one. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

interface LooseReq {
  readonly params?: Record<string, string>;
  readonly query?: Record<string, string | undefined>;
  readonly body?: unknown;
}

/** Request parts a route declares; routes without parts take no argument. */
export type ApiReq<N extends RouteName> = keyof RouteReq<N> extends never ? undefined : RouteReq<N>;

function urlOf(route: RouteDef, req: LooseReq): string {
  const query = new URLSearchParams(
    Object.entries(req.query ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ).toString();
  return `${buildPath(route, req.params)}${query ? `?${query}` : ""}`;
}

function bodyOf(route: RouteDef, req: LooseReq): { body?: BodyInit; headers: Record<string, string> } {
  if (req.body === undefined) return { headers: {} };
  if (route.multipart) {
    const form = new FormData();
    for (const [key, value] of Object.entries(req.body as Record<string, unknown>)) form.append(key, value instanceof Blob ? value : String(value));
    return { body: form, headers: {} };
  }
  return { body: JSON.stringify(req.body), headers: { "content-type": "application/json" } };
}

/** The longest wait a Retry-After can impose (the server asks for at most a minute). */
export const MAX_RETRY_AFTER_MS = 5 * 60_000;
const SECONDS = /^[0-9]{1,9}$/;

/** Retry-After as whole seconds or an HTTP date, in ms; null when absent or unreadable. */
function headerWaitMs(header: string): number | null {
  if (SECONDS.test(header)) return Number(header) * 1000;
  const date = /[a-z]/i.test(header) ? Date.parse(header) : Number.NaN;
  return Number.isFinite(date) ? date - Date.now() : null;
}

/** A 429's wait in ms: the Retry-After header, else the body's details.retryAfterSeconds; capped, never ≤ 0. */
function retryAfterOf(res: Response, details: Record<string, unknown> | undefined): number | undefined {
  if (res.status !== 429) return undefined;
  const fromBody = details?.retryAfterSeconds;
  const ms = headerWaitMs(res.headers.get("retry-after")?.trim() ?? "") ?? (typeof fromBody === "number" && Number.isSafeInteger(fromBody) ? fromBody * 1000 : null);
  return ms !== null && ms > 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : undefined;
}

async function errorOf(res: Response): Promise<ApiClientError> {
  const parsed = ApiError.safeParse(await res.json().catch(() => null));
  if (!parsed.success) return new ApiClientError("UPSTREAM", `The API answered ${res.status}`, res.status, undefined, undefined, undefined, retryAfterOf(res, undefined));
  const { code, message, contractError, traceId, details } = parsed.data.error;
  return new ApiClientError(code, message, res.status, contractError, traceId, details, retryAfterOf(res, details));
}

/** The wait a 429 asked for, in ms; null for any other error or a 429 without a readable wait. */
export function retryAfterMsOf(error: unknown): number | null {
  return error instanceof ApiClientError && error.status === 429 && error.retryAfterMs !== undefined ? error.retryAfterMs : null;
}

/** GET URL → until when it is held, and the 429 that asked for it. */
const held = new Map<string, { readonly until: number; readonly error: ApiClientError }>();

/** The local 429 for a GET still within its Retry-After (with the remaining wait), else null. */
function heldError(url: string): ApiClientError | null {
  const h = held.get(url);
  if (!h) return null;
  const left = h.until - Date.now();
  if (left <= 0) {
    held.delete(url);
    return null;
  }
  const e = h.error;
  return new ApiClientError(e.code, e.message, 429, e.contractError, e.traceId, e.details, left);
}

function hold(url: string, error: ApiClientError): void {
  const wait = retryAfterMsOf(error);
  if (wait === null) return;
  const now = Date.now();
  for (const [key, h] of held) if (h.until <= now) held.delete(key);
  held.set(url, { until: now + wait, error });
}

/** Forgets every held GET (tests). */
export function clearRetryAfter(): void {
  held.clear();
}

export async function apiCall<N extends RouteName>(name: N, req?: ApiReq<N>, init: { signal?: AbortSignal } = {}): Promise<RouteRes<N>> {
  const route = routes[name] as RouteDef;
  const loose = (req ?? {}) as LooseReq;
  const url = urlOf(route, loose);
  const isGet = route.method === "GET";
  const waiting = isGet ? heldError(url) : null;
  if (waiting) throw waiting;
  const { body, headers } = bodyOf(route, loose);
  let res: Response;
  try {
    res = await fetch(url, { method: route.method, headers, body, credentials: "same-origin", cache: "no-store", signal: init.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiClientError("UPSTREAM", "Can't reach the Hogee API", 0);
  }
  if (!res.ok) {
    const error = await errorOf(res);
    if (isGet) hold(url, error);
    throw error;
  }
  if (route.fileResponse) return (await res.blob()) as RouteRes<N>;
  const parsed = route.res.safeParse(await res.json());
  if (!parsed.success) {
    throw new ApiClientError("UPSTREAM", `Unexpected response from ${route.path}`, res.status, undefined, undefined, {
      issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`),
    });
  }
  return parsed.data as RouteRes<N>;
}

/** URL of a route (for streams and links), e.g. the chat transport. */
export function apiUrl<N extends RouteName>(name: N, req?: ApiReq<N>): string {
  return urlOf(routes[name] as RouteDef, (req ?? {}) as LooseReq);
}
