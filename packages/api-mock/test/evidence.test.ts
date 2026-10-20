/**
 * api-mock evidence reading (P1 reviews of #5 point 10 and #6 LOW 6): links are never followed, special files never
 * block, unreadable folders are skipped, depth and size are capped, and every evidence response is inert.
 * Run: pnpm --filter @hogee/api-mock test
 */
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, truncateSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MEI_IDS, RINA_IDS, exampleBundleManifest, exampleEvidenceBundle } from "@hogee/core";
import { readEnv, type MockEnv } from "../src/env";
import { MAX_FILE_BYTES, MAX_INDEX_FILE_BYTES, MAX_LISTED_RUNS, SAMPLE_RUN_PREFIX, evidenceBundle, evidenceFile, evidenceRuns } from "../src/evidence";

const { app } = await import("../src/index");

/** File symlinks need admin rights on Windows (unless Developer Mode is on); folder junctions never do. */
function canSymlinkFiles(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "hogee-symlink-probe-"));
  try {
    writeFileSync(join(dir, "target"), "");
    symlinkSync(join(dir, "target"), join(dir, "link"), "file");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("evidence files and links (P1 review of #5, point 10)", () => {
  // The fixture sample is served under the reserved sample id (audit run-10 v-2), never its manifest's bare runId.
  const runId = `${SAMPLE_RUN_PREFIX}${exampleBundleManifest.runId}`;
  let tmp = "";
  let runDir = "";
  let env: MockEnv;

  // fixtures/evidence-sample/ with a junction back to itself ("loop") and one to a folder outside it ("elsewhere").
  // Junctions behave as symlinks here and need no admin rights on Windows ("junction" is ignored elsewhere).
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "hogee-evidence-"));
    runDir = join(tmp, "fixtures", "evidence-sample");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "manifest.json"), JSON.stringify(exampleBundleManifest));
    writeFileSync(join(runDir, "evidence.json"), JSON.stringify(exampleEvidenceBundle.rows));
    writeFileSync(join(runDir, "notes.md"), "# notes");
    mkdirSync(join(tmp, "outside"));
    writeFileSync(join(tmp, "outside", "secret.txt"), "not part of the bundle");
    symlinkSync(runDir, join(runDir, "loop"), "junction");
    symlinkSync(join(tmp, "outside"), join(runDir, "elsewhere"), "junction");
    env = { ...readEnv(), repoRoot: tmp, fixturesDir: join(tmp, "fixtures"), replayRunId: undefined };
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("lists regular files only: a linked folder neither loops nor leaks", () => {
    expect(evidenceBundle(env, runId)?.files).toEqual(["evidence.json", "manifest.json", "notes.md"]);
  });

  it("serves a bundle file, never one reached through a linked folder", async () => {
    expect(await evidenceFile(env, runId, "notes.md")?.text()).toBe("# notes");
    expect(evidenceFile(env, runId, "elsewhere/secret.txt")).toBeUndefined();
    expect(evidenceFile(env, runId, "loop/notes.md")).toBeUndefined();
    expect(evidenceFile(env, runId, "loop")).toBeUndefined();
  });

  /** evidence/<name>/ with the given manifest.json text and the sample's rows. */
  function evidenceRun(name: string, manifest: string): string {
    const dir = join(tmp, "evidence", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), manifest);
    writeFileSync(join(dir, "evidence.json"), JSON.stringify(exampleEvidenceBundle.rows));
    return dir;
  }
  const runDirs = () => evidenceRuns(env).map((r) => r.dir);

  it("leaves out a bundle whose manifest is not JSON instead of failing every evidence route", () => {
    const bad = evidenceRun("not-json", "this is not json");
    expect(() => evidenceRuns(env)).not.toThrow();
    expect(runDirs()).not.toContain(bad);
    expect(evidenceBundle(env, runId)?.files).toContain("notes.md");
  });

  it("skips a run folder that is a junction and a manifest that is a hard link", () => {
    const linked = join(tmp, "evidence", "linked-run");
    symlinkSync(runDir, linked, "junction");
    const outsideManifest = join(tmp, "outside", "manifest.json");
    writeFileSync(outsideManifest, JSON.stringify({ ...exampleBundleManifest, runId: "outside-run" }));
    const hard = evidenceRun("hard-manifest", "{}");
    rmSync(join(hard, "manifest.json"));
    linkSync(outsideManifest, join(hard, "manifest.json"));
    expect(runDirs()).not.toContain(linked);
    expect(runDirs()).not.toContain(hard);
    expect(evidenceRuns(env).some((r) => r.summary.runId === "outside-run")).toBe(false);
  });

  it("neither lists nor serves a hard link to a file outside the bundle", () => {
    const hard = join(runDir, "hard.txt");
    linkSync(join(tmp, "outside", "secret.txt"), hard);
    try {
      expect(evidenceBundle(env, runId)?.files).not.toContain("hard.txt");
      expect(evidenceFile(env, runId, "hard.txt")).toBeUndefined();
    } finally {
      unlinkSync(hard);
    }
  });

  // Skipped on Windows, which has no mkfifo. Without O_NONBLOCK the open would block Node's main thread, where no
  // vitest timeout can fire. So a child process opens the pipe for writing after UNBLOCK_MS (no O_CREAT: it never
  // makes a file), which ends such a blocked open, and the elapsed time fails the test instead of hanging it.
  it.skipIf(process.platform === "win32")("neither lists nor serves a named pipe, and doesn't block on it", () => {
    const UNBLOCK_MS = 2_000;
    const unblock = "setTimeout(() => { const fs = require('node:fs'); try { fs.closeSync(fs.openSync(process.argv[1], fs.constants.O_WRONLY)); } catch {} }, Number(process.argv[2]));";
    const pipe = join(runDir, "pipe.txt");
    execFileSync("mkfifo", [pipe]);
    const unblocker = spawn(process.execPath, ["-e", unblock, pipe, String(UNBLOCK_MS)], { stdio: "ignore" });
    try {
      const started = Date.now();
      expect(evidenceBundle(env, runId)?.files).not.toContain("pipe.txt");
      expect(evidenceFile(env, runId, "pipe.txt")).toBeUndefined();
      expect(Date.now() - started, "opening the pipe blocked until the writer came").toBeLessThan(UNBLOCK_MS / 2);
    } finally {
      unblocker.kill("SIGKILL");
      unlinkSync(pipe);
    }
  });

  // Skipped on Windows (no POSIX modes) and as root (which reads a mode-000 folder anyway).
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("skips an unreadable subfolder instead of failing the bundle (#6 LOW 6)", () => {
    const locked = join(runDir, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "inside.txt"), "x");
    chmodSync(locked, 0o000);
    try {
      expect(() => evidenceBundle(env, runId)).not.toThrow();
      expect(evidenceBundle(env, runId)?.files).toEqual(["evidence.json", "manifest.json", "notes.md"]);
      expect(evidenceFile(env, runId, "locked/inside.txt")).toBeUndefined();
    } finally {
      chmodSync(locked, 0o755);
      rmSync(locked, { recursive: true, force: true });
    }
  });

  it("lists files at most two folders down (#6 LOW 6)", () => {
    const deep = join(runDir, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(runDir, "a", "b", "two.txt"), "2");
    writeFileSync(join(deep, "three.txt"), "3");
    try {
      const files = evidenceBundle(env, runId)?.files ?? [];
      expect(files).toContain("a/b/two.txt");
      expect(files).not.toContain("a/b/c/three.txt");
    } finally {
      rmSync(join(runDir, "a"), { recursive: true, force: true });
    }
  });

  it("serves a file only up to the size cap, and a bundle only with index files under theirs (#6 LOW 6)", async () => {
    // Sparse files: the size is what counts, nothing is written to disk.
    const big = join(runDir, "big.bin");
    writeFileSync(big, "");
    truncateSync(big, MAX_FILE_BYTES + 1);
    try {
      expect(evidenceFile(env, runId, "big.bin")).toBeUndefined();
      truncateSync(big, MAX_FILE_BYTES);
      const res = evidenceFile(env, runId, "big.bin");
      expect(res?.headers.get("content-type")).toBe("application/octet-stream");
      await res?.body?.cancel();
    } finally {
      unlinkSync(big);
    }
    const huge = evidenceRun("huge-manifest", JSON.stringify(exampleBundleManifest));
    truncateSync(join(huge, "manifest.json"), MAX_INDEX_FILE_BYTES + 1);
    expect(runDirs()).not.toContain(huge);
  });

  it("serves bundle files inert: nosniff, a sandboxing CSP, no-store (#6 LOW 6)", () => {
    const headers = evidenceFile(env, runId, "notes.md")?.headers;
    expect(headers?.get("x-content-type-options")).toBe("nosniff");
    expect(headers?.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(headers?.get("cache-control")).toBe("no-store");
  });

  // Skipped on Windows without admin rights or Developer Mode: creating a file symlink fails with EPERM there.
  it.skipIf(!canSymlinkFiles())("skips a bundle whose manifest is a symlink", () => {
    const dir = evidenceRun("linked-manifest", "{}");
    rmSync(join(dir, "manifest.json"));
    symlinkSync(join(runDir, "manifest.json"), join(dir, "manifest.json"), "file");
    expect(runDirs()).not.toContain(dir);
  });

  // Skipped on Windows without admin rights or Developer Mode: creating a file symlink fails with EPERM there.
  it.skipIf(!canSymlinkFiles())("neither lists nor serves a file symlink", () => {
    const link = join(runDir, "secret.txt");
    symlinkSync(join(tmp, "outside", "secret.txt"), link, "file");
    try {
      expect(evidenceBundle(env, runId)?.files).not.toContain("secret.txt");
      expect(evidenceFile(env, runId, "secret.txt")).toBeUndefined();
    } finally {
      unlinkSync(link);
    }
  });
});

