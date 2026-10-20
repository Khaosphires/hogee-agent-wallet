/**
 * Evidence routes (project.md §16, §26.6): bundles from evidence/<runId>/ (REPLAY=<runId> serves only that run),
 * P3's fixtures/evidence-sample/, and the core example bundle as a last resort.
 * Links are never followed inside a bundle: a run folder, manifest, rows file or served file that is a symlink, a
 * junction or a hard link is skipped, and a bundle that doesn't parse is left out instead of failing the route.
 * As the live API's reader (packages/api evidence/store.ts):
 *   - an evidence/ bundle is served only to its tenant: its contracts.json names the demo's facility and chain, on any
 *     deployment of that facility there (profile.ts; ux3-officer, P1 19 Oct: the final-2 Sepolia export is Mei's too;
 *     an SG mock never shows Rina's bundles, nor an Anvil run while the demo is on Sepolia), and the
 *     folder name, the manifest's runId and contracts.json's runId are the same (never a dot folder such as the
 *     exporter's .export-* temp folder). REPLAY=<runId> names its run, so any deployment and chain of the demo's
 *     facility replays (an Anvil run too), provided the manifest lists that deployment on that chain;
 *   - listing opens the index files of at most MAX_LISTED_RUNS run folders, the newest by folder mtime, and a request
 *     for one run reads only that run's folder;
 *   - an unreadable folder is skipped, the file list goes at most MAX_DEPTH folders down, a file is read only up to a
 *     size cap, and a served file is inert (nosniff, a sandboxing CSP, no-store; index.ts adds nosniff to every
 *     evidence response).
 * The sample and the example are fixed, labelled mock data and are not tenant-checked. They are listed and served only
 * under a reserved run id (SAMPLE_RUN_PREFIX + their own id) that no evidence/ folder can have, and that id names only
 * them: the Proof page calls a pack a sample from that id alone (web proof-model.ts; audit run-10 v-2), so an exported
 * pack that fails its check is never explained away as one.
 * Index files (at most MAX_INDEX_FILE_BYTES each) are still read synchronously, because the route handlers
 * (handlers-ops.ts) call these functions synchronously; a served file (up to MAX_FILE_BYTES) is read asynchronously
 * into the response body, so it never blocks the event loop.
 */
import { close, closeSync, constants, existsSync, fstatSync, lstatSync, openSync, read, readSync, readdirSync, realpathSync, type Dirent } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  BundleManifest,
  EvidenceRows,
  Id,
  IsoDateTime,
  exampleBundleManifest,
  exampleEvidenceBundle,
  exampleEvidenceRunSummary,
  type EvidenceBundle,
  type EvidenceRunSummary,
} from "@hogee/core";
import type { MockEnv } from "./env";
import { PROFILES } from "./profile";

interface RunSource {
  readonly summary: EvidenceRunSummary;
  /** Bundle directory on disk; undefined for the in-memory example bundle. */
  readonly dir?: string;
  /** manifest.json and evidence.json as read and parsed once, when the run was listed. */
  readonly parsed?: Pick<EvidenceBundle, "manifest" | "rows">;
}

/**
 * Whose evidence/ bundles the mock serves (live: store.ts Tenant, which also pins the deployment): the demo's facility,
 * on any of its deployments on the demo's chain, so a later deployment's recorded export (final-2) is listed too.
 * `chainId` is undefined only for REPLAY=<runId>, where the operator names the run, so the run's own deployment
 * (contracts.json, matching its manifest) is the replay's, e.g. an Anvil run; the facility is still the demo's.
 */
interface Tenant {
  readonly facilityId: string;
  readonly chainId: number | undefined;
}

const MAX_FILES = 500;
/** At most this many evidence/ runs are listed, the newest by folder mtime (live: MAX_LISTED_RUNS in store.ts). */
export const MAX_LISTED_RUNS = 200;
/** Folders below the bundle root the file list walks (live: MAX_DEPTH in packages/api evidence/store.ts). */
export const MAX_DEPTH = 2;
/** A served bundle file is read up to this (@hogee/verify-evidence MAX_FILE_BYTES, which the live API uses). */
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
/** manifest.json, evidence.json and contracts.json are parsed per listed run: each at most this (live: MAX_INDEX_FILE_BYTES). */
export const MAX_INDEX_FILE_BYTES = 4 * 1024 * 1024;
/** A served file is read into its response body in chunks of this size. */
const READ_CHUNK_BYTES = 1024 * 1024;

/** Headers of a served bundle file, as the live API sends them: never sniffed, never run, never cached. */
const INERT_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
  "cache-control": "no-store",
};

