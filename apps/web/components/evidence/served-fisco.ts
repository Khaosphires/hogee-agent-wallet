import type { BundleFiles } from "@hogee/verify-evidence";
import { isPackPath, verifyFiscoPack, type FiscoResult } from "@hogee/verify-evidence/fisco";
import { anchorCheckerOf, checkAnchor, type AnchorChecker } from "./fisco-anchor-check";
import { folderCheck, packIdentityOf, type AnchorCheck, type FiscoCheck } from "./fisco-model";

/** What the API lists for a pack (api-contract FiscoPackSummary). */
export interface ListedPack {
  readonly packId: string;
  readonly files: readonly string[];
  readonly anchored: boolean;
}

/** How the page reads a pack, its source Sepolia bundle and its anchor (fisco-section.tsx: the local API). */
export interface FiscoSource {
  readonly packFile: (path: string) => Promise<Blob>;
  /** The source bundle's file list (GET /api/evidence/:runId). */
  readonly bundleFiles: (runId: string) => Promise<readonly string[]>;
  readonly bundleFile: (runId: string, path: string) => Promise<Blob>;
  readonly anchor: () => Promise<Blob>;
}

export interface ServedFisco {
  /** The pack as served, exact bytes (fisco-model.ts reads its steps, nodes and blocks). */
  readonly files: BundleFiles;
  readonly result: FiscoResult;
  /** Every check this browser ran: the verifier's, the folder check, and the Sepolia timestamp when it counts (anchorCounts). */
  readonly checks: readonly FiscoCheck[];
  readonly ok: boolean;
  readonly anchor: AnchorCheck;
}

/** At most this many files are fetched at once (a pack holds up to 400). */
const PARALLEL = 8;

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Every file as its exact bytes (never Blob.text(): served-pack.ts, run-10 re-check H-2). */
async function bytesOf(paths: readonly string[], fetchFile: (path: string) => Promise<Blob>): Promise<BundleFiles> {
  const entries = await mapLimited(paths, PARALLEL, async (path) => [path, new Uint8Array(await (await fetchFile(path)).arrayBuffer())] as const);
  return Object.fromEntries(entries);
}

/**
 * The pack's files: every listed entry a pack may hold, fetched as its exact bytes. An entry no pack may hold (pack.ts
 * isPackPath; the API lists it but never serves it) is not fetched: it stays in the set, empty, so the verifier's
 * "pack files" check fails on it by name ("unexpected file …"), as `make verify-fisco` does on disk.
 */
async function packBytesOf(paths: readonly string[], fetchFile: (path: string) => Promise<Blob>): Promise<BundleFiles> {
  const fetched = await bytesOf(paths.filter(isPackPath), fetchFile);
  return Object.fromEntries(paths.map((path) => [path, fetched[path] ?? new Uint8Array(0)]));
}

/**
 * Whether the timestamp is a check line: when a sidecar was served (anchored) or its check failed. A pack with no
 * sidecar is "not timestamped yet", a neutral state outside the count, never a passing line (audit run-12 v-1).
 */
export const anchorCounts = (anchor: AnchorCheck): boolean => anchor.available && (anchor.anchored || !anchor.ok);

/**
 * Checks a served FISCO mirror pack in this browser, as `make verify-fisco` checks it on disk: verifyFiscoPack on the
 * pack's bytes with the source Sepolia bundle's bytes (the run pack.json names, read through the existing evidence
 * route, so only a bundle this tenant may read), the folder check, and the Sepolia timestamp when one was served or its
 * check failed. A file that can't be read throws (the page says "could not be read", never a pass); an anchor that
 * can't be read is a failed timestamp.
 */
export async function verifyServedFisco(pack: ListedPack, source: FiscoSource, checker?: AnchorChecker | null): Promise<ServedFisco> {
  const files = await packBytesOf(pack.files, source.packFile);
  const identity = packIdentityOf(files);
  const sepoliaBundle = identity ? await bytesOf(await source.bundleFiles(identity.sourceRunId), (path) => source.bundleFile(identity.sourceRunId, path)) : undefined;
  const result = verifyFiscoPack(files, sepoliaBundle ? { sepoliaBundle } : {});
  const anchor = await anchorOf(pack, files, source, checker);
  const checks: FiscoCheck[] = [...result.checks, folderCheck(pack.packId, result.packId)];
  if (anchorCounts(anchor)) checks.push({ name: ANCHOR_CHECK, ok: anchor.ok, detail: anchor.detail });
  return { files, result, checks, ok: result.ok && checks.every((c) => c.ok), anchor };
}

/** The check line fisco-anchor's CLI prints (anchor.ts ANCHOR_CHECK). */
export const ANCHOR_CHECK = "Sepolia timestamp";

async function anchorOf(pack: ListedPack, files: BundleFiles, source: FiscoSource, checker: AnchorChecker | null | undefined): Promise<AnchorCheck> {
  const check = checker === undefined ? anchorCheckerOf() : checker;
  if (!check || !pack.anchored) return checkAnchor(files, null, check);
  let sidecar: Uint8Array;
  try {
    sidecar = new Uint8Array(await (await source.anchor()).arrayBuffer());
  } catch {
    return { available: true, ok: false, anchored: false, anchor: null, detail: "the anchor file could not be read" };
  }
  return checkAnchor(files, sidecar, check);
}
