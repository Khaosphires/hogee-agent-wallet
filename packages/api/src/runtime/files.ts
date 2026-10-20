/**
 * Shared file readers for the catalog and the eval datasets: P3's supplier files (a Supplier record, or
 * {supplier, evidence[]}) and their raw listing text, packs, specs and JSONL datasets, and load caches that never keep a
 * failure.
 *
 * EVERY dataset file is read through readContained: the path, and again its realpath, must stay under the file's data
 * root (no `..`, no absolute path, no symlink out, so no /dev/zero or /dev/tty), it must be a regular file (no FIFO or
 * device, which could block a load), and at most its size cap. Anything else, or a read that fails, is logged and
 * reads as null. A listing's `rawTextRef` is repo-relative (frozen Supplier schema) but may only name a file under
 * data/suppliers; unreadable text fails a shortlist closed rather than passing the listing's gates on no text.
 */
import { existsSync } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Supplier, SupplierEvidence } from "@hogee/core";
import { z } from "zod";
import type { ApiLogger, SupplierFixture } from "../context";

/** A raw listing larger than this is not read (the scorer only scans the first 20,000 characters anyway). */
export const MAX_LISTING_BYTES = 256 * 1024;
/** Any other dataset file (supplier record, pack, spec, JSONL) larger than this is not read. */
export const MAX_DATASET_FILE_BYTES = 2 * 1024 * 1024;
const LISTING_CHARS = 20_000;

const SupplierFile = z.union([z.strictObject({ supplier: Supplier, evidence: z.array(SupplierEvidence).default([]) }), Supplier.transform((supplier) => ({ supplier, evidence: [] }))]);


/** Where P3's data lives: the repo root (rawTextRef is relative to it) and data/suppliers (where it must point). */
export interface DataRoots {
  readonly repo: string;
  readonly suppliers: string;
}

export const dataRoots = (dataDir: string): DataRoots => ({ repo: resolve(dataDir, ".."), suppliers: join(dataDir, "suppliers") });

const within = (root: string, p: string): boolean => p.startsWith(root + sep);
const errorCode = (error: unknown): string => (error instanceof Error && "code" in error ? String(error.code) : "read failed");

/**
 * The text of `path` if it is a regular file of at most `maxBytes` whose path and realpath stay under `root`; else
 * null, logged as `dataset_file_refused` with the reason (never the content). Never opens a device, FIFO or symlink out.
 */
export async function readContained(root: string, path: string, maxBytes: number, log: ApiLogger): Promise<string | null> {
  const refuse = (reason: string): null => {
    log.warn("dataset_file_refused", { reason, file: path.split(sep).slice(-2).join("/") });
    return null;
  };
  if (!within(resolve(root), resolve(path))) return refuse("outside its data root");
  try {
    const [real, realRoot] = await Promise.all([realpath(path), realpath(root)]);
    if (!within(realRoot, real)) return refuse("resolves outside its data root");
    const st = await lstat(real);
    if (!st.isFile()) return refuse("not a regular file");
    if (st.size > maxBytes) return refuse("too large");
    return await readFile(real, "utf8");
  } catch (error: unknown) {
    return refuse(errorCode(error));
  }
}

/** A contained JSON file (readContained), parsed; undefined when refused or not JSON. */
export async function readContainedJson(root: string, path: string, log: ApiLogger, maxBytes = MAX_DATASET_FILE_BYTES): Promise<unknown> {
  const text = await readContained(root, path, maxBytes, log);
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The listing text at `rel`, or null when it is outside data/suppliers, not a regular file, too large or unreadable. */
export async function readListingText(roots: DataRoots, rel: string, log: ApiLogger): Promise<string | null> {
  const refuse = (reason: string): null => {
    log.warn("listing_text_unreadable", { reason });
    return null;
  };
  if (rel.startsWith("/") || rel.includes("..")) return refuse("not a repo-relative path");
  const text = await readContained(roots.suppliers, resolve(roots.repo, rel), MAX_LISTING_BYTES, log);
  return text === null ? refuse("refused or unreadable") : text.slice(0, LISTING_CHARS);
}

/**
 * Every valid supplier file of `dir` (under data/suppliers; sorted by name) with its raw listing text (null when it
 * cannot be read). Supplier files are read contained like every dataset file; a refused one is skipped.
 */
export async function loadSupplierDir(dir: string, roots: DataRoots | undefined, log: ApiLogger): Promise<SupplierFixture[]> {
  if (!roots || !existsSync(dir)) return [];
  const out: SupplierFixture[] = [];
  for (const name of (await readdir(dir)).filter((n) => n.endsWith(".json")).sort()) {
    const parsed = SupplierFile.safeParse(await readContainedJson(roots.suppliers, join(dir, name), log));
    if (!parsed.success) {
      log.error("supplier_file_invalid", { file: name });
      continue;
    }
    const text = await readListingText(roots, parsed.data.supplier.listing.rawTextRef, log);
    out.push({ supplier: parsed.data.supplier, evidence: parsed.data.evidence, listingText: text });
  }
  return out;
}

/**
 * Caches a load's promise per key, but forgets a rejected one, and a result `keep` refuses (absent or partly unreadable
 * data), so the next call reads the files again: a transient EACCES/EMFILE or a file added later never sticks.
 */
export function cachedLoad<K, T>(load: (key: K) => Promise<T>, keep: (value: T) => boolean = () => true): (key: K) => Promise<T> {
  const cache = new Map<K, Promise<T>>();
  return (key) => {
    const hit = cache.get(key);
    if (hit) return hit;
    const forget = () => {
      if (cache.get(key) === p) cache.delete(key);
    };
    const p: Promise<T> = load(key).then(
      (value) => {
        if (!keep(value)) forget();
        return value;
      },
      (error: unknown) => {
        forget();
        throw error;
      },
    );
    cache.set(key, p);
    return p;
  };
}

/** Supplier fixtures worth caching: at least one, and every listing text read. */
export const completeFixtures = (fixtures: readonly SupplierFixture[]): boolean => fixtures.length > 0 && fixtures.every((f) => f.listingText !== null);
