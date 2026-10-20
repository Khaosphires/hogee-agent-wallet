/**
 * How the pages fetch and keep server data (fix-cfo-load), as plain options and functions so they are tested on a
 * real QueryClient without React (query-policy.test.ts).
 *
 * The CFO report (GET /api/cfo) is ONE query for every consumer (the chat's wallet rail and CFO card, the CFO page and
 * its wallet tiles), polled every CFO_POLL_MS. Before, two consumers polled it every 1.5 s and two every 10 s on the
 * same key; every query update restarts each observer's interval, so the 1.5 s won: 40 reports a minute from one tab
 * against a fast server, over the server's 30 a minute per client (in Next every browser is that one client). 15 s
 * matches the server's report cache (one report per head block, kept 15 s); a hidden tab does not poll; a 429 waits
 * its Retry-After (client.ts holds the GET). A newly mounted card still asks for the current report (one request for
 * the cards mounted together): "How are we doing?" answers with fresh numbers, and the server serves it from its cache.
 *
 * The other money reads (P1 follow-up): each GET /api/balances and GET /api/stats/autonomy is a full chain snapshot on
 * the server, with no cache, so they no longer poll every 1.5 s: balances every BALANCES_POLL_MS (5 s), autonomy every
 * AUTONOMY_POLL_MS (15 s), never in a hidden tab. After an action that changes money every query refetches at once
 * (hooks.ts refreshAfterAction), so a poll's pace never delays the founder's own action.
 */
import { queryOptions, type Query } from "@tanstack/react-query";
import type { RouteRes } from "@hogee/api-contract";
import { ApiClientError, apiCall, retryAfterMsOf, type ApiReq } from "./client";
import { apiKey } from "./hooks";

/** A 4xx is an answer, not an outage: retry only network errors and 5xx, twice. */
export const retryQuery = (failures: number, error: unknown): boolean =>
  !(error instanceof ApiClientError && error.status >= 400 && error.status < 500) && failures < 2;

/** One CFO report every 15 s per visible tab (4 a minute; the server allows 30 per client). */
export const CFO_POLL_MS = 15_000;
/** Balances every 5 s per visible tab (12 a minute; each is a chain snapshot). */
export const BALANCES_POLL_MS = 5_000;
/** Autonomy stats every 15 s per visible tab (4 a minute; each is a chain snapshot and the DB counters). */
export const AUTONOMY_POLL_MS = 15_000;

/** The GETs polled at their own pace (no request parts). */
type PolledRoute = "getCfoReport" | "getBalances" | "getAutonomyStats";

/** `everyMs`, or the Retry-After of a refused poll when that is longer. */
export const pollInterval =
  (everyMs: number) =>
  (query: Pick<Query<unknown, ApiClientError>, "state">): number => {
    const wait = retryAfterMsOf(query.state.error);
    return wait === null ? everyMs : Math.max(everyMs, wait);
  };

/** One shared query for `name`, polled every `everyMs` while the tab is visible. */
const polledRead = <N extends PolledRoute>(name: N, everyMs: number) =>
  queryOptions<RouteRes<N>, ApiClientError>({
    queryKey: apiKey(name),
    queryFn: ({ signal }) => apiCall(name, undefined as ApiReq<N>, { signal }),
    refetchInterval: pollInterval(everyMs),
    refetchIntervalInBackground: false,
  });

/** The one CFO report query (useCfoReport in queries.ts). */
export const cfoReportQuery = () => polledRead("getCfoReport", CFO_POLL_MS);
/** The one balances query (useBalances). */
export const balancesQuery = () => polledRead("getBalances", BALANCES_POLL_MS);
/** The one autonomy stats query (useAutonomy). */
export const autonomyQuery = () => polledRead("getAutonomyStats", AUTONOMY_POLL_MS);

/**
 * What a page shows for a polled query. A failed refresh keeps the last good data (flagged in `refreshFailed`, for a
 * quiet note); the error replaces the content only when there is no data at all.
 */
export type QueryView<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly error: ApiClientError }
  | { readonly kind: "data"; readonly data: T; readonly refreshFailed: ApiClientError | null };

export function queryView<T>(q: { readonly data: T | undefined; readonly error: ApiClientError | null }): QueryView<T> {
  if (q.data !== undefined) return { kind: "data", data: q.data, refreshFailed: q.error };
  if (q.error) return { kind: "error", error: q.error };
  return { kind: "loading" };
}
