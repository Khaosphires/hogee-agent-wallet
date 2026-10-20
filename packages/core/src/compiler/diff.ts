/**
 * Deterministic JSON diff between the baseline and the proposed manifest, as RFC 6901 JSON Pointers.
 * Objects are compared key by key (sorted), arrays index by index; a value missing on one side is `null`.
 * Only differing leaves are listed (a type change is listed at the node where it happens).
 */
import type { PlanDiffEntry } from "../schemas/plan";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** RFC 6901 escaping of one pointer segment (`~` → `~0`, `/` → `~1`). */
export function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

const isObject = (v: unknown): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);

function walk(a: Json | undefined, b: Json | undefined, path: string, out: PlanDiffEntry[]): void {
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i += 1) walk(a[i], b[i], `${path}/${i}`, out);
    return;
  }
  if (isObject(a) && isObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) walk(a[k], b[k], `${path}/${escapePointerSegment(k)}`, out);
    return;
  }
  if (a === b) return;
  if (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b)) return;
  out.push({ path, baseline: a ?? null, proposed: b ?? null });
}

/** Leaf differences baseline → proposed, excluding pointers that start with any of `ignore`. */
export function jsonDiff(baseline: unknown, proposed: unknown, ignore: readonly string[] = []): PlanDiffEntry[] {
  const out: PlanDiffEntry[] = [];
  walk(baseline as Json, proposed as Json, "", out);
  return out.filter((d) => !ignore.some((p) => d.path === p || d.path.startsWith(`${p}/`)));
}
