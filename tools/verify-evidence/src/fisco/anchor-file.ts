/**
 * Node-only: finds and reads a pack's Sepolia anchor sidecar for the CLI. The default place is next to the pack:
 * <pack>/../anchors/<packId>.sepolia.json (evidence/fisco/anchors/). No link is followed: the anchors folder and the
 * file must be real (lstat), the file a single-link regular file of at most MAX_ANCHOR_BYTES, opened O_NOFOLLOW and
 * checked to be the inode its path named. A missing folder or file is "not anchored"; anything else odd is refused.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ANCHORS_DIR, anchorFileOf, MAX_ANCHOR_BYTES } from "./anchor";

export type AnchorRead =
  | { readonly kind: "missing"; readonly path: string }
  | { readonly kind: "bytes"; readonly path: string; readonly bytes: Uint8Array }
  | { readonly kind: "refused"; readonly path: string; readonly reason: string };

/** <packDir>/../anchors/<packId>.sepolia.json */
export const anchorPathOf = (packDir: string, packId: string): string => join(dirname(resolve(packDir)), ANCHORS_DIR, anchorFileOf(packId));

const lstatOrNull = (path: string): Stats | null => {
  try {
    return lstatSync(path);
  } catch (error: unknown) {
    if ((error as { code?: unknown }).code === "ENOENT") return null;
    throw error;
  }
};

/** Reads the sidecar at `path` without following links. */
export function readAnchorFile(path: string): AnchorRead {
  try {
    const folder = lstatOrNull(dirname(path));
    if (folder === null) return { kind: "missing", path };
    if (!folder.isDirectory()) return { kind: "refused", path, reason: `${ANCHORS_DIR}/ is not a real folder (a link?)` };
    const named = lstatOrNull(path);
    if (named === null) return { kind: "missing", path };
    if (!named.isFile()) return { kind: "refused", path, reason: "the sidecar is not a regular file (a link?)" };
    if (named.nlink !== 1) return { kind: "refused", path, reason: "the sidecar is a hard link" };
    if (named.size > MAX_ANCHOR_BYTES) return { kind: "refused", path, reason: `the sidecar is larger than ${MAX_ANCHOR_BYTES} bytes` };
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino || opened.size > MAX_ANCHOR_BYTES) return { kind: "refused", path, reason: "the sidecar changed while reading" };
      return { kind: "bytes", path, bytes: new Uint8Array(readFileSync(fd)) };
    } finally {
      closeSync(fd);
    }
  } catch (error: unknown) {
    return { kind: "refused", path, reason: `the sidecar cannot be read (${(error as { code?: unknown }).code ?? (error instanceof Error ? error.name : "error")})` };
  }
}
