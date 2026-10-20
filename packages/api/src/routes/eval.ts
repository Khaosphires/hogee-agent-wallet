/**
 * POST /api/eval/case (E1), /api/eval/plan (E2/E4) and /api/eval/shortlist (E3), task 1.13. DEMO_MODE only (register.ts)
 * and Anvil only (CHAIN=local): evals run against the shipped pipeline on a local chain with the mock payout rail
 * (project.md §15 D18), never against Sepolia. They read the facility, the chain and P3's datasets; they never sign and
 * never write chain_actions, payments, invoices, drafts or shortlists (only traces and the LLM call log). Missing inputs
 * (no facility, no committed plan, no dataset row, no country pack, a supplier check down) answer the route's declared
 * NOT_FOUND, never a 502. At most EVAL_MAX_CONCURRENT eval requests run at once per server (a 503 UPSTREAM otherwise).
 * Eval model calls share the server's model budget with chat: a call it refuses ends the request with a 503 UPSTREAM
 * (MODEL_BUDGET_EXHAUSTED) before that call is sent (docs/decisions/api-guard.md).
 */
import type { Context } from "hono";
import type { ApiDeps, Scope } from "../context";
import { ApiProblem, fail } from "../http/problem";
import type { RouteGroup } from "../http/register";
import { evalCase } from "../services/eval-case";
import { evalPlan } from "../services/eval-plan";
import { evalShortlist } from "../services/eval-shortlist";
import { requireFacility } from "../services/facility";
import { budgetProblem } from "../services/refusals";
import { pool } from "../services/sql";

/** Eval requests one server runs at once: /api/eval/plan alone can make 24 planner calls, and DEMO_MODE has no rate limit. */
export const EVAL_MAX_CONCURRENT = 2;

/**
 * One deadline per eval request, carried by every model call it makes (planner, reader, baseline): /api/eval/plan's
 * worst case is 4 turns × 6 planner calls. At the deadline the call in flight is aborted and the request is a 504.
 */
export const EVAL_DEADLINE_MS = 240_000;

const deadline = (ms: number) =>
  fail("UPSTREAM", `The eval run hit its ${Math.round(ms / 1000)} s deadline; its model call was aborted`, { status: 504, details: { reason: "EVAL_DEADLINE", deadlineMs: ms } });

const busy = () =>
  fail("UPSTREAM", `The eval routes are busy: this server runs at most ${EVAL_MAX_CONCURRENT} eval requests at a time; retry shortly`, {
    status: 503,
    details: { reason: "EVAL_BUSY", maxConcurrent: EVAL_MAX_CONCURRENT },
  });

/**
 * The eval group of one app: Anvil only, at most EVAL_MAX_CONCURRENT requests in flight (the next one is a 503
 * UPSTREAM, EVAL_BUSY, before any work), a per-request deadline on every model call (504 UPSTREAM, EVAL_DEADLINE), and
 * an opened facility (traces and llm_calls reference it). A slot is released only once the request's work has
 * settled, so an aborted call has stopped before its slot is reused. "Not set up yet" CONFLICTs (facility, committed
 * plan) are missing inputs here.
 */
export function evalRoutes(opts: { readonly deadlineMs?: number } = {}): RouteGroup {
  const deadlineMs = opts.deadlineMs ?? EVAL_DEADLINE_MS;
  let inFlight = 0;
  async function onAnvil<T>(deps: ApiDeps, scope: Scope, c: Context, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (deps.config.chain !== "local") throw fail("NOT_FOUND", "Eval routes run on Anvil only (CHAIN=local)");
    if (inFlight >= EVAL_MAX_CONCURRENT) throw busy();
    inFlight += 1;
    const signal = AbortSignal.timeout(deadlineMs);
    try {
      await requireFacility(pool(deps.db), scope);
      return await run(signal);
    } catch (e) {
      if (signal.aborted) throw deadline(deadlineMs);
      const overBudget = await budgetProblem(c, deps, scope, "eval", e);
      if (overBudget) throw overBudget;
      if (e instanceof ApiProblem && e.failure.code === "CONFLICT") throw fail("NOT_FOUND", e.failure.message);
      throw e;
    } finally {
      inFlight -= 1;
    }
  }
  return {
    evalCase: ({ req, deps, scope, c }) => onAnvil(deps, scope, c, (signal) => evalCase(deps, scope, req.body.arm, req.body.case, signal)),
    evalPlan: ({ req, deps, scope, c }) => onAnvil(deps, scope, c, (signal) => evalPlan(deps, scope, req.body, signal)),
    evalShortlist: ({ req, deps, scope, c }) => onAnvil(deps, scope, c, (signal) => evalShortlist(deps, scope, req.body.setId, req.body.mode, signal)),
  };
}