// Audit run-8 (h-mock): the evidence/ listing is per tenant, capped and looked up by folder name, as live store.ts.
describe("evidence/ bundles: tenant, run id, cap (audit run-8)", () => {
  let tmp = "";
  let env: MockEnv;
  const root = () => join(tmp, "evidence");

  interface BundleOpts {
    readonly facilityId?: string;
    readonly deploymentId?: string;
    readonly chainId?: number;
    readonly runId?: string;
    readonly manifestDeployment?: string;
    readonly exportedAt?: string;
  }

  /** evidence/<name>/ holding a bundle: by default Mei's, on final-1 / Sepolia, under its own folder name. */
  function bundle(name: string, o: BundleOpts = {}): string {
    const dir = join(root(), name);
    mkdirSync(dir, { recursive: true });
    const runId = o.runId ?? name;
    const deploymentId = o.deploymentId ?? MEI_IDS.deploymentId;
    const chainId = o.chainId ?? MEI_IDS.chainId;
    const deployment = Object.values(exampleBundleManifest.deployments)[0];
    const manifest = { ...exampleBundleManifest, runId, deployments: { [o.manifestDeployment ?? deploymentId]: { ...deployment, chainId } } };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(dir, "evidence.json"), JSON.stringify(exampleEvidenceBundle.rows));
    const contracts = { format: "hogee-evidence/1", runId, facilityId: o.facilityId ?? MEI_IDS.facilityId, exportedAt: o.exportedAt ?? "2026-10-18T10:00:00Z", deploymentId, chainId };
    writeFileSync(join(dir, "contracts.json"), JSON.stringify(contracts));
    writeFileSync(join(dir, "notes.md"), `# ${name}`);
    return dir;
  }
  const listed = (e: MockEnv = env) => evidenceRuns(e).map((r) => r.summary.runId);

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "hogee-evidence-tenant-"));
    mkdirSync(join(tmp, "fixtures"), { recursive: true });
    env = { ...readEnv(), country: "SG", repoRoot: tmp, fixturesDir: join(tmp, "fixtures"), replayRunId: undefined };
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("lists and serves the demo's own bundles (any deployment of its facility on its chain), and nobody else's", async () => {
    bundle("ev-mei-1");
    // ux3-officer (P1, 19 Oct): the demo facility's later deployment on the same chain is its own too (the final-2 export).
    bundle("ev-mei-final2", { deploymentId: "final-2", exportedAt: "2026-10-18T09:00:00Z" });
    bundle("ev-rina-1", { facilityId: RINA_IDS.facilityId });
    bundle("ev-mei-anvil", { deploymentId: "anvil-7", chainId: 31337 });
    bundle("ev-mei-chain", { chainId: 31337 });
    bundle("ev-mei-nocontracts");
    rmSync(join(root(), "ev-mei-nocontracts", "contracts.json"));
    expect(listed()).toEqual(["ev-mei-1", "ev-mei-final2"]);
    expect(evidenceBundle(env, "ev-mei-final2")?.manifest.runId).toBe("ev-mei-final2");
    rmSync(join(root(), "ev-mei-final2"), { recursive: true, force: true });
    expect(evidenceRuns(env)[0]?.summary.createdAt).toBe("2026-10-18T10:00:00Z");
    expect(evidenceBundle(env, "ev-mei-1")?.files).toEqual(["contracts.json", "evidence.json", "manifest.json", "notes.md"]);
    expect(await evidenceFile(env, "ev-mei-1", "notes.md")?.text()).toBe("# ev-mei-1");
    for (const other of ["ev-rina-1", "ev-mei-anvil", "ev-mei-chain", "ev-mei-nocontracts"]) {
      expect(evidenceBundle(env, other), other).toBeUndefined();
      expect(evidenceFile(env, other, "notes.md"), other).toBeUndefined();
    }
    // HOGEE_COUNTRY=MY serves Rina's bundle and not Mei's.
    expect(listed({ ...env, country: "MY" })).toEqual(["ev-rina-1"]);
  });

  it("lists exported runs before the fixture sample, however new the sample's files are", () => {
    const sampleDir = join(tmp, "fixtures", "evidence-sample");
    mkdirSync(sampleDir, { recursive: true });
    writeFileSync(join(sampleDir, "manifest.json"), JSON.stringify({ ...exampleBundleManifest, runId: "mock-sample-1" }));
    writeFileSync(join(sampleDir, "evidence.json"), JSON.stringify(exampleEvidenceBundle.rows));
    try {
      const ids = listed();
      expect(ids.at(-1)).toBe(`${SAMPLE_RUN_PREFIX}mock-sample-1`);
      expect(ids[0]).toBe("ev-mei-1");
    } finally {
      rmSync(sampleDir, { recursive: true, force: true });
    }
  });

  it("needs the folder name, the manifest's runId and contracts.json's runId to agree, and never reads a dot folder", () => {
    bundle("ev-renamed", { runId: "ev-other-name" });
    bundle(".export-ev-tmp", { runId: ".export-ev-tmp" });
    bundle("ev-manifest-elsewhere", { manifestDeployment: "final-2" });
    const ids = listed();
    expect(ids).not.toContain("ev-renamed");
    expect(ids).not.toContain("ev-other-name");
    expect(ids).not.toContain(".export-ev-tmp");
    expect(ids).not.toContain("ev-manifest-elsewhere");
    expect(evidenceBundle(env, "ev-other-name")).toBeUndefined();
    expect(evidenceBundle(env, ".export-ev-tmp")).toBeUndefined();
  });

  it("REPLAY serves its run on any deployment of the demo's facility, never another facility's", () => {
    bundle("ev-replay-anvil", { deploymentId: "anvil-9", chainId: 31337 });
    bundle("ev-replay-rina", { facilityId: RINA_IDS.facilityId, deploymentId: "anvil-9", chainId: 31337 });
    const replay = (runId: string): MockEnv => ({ ...env, replayRunId: runId });
    expect(listed(replay("ev-replay-anvil"))).toEqual(["ev-replay-anvil"]);
    expect(evidenceBundle(replay("ev-replay-anvil"), "ev-replay-anvil")?.manifest.runId).toBe("ev-replay-anvil");
    expect(evidenceBundle(replay("ev-replay-anvil"), "ev-mei-1"), "only the replayed run").toBeUndefined();
    expect(listed(replay("ev-replay-rina"))).toEqual([]);
    expect(evidenceBundle(replay("ev-replay-rina"), "ev-replay-rina")).toBeUndefined();
  });

  it(`lists the ${MAX_LISTED_RUNS} newest run folders by mtime; an older one is still served when asked for by id`, () => {
    rmSync(root(), { recursive: true, force: true });
    const extra = 5;
    const base = Date.now() / 1000 - 100_000;
    for (let i = 0; i < MAX_LISTED_RUNS + extra; i += 1) {
      const name = `ev-cap-${String(i).padStart(3, "0")}`;
      const dir = bundle(name, { exportedAt: `2026-10-18T${String(Math.floor(i / 60) % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z` });
      utimesSync(dir, base + i, base + i);
    }
    const ids = listed();
    expect(ids).toHaveLength(MAX_LISTED_RUNS);
    expect(ids).not.toContain("ev-cap-000");
    expect(ids).not.toContain(`ev-cap-${String(extra - 1).padStart(3, "0")}`);
    expect(ids).toContain(`ev-cap-${String(extra).padStart(3, "0")}`);
    expect(evidenceBundle(env, "ev-cap-000")?.manifest.runId).toBe("ev-cap-000");
  });
});

