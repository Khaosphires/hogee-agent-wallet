/**
 * POST /api/suppliers/search and GET /api/suppliers/search/:id (VISION-DECISIONS §5). The limits (1 search in flight
 * per process, 1 a minute per session key) are the service's per-process ones, so the chat journey's start_search and
 * this route share them. A RATE_LIMITED refusal carries Retry-After.
 */
import { ApiProblem } from "../http/problem";
import { clientAddress, setRetryAfter } from "../http/rate-limit";
import type { RouteGroup } from "../http/register";
import { readWebSearch, startWebSearch } from "../services/web-search";

export function searchRoutes(): RouteGroup {
  return {
    startSupplierSearch: async ({ req, deps, scope, persona, c }) => {
      try {
        return await startWebSearch(deps, scope, req.body, { persona, client: clientAddress(c) });
      } catch (error: unknown) {
        const wait = error instanceof ApiProblem ? error.failure.details?.retryAfterSeconds : undefined;
        if (typeof wait === "number") setRetryAfter(c, wait * 1000);
        throw error;
      }
    },
    getSupplierSearch: ({ req, deps, scope }) => readWebSearch(deps, scope, req.params.id),
  };
}
