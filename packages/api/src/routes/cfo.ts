/**
 * GET /api/cfo (VISION-DECISIONS §5): the AI CFO report, from one chain snapshot and the facility's mirrored records
 * (services/cfo.ts). Read-only: the CFO acts only through the worker's cfo-guard (tighten-only, agent key).
 *
 * Rate limited (fixr-cfo, re-check LOW 4), in-process like the chat limiter: CFO_RATE.perClient reports a minute per
 * client address (the socket address; one LOCAL_CLIENT bucket when mounted in Next) and CFO_RATE.perServer per server.
 * Past either, a 429 UPSTREAM {reason RATE_LIMITED, scope, retryAfterSeconds} with Retry-After, before any chain or
 * database read; logged, never traced (no effect happened). Every page polls it as one shared query every 15 s per
 * visible tab and waits a 429's Retry-After (apps/web lib/api/query-policy.ts, fix-cfo-load).
 */
import type { Context } from "hono";
import type { ApiDeps } from "../context";
import { fail } from "../http/problem";
import { RATE_WINDOW_MS, WindowCounter, clientAddress, retryAfterSeconds, setRetryAfter } from "../http/rate-limit";
import type { RouteGroup } from "../http/register";
import { cfoReport } from "../services/cfo";
import { RATE_LIMITED } from "../services/refusals";

/** Reports a minute per client address and per server. */
export const CFO_RATE = { perClient: 30, perServer: 120 } as const;
const SERVER_KEY = "server";

interface CfoLimiter {
  readonly client: WindowCounter;
  readonly server: WindowCounter;
}

/** Counts one report, or throws the 429 (nothing counted) when the client's or the server's minute is used up. */
function admit(c: Context, deps: ApiDeps, limiter: CfoLimiter): void {
  const now = deps.clock();
  const client = clientAddress(c);
  const scopes = [
    ["client", limiter.client, client],
    ["server", limiter.server, SERVER_KEY],
  ] as const;
  for (const [scope, counter, key] of scopes) {
    const wait = counter.waitMs(key, now);
    if (wait === 0) continue;
    deps.log.warn("cfo_rate_limited", { scope });
    setRetryAfter(c, wait);
    const seconds = retryAfterSeconds(wait);
    throw fail("UPSTREAM", `Too many CFO report requests; try again in ${seconds} s`, { status: 429, details: { reason: RATE_LIMITED, scope, retryAfterSeconds: seconds } });
  }
  for (const [, counter, key] of scopes) counter.hit(key, now);
}

/** The CFO group of one app: its limiter is per app (so per server). */
export function cfoRoutes(): RouteGroup {
  const limiter: CfoLimiter = { client: new WindowCounter(CFO_RATE.perClient, RATE_WINDOW_MS), server: new WindowCounter(CFO_RATE.perServer, RATE_WINDOW_MS, 1) };
  return {
    getCfoReport: ({ deps, scope, c }) => {
      admit(c, deps, limiter);
      return cfoReport(deps, scope);
    },
  };
}