// Audit run-10 v-2: the Proof page calls a pack a sample from its id alone (web proof-model isSampleRun), so only the
// fixture sample and the core example may carry the reserved prefix, and no evidence/ folder (an exported pack) ever can.
describe("the sample's reserved run id (audit run-10 v-2)", () => {
  let tmp = "";
  let env: MockEnv;
  const root = () => join(tmp, "evidence");
  const sampleDir = () => join(tmp, "fixtures", "evidence-sample");
  const listed = (e: MockEnv = env) => evidenceRuns(e).map((r) => r.summary.runId);

  /** evidence/<name>/ holding Mei's bundle on final-1 / Sepolia under that same run id. */
  function exported(name: string): void {
    const dir = join(root(), name);
    mkdirSync(dir, { recursive: true });
    const deployment = Object.values(exampleBundleManifest.deployments)[0];
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...exampleBundleManifest, runId: name, deployments: { [MEI_IDS.deploymentId]: { ...deployment, chainId: MEI_IDS.chainId } } }));
    writeFileSync(join(dir, "evidence.json"), JSON.stringify(exampleEvidenceBundle.rows));
    writeFileSync(join(dir, "contracts.json"), JSON.stringify({ runId: name, facilityId: MEI_IDS.facilityId, exportedAt: "2026-10-18T10:00:00Z", deploymentId: MEI_IDS.deploymentId, chainId: MEI_IDS.chainId }));
    writeFileSync(join(dir, "notes.md"), `# exported ${name}`);
  }

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "hogee-evidence-sample-id-"));
    mkdirSync(sampleDir(), { recursive: true });
    env = { ...readEnv(), country: "SG", repoRoot: tmp, fixturesDir: join(tmp, "fixtures"), replayRunId: undefined };
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reserves the same prefix the Proof page reads (web proof-model.ts SAMPLE_RUN_PREFIX)", () => {
    expect(SAMPLE_RUN_PREFIX).toBe("sample:");
  });

  it("serves the core example only under the reserved id when nothing else is listed", () => {
    const id = `${SAMPLE_RUN_PREFIX}${exampleBundleManifest.runId}`;
    expect(listed()).toEqual([id]);
    expect(evidenceBundle(env, id)?.rows).toEqual(exampleEvidenceBundle.rows);
    expect(evidenceBundle(env, exampleBundleManifest.runId)).toBeUndefined();
  });

  it("lists and serves the fixture sample under the reserved id, never under its manifest's bare runId", async () => {
    writeFileSync(join(sampleDir(), "manifest.json"), JSON.stringify({ ...exampleBundleManifest, runId: "mock-sample-1" }));
    writeFileSync(join(sampleDir(), "evidence.json"), JSON.stringify(exampleEvidenceBundle.rows));
    writeFileSync(join(sampleDir(), "notes.md"), "# the fixture sample");
    const id = `${SAMPLE_RUN_PREFIX}mock-sample-1`;
    expect(listed()).toEqual([id]);
    expect(evidenceBundle(env, id)?.manifest.runId).toBe("mock-sample-1");
    expect(await evidenceFile(env, id, "notes.md")?.text()).toBe("# the fixture sample");
    expect(evidenceBundle(env, "mock-sample-1")).toBeUndefined();
    expect(evidenceFile(env, "mock-sample-1", "notes.md")).toBeUndefined();
  });

  it("an exported pack under the sample's bare id stays an exported pack, and never takes the sample's id", async () => {
    exported("mock-sample-1");
    try {
      expect(listed()).toEqual(["mock-sample-1", `${SAMPLE_RUN_PREFIX}mock-sample-1`]);
      expect(await evidenceFile(env, "mock-sample-1", "notes.md")?.text()).toBe("# exported mock-sample-1");
      expect(await evidenceFile(env, `${SAMPLE_RUN_PREFIX}mock-sample-1`, "notes.md")?.text()).toBe("# the fixture sample");
    } finally {
      rmSync(join(root(), "mock-sample-1"), { recursive: true, force: true });
    }
  });

  // Skipped on Windows, where a folder name can't hold ":" anyway.
  it.skipIf(process.platform === "win32")("never lists or serves an evidence/ folder that carries the reserved prefix, in REPLAY either", () => {
    const name = `${SAMPLE_RUN_PREFIX}mock-sample-1`;
    const own = `${SAMPLE_RUN_PREFIX}ev-own`;
    exported(name);
    exported(own);
    try {
      expect(listed()).toEqual([name]);
      expect(evidenceRuns(env).find((r) => r.summary.runId === name)?.dir).toBe(sampleDir());
      expect(evidenceBundle(env, own)).toBeUndefined();
      expect(evidenceFile(env, own, "notes.md")).toBeUndefined();
      const replay: MockEnv = { ...env, replayRunId: own };
      expect(listed(replay)).toEqual([]);
      expect(evidenceBundle(replay, own)).toBeUndefined();
      expect(evidenceFile(replay, own, "notes.md")).toBeUndefined();
    } finally {
      rmSync(root(), { recursive: true, force: true });
    }
  });
});

