/**
 * Reading finished bundles from evidence/ for GET /api/evidence/runs, /:runId and /:runId/files/* (§26.6), with the
 * same containment as P2's mock reader (packages/api-mock evidence.ts `readInside`):
 *   - the run folder is a real directory directly under the evidence root (no symlink, no `.export-*` temp folder);
 *   - a file's path is its own realpath under the run's realpath (no `..`, no symlinked component), it is a regular
 *     file with ONE link (a hard link could alias any file on the volume), opened with O_NOFOLLOW | O_NONBLOCK (a
 *     FIFO or device never blocks), and the opened inode is the one the path names (a swap between check and read is
 *     caught), at most MAX_FILE_BYTES, and read from the opened descriptor up to the size checked, never more (a file
 *     that changes size meanwhile reads as absent);
 *   - a bundle is served only to its own tenant: contracts.json names the server's facility (T31) AND its deployment
 *     and chain (one evidence root can be shared by an Anvil and a Sepolia checkout with the same facility id);
 *   - listing opens the index files of at most MAX_LISTED_RUNS run folders, the newest by folder mtime (one lstat
 *     each), so its cost does not grow with what the root holds (audit run-6 v-2).
 * Anything else reads as absent (NOT_FOUND), never as an error that names a path.
 */
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { BundleManifest, EvidenceRows, Id, type EvidenceBundle, type EvidenceRunSummary } from "@hogee/core";
import { BUNDLE_FILES, ContractsFile, MAX_BUNDLE_FILES, MAX_FILE_BYTES } from "@hogee/verify-evidence";

/** At most this many runs are listed (newest first). */
export const MAX_LISTED_RUNS = 200;
/** manifest.json, evidence.json and contracts.json are read per run when listing: each at most this. */
const MAX_INDEX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 2;

const isRunName = (name: string): boolean => !name.startsWith(".") && Id.safeParse(name).success;

/** Whose bundles a reader may see: the server's facility on the server's deployment and chain. */
export interface Tenant {
  readonly facilityId: string;
  readonly deploymentId: string;
  readonly chainId: number;
}

/**
 * Exactly `size` bytes from the start of an open file, never more: null when the file ends early or its size changed
 * by the time they were read (fh.readFile would read whatever the file has grown to, past the cap checked).
 */
async function readChecked(fh: FileHandle, size: number): Promise<Buffer | null> {
  const data = Buffer.alloc(size);
  let at = 0;
  while (at < size) {
    const { bytesRead } = await fh.read(data, at, size - at, at);
    if (bytesRead === 0) return null;
    at += bytesRead;
  }
  return (await fh.stat()).size === size ? data : null;
}

