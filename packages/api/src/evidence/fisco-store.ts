/**
 * Reading FISCO BCOS mirror packs (evidence/fisco/fm-<16hex>/, @hogee/verify-evidence fisco) for GET
 * /api/evidence/fisco, /fisco/:packId/files/* and /fisco/:packId/anchor (REG-BRIEF fisco-proof), with the bundle
 * reader's containment (store.ts readInside):
 *   - a pack folder is a real directory named after its packId directly under <evidence>/fisco (no link), and its
 *     pack.json (read under its own MAX_PACK_JSON_BYTES cap) is a FISCO mirror pack whose packId is that name;
 *   - tenancy: a pack is listed and served only while the tenant may read the Sepolia bundle it mirrors today
 *     (pack.json sourceBundle.runId; the caller's `owns`, i.e. store.ts ownsRun or the mock's readEvidenceRun), asked
 *     once per source run within a request (oncePerRun);
 *   - a file is a path a pack may hold (the verifier's isPackPath) and a regular single-link file under the pack's real
 *     path, opened O_NOFOLLOW | O_NONBLOCK, the inode the path names, at most MAX_PACK_FILE_BYTES; the anchor sidecar
 *     (anchors/<packId>.sepolia.json, a real folder) the same, at most MAX_ANCHOR_BYTES; both are served inert
 *     (nosniff, a sandboxing CSP, no-store);
 *   - the file list names every entry `make verify-fisco` would read or refuse (read-dir.ts walks the same depth), so a
 *     stray file, a link, a hard link or a FIFO is listed but never served, and the browser's check fails as the CLI's
 *     does. A pack with more entries than a pack may hold, or an entry name the contract can't carry, is not listed;
 *   - listing reads the pack.json of at most MAX_SCANNED_PACKS pack folders, the newest by folder mtime, applies the
 *     tenancy filter, and only then keeps the tenant's newest MAX_LISTED_PACKS (another tenant's newer packs never
 *     push this tenant's out).
 * Nothing here vouches for a pack: the browser verifies the bytes (apps/web served-fisco.ts). Anything else reads as
 * absent (null, NOT_FOUND), never as an error that names a path.
 */
import { lstat, readdir, realpath } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { z } from "zod";
import { FiscoFileParams, type FiscoPackSummary } from "@hogee/api-contract";
import { Id, IsoDateTime } from "@hogee/core";
import { FISCO_PACKS_DIR, isPackPath, MAX_PACK_FILE_BYTES, MAX_PACK_FILES, PACK_DIR_RE } from "@hogee/verify-evidence/fisco";
import { readInside } from "./store";

/** At most this many of the tenant's packs are listed (newest first). */
export const MAX_LISTED_PACKS = 20;
/** At most this many pack folders have their pack.json read per listing (newest by mtime; store.ts MAX_LISTED_RUNS). */
export const MAX_SCANNED_PACKS = 200;
/**
 * The cap on pack.json when the store reads it to list or serve a pack (every listing reads up to MAX_SCANNED_PACKS of
 * them): a real one is about 3 KB. Served as a file, it keeps the pack's per-file cap; a larger one is no pack here.
 */
export const MAX_PACK_JSON_BYTES = 64 * 1024;
/** The Sepolia anchor sidecar's cap (fisco-anchor's MAX_ANCHOR_BYTES, the same value). */
export const MAX_ANCHOR_BYTES = 64 * 1024;
/** evidence/fisco/anchors/<packId>.sepolia.json */
export const ANCHORS_DIR = "anchors";
const anchorFile = (packId: string): string => `${packId}.sepolia.json`;
/** Folders below the pack root the walk enters (read-dir.ts: depth < 2). */
const MAX_DEPTH = 2;

/** Whether the tenant may read the evidence run `runId` today (the pack's source Sepolia bundle). */
export type OwnsSource = (runId: string) => Promise<boolean>;

/** What the store reads of pack.json: a mirror pack of any version (the browser checks the rest). */
const PackIndex = z.looseObject({
  format: z.string().regex(/^hogee\.fisco-mirror\/[0-9]{1,3}$/),
  packId: z.string().regex(PACK_DIR_RE),
  createdAt: IsoDateTime,
  sourceBundle: z.looseObject({ runId: Id }),
});

const INERT = { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "cache-control": "no-store" } as const;
const CONTENT_TYPES: Readonly<Record<string, string>> = { ".json": "application/json", ".hex": "text/plain; charset=utf-8" };

