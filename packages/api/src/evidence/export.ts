/**
 * Evidence export (§16, POST /api/evidence/export, `make evidence`): builds evidence/<runId>/ for the server's
 * facility from Postgres and the chain, read-only (nothing is signed or sent).
 *   - Idempotent: runId = "ev-" + the first 16 hex of keccak256(JCS(everything the bundle is built from)), so the same
 *     evidence always yields the same run, and an export with nothing new returns the finished bundle untouched.
 *   - One at a time: a session advisory lock across every API process and the CLI; a second export is CONFLICT.
 *   - Bounded: row caps per table (collect.ts), at most MAX_BUNDLE_FILES files of MAX_FILE_BYTES each and
 *     MAX_BUNDLE_BYTES in all; else it fails, never truncating evidence.
 *   - Never overwrites: files are written into a fresh `.export-<tag>-*` folder (tag = this deployment) and renamed
 *     into place only if evidence/<runId> does not exist yet.
 *   - Bounded in total (audit run-6 v-2, retention.ts): a new run starts at most once per MIN_EXPORT_INTERVAL_S per
 *     facility (checked under the lock before anything is collected), and after a publish only the facility's newest
 *     KEEP_RUNS runs of this deployment stay on disk. A call that collects but claims no run (idempotent, or refused
 *     while collecting) starts the interval too, checked before the lock and again under it (run-6 re-check L1).
 *   - Settled first (run-6 re-check M1, ready.ts): before anything is collected, an export with a row in flight or a
 *     row above the `finalized` head is refused synchronously (409 with the reason), with no FAILED row and no interval.
 * The route returns {runId} once the run is claimed and finishes in the background (evidence_runs tracks it);
 * the CLI waits.
 */
import { execFile } from "node:child_process";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { hashObject, type BundleManifest, type CountryCode } from "@hogee/core";
import { BUNDLE_FILES, BUNDLE_FORMAT, codeUrlOf, COUNTRY_PACK_FILE, explorerOf, hashesFileOf, LOCAL_URL_BASE, MAX_BUNDLE_FILES, MAX_FILE_BYTES, receiptPath, verifyBundle, type ContractsFile } from "@hogee/verify-evidence";
import type { PoolClient } from "pg";
import type { ApiDeps, Scope } from "../context";
import { collect, EvidenceIncompleteError, EvidenceTooLargeError, MAX_ROWS_PER_TABLE, type Collected } from "./collect";
import { EvidenceChainError, fetchChainData, minedTxHashes } from "./fetch";
import { assertExportReady } from "./ready";
import { evidenceRows } from "./rows";
import { attemptedRecently, MIN_EXPORT_INTERVAL_S, noteAttempt, pruneRuns, sweep, tempName, tempTag, tooSoon } from "./retention";
import type { Tenant } from "./store";
import { summaryMarkdown } from "./summary";

export const MAX_BUNDLE_BYTES = 128 * 1024 * 1024;
/** pg_try_advisory_lock key of the export (ASCII "EVID"). */
export const EXPORT_LOCK_KEY = 0x45564944;
export const EXPORTER_VERSION = "hogee-evidence-export/1";
const GIT_COMMIT_RE = /^[0-9a-f]{7,40}$/;

export class EvidenceBusyError extends Error {
  override readonly name = "EvidenceBusyError";
}
export class EvidenceExportError extends Error {
  override readonly name = "EvidenceExportError";
}
export { EvidenceTooLargeError };

export interface ExportOptions {
  /** The evidence/ folder (absolute). */
  readonly root: string;
  /** HOGEE_GIT_COMMIT, else `git rev-parse HEAD` at the repo root. */
  readonly gitCommit?: string;
  /** Wait for the bundle (CLI); the route returns once the run is claimed. */
  readonly wait?: boolean;
  readonly now?: () => Date;
}

export interface ExportResult {
  readonly runId: string;
  /** false: the bundle already existed (same evidence), nothing was written. */
  readonly created: boolean;
  /**
   * Resolves when the bundle is on disk; its value is the verifier's verdict on what this call wrote, or null when it
   * wrote nothing (an existing folder is not re-checked here: `make verify` checks it).
   */
  readonly done: Promise<{ readonly verified: boolean | null }>;
}

const run = promisify(execFile);