/** The fields of contracts.json (@hogee/verify-evidence ContractsFile) the tenant check reads; the rest is not needed here. */
const ContractsTenant = z.object({ runId: Id, facilityId: Id, exportedAt: IsoDateTime, deploymentId: z.string().min(1), chainId: z.number().int().positive() });

/**
 * The run id prefix of the fixture sample and the core example (audit run-10 v-2). The Proof page reads a pack as a
 * labelled sample only under it (apps/web components/evidence/proof-model.ts SAMPLE_RUN_PREFIX, the same literal), so
 * isRunName refuses it: no evidence/ folder is ever listed or served under it, in REPLAY either.
 */
export const SAMPLE_RUN_PREFIX = "sample:";

const isSampleRunId = (runId: string): boolean => runId.startsWith(SAMPLE_RUN_PREFIX);

/** The reserved id the sample or the example with run id `runId` is served under; undefined if that is no valid id. */
function sampleRunId(runId: string): string | undefined {
  const id = `${SAMPLE_RUN_PREFIX}${runId}`;
  return Id.safeParse(id).success ? id : undefined;
}

/** The core example's served id (Id-valid: a short fixed id). */
const EXAMPLE_RUN_ID = `${SAMPLE_RUN_PREFIX}${exampleEvidenceRunSummary.runId}`;

/**
 * A run folder name the live API would serve: an id, never a dot folder (live: isRunName in store.ts), and never the
 * reserved sample prefix (audit run-10 v-2).
 */
const isRunName = (name: string): boolean => !name.startsWith(".") && !isSampleRunId(name) && Id.safeParse(name).success;

/** True for a directory that is not a link (lstat does not follow one). */
export const isRealDir = (dir: string): boolean => {
  try {
    return lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
};

/** The first `size` bytes of `fd` (fewer if it shrank): a file that grows after its size was checked stays capped. */
function readUpTo(fd: number, size: number): Buffer<ArrayBuffer> {
  const data = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const n = readSync(fd, data, read, size - read, read);
    if (n === 0) break;
    read += n;
  }
  return data.subarray(0, read);
}

interface OpenedFile {
  readonly fd: number;
  readonly size: number;
  readonly mtime: Date;
}

/**
 * A regular file inside `root`, opened without following links and only if it holds at most `maxBytes`; the caller
 * closes the descriptor. The path must be its own real path under the root's real path, the file must have one link
 * (a hard link can alias any file on the volume), and the opened file must be the one the path names (same dev and
 * inode). That narrows a swap between the checks and the read, it doesn't close it: O_NOFOLLOW guards only the last
 * component, so a folder on the path swapped for a link during the open is still followed (lstat follows it too).
 * Winning that race needs a local writer, which is acceptable for the mock.
 */
function openInside(root: string, rel: string, maxBytes: number): OpenedFile | undefined {
  try {
    const realRoot = realpathSync(root);
    const full = resolve(realRoot, rel);
    if (!full.startsWith(realRoot + sep) || realpathSync(full) !== full) return undefined;
    // O_NOFOLLOW and O_NONBLOCK are POSIX only (undefined on Windows). O_NONBLOCK keeps a named pipe from blocking
    // the open (and Node's main thread); the isFile check below then refuses it.
    const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = fstatSync(fd);
      const named = lstatSync(full);
      if (opened.isFile() && named.isFile() && opened.nlink === 1 && opened.dev === named.dev && opened.ino === named.ino && opened.size <= maxBytes) {
        return { fd, size: opened.size, mtime: opened.mtime };
      }
    } catch {
      // fall through to close
    }
    closeSync(fd);
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * The bytes of a regular, single-link file at `rel` inside `root`, at most `maxBytes`, read without following links
 * (openInside); undefined for anything else. seed.ts reads REPLAY snapshots and fixtures with it too.
 */
export function readInside(root: string, rel: string, maxBytes = MAX_FILE_BYTES): { data: Buffer<ArrayBuffer>; mtime: Date } | undefined {
  const file = openInside(root, rel, maxBytes);
  if (!file) return undefined;
  try {
    return { data: readUpTo(file.fd, file.size), mtime: file.mtime };
  } catch {
    return undefined;
  } finally {
    try {
      closeSync(file.fd);
    } catch {
      // already closed
    }
  }
}

const readChunk = (fd: number, buffer: Buffer, position: number): Promise<number> =>
  new Promise((done, fail) => {
    read(fd, buffer, 0, buffer.length, position, (error, bytesRead) => (error ? fail(error) : done(bytesRead)));
  });

/**
 * The first `size` bytes of `fd` as a stream, read asynchronously from the moment it is made and closed when the read
 * ends, whether or not anyone consumes the body (a HEAD request or a dropped client never leaves the descriptor open).
 * As readUpTo, a file that grows stays capped at `size` and one that shrinks ends early.
 */
function bodyOf(fd: number, size: number): ReadableStream<Uint8Array> {
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        try {
          let position = 0;
          while (position < size && !cancelled) {
            const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, size - position));
            const n = await readChunk(fd, chunk, position);
            if (n === 0) break;
            if (!cancelled) controller.enqueue(chunk.subarray(0, n));
            position += n;
          }
          if (!cancelled) controller.close();
        } catch (error) {
          try {
            if (!cancelled) controller.error(error);
          } catch {
            // the stream is already closed
          }
        } finally {
          close(fd, () => undefined);
        }
      })();
    },
    cancel() {
      cancelled = true;
    },
  });
}

