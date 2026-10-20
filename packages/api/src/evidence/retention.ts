/**
 * Bounds on what the evidence export leaves behind (audit run-6 v-2), all run under the export's advisory lock:
 *   - interval: no new run within MIN_EXPORT_INTERVAL_S of the facility's last finished run (one evidence_runs query),
 *     nor of its last call that collected but claimed no run (idempotent or refused; in process, run-6 re-check L1);
 *   - retention: after a publish only the newest KEEP_RUNS READY runs of the facility and deployment stay; an older
 *     run folder is removed only if it is a real directory directly under the root holding this tenant's bundle
 *     (never through a symlink). Its evidence_runs row is dropped only once no entry of that name is left: a folder
 *     that stays (not readable as ours, e.g. an index over the size cap) keeps its row and is retried (re-check L8a);
 *   - temp folders: `.export-<tag>-*`, tag = this deployment. The lock is per database, so another exporter's folder
 *     may be live: only our own tag is swept, plus any `.export-*` older than STALE_TEMP_MS.
 */
import { createHash, randomBytes } from "node:crypto";
import { lstat, readdir, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ApiDeps, Scope } from "../context";
import { ownsRun, type Tenant } from "./store";

/** Run folders kept per facility and deployment after a publish (the newest by evidence_runs.finished_at). */
export const KEEP_RUNS = 10;
/** No new run starts within this many seconds of the facility's last finished (READY or FAILED) run. */
export const MIN_EXPORT_INTERVAL_S = 60;
/** Another exporter's `.export-*` folder is swept only once it is this old (it may still be writing). */
export const STALE_TEMP_MS = 60 * 60 * 1000;
const RUN_ID_RE = /^ev-[0-9a-f]{16}$/;

/** The temp-folder tag of an exporter: 12 hex of sha256(chainId:deploymentId), so no tag is a prefix of another. */
export const tempTag = (t: Pick<Tenant, "chainId" | "deploymentId">): string => createHash("sha256").update(`${t.chainId}:${t.deploymentId}`).digest("hex").slice(0, 12);

export const tempName = (tag: string, what: string): string => `.export-${tag}-${what}-${randomBytes(6).toString("hex")}`;

/** Any entry of that name, a symlink included (lstat). */
const present = async (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    () => false,
  );

const isRealDir = async (path: string): Promise<boolean> =>
  lstat(path).then(
    (s) => s.isDirectory() && !s.isSymbolicLink(),
    () => false,
  );

/** Removes this exporter's `.export-<tag>-*` folders (we hold the lock) and any `.export-*` older than STALE_TEMP_MS. */
export async function sweep(root: string, tag: string, nowMs: number = Date.now()): Promise<void> {
  for (const e of await readdir(root, { withFileTypes: true })) {
    if (!e.name.startsWith(".export-") || !e.isDirectory() || e.isSymbolicLink()) continue;
    const path = join(root, e.name);
    const own = e.name.startsWith(`.export-${tag}-`);
    const stale = await lstat(path).then(
      (s) => nowMs - s.mtimeMs > STALE_TEMP_MS,
      () => false,
    );
    if (own || stale) await rm(path, { recursive: true, force: true });
  }
}

/** True when the facility finished a run (READY or FAILED) less than MIN_EXPORT_INTERVAL_S ago (database clock). */
export async function tooSoon(deps: ApiDeps, scope: Scope): Promise<boolean> {
  const r = await deps.db.$client.query<{ soon: boolean }>(
    "select exists (select 1 from evidence_runs where facility_id = $1 and status in ('READY', 'FAILED') and finished_at > now() - make_interval(secs => $2)) as soon",
    [scope.facilityId, MIN_EXPORT_INTERVAL_S],
  );
  return r.rows[0]?.soon === true;
}

/**
 * Wall-clock time of each facility's last export call that collected but claimed no run (idempotent, or refused while
 * collecting): it leaves no evidence_runs row, so tooSoon cannot see it (run-6 re-check L1). In process only: the CLI
 * is another process, and a restart forgets it, which costs at most one more collect.
 */
const lastAttempt = new Map<string, number>();
const INTERVAL_MS = MIN_EXPORT_INTERVAL_S * 1000;

/** True when the facility's last collecting call that claimed no run was less than MIN_EXPORT_INTERVAL_S ago. */
export function attemptedRecently(facilityId: string, nowMs: number = Date.now()): boolean {
  const at = lastAttempt.get(facilityId);
  return at !== undefined && nowMs - at < INTERVAL_MS;
}

/** Records a collecting call that claimed no run; entries older than the interval are dropped. */
export function noteAttempt(facilityId: string, nowMs: number = Date.now()): void {
  for (const [id, at] of lastAttempt) if (nowMs - at >= INTERVAL_MS) lastAttempt.delete(id);
  lastAttempt.set(facilityId, nowMs);
}

/** Tests: forget every attempt (they pass the database interval by moving evidence_runs.finished_at back). */
export function forgetAttempts(): void {
  lastAttempt.clear();
}

/**
 * Removes run folder `runId` under `root`: it is renamed to a `.export-<tag>-prune-*` name first (it leaves the
 * listing at once, and a crash mid-delete is swept later), then deleted only if it is still a real directory.
 * Returns false (nothing touched) when the entry is missing, not a run name, or not a real directory.
 */
export async function removeRunFolder(root: string, runId: string, tag: string): Promise<boolean> {
  if (!RUN_ID_RE.test(runId)) return false;
  const dir = join(root, runId);
  if (!(await isRealDir(dir))) return false;
  const doomed = join(root, tempName(tag, `prune-${runId}`));
  await rename(dir, doomed);
  // Swapped for a link between the check and the rename: drop the link only, never what it points to.
  if (await isRealDir(doomed)) await rm(doomed, { recursive: true, force: true });
  else await unlink(doomed);
  return true;
}

/** Keeps the facility's newest KEEP_RUNS READY runs of this deployment; returns how many older ones were removed. */
export async function pruneRuns(deps: ApiDeps, root: string, tenant: Tenant): Promise<number> {
  const old = await deps.db.$client.query<{ id: string }>(
    `select id from evidence_runs where facility_id = $1 and status = 'READY' and jsonb_exists(manifest_json -> 'deployments', $2)
      order by finished_at desc nulls last, id desc offset $3`,
    [tenant.facilityId, tenant.deploymentId, KEEP_RUNS],
  );
  const tag = tempTag(tenant);
  let removed = 0;
  for (const { id } of old.rows) {
    if (await ownsRun(root, id, tenant)) {
      if (await removeRunFolder(root, id, tag)) removed += 1;
    } else if (await isRealDir(join(root, id))) {
      deps.log.warn("evidence_prune_skipped", { runId: id }); // not this tenant's bundle: left in place
    }
    // Only once the folder is gone: a row dropped for a folder still on disk would never be listed or pruned again.
    if (await present(join(root, id))) continue;
    await deps.db.$client.query("delete from evidence_runs where facility_id = $1 and id = $2 and status = 'READY'", [tenant.facilityId, id]);
  }
  return removed;
}