// Audit run-8 (h-mock): a served file is read asynchronously into the body, never with a blocking read.
describe("evidence file bodies (audit run-8)", () => {
  let tmp = "";
  let env: MockEnv;
  const runId = `${SAMPLE_RUN_PREFIX}${exampleBundleManifest.runId}`;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "hogee-evidence-body-"));
    const dir = join(tmp, "fixtures", "evidence-sample");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(exampleBundleManifest));
    writeFileSync(join(dir, "evidence.json"), JSON.stringify(exampleEvidenceBundle.rows));
    env = { ...readEnv(), repoRoot: tmp, fixturesDir: join(tmp, "fixtures"), replayRunId: undefined };
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("streams a multi-chunk file byte for byte", async () => {
    const data = Buffer.alloc(2 * 1024 * 1024 + 12_345);
    for (let i = 0; i < data.length; i += 1) data[i] = (i * 31) % 251;
    writeFileSync(join(tmp, "fixtures", "evidence-sample", "trace.bin"), data);
    const res = evidenceFile(env, runId, "trace.bin");
    expect(Buffer.from(await (res as Response).arrayBuffer()).equals(data)).toBe(true);
  });

  // /dev/fd lists this process's open descriptors on macOS and Linux.
  it.skipIf(process.platform === "win32")("closes the file when the read ends, even if nobody reads the body", async () => {
    writeFileSync(join(tmp, "fixtures", "evidence-sample", "unread.md"), "x".repeat(300_000));
    const openFds = () => readdirSync("/dev/fd").length;
    const before = openFds();
    const unread = Array.from({ length: 20 }, () => evidenceFile(env, runId, "unread.md"));
    expect(unread.every((r) => r instanceof Response)).toBe(true);
    await vi.waitFor(() => expect(openFds()).toBeLessThanOrEqual(before), { timeout: 5_000 });
  });
});

