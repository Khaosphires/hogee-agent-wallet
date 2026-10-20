/**
 * Evidence bundle reads (evidence/store.ts) on a real bundle written to disk: only this tenant's runs (facility,
 * deployment and chain), listing opens at most MAX_LISTED_RUNS folders, and the file reader never follows a symlink or
 * hard link, never opens a FIFO, and never leaves the run folder.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getRun, listRuns, MAX_LISTED_RUNS, ownsRun, readFileResponse, readInside, type Tenant } from "../src/evidence/store";
import { buildFixture, CHAIN_ID, DEPLOYMENT_ID } from "../../../tools/verify-evidence/test/fixture";

let root: string;
let dir: string;
const RUN = "run-test-1";
const TEST: Tenant = { facilityId: "fac-test", deploymentId: DEPLOYMENT_ID, chainId: CHAIN_ID };
const OTHER: Tenant = { ...TEST, facilityId: "fac-other" };

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "hogee-store-"));
  dir = join(root, RUN);
  const { files } = await buildFixture();
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("evidence store", () => {
  it("lists and opens a bundle for its own facility only", async () => {
    expect((await listRuns(root, TEST)).map((r) => r.runId)).toEqual([RUN]);
    expect(await listRuns(root, OTHER)).toEqual([]);
    const bundle = await getRun(root, RUN, TEST);
    expect(bundle?.files).toContain("hashes.json");
    expect(bundle?.files.some((f) => f.startsWith("receipts/"))).toBe(true);
    expect(await getRun(root, RUN, OTHER)).toBeNull();
    expect(await readFileResponse(root, RUN, "manifest.json", OTHER)).toBeNull();
  });

  it("serves a bundle only to its own deployment and chain (one root shared by an Anvil and a Sepolia checkout)", async () => {
    for (const t of [{ ...TEST, deploymentId: "final-sepolia" }, { ...TEST, chainId: 11_155_111 }]) {
      expect(await listRuns(root, t)).toEqual([]);
      expect(await getRun(root, RUN, t)).toBeNull();
      expect(await readFileResponse(root, RUN, "manifest.json", t)).toBeNull();
      expect(await ownsRun(root, RUN, t)).toBe(false);
    }
    expect(await ownsRun(root, RUN, TEST)).toBe(true);
  });

  it("opens the index files of the newest MAX_LISTED_RUNS folders only (by folder mtime)", async () => {
    const crowded = mkdtempSync(join(tmpdir(), "hogee-store-many-"));
    try {
      cpSync(dir, join(crowded, RUN), { recursive: true });
      const old = new Date(Date.now() - 86_400_000);
      utimesSync(join(crowded, RUN), old, old);
      for (let i = 0; i < MAX_LISTED_RUNS; i += 1) mkdirSync(join(crowded, `run-empty-${i}`));
      // The real bundle is the oldest of MAX_LISTED_RUNS + 1 folders: it is never opened, so it is not listed.
      expect(await listRuns(crowded, TEST)).toEqual([]);
      const now = new Date(Date.now() + 60_000);
      utimesSync(join(crowded, RUN), now, now);
      expect((await listRuns(crowded, TEST)).map((r) => r.runId)).toEqual([RUN]);
    } finally {
      rmSync(crowded, { recursive: true, force: true });
    }
  });

  it("serves a file inert (nosniff, sandbox CSP) and refuses paths outside the run", async () => {
    const res = await readFileResponse(root, RUN, "manifest.json", TEST);
    expect(res?.headers.get("content-type")).toBe("application/json");
    expect(res?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res?.headers.get("content-security-policy")).toMatch(/sandbox/);
    expect(await readFileResponse(root, RUN, "../../etc/hosts", TEST)).toBeNull();
    expect(await readFileResponse(root, "../x", "manifest.json", TEST)).toBeNull();
    expect(await readFileResponse(root, ".export-x", "manifest.json", TEST)).toBeNull();
  });

  it("never follows a symlink or a hard link, and never opens a FIFO", async () => {
    const outside = join(mkdtempSync(join(tmpdir(), "hogee-out-")), "secret.json");
    writeFileSync(outside, "{}");
    symlinkSync(outside, join(dir, "sym.json"));
    linkSync(outside, join(dir, "hard.json"));
    execFileSync("mkfifo", [join(dir, "fifo.json")]);
    expect(await readInside(dir, "sym.json")).toBeNull();
    expect(await readInside(dir, "hard.json")).toBeNull();
    expect(await readInside(dir, "fifo.json")).toBeNull();
    const bundle = await getRun(root, RUN, TEST);
    expect(bundle?.files).not.toContain("sym.json");
    expect(bundle?.files).not.toContain("hard.json");
    expect(bundle?.files).not.toContain("fifo.json");
  });

  it("does not list a symlinked run folder", async () => {
    symlinkSync(dir, join(root, "run-linked"));
    expect((await listRuns(root, TEST)).map((r) => r.runId)).toEqual([RUN]);
    expect(await getRun(root, "run-linked", TEST)).toBeNull();
  });
});

describe("readInside reads at most the size it checked", () => {
  let scratch: string;
  beforeAll(() => {
    // readInside takes a real path (the stores pass realpath'd folders); macOS's tmpdir is behind a link.
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "hogee-read-inside-")));
  });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it("returns the exact bytes up to the cap, nothing over it, and an empty file as empty", async () => {
    writeFileSync(join(scratch, "at-cap.json"), "x".repeat(16));
    writeFileSync(join(scratch, "over-cap.json"), "x".repeat(17));
    writeFileSync(join(scratch, "empty.json"), "");
    expect((await readInside(scratch, "at-cap.json", 16))?.data.toString()).toBe("x".repeat(16));
    expect(await readInside(scratch, "over-cap.json", 16)).toBeNull();
    expect((await readInside(scratch, "empty.json", 16))?.data.length).toBe(0);
  });

  it("never reads a file whole (readFile), and refuses one that grows between the check and the read", async () => {
    const file = join(scratch, "grows.json");
    writeFileSync(file, "{}");
    const probe = await open(file);
    const proto = Object.getPrototypeOf(probe) as { read: (...args: unknown[]) => Promise<unknown>; readFile: (...args: unknown[]) => Promise<unknown> };
    await probe.close();
    const original = proto.read;
    const readFile = vi.spyOn(proto, "readFile");
    const read = vi.spyOn(proto, "read");
    try {
      expect((await readInside(scratch, "grows.json"))?.data.toString()).toBe("{}");
      expect(readFile).not.toHaveBeenCalled();
      read.mockImplementationOnce(function (this: unknown, ...args: unknown[]) {
        appendFileSync(file, "x".repeat(1024));
        return original.apply(this, args);
      });
      expect(await readInside(scratch, "grows.json")).toBeNull();
      expect(readFile).not.toHaveBeenCalled();
    } finally {
      readFile.mockRestore();
      read.mockRestore();
    }
  });
});
