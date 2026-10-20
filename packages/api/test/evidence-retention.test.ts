/**
 * Audit run-6 (v-2) file-system side of the export bounds (evidence/retention.ts): temp folders are tagged per
 * deployment and only our own (or stale ones) are swept; a pruned run folder is removed only when it is a real
 * directory with a run name, never through a symlink. The database side (interval, keep-K) is in
 * test/live/export-bounds.live.test.ts.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attemptedRecently, forgetAttempts, MIN_EXPORT_INTERVAL_S, noteAttempt, pruneRuns, removeRunFolder, STALE_TEMP_MS, sweep, tempName, tempTag } from "../src/evidence/retention";

let root: string;
let outside: string;
const ANVIL = { chainId: 31337, deploymentId: "final-1" };
const tag = tempTag(ANVIL);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hogee-retention-"));
  outside = mkdtempSync(join(tmpdir(), "hogee-retention-out-"));
  writeFileSync(join(outside, "keep.json"), "{}");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const folder = (name: string): string => {
  mkdirSync(join(root, name, "receipts"), { recursive: true });
  writeFileSync(join(root, name, "manifest.json"), "{}");
  return join(root, name);
};

describe("tempTag", () => {
  it("is fixed-length hex per chain and deployment, so no exporter's prefix is another's", () => {
    expect(tag).toMatch(/^[0-9a-f]{12}$/);
    expect(tempTag(ANVIL)).toBe(tag);
    expect(tempTag({ chainId: 31337, deploymentId: "final-10" })).not.toBe(tag);
    expect(tempTag({ chainId: 11_155_111, deploymentId: "final-1" })).not.toBe(tag);
    expect(tempName(tag, "ev-0123456789abcdef")).toMatch(new RegExp(`^\\.export-${tag}-ev-0123456789abcdef-[0-9a-f]{12}$`));
  });
});

describe("sweep", () => {
  it("removes our own temp folders and stale foreign ones; keeps a live foreign one, runs and link targets", async () => {
    const own = folder(tempName(tag, "ev-0000000000000001"));
    const foreign = folder(tempName(tempTag({ chainId: 11_155_111, deploymentId: "final-1" }), "ev-0000000000000002"));
    const staleForeign = folder(tempName(tempTag({ chainId: 1, deploymentId: "x" }), "ev-0000000000000003"));
    const old = new Date(Date.now() - STALE_TEMP_MS - 60_000);
    utimesSync(staleForeign, old, old);
    const run = folder("ev-00000000000000aa");
    symlinkSync(outside, join(root, `.export-${tag}-linked`));
    await sweep(root, tag);
    expect(existsSync(own)).toBe(false);
    expect(existsSync(staleForeign)).toBe(false);
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(run)).toBe(true);
    expect(existsSync(join(outside, "keep.json"))).toBe(true);
  });
});

describe("removeRunFolder", () => {
  it("removes a real run directory (nothing is left, not even the renamed temp folder)", async () => {
    folder("ev-00000000000000aa");
    expect(await removeRunFolder(root, "ev-00000000000000aa", tag)).toBe(true);
    expect(existsSync(join(root, "ev-00000000000000aa"))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it("never follows a symlinked run folder and never leaves the root", async () => {
    symlinkSync(outside, join(root, "ev-00000000000000bb"));
    expect(await removeRunFolder(root, "ev-00000000000000bb", tag)).toBe(false);
    expect(existsSync(join(outside, "keep.json"))).toBe(true);
    expect(existsSync(join(root, "ev-00000000000000bb"))).toBe(true);
    for (const name of ["../x", "ev-0000", ".export-x", "run-test-1", `ev-00000000000000aa/../..`]) expect(await removeRunFolder(root, name, tag)).toBe(false);
    expect(await removeRunFolder(root, "ev-00000000000000cc", tag)).toBe(false); // missing
    writeFileSync(join(root, "ev-00000000000000dd"), "not a folder");
    expect(await removeRunFolder(root, "ev-00000000000000dd", tag)).toBe(false);
    expect(existsSync(join(root, "ev-00000000000000dd"))).toBe(true);
  });
});

describe("the interval of collecting calls that claim no run (run-6 re-check L1)", () => {
  afterEach(() => forgetAttempts());

  it("holds a facility for MIN_EXPORT_INTERVAL_S after an idempotent or refused call, per facility", () => {
    const t0 = 1_000_000;
    expect(attemptedRecently("fac-a", t0)).toBe(false);
    noteAttempt("fac-a", t0);
    expect(attemptedRecently("fac-a", t0 + MIN_EXPORT_INTERVAL_S * 1000 - 1)).toBe(true);
    expect(attemptedRecently("fac-b", t0 + 1)).toBe(false);
    expect(attemptedRecently("fac-a", t0 + MIN_EXPORT_INTERVAL_S * 1000)).toBe(false);
  });

  it("drops entries once their interval is over", () => {
    noteAttempt("fac-a", 0);
    noteAttempt("fac-b", MIN_EXPORT_INTERVAL_S * 1000);
    expect(attemptedRecently("fac-a", MIN_EXPORT_INTERVAL_S * 1000)).toBe(false);
    expect(attemptedRecently("fac-b", MIN_EXPORT_INTERVAL_S * 1000)).toBe(true);
  });
});

describe("pruneRuns drops a row only once its folder is gone (run-6 re-check L8a)", () => {
  it("keeps the row of a folder it cannot read as ours, drops the row of a missing one", async () => {
    folder("ev-00000000000000aa"); // on disk but not readable as this tenant's bundle (e.g. an index over the cap)
    const deleted: string[] = [];
    const warned: string[] = [];
    const deps = {
      db: {
        $client: {
          query: async (sql: string, values: unknown[]) => {
            if (sql.startsWith("select")) return { rows: [{ id: "ev-00000000000000aa" }, { id: "ev-00000000000000bb" }] };
            deleted.push(values[1] as string);
            return { rows: [] };
          },
        },
      },
      log: { warn: (event: string) => warned.push(event), info: () => undefined, error: () => undefined },
    } as unknown as Parameters<typeof pruneRuns>[0];
    expect(await pruneRuns(deps, root, { facilityId: "fac-1", ...ANVIL })).toBe(0);
    expect(existsSync(join(root, "ev-00000000000000aa"))).toBe(true);
    expect(warned).toEqual(["evidence_prune_skipped"]);
    expect(deleted).toEqual(["ev-00000000000000bb"]);
  });
});
