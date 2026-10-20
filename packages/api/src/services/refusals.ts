/**
 * How the chat rate limit and the model budget refuse (docs/decisions/api-guard.md). The frozen ApiError codes have no
 * rate-limit code, so both answer the routes' declared UPSTREAM at their own status, like EVAL_BUSY (503):
 *   - 429 UPSTREAM {reason RATE_LIMITED, scope, retryAfterSeconds} for a chat turn over a rate limit;
 *   - 503 UPSTREAM {reason MODEL_BUDGET_EXHAUSTED, scope, retryAfterSeconds?} once the server's model budget is used up.
 * Like the officer lockout, every refusal is logged and only the first of a window leaves a trace event (an ALERT), so
 * a refused caller cannot grow the trace table. An eval route's event carries the eval prefix (a measurement, not a
 * decision of the facility). A trace that cannot be written (no facility yet) is logged; the refusal stands.
 */
import type { Context } from "hono";
import type { TraceActor } from "@hogee/core";
import type { ApiDeps, Scope } from "../context";
import { fail, type ApiProblem } from "../http/problem";
import { retryAfterSeconds as seconds, setRetryAfter, type RateRefusal } from "../http/rate-limit";
import { newId } from "./ids";
import { budgetRefusalIn } from "./model-budget";
import { appendEvalTrace, appendTrace } from "./traces";

export const RATE_LIMITED = "RATE_LIMITED";
export const CHAT_RATE_LIMITED = "CHAT_RATE_LIMITED";
export const MODEL_BUDGET_EXHAUSTED = "MODEL_BUDGET_EXHAUSTED";

export type RefusingRoute = "chat" | "eval";

async function alert(deps: ApiDeps, scope: Scope, route: RefusingRoute, actor: TraceActor, reasonCode: string, summary: string): Promise<void> {
  const event = { facilityId: scope.facilityId, traceId: newId("trace"), actor, kind: "ALERT" as const, reasonCode };
  try {
    if (route === "eval") await appendEvalTrace(deps.db, { ...event, summary: `[eval guard] ${summary}` });
    else await appendTrace(deps.db, { ...event, summary });
  } catch (error: unknown) {
    deps.log.warn("refusal_trace_failed", { reasonCode, error });
  }
}

/** A chat turn over a rate limit: logged, traced once per window (`trace`), answered 429. Nothing was stored or sent. */
export async function rateLimited(c: Context, deps: ApiDeps, scope: Scope, refusal: RateRefusal, trace: boolean): Promise<ApiProblem> {
  deps.log.warn("chat_rate_limited", { scope: refusal.scope });
  setRetryAfter(c, refusal.retryAfterMs);
  if (trace) await alert(deps, scope, "chat", "planner", CHAT_RATE_LIMITED, `Chat message refused: too many messages for this ${refusal.scope}; nothing was stored or sent to a model`);
  const retryAfterSeconds = seconds(refusal.retryAfterMs);
  return fail("UPSTREAM", `Too many chat messages; try again in ${retryAfterSeconds} s`, {
    status: 429,
    details: { reason: RATE_LIMITED, scope: refusal.scope, retryAfterSeconds },
  });
}

/**
 * When `error` is (or wraps) a model-budget refusal: logged, traced at most once an hour per server, and returned as
 * the 503 to throw (Retry-After set when the window will free room). Otherwise null: the caller handles `error`.
 */
export async function budgetProblem(c: Context, deps: ApiDeps, scope: Scope, route: RefusingRoute, error: unknown): Promise<ApiProblem | null> {
  const refusal = budgetRefusalIn(error);
  if (!refusal) return null;
  if (refusal.retryAfterMs !== null) setRetryAfter(c, refusal.retryAfterMs);
  const status = deps.agent.budget.status();
  deps.log.warn("model_budget_refused", { route, scope: refusal.scope, window: status.window, total: status.total });
  if (deps.agent.budget.traceRefusal()) {
    await alert(deps, scope, route, "planner", MODEL_BUDGET_EXHAUSTED, `Model call refused before it was sent: the server's model budget (${refusal.scope}) is used up`);
  }
  const when = refusal.retryAfterMs === null ? "An operator must raise it." : `Try again in ${seconds(refusal.retryAfterMs)} s.`;
  return fail("UPSTREAM", `The server's model budget is used up: the model call was refused before it was sent. ${when}`, {
    status: 503,
    details: { reason: MODEL_BUDGET_EXHAUSTED, scope: refusal.scope, ...(refusal.retryAfterMs === null ? {} : { retryAfterSeconds: seconds(refusal.retryAfterMs) }) },
  });
}