describe("evidence routes over HTTP (#6 LOW 6)", () => {
  it("every evidence response, errors included, carries X-Content-Type-Options: nosniff", async () => {
    const runs = await app.request("/api/evidence/runs");
    expect(runs.status).toBe(200);
    expect(runs.headers.get("x-content-type-options")).toBe("nosniff");
    const runId = ((await runs.json()) as { runId: string }[])[0]?.runId ?? "none";
    const bundle = await app.request(`/api/evidence/${runId}`);
    expect(bundle.headers.get("x-content-type-options")).toBe("nosniff");
    const missing = await app.request("/api/evidence/no-such-run/files/manifest.json");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("serves the repo's fixture sample under its reserved id, encoded as the client sends it (audit run-10 v-2)", async () => {
    const ids = ((await (await app.request("/api/evidence/runs")).json()) as { runId: string }[]).map((r) => r.runId);
    const sample = `${SAMPLE_RUN_PREFIX}mock-rina-evidence-3`;
    expect(ids.at(-1)).toBe(sample);
    expect(ids.filter((id) => id.startsWith(SAMPLE_RUN_PREFIX))).toEqual([sample]);
    const bundle = await app.request(`/api/evidence/${encodeURIComponent(sample)}`);
    expect(bundle.status).toBe(200);
    expect(((await bundle.json()) as { manifest: { runId: string } }).manifest.runId).toBe("mock-rina-evidence-3");
    const file = await app.request(`/api/evidence/${encodeURIComponent(sample)}/files/manifest.json`);
    expect(file.status).toBe(200);
    expect(((await file.json()) as { runId: string }).runId).toBe("mock-rina-evidence-3");
  });
});