async function gitCommitOf(root: string, explicit: string | undefined): Promise<string> {
  const fromEnv = explicit ?? process.env.HOGEE_GIT_COMMIT;
  if (fromEnv) {
    if (!GIT_COMMIT_RE.test(fromEnv)) throw new EvidenceExportError("HOGEE_GIT_COMMIT must be 7-40 lowercase hex characters");
    return fromEnv;
  }
  // The repo holding evidence/, else the one holding this file (an evidence dir outside the repo, e.g. in tests).
  // A path, not `new URL("../..", import.meta.url)`: apps/web's Next bundler treats that as an asset import and fails.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  for (const cwd of [dirname(root), repoRoot]) {
    try {
      const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd, timeout: 5_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } as unknown as NodeJS.ProcessEnv });
      const commit = stdout.trim();
      if (GIT_COMMIT_RE.test(commit)) return commit;
    } catch {
      // try the next one
    }
  }
  throw new EvidenceExportError("cannot read the git commit (set HOGEE_GIT_COMMIT)");
}

async function takeLock(deps: ApiDeps): Promise<() => Promise<void>> {
  const client: PoolClient = await deps.db.$client.connect();
  try {
    const got = await client.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [EXPORT_LOCK_KEY]);
    if (!got.rows[0]?.ok) throw new EvidenceBusyError("An evidence export is already running");
  } catch (error: unknown) {
    client.release();
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await client.query("select pg_advisory_unlock($1)", [EXPORT_LOCK_KEY]).catch(() => undefined);
    client.release();
  };
}

/**
 * contracts.json: links only on the explorer the verifier pins for the chain (run-6 re-check M5), and only the exact
 * code page of each contract (`codeUrlOf`, run-7 re-check L2), whatever the deployment's verifiedUrl says (e.g. a
 * Sourcify link); `verified` still says whether the deployment names one. A chain with no pinned explorer links nowhere.
 */
export function contractsFile(deps: Pick<ApiDeps, "deployment">, scope: Scope, runId: string, exportedAt: string, excluded: number): ContractsFile {
  const d = deps.deployment;
  const explorer = explorerOf(d.chainId);
  const entry = (c: { address: string; verifiedUrl?: string | undefined }) => {
    const address = c.address.toLowerCase();
    return { address: address as `0x${string}`, verifiedUrl: explorer ? codeUrlOf(explorer, address) : null, verified: c.verifiedUrl !== undefined };
  };
  return {
    format: BUNDLE_FORMAT,
    runId,
    facilityId: scope.facilityId,
    exportedAt,
    deploymentId: d.deploymentId,
    chainId: d.chainId,
    chainTag: d.chainTag,
    explorer,
    contracts: { PlanRegistry: entry(d.contracts.PlanRegistry), Treasury: entry(d.contracts.Treasury), MilestoneEscrow: entry(d.contracts.MilestoneEscrow), SalesOracle: entry(d.contracts.SalesOracle) },
    excludedEvalTraces: excluded,
  };
}

interface Prepared {
  readonly runId: string;
  readonly collected: Collected;
  readonly pack: { readonly countryCode: CountryCode; readonly countryPackHash: string; readonly pack: unknown } | null;
}

/** Reads the DB and the country pack and derives the run id (no chain reads yet). */
async function prepare(deps: ApiDeps, scope: Scope): Promise<Prepared> {
  const collected = await collect(deps.db.$client, scope);
  // Audit run-7: the bundle schema has no field for this yet, so the operator log records what was left out.
  if (collected.omittedTraces.traces > 0) deps.log.warn("evidence_traces_omitted", { ...collected.omittedTraces, max: MAX_ROWS_PER_TABLE });
  if (collected.omittedLlmCalls > 0) deps.log.warn("evidence_llm_calls_omitted", { calls: collected.omittedLlmCalls, max: MAX_ROWS_PER_TABLE });
  // Unused signature requests (never submitted, no chain action) prove nothing, so they are never in a bundle (re-check H1).
  if (collected.omittedSignatures > 0) deps.log.info("evidence_signature_requests_omitted", { requests: collected.omittedSignatures });
  const committed = collected.plans.find((p) => p.status === "COMMITTED" || p.status === "SUPERSEDED") ?? collected.plans[0];
  const country = committed?.manifest.countryCode ?? deps.config.countryCode;
  const raw = await deps.catalog.countryPack(country);
  const pack = raw && committed && hashObject(raw) === committed.countryPackHash ? { countryCode: country, countryPackHash: committed.countryPackHash, pack: raw as unknown } : null;
  const fingerprint = hashObject(
    JSON.parse(
      JSON.stringify({ format: BUNDLE_FORMAT, exporter: EXPORTER_VERSION, facilityId: scope.facilityId, deploymentId: deps.deployment.deploymentId, chainId: deps.deployment.chainId, packHash: pack?.countryPackHash ?? null, collected }),
    ) as unknown,
  );
  return { runId: `ev-${fingerprint.slice(2, 18)}`, collected, pack };
}