/** The bytes of a regular, single-link file at `rel` inside `dir` (a real path), or null. */
export async function readInside(dir: string, rel: string, maxBytes: number = MAX_FILE_BYTES): Promise<{ data: Buffer; mtime: Date } | null> {
  try {
    const full = resolve(dir, rel);
    if (!full.startsWith(dir + sep) || (await realpath(full)) !== full) return null;
    const named = await lstat(full);
    if (!named.isFile() || named.nlink !== 1 || named.size > maxBytes) return null;
    const fh = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = await fh.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== named.dev || opened.ino !== named.ino || opened.size > maxBytes) return null;
      const data = await readChecked(fh, opened.size);
      return data ? { data, mtime: opened.mtime } : null;
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/** The real path of run `runId` under `root`, or null (not a plain directory directly under the root). */
async function runDir(root: string, runId: string): Promise<string | null> {
  if (!isRunName(runId)) return null;
  try {
    const realRoot = await realpath(root);
    const dir = join(realRoot, runId);
    const st = await lstat(dir);
    if (!st.isDirectory() || (await realpath(dir)) !== dir) return null;
    return dir;
  } catch {
    return null;
  }
}

const json = (b: Buffer): unknown => {
  try {
    return JSON.parse(b.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
};

interface Run {
  readonly dir: string;
  readonly summary: EvidenceRunSummary;
  readonly bundle: Omit<EvidenceBundle, "files">;
}

/** A finished bundle of `tenant`: manifest, rows and contracts.json parse and name this facility, deployment and chain. */
async function readRun(root: string, runId: string, tenant: Tenant): Promise<Run | null> {
  const dir = await runDir(root, runId);
  if (!dir) return null;
  const index = (file: string) => readInside(dir, file, MAX_INDEX_FILE_BYTES);
  const [m, r, c] = await Promise.all([index(BUNDLE_FILES.manifest), index(BUNDLE_FILES.evidence), index(BUNDLE_FILES.contracts)]);
  if (!m || !r || !c) return null;
  const manifest = BundleManifest.safeParse(json(m.data));
  const rows = EvidenceRows.safeParse(json(r.data));
  const contracts = ContractsFile.safeParse(json(c.data));
  if (!manifest.success || !rows.success || !contracts.success) return null;
  const k = contracts.data;
  if (k.facilityId !== tenant.facilityId || k.deploymentId !== tenant.deploymentId || k.chainId !== tenant.chainId) return null;
  if (manifest.data.runId !== runId || k.runId !== runId || manifest.data.deployments[tenant.deploymentId]?.chainId !== tenant.chainId) return null;
  return {
    dir,
    summary: { runId, createdAt: contracts.data.exportedAt, gitCommit: manifest.data.gitCommit, rowCount: rows.data.length },
    bundle: { manifest: manifest.data, rows: rows.data },
  };
}

/** True when `runId` is a real run folder directly under `root` holding a bundle of `tenant`. */
export async function ownsRun(root: string, runId: string, tenant: Tenant): Promise<boolean> {
  return (await readRun(root, runId, tenant)) !== null;
}

/** The newest MAX_LISTED_RUNS run folder names by mtime (newest first; ties by name), before any file is opened. */
async function newestRunNames(root: string): Promise<string[]> {
  const names = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.isSymbolicLink() && isRunName(e.name)).map((e) => e.name);
  const dated = await Promise.all(
    names.map(async (name) => ({
      name,
      mtime: await lstat(join(root, name)).then(
        (s) => s.mtimeMs,
        () => Number.NaN,
      ),
    })),
  );
  return dated
    .filter((d) => !Number.isNaN(d.mtime))
    .sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, MAX_LISTED_RUNS)
    .map((d) => d.name);
}

export async function listRuns(root: string, tenant: Tenant): Promise<EvidenceRunSummary[]> {
  let names: string[];
  try {
    names = await newestRunNames(root);
  } catch {
    return [];
  }
  const runs: EvidenceRunSummary[] = [];
  for (const name of names) {
    const run = await readRun(root, name, tenant);
    if (run) runs.push(run.summary);
  }
  return runs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/** Regular single-link files of a bundle, relative paths, sorted; links and special files are skipped. */
async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, depth: number): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      if (out.length >= MAX_BUNDLE_FILES) return;
      const full = join(d, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (depth < MAX_DEPTH) await walk(full, depth + 1);
      } else if (entry.isFile() && (await lstat(full)).nlink === 1) {
        out.push(relative(dir, full).split(sep).join("/"));
      }
    }
  };
  await walk(dir, 0);
  return out.filter((p) => p.length <= 300).sort();
}

export async function getRun(root: string, runId: string, tenant: Tenant): Promise<EvidenceBundle | null> {
  const run = await readRun(root, runId, tenant);
  if (!run) return null;
  return { ...run.bundle, files: await listFiles(run.dir) };
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** One raw file of a tenant's bundle as a Response, or null. Served inert: nosniff and a sandboxing CSP. */
export async function readFileResponse(root: string, runId: string, path: string, tenant: Tenant): Promise<Response | null> {
  const run = await readRun(root, runId, tenant);
  if (!run) return null;
  const file = await readInside(run.dir, path);
  if (!file) return null;
  return new Response(new Uint8Array(file.data), {
    headers: {
      "content-type": CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "no-store",
    },
  });
}
