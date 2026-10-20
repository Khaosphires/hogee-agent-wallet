/**
 * The Hogee HTTP API as the MCP server sees it: routes and response schemas from the frozen @hogee/api-contract.
 * The MCP wrapper never touches the chain or a key; it calls the same routes the web app does (project.md §5).
 */
import { ApiError, buildPath, routes, type RouteDef, type RouteName, type RouteReq, type RouteRes } from "@hogee/api-contract";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Every MCP call is the agent's, so the officer sees "Requested by the agent (AI)" (packages/api-mock reads it in
 * createException). The header can only lower a requester to "agent", never raise it.
 */
export const REQUESTER_HEADERS = { "x-hogee-requester": "agent" } as const;

export class HogeeApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HogeeApiError";
  }
}

export interface CallOptions {
  /** Give up after this long. The request is never resent: its outcome is then unknown (code TIMEOUT). */
  readonly timeoutMs?: number;
}

export interface HogeeApi {
  call<N extends RouteName>(name: N, req?: RouteReq<N>, opts?: CallOptions): Promise<RouteRes<N>>;
}

interface LooseReq {
  readonly params?: Record<string, string>;
  readonly query?: Record<string, string | undefined>;
  readonly body?: unknown;
}

/** Node's fetch (undici) puts the socket error's code on `cause`: ECONNREFUSED, UND_ERR_SOCKET, ECONNRESET, ... */
const causeCode = (e: unknown): string | undefined => {
  const cause = (e as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === "string" ? cause.code : undefined;
};

/**
 * A request that got no complete answer (status 0). Only a refused connection (ECONNREFUSED) is known not to have
 * reached the API (UNREACHABLE). A timeout (TIMEOUT) or a reset after sending (NO_ANSWER) may have been processed.
 */
function noAnswer(e: unknown, path: string, base: string, timeoutMs: number | undefined): HogeeApiError {
  if (e instanceof DOMException && e.name === "TimeoutError") return new HogeeApiError("TIMEOUT", `${path} did not answer within ${timeoutMs} ms`, 0);
  if (causeCode(e) === "ECONNREFUSED") return new HogeeApiError("UNREACHABLE", `Can't reach the Hogee API at ${base}; nothing was sent`, 0);
  return new HogeeApiError("NO_ANSWER", `The connection to ${path} failed before a complete answer arrived`, 0);
}

export function hogeeApi(baseUrl: string, fetchImpl: Fetch = fetch): HogeeApi {
  const base = baseUrl.replace(/\/$/, "");
  return {
    async call(name, req, opts = {}) {
      const route = routes[name] as RouteDef;
      const r = (req ?? {}) as LooseReq;
      const query = new URLSearchParams(Object.entries(r.query ?? {}).filter((e): e is [string, string] => e[1] !== undefined)).toString();
      const url = `${base}${buildPath(route, r.params)}${query ? `?${query}` : ""}`;
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: route.method,
          headers: r.body === undefined ? { ...REQUESTER_HEADERS } : { ...REQUESTER_HEADERS, "content-type": "application/json" },
          body: r.body === undefined ? undefined : JSON.stringify(r.body),
          signal: opts.timeoutMs === undefined ? undefined : AbortSignal.timeout(opts.timeoutMs),
        });
      } catch (e) {
        // One attempt only: a resent proposal is a second proposal (a resent invoice is recorded as a denial).
        throw noAnswer(e, route.path, base, opts.timeoutMs);
      }
      let json: unknown = null;
      try {
        json = await res.json();
      } catch (e) {
        // A body that isn't JSON is answered below; a timeout or a reset while reading it means no complete answer.
        if (!(e instanceof SyntaxError)) throw noAnswer(e, route.path, base, opts.timeoutMs);
      }
      if (!res.ok) {
        const err = ApiError.safeParse(json);
        throw err.success ? new HogeeApiError(err.data.error.code, err.data.error.message, res.status) : new HogeeApiError("UPSTREAM", `HTTP ${res.status}`, res.status);
      }
      const parsed = route.res.safeParse(json);
      if (!parsed.success) throw new HogeeApiError("UPSTREAM", `Unexpected response from ${route.path}`, res.status);
      return parsed.data as RouteRes<typeof name>;
    },
  };
}