function parseJson(data: Buffer): unknown {
  try {
    return JSON.parse(data.toString("utf8"));
  } catch {
    return undefined;
  }
}

/** The entries of a folder, or none if it can't be read (a permission, a race): one bad folder never fails a route. */
function entriesOf(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** True for a regular file with one link; false for anything else, or a file that went away meanwhile. */
function isSingleLinkFile(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isFile() && st.nlink === 1;
  } catch {
    return false;
  }
}

/**
 * Regular single-link files of a bundle, at most MAX_DEPTH folders down. Links are skipped (a Dirent describes the
 * link itself), so a linked folder can neither loop nor leak, and an unreadable folder is skipped.
 */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    for (const entry of entriesOf(d)) {
      if (out.length >= MAX_FILES) return;
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) walk(full, depth + 1);
      } else if (entry.isFile() && isSingleLinkFile(full)) {
        out.push(relative(dir, full).split(sep).join("/"));
      }
    }
  };
  walk(dir, 0);
  return out.sort();
}

/** manifest.json and evidence.json of a bundle folder, parsed, or undefined. */
function readIndex(dir: string): (Pick<EvidenceBundle, "manifest" | "rows"> & { mtime: Date }) | undefined {
  if (!isRealDir(dir)) return undefined;
  const manifestFile = readInside(dir, "manifest.json", MAX_INDEX_FILE_BYTES);
  const rowsFile = readInside(dir, "evidence.json", MAX_INDEX_FILE_BYTES);
  if (!manifestFile || !rowsFile) return undefined;
  const manifest = BundleManifest.safeParse(parseJson(manifestFile.data));
  const rows = EvidenceRows.safeParse(parseJson(rowsFile.data));
  if (!manifest.success || !rows.success) return undefined;
  return { manifest: manifest.data, rows: rows.data, mtime: manifestFile.mtime };
}

const isoSeconds = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, "Z");

/** The fixture sample (fixtures/evidence-sample/): fixed mock data, listed under the reserved id of its manifest's runId. */
function readSample(dir: string): RunSource | undefined {
  const index = readIndex(dir);
  const runId = index ? sampleRunId(index.manifest.runId) : undefined;
  if (!index || !runId) return undefined;
  const { manifest, rows } = index;
  return { dir, parsed: { manifest, rows }, summary: { runId, createdAt: isoSeconds(index.mtime), gitCommit: manifest.gitCommit, rowCount: rows.length } };
}

/** The demo's tenant (profile.ts ids, which the seeded session.json repeats); in REPLAY mode, any chain of its facility. */
function tenantOf(env: MockEnv): Tenant {
  const { facilityId, chainId } = PROFILES[env.country].ids;
  return { facilityId, chainId: env.replayRunId ? undefined : chainId };
}

/** evidence/<name>/ when it holds a bundle of `tenant` under that same run id (live: readRun in store.ts), else undefined. */
function readEvidenceRun(evidenceRoot: string, name: string, tenant: Tenant): RunSource | undefined {
  if (!isRunName(name)) return undefined;
  const dir = join(evidenceRoot, name);
  const index = readIndex(dir);
  const contractsFile = index ? readInside(dir, "contracts.json", MAX_INDEX_FILE_BYTES) : undefined;
  if (!index || !contractsFile) return undefined;
  const contracts = ContractsTenant.safeParse(parseJson(contractsFile.data));
  if (!contracts.success) return undefined;
  const k = contracts.data;
  const { manifest, rows } = index;
  if (k.facilityId !== tenant.facilityId || (tenant.chainId !== undefined && k.chainId !== tenant.chainId)) return undefined;
  if (manifest.runId !== name || k.runId !== name || manifest.deployments[k.deploymentId]?.chainId !== k.chainId) return undefined;
  return { dir, parsed: { manifest, rows }, summary: { runId: name, createdAt: k.exportedAt, gitCommit: manifest.gitCommit, rowCount: rows.length } };
}