const json = (b: Buffer): unknown => {
  try {
    return JSON.parse(b.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
};

/** The real path of `name` directly under `parent` (a real path) when it is a plain directory there, else null. */
async function realDirIn(parent: string, name: string): Promise<string | null> {
  try {
    const dir = join(parent, name);
    const st = await lstat(dir);
    return st.isDirectory() && (await realpath(dir)) === dir ? dir : null;
  } catch {
    return null;
  }
}

/** <root>/fisco as a real path, or null. */
async function packsRoot(root: string): Promise<string | null> {
  try {
    return await realDirIn(await realpath(root), FISCO_PACKS_DIR);
  } catch {
    return null;
  }
}

interface Pack {
  readonly dir: string;
  readonly createdAt: string;
}

/** Pack `packId` under `fisco` (a real path) when its pack.json names it and its source run is the tenant's, else null. */
async function readPack(fisco: string, packId: string, owns: OwnsSource): Promise<Pack | null> {
  if (!PACK_DIR_RE.test(packId)) return null;
  const dir = await realDirIn(fisco, packId);
  const file = dir ? await readInside(dir, "pack.json", MAX_PACK_JSON_BYTES) : null;
  const index = file ? PackIndex.safeParse(json(file.data)) : null;
  if (!dir || !index?.success || index.data.packId !== packId) return null;
  return (await owns(index.data.sourceBundle.runId)) ? { dir, createdAt: index.data.createdAt } : null;
}

/** A name the contract can carry (listing). */
const isListablePath = (path: string): boolean => FiscoFileParams.shape.path.safeParse(path).success;
/** A name the file route serves: listable, and one a pack may hold (pack.ts isPackPath). */
const isServablePath = (path: string): boolean => isListablePath(path) && isPackPath(path);

/**
 * Every entry of a pack as `make verify-fisco` walks it (read-dir.ts): real folders are entered up to MAX_DEPTH, and
 * anything else (a file, a link, a FIFO, a folder below that depth) is an entry. Null when there are more than a pack
 * may hold, a name the contract can't carry, or the walk fails.
 */
async function packEntries(dir: string): Promise<string[] | null> {
  const out: string[] = [];
  const walk = async (d: string, depth: number): Promise<boolean> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory() && depth < MAX_DEPTH) {
        if (!(await walk(full, depth + 1))) return false;
        continue;
      }
      out.push(relative(dir, full).split(sep).join("/"));
      if (out.length > MAX_PACK_FILES) return false;
    }
    return true;
  };
  try {
    if (!(await walk(dir, 0))) return null;
  } catch {
    return null;
  }
  return out.every(isListablePath) ? out.sort() : null;
}

/** The pack's anchor sidecar bytes (a regular single-link file in a real anchors folder, at most the cap), or null. */
async function anchorBytes(fisco: string, packId: string): Promise<Buffer | null> {
  const anchors = await realDirIn(fisco, ANCHORS_DIR);
  return anchors ? ((await readInside(anchors, anchorFile(packId), MAX_ANCHOR_BYTES))?.data ?? null) : null;
}

/** The newest MAX_SCANNED_PACKS pack folder names by mtime (ties by name), before any file is opened. */
async function newestPackNames(fisco: string): Promise<string[]> {
  const names = (await readdir(fisco, { withFileTypes: true })).filter((e) => e.isDirectory() && PACK_DIR_RE.test(e.name)).map((e) => e.name);
  const dated = await Promise.all(names.map(async (name) => ({ name, mtime: await lstat(join(fisco, name)).then((s) => s.mtimeMs, () => Number.NaN) })));
  return dated
    .filter((d) => !Number.isNaN(d.mtime))
    .sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, MAX_SCANNED_PACKS)
    .map((d) => d.name);
}

/**
 * One tenancy answer per source run within a request: every pack of a run mirrors the same bundle. A question that
 * throws is a "no". Each entry point below wraps the caller's `owns` once per call (one call = one request).
 */
function oncePerRun(owns: OwnsSource): OwnsSource {
  const seen = new Map<string, Promise<boolean>>();
  return (runId) => {
    const known = seen.get(runId);
    if (known) return known;
    const answer = owns(runId).catch(() => false);
    seen.set(runId, answer);
    return answer;
  };
}

/** The tenant's packs, newest first (pack.json createdAt, then packId). */
export async function listFiscoPacks(root: string, owns: OwnsSource): Promise<FiscoPackSummary[]> {
  const fisco = await packsRoot(root);
  if (!fisco) return [];
  let names: string[];
  try {
    names = await newestPackNames(fisco);
  } catch {
    return [];
  }
  const tenantOwns = oncePerRun(owns);
  const packs: FiscoPackSummary[] = [];
  let opened = 0;
  for (const packId of names) {
    if (opened >= MAX_LISTED_PACKS) break;
    // Tenancy first: only the tenant's own packs count toward the cap.
    const pack = await readPack(fisco, packId, tenantOwns);
    if (!pack) continue;
    opened += 1;
    const files = await packEntries(pack.dir);
    if (files) packs.push({ packId, createdAt: pack.createdAt, files, anchored: (await anchorBytes(fisco, packId)) !== null });
  }
  return packs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.packId < b.packId ? -1 : 1));
}

const inert = (data: Buffer, type: string): Response => new Response(new Uint8Array(data), { headers: { "content-type": type, ...INERT } });

/** One raw file of a tenant's pack as a Response, or null. */
export async function readFiscoFile(root: string, packId: string, path: string, owns: OwnsSource): Promise<Response | null> {
  if (!isServablePath(path)) return null;
  const fisco = await packsRoot(root);
  const pack = fisco ? await readPack(fisco, packId, oncePerRun(owns)) : null;
  if (!pack || (await packEntries(pack.dir)) === null) return null;
  const file = await readInside(pack.dir, path, MAX_PACK_FILE_BYTES);
  return file ? inert(file.data, CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream") : null;
}

/** A tenant's pack's Sepolia anchor sidecar as a Response, or null (none, or not served). */
export async function readFiscoAnchor(root: string, packId: string, owns: OwnsSource): Promise<Response | null> {
  const fisco = await packsRoot(root);
  const pack = fisco ? await readPack(fisco, packId, oncePerRun(owns)) : null;
  const data = fisco && pack ? await anchorBytes(fisco, packId) : null;
  return data ? inert(data, "application/json") : null;
}
