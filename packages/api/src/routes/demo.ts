/**
 * DEMO_MODE=1 control routes (officer only; 404 otherwise, enforced centrally).
 *   autonomy start/stop and crash-next-broadcast write the worker's flag table (hogee_worker.flags): a flag can only
 *     stop the tick or stop the process after its next broadcast (the crash-recovery demo); it never grants anything.
 *   reset (CHAIN=local only): reverts Anvil to the snapshot taken before the facility opened, deletes this facility's
 *     rows, and drops the worker's per-chain caches for this deployment so step 0 can run again.
 */
import type { ApiDeps, Scope } from "../context";
import { fail } from "../http/problem";
import type { RouteGroup } from "../http/register";
import { one, pool, rows } from "../services/sql";

const FLAGS = "hogee_worker.flags";

async function writeFlag(deps: ApiDeps, name: string, value: unknown): Promise<void> {
  try {
    await pool(deps.db).query(`insert into ${FLAGS} (name, value) values ($1, $2::jsonb) on conflict (name) do update set value = excluded.value, updated_at = now()`, [name, JSON.stringify(value)]);
  } catch (error: unknown) {
    deps.log.warn("worker_flag_failed", { name, error });
    throw fail("NOT_FOUND", "The worker has not started yet (no flag table)");
  }
}

/** Tables holding this facility's rows, children before parents (a pass that hits a foreign key retries next pass). */
async function facilityTables(deps: ApiDeps): Promise<string[]> {
  const r = await rows<{ table_name: string }>(
    pool(deps.db),
    "select table_name from information_schema.columns where table_schema = 'public' and column_name = 'facility_id' and table_name <> 'facilities' order by table_name",
  );
  return [...r.map((x) => x.table_name), "facilities"];
}

async function deleteFacilityRows(deps: ApiDeps, scope: Scope): Promise<void> {
  let pending = await facilityTables(deps);
  for (let pass = 0; pass < 8 && pending.length > 0; pass += 1) {
    const failed: string[] = [];
    for (const table of pending) {
      try {
        await pool(deps.db).query(`delete from public.${table.replace(/[^a-z_]/g, "")} where facility_id = $1`, [scope.facilityId]);
      } catch {
        failed.push(table); // a child still references it: retry after the others
      }
    }
    pending = failed;
  }
  if (pending.length > 0) throw fail("NOT_FOUND", "Reset could not clear every row; try again");
}

async function reset(deps: ApiDeps, scope: Scope): Promise<{ ok: true }> {
  if (deps.config.chain !== "local" || deps.deployment.chainId !== 31337) throw fail("FORBIDDEN", "Reset only runs on a local Anvil chain");
  const db = pool(deps.db);
  const open = await one<{ baseline: string | null }>(
    db,
    "select request_json->>'anvilBaseline' as baseline from chain_actions where facility_id = $1 and kind = 'Treasury.openFacility' order by created_at limit 1",
    [scope.facilityId],
  );
  if (open?.baseline) {
    const reverted = (await deps.client.request({ method: "evm_revert", params: [open.baseline] } as never)) as boolean;
    if (!reverted) throw fail("NOT_FOUND", "The Anvil snapshot is gone (Anvil restarted?); restart the demo chain");
  }
  await deleteFacilityRows(deps, scope);
  const roles = await rows<{ address: string }>(db, "select address from hogee_worker.roles where deployment_id = $1 and chain_id = $2", [deps.deployment.deploymentId, deps.deployment.chainId]).catch(() => []);
  const contracts = Object.values(deps.deployment.contracts).map((c) => c.address.toLowerCase());
  await db.query("delete from nonces where chain_id = $1 and signer_address = any($2::text[])", [deps.deployment.chainId, roles.map((r) => r.address.toLowerCase())]);
  await db.query("delete from log_checkpoints where chain_id = $1 and contract = any($2::text[])", [deps.deployment.chainId, contracts]);
  for (const t of ["halts", "noncanonical_watch", "unresolved_watch", "mock_payouts", "flags"]) {
    await db.query(`delete from hogee_worker.${t}`).catch(() => undefined); // worker tables (Anvil demo only)
  }
  deps.log.info("demo_reset", { facilityId: scope.facilityId });
  return { ok: true };
}

export const demoRoutes: RouteGroup = {
  demoAutonomyStart: async ({ deps }) => {
    await writeFlag(deps, "autonomy", { running: true });
    return { running: true };
  },
  demoAutonomyStop: async ({ deps }) => {
    await writeFlag(deps, "autonomy", { running: false });
    return { running: false };
  },
  demoCrashNextBroadcast: async ({ deps }) => {
    await writeFlag(deps, "crash_next_broadcast", { armed: true });
    return { armed: true };
  },
  demoReset: ({ deps, scope }) => reset(deps, scope),
};
