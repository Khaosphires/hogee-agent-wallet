/**
 * The whole suite on a local Anvil + throwaway Postgres (TEST_RPC_URL, TEST_DATABASE_URL; skipped without them, as
 * every live test in the repo). Every case passes except the ones honestly written as not run, every row is the frozen
 * EvidenceRow shape, and every row that ran carries a tx hash or a trace id.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceRows } from "@hogee/core";
import { afterAll, describe, expect, it } from "vitest";
import { loadRunConfig } from "../src/config";
import { runSuite } from "../src/run";
import { CATALOGUE } from "../src/cases/catalogue";

const LIVE = Boolean(process.env.TEST_RPC_URL && process.env.TEST_DATABASE_URL);
/**
 * Cases with no shipped path to attack yet (README "Not run"). T33's main-world row stays "not run" (no query path
 * there) but its WEB variant runs the real query path, so the task passes once the chat-first features are merged.
 */
const EXPECTED_NOT_RUN: string[] = [];

describe.skipIf(!LIVE)("red-team suite (live, Anvil)", { timeout: 900_000 }, () => {
  const out = mkdtempSync(join(tmpdir(), "rt-live-"));
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("runs T1-T33, S1-S12, D-poison, D-plug, the Singapore variants and the WEB variants end to end", async () => {
    const cfg = loadRunConfig(["--out", out], process.env);
    const lines: string[] = [];
    const result = await runSuite(cfg, (l) => lines.push(l));
    const failed = result.reports.filter((r) => r.status === "fail").map((r) => `${r.taskId}: ${r.reason ?? r.notes.join("; ")}`);
    expect(failed, lines.join("\n")).toEqual([]);
    expect(result.reports.filter((r) => r.status === "not_run").map((r) => r.taskId)).toEqual(EXPECTED_NOT_RUN);
    expect(result.variants.map((v) => `${v.variant} ${v.taskId} ${v.status}`)).toEqual(["SG T1 pass", "SG T4 pass", ...CATALOGUE.web.map((c) => `WEB ${c.id} pass`)]);
    const rows = EvidenceRows.parse(JSON.parse(readFileSync(join(result.dir, "evidence.json"), "utf8")));
    const ran = rows.filter((r) => !r.title.startsWith("NOT RUN"));
    expect(ran.filter((r) => !r.txHash && !r.traceId).map((r) => `${r.taskId}: ${r.title}`)).toEqual([]);
    expect(ran.every((r) => r.outcome === "pass")).toBe(true);
    for (const id of ["T22", "T30", "T31", "T32"]) expect(rows.some((r) => r.taskId === id && (r.txHash || r.traceId)), id).toBe(true);
    // Each world's task 1.16 bundle (the API's exporter on the world's own deps) verifies and sits in the scanned dir.
    expect(result.exports.map((e) => `${e.world} ${e.status}${e.reason ? ` ${e.reason}` : ""}`)).toEqual(["main verified", "extras verified", "sg verified", "web verified"]);
    for (const e of result.exports) expect(existsSync(join(result.dir, e.path ?? "-", "manifest.json")), e.world).toBe(true);
  });
});