const j = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

async function build(deps: ApiDeps, scope: Scope, p: Prepared, gitCommit: string, now: Date): Promise<Record<string, string>> {
  const c = p.collected;
  const chain = await fetchChainData(deps.client, minedTxHashes(c.payments, c.chainActions));
  const contracts = contractsFile(deps, scope, p.runId, now.toISOString(), c.excludedEvalTraces);
  const rows = evidenceRows({ contracts, receipts: chain.receipts }, c);
  const manifest: BundleManifest = {
    runId: p.runId,
    gitCommit,
    // The frozen manifest schema needs a URL: the local placeholder when the chain has no explorer.
    deployments: {
      [contracts.deploymentId]: {
        chainId: contracts.chainId,
        contracts: Object.fromEntries(Object.entries(contracts.contracts).map(([k, v]) => [k, { address: v.address, verifiedUrl: v.verifiedUrl ?? `${LOCAL_URL_BASE}/${contracts.chainTag}/address/${v.address}` }])),
      },
    },
    toolVersions: { exporter: EXPORTER_VERSION, bundleFormat: BUNDLE_FORMAT, node: process.version.slice(0, 64) },
  };
  const files: Record<string, string> = {
    [BUNDLE_FILES.manifest]: j(manifest),
    [BUNDLE_FILES.evidence]: j(rows),
    [BUNDLE_FILES.contracts]: j(contracts),
    [BUNDLE_FILES.plans]: j(c.plans),
    [BUNDLE_FILES.signatures]: j(c.signatures),
    [BUNDLE_FILES.payments]: j(c.payments),
    [BUNDLE_FILES.chainActions]: j(c.chainActions),
    [BUNDLE_FILES.rationales]: j(c.rationales),
    [BUNDLE_FILES.traces]: j(c.traces),
    [BUNDLE_FILES.llmCalls]: j(c.llmCalls),
    [BUNDLE_FILES.blocks]: j(chain.blocks),
    ...(p.pack ? { [COUNTRY_PACK_FILE]: j(p.pack) } : {}),
    ...Object.fromEntries([...chain.receipts].map(([hash, r]) => [receiptPath(hash), j(r)])),
  };
  files[BUNDLE_FILES.summary] = summaryMarkdown({ manifest, contracts, rows, collected: c, receipts: chain.receipts.size, countryPackIncluded: p.pack !== null });
  files[BUNDLE_FILES.hashes] = hashesFileOf(files);
  const sizes = Object.values(files).map((f) => Buffer.byteLength(f));
  if (sizes.length > MAX_BUNDLE_FILES || sizes.some((s) => s > MAX_FILE_BYTES) || sizes.reduce((a, s) => a + s, 0) > MAX_BUNDLE_BYTES) {
    throw new EvidenceTooLargeError(`the bundle is over its limits (${sizes.length} files)`);
  }
  return files;
}

const exists = async (path: string): Promise<boolean> => lstat(path).then(() => true, () => false);

