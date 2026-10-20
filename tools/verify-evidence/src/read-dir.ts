/**
 * Node-only: reads a bundle directory into BundleFiles for the CLI. Links are never followed: every entry must be a
 * regular single-link file (or a real directory) whose opened inode is the one its path names (O_NOFOLLOW + fstat),
 * so a planted symlink, hard link, FIFO or device can neither leak a file into the bundle nor block the read.
 * Entry and size caps (a bundle's by default, a FISCO pack's from its CLI) apply before a file is read.
 * Refused entries are reported (the CLI fails on any).
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { MAX_BUNDLE_FILES, MAX_FILE_BYTES, type BundleFiles } from "./load";

export interface ReadBundle {
  readonly files: BundleFiles;
  readonly refused: readonly string[];
}

/** Limits applied while walking, before any file is read: entries (files + refused) and bytes per relative path. */
export interface ReadCaps {
  readonly maxEntries: number;
  readonly maxBytes: (rel: string) => number;
}

/** An evidence bundle's caps (load.ts); the FISCO pack CLI passes its own, smaller ones. */
export const BUNDLE_CAPS: ReadCaps = { maxEntries: MAX_BUNDLE_FILES, maxBytes: () => MAX_FILE_BYTES };

function readRegular(full: string, max: number): Uint8Array | string {
  const named = lstatSync(full);
  if (!named.isFile()) return "not a regular file";
  if (named.nlink !== 1) return "a hard link";
  if (named.size > max) return "too large";
  const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino || opened.size > max) return "changed while reading";
    return new Uint8Array(readFileSync(fd));
  } finally {
    closeSync(fd);
  }
}

export function readBundleDir(dir: string, caps: ReadCaps = BUNDLE_CAPS): ReadBundle {
  const root = realpathSync(resolve(dir));
  if (!statSync(root).isDirectory()) throw new Error(`${dir} is not a directory`);
  const files: Record<string, Uint8Array> = {};
  const refused: string[] = [];
  const walk = (d: string, depth: number) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      const rel = relative(root, full).split(sep).join("/");
      if (Object.keys(files).length + refused.length >= caps.maxEntries) {
        refused.push(`${rel}: more than ${caps.maxEntries} entries`);
        return;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink() && depth < 2) {
        walk(full, depth + 1);
        continue;
      }
      try {
        const got = readRegular(full, caps.maxBytes(rel));
        if (typeof got === "string") refused.push(`${rel}: ${got}`);
        else files[rel] = got;
      } catch (error: unknown) {
        refused.push(`${rel}: ${error instanceof Error && "code" in error ? String(error.code) : "unreadable"}`);
      }
    }
  };
  walk(root, 0);
  return { files, refused };
}
