/**
 * POST /api/control/pause: tighten-only and instant, so any persona may ask (§8.8). The API writes the unsigned
 * action; the worker sends Treasury.pause with the lender key first (the agent key as fallback; re-check A-3). A repeat while
 * one is pending returns it; once the chain shows paused there is nothing to do (CONFLICT).
 */
import type { ChainAction, Persona } from "@hogee/core";
import { iTreasuryAbi } from "../chain-lib";
import type { ApiDeps, Scope } from "../context";
import { fail } from "../http/problem";
import type { RouteGroup } from "../http/register";
import { insertAction, liveAction, wake } from "../services/actions";
import { requireFacility } from "../services/facility";
import { newId } from "../services/ids";
import { inTx, pool } from "../services/sql";
import { appendTrace } from "../services/traces";

async function pause(deps: ApiDeps, scope: Scope, persona: Persona): Promise<ChainAction> {
  const db = pool(deps.db);
  await requireFacility(db, scope);
  const paused = await deps.client.readContract({ address: deps.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: "paused" });
  if (paused) throw fail("CONFLICT", "Payments are already paused");
  const pending = await liveAction(db, scope.facilityId, "Treasury.pause", scope.facilityId);
  if (pending && (pending.state === "PENDING" || pending.state === "BROADCAST")) return pending;
  const action = await inTx(deps.db, async (q) => {
    const created = await insertAction(q, { facilityId: scope.facilityId, kind: "Treasury.pause", refId: scope.facilityId, request: {} });
    await appendTrace(q, { facilityId: scope.facilityId, traceId: newId("trace"), actor: persona === "officer" ? "officer" : "founder", kind: "TX", summary: "Pause requested: every agent payment stops (tighten-only)" });
    return created;
  });
  await wake(deps, "relay");
  return action;
}

export const controlRoutes: RouteGroup = {
  pause: ({ deps, scope, persona }) => pause(deps, scope, persona),
};