/** The newest MAX_LISTED_RUNS run folder names under `root` by mtime (newest first; ties by name), before any file is opened. */
function newestRunNames(root: string): string[] {
  const dated: { name: string; mtime: number }[] = [];
  for (const entry of entriesOf(root)) {
    if (!entry.isDirectory() || !isRunName(entry.name)) continue;
    try {
      dated.push({ name: entry.name, mtime: lstatSync(join(root, entry.name)).mtimeMs });
    } catch {
      // gone meanwhile
    }
  }
  return dated
    .sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, MAX_LISTED_RUNS)
    .map((d) => d.name);
}

const byNewest = (a: RunSource, b: RunSource): number => (a.summary.createdAt < b.summary.createdAt ? 1 : a.summary.createdAt > b.summary.createdAt ? -1 : 0);

export function evidenceRuns(env: MockEnv): RunSource[] {
  const evidenceRoot = join(env.repoRoot, "evidence");
  const tenant = tenantOf(env);
  if (env.replayRunId) {
    const run = readEvidenceRun(evidenceRoot, env.replayRunId, tenant);
    return run ? [run] : [];
  }
  const runs: RunSource[] = [];
  if (existsSync(evidenceRoot)) {
    for (const name of newestRunNames(evidenceRoot)) {
      const run = readEvidenceRun(evidenceRoot, name, tenant);
      if (run) runs.push(run);
    }
  }
  // Exported runs first (newest first), then the labelled fixture sample, so the default pack is a recorded one whenever
  // there is one; the sample's date is its files' mtime, which says nothing about when it was recorded.
  const sample = readSample(join(env.fixturesDir, "evidence-sample"));
  const listed = [...runs.sort(byNewest), ...(sample ? [sample] : [])];
  return listed.length > 0 ? listed : [{ summary: { ...exampleEvidenceRunSummary, runId: EXAMPLE_RUN_ID } }];
}

/**
 * Run `runId`, reading only what that id can name: a reserved sample id only the sample, then the example; any other
 * id only evidence/<runId>/. Only the example's own id falls back to the listing, since the example is served only
 * when nothing else is listed.
 */
function findRun(env: MockEnv, runId: string): RunSource | undefined {
  const evidenceRoot = join(env.repoRoot, "evidence");
  if (env.replayRunId) return runId === env.replayRunId ? readEvidenceRun(evidenceRoot, runId, tenantOf(env)) : undefined;
  if (!isSampleRunId(runId)) return readEvidenceRun(evidenceRoot, runId, tenantOf(env));
  const sample = readSample(join(env.fixturesDir, "evidence-sample"));
  if (sample?.summary.runId === runId) return sample;
  return runId === EXAMPLE_RUN_ID ? evidenceRuns(env).find((r) => r.summary.runId === runId) : undefined;
}

/**
 * True when the demo's tenant may read evidence run `runId` today (REG-BRIEF fisco-proof: a FISCO mirror pack is
 * served only while its source bundle is): an evidence/ run of the tenant, or the REPLAY run. Never the sample or the
 * example, whose reserved ids name mock data, not a recorded run.
 */
export const ownsEvidenceRun = (env: MockEnv, runId: string): boolean => !isSampleRunId(runId) && findRun(env, runId) !== undefined;

export function evidenceBundle(env: MockEnv, runId: string): EvidenceBundle | undefined {
  const run = findRun(env, runId);
  if (!run) return undefined;
  if (!run.dir || !run.parsed) return exampleEvidenceBundle;
  return { ...run.parsed, files: listFiles(run.dir) };
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".jsonl": "application/x-ndjson",
  ".pdf": "application/pdf",
  ".csv": "text/csv; charset=utf-8",
};

/**
 * Raw file of a bundle; the path is already validated (no "..", relative) and openInside re-checks it. The checks run
 * now; the bytes are read asynchronously into the body (bodyOf).
 */
export function evidenceFile(env: MockEnv, runId: string, path: string): Response | undefined {
  const run = findRun(env, runId);
  if (!run) return undefined;
  if (!run.dir) {
    if (!exampleEvidenceBundle.files.includes(path)) return undefined;
    const body =
      path === "evidence.json" ? exampleEvidenceBundle.rows : path === "manifest.json" ? exampleBundleManifest : { note: "Example bundle placeholder (no files on disk)", path };
    return Response.json(body, { headers: INERT_HEADERS });
  }
  const file = openInside(run.dir, path, MAX_FILE_BYTES);
  if (!file) return undefined;
  const type = CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
  return new Response(bodyOf(file.fd, file.size), { headers: { ...INERT_HEADERS, "content-type": type } });
}
