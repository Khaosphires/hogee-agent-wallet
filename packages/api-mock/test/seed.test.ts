/**
 * Seed files (audit run-8, h-mock): fixtures and REPLAY scenario snapshots are read as evidence files are, never
 * through a link, a hard link or a special file, and only up to a size cap; anything else there throws rather than
 * seed the store from elsewhere or fall back to the examples silently.
 * Run: pnpm --filter @hogee/api-mock test
 */
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findRepoRoot } from "../src/env";
import { PROFILES } from "../src/profile";
import { MAX_FIXTURE_BYTES, loadScenario, scenarioDir, type ScenarioPaths } from "../src/seed";

const REAL_BALANCES = join(findRepoRoot(), "fixtures", "scenario-rina", "balances.json");

describe("seed file reads (audit run-8)", () => {
  let tmp = "";
  let paths: ScenarioPaths;
  const rina = () => join(tmp, "fixtures", "scenario-rina");

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "hogee-seed-"));
    mkdirSync(rina(), { recursive: true });
    mkdirSync(join(tmp, "outside"));
    copyFileSync(REAL_BALANCES, join(tmp, "outside", "balances.json"));
    paths = { repoRoot: tmp, fixturesDir: join(tmp, "fixtures"), replayRunId: undefined };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("loads a plain fixture file, and falls back to the example when none is there", () => {
    expect(loadScenario(paths, "MY").sources["balances.json"]).toBe("example");
    copyFileSync(REAL_BALANCES, join(rina(), "balances.json"));
    expect(loadScenario(paths, "MY").sources["balances.json"]).toBe("fixture");
  });

  it("refuses a fixture that is a hard link (it could alias any file on the volume)", () => {
    linkSync(join(tmp, "outside", "balances.json"), join(rina(), "balances.json"));
    expect(() => loadScenario(paths, "MY")).toThrow(/balances\.json is not a regular, single-link file/);
  });

  it.skipIf(process.platform === "win32")("refuses a fixture that is a symlink, a dangling one included", () => {
    symlinkSync(join(tmp, "outside", "balances.json"), join(rina(), "balances.json"));
    expect(() => loadScenario(paths, "MY")).toThrow(/links are never followed/);
    rmSync(join(rina(), "balances.json"));
    symlinkSync(join(tmp, "outside", "missing.json"), join(rina(), "balances.json"));
    expect(() => loadScenario(paths, "MY")).toThrow(/links are never followed/);
  });

  it("refuses a fixture over the size cap, and one that is not JSON", () => {
    const big = join(rina(), "balances.json");
    writeFileSync(big, "");
    truncateSync(big, MAX_FIXTURE_BYTES + 1);
    expect(() => loadScenario(paths, "MY")).toThrow(/at most/);
    writeFileSync(big, "not json");
    expect(() => loadScenario(paths, "MY")).toThrow(/is not JSON/);
  });

  it("seeds REPLAY from a plain scenario/ snapshot, and refuses one reached through a link", () => {
    const run = join(tmp, "evidence", "ev-replay-1");
    mkdirSync(join(run, "scenario"), { recursive: true });
    copyFileSync(REAL_BALANCES, join(run, "scenario", "balances.json"));
    const replay = { ...paths, replayRunId: "ev-replay-1" };
    expect(scenarioDir(replay, PROFILES.MY)).toBe(join(run, "scenario"));
    expect(loadScenario(replay, "MY").sources["balances.json"]).toBe("fixture");
    // No snapshot: the fixtures, as before.
    expect(scenarioDir({ ...paths, replayRunId: "ev-no-run" }, PROFILES.MY)).toBe(rina());
    // A run folder or a snapshot folder that is a link (a junction needs no admin rights on Windows).
    symlinkSync(run, join(tmp, "evidence", "ev-linked-run"), "junction");
    expect(() => scenarioDir({ ...paths, replayRunId: "ev-linked-run" }, PROFILES.MY)).toThrow(/not a plain folder/);
    const run2 = join(tmp, "evidence", "ev-replay-2");
    mkdirSync(run2);
    symlinkSync(join(run, "scenario"), join(run2, "scenario"), "junction");
    expect(() => scenarioDir({ ...paths, replayRunId: "ev-replay-2" }, PROFILES.MY)).toThrow(/not a plain folder/);
  });
});