/** Writes into a fresh hidden folder, then renames it into place unless the run already exists. */
async function publish(root: string, tag: string, runId: string, files: Record<string, string>): Promise<boolean> {
  const tmp = join(root, tempName(tag, runId));
  await mkdir(tmp, { mode: 0o755 });
  try {
    for (const [path, body] of Object.entries(files)) {
      if (path.includes("/")) await mkdir(join(tmp, dirname(path)), { recursive: true, mode: 0o755 });
      await writeFile(join(tmp, path), body, { flag: "wx", mode: 0o644 });
    }
    if (await exists(join(root, runId))) return false;
    await rename(tmp, join(root, runId));
    return true;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function mark(deps: ApiDeps, scope: Scope, runId: string, status: "PENDING" | "READY" | "FAILED", extra: { gitCommit?: string; manifest?: unknown; rowCount?: number; error?: string } = {}): Promise<void> {
  await deps.db.$client.query(
    `insert into evidence_runs (id, facility_id, status, git_commit, manifest_json, row_count, error, finished_at)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7, case when $8::boolean then now() else null end)
     on conflict (facility_id, id) do update set status = excluded.status, git_commit = coalesce(excluded.git_commit, evidence_runs.git_commit),
       manifest_json = excluded.manifest_json, row_count = excluded.row_count, error = excluded.error, finished_at = excluded.finished_at`,
    [runId, scope.facilityId, status, extra.gitCommit ?? null, extra.manifest === undefined ? null : JSON.stringify(extra.manifest), extra.rowCount ?? null, extra.error?.slice(0, 500) ?? null, status !== "PENDING"],
  );
}

/** Refusals whose message names only row ids, tx hashes and table names (all in the bundle anyway), never a URL or path. */
export const isEvidenceRefusal = (error: unknown): error is Error =>
  error instanceof EvidenceTooLargeError || error instanceof EvidenceExportError || error instanceof EvidenceIncompleteError || error instanceof EvidenceChainError;

/** A failure as stored and logged: the error class and a short message, never an RPC URL or a path. */
const safeError = (error: unknown): string =>
  isEvidenceRefusal(error) ? error.message : `${error instanceof Error ? error.name : "Error"}: the export failed (see the server log)`;

/** The server's tenant for evidence reads and retention: its facility on its deployment and chain. */
export const tenantOf = (deps: Pick<ApiDeps, "deployment">, scope: Scope): Tenant => ({ facilityId: scope.facilityId, deploymentId: deps.deployment.deploymentId, chainId: deps.deployment.chainId });

/** Keeps the newest runs after a publish; a failure here never fails the export (the bundle is already on disk). */
async function retain(deps: ApiDeps, root: string, tenant: Tenant): Promise<void> {
  try {
    const removed = await pruneRuns(deps, root, tenant);
    if (removed > 0) deps.log.info("evidence_pruned", { removed });
  } catch (error: unknown) {
    deps.log.warn("evidence_prune_failed", { error });
  }
}

const intervalRefusal = (): EvidenceBusyError => new EvidenceBusyError(`An evidence bundle was exported less than ${MIN_EXPORT_INTERVAL_S} s ago; try again shortly`);

export async function exportEvidence(deps: ApiDeps, scope: Scope, opts: ExportOptions): Promise<ExportResult> {
  // A collecting call that claimed no run (idempotent or refused) starts the interval too: refused before the lock.
  if (attemptedRecently(scope.facilityId)) throw intervalRefusal();
  const release = await takeLock(deps);
  /** Set once the collect starts; a call that collects and claims no run is noted for the interval (finally). */
  let collecting = false;
  let claimed = false;
  try {
    // Before anything is collected: inside the interval a call costs this one query (an identical state included).
    if (attemptedRecently(scope.facilityId) || (await tooSoon(deps, scope))) throw intervalRefusal();
    const tenant = tenantOf(deps, scope);
    const tag = tempTag(tenant);
    await mkdir(opts.root, { recursive: true, mode: 0o755 });
    await sweep(opts.root, tag);
    // Synchronously, before the run is claimed: an unsettled export is refused here with its reason (no FAILED row).
    await assertExportReady(deps, scope);
    collecting = true;
    const p = await prepare(deps, scope);
    if (await exists(join(opts.root, p.runId))) {
      await release();
      return { runId: p.runId, created: false, done: Promise.resolve({ verified: null }) };
    }
    const gitCommit = await gitCommitOf(opts.root, opts.gitCommit);
    await mark(deps, scope, p.runId, "PENDING", { gitCommit });
    claimed = true; // from here evidence_runs tracks the run (PENDING, then READY or FAILED)
    const done = (async () => {
      try {
        const files = await build(deps, scope, p, gitCommit, (opts.now ?? (() => new Date()))());
        await publish(opts.root, tag, p.runId, files);
        const manifest = JSON.parse(files[BUNDLE_FILES.manifest] as string) as unknown;
        await mark(deps, scope, p.runId, "READY", { gitCommit, manifest, rowCount: (JSON.parse(files[BUNDLE_FILES.evidence] as string) as unknown[]).length });
        await retain(deps, opts.root, tenant);
        const verified = verifyBundle(files).ok;
        deps.log.info("evidence_exported", { runId: p.runId, verified });
        return { verified };
      } catch (error: unknown) {
        deps.log.error("evidence_export_failed", { runId: p.runId, error });
        await mark(deps, scope, p.runId, "FAILED", { error: safeError(error) }).catch(() => undefined);
        throw error;
      } finally {
        await release();
      }
    })();
    if (opts.wait) await done;
    else done.catch(() => undefined);
    return { runId: p.runId, created: true, done };
  } catch (error: unknown) {
    await release();
    throw error;
  } finally {
    if (collecting && !claimed) noteAttempt(scope.facilityId);
  }
}
