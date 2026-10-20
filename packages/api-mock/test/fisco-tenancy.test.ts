/**
 * The mock's FISCO pack tenancy (src/fisco.ts; FIX12-BRIEF fix12-web 6): one tenancy answer per source run within a
 * request, however many packs mirror it, and the tenancy filter applies before the listing cap, so packs the demo may
 * not read never push its own out of the list. ownsEvidenceRun is wrapped here only to count the questions.
 * Run: pnpm --filter @hogee/api-mock test
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MEI_IDS, RINA_IDS, exampleBundleManifest, exampleEvidenceBundle } from "@hogee/core";
import { readEnv, type MockEnv } from "../src/env";

const asked = vi.hoisted(() => [] as string[]);
vi.mock("../src/evidence", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/evidence")>();
  return { ...real, ownsEvidenceRun: (env: MockEnv, runId: string) => (asked.push(runId), real.ownsEvidenceRun(env, runId)) };
});

const { fiscoFile, fiscoPacks } = await import("../src/fisco");

let tmp = "";
let env: MockEnv;
const evidence = () => join(tmp, "evidence");

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function bundle(name: string, facilityId: string): void {
  const dir = join(evidence(), name);
  const deployment = Object.values(exampleBundleManifest.deployments)[0];
  write(join(dir, "manifest.json"), JSON.stringify({ ...exampleBundleManifest, runId: name, deployments: { [MEI_IDS.deploymentId]: { ...deployment, chainId: MEI_IDS.chainId } } }));
  write(join(dir, "evidence.json"), JSON.stringify(exampleEvidenceBundle.rows));
  write(join(dir, "contracts.json"), JSON.stringify({ runId: name, facilityId, exportedAt: "2026-10-18T10:00:00Z", deploymentId: MEI_IDS.deploymentId, chainId: MEI_IDS.chainId }));
}

/** evidence/fisco/fm-<n>/ mirroring `runId`, its folder dated `age` seconds before now. */
function pack(n: number, runId: string, age: number): string {
  const packId = `fm-${n.toString(16).padStart(16, "0")}`;
  const dir = join(evidence(), "fisco", packId);
  write(join(dir, "pack.json"), JSON.stringify({ format: "hogee.fisco-mirror/2", packId, createdAt: "2026-10-20T08:00:00.000Z", gitCommit: "abcdef1", sourceBundle: { runId, files: {} } }));
  const t = Date.now() / 1000 - age;
  utimesSync(dir, t, t);
  return packId;
}

let mine: string[] = [];

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "hogee-mock-fisco-tenancy-"));
  mkdirSync(join(tmp, "fixtures"), { recursive: true });
  bundle("ev-mei-1", MEI_IDS.facilityId);
  bundle("ev-rina-1", RINA_IDS.facilityId);
  // 21 newer packs of another tenant's bundle, then three of the demo's own.
  for (let i = 0; i < 21; i += 1) pack(0x100 + i, "ev-rina-1", 10 + i);
  mine = [pack(0x1, "ev-mei-1", 3600), pack(0x2, "ev-mei-1", 3601), pack(0x3, "ev-mei-1", 3602)];
  env = { ...readEnv(), country: "SG", repoRoot: tmp, fixturesDir: join(tmp, "fixtures"), replayRunId: undefined };
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("FISCO pack tenancy in the mock", () => {
  it("lists the demo's packs behind another tenant's newer ones, asking once per source run", async () => {
    asked.length = 0;
    expect((await fiscoPacks(env)).map((p) => p.packId).sort()).toEqual([...mine].sort());
    expect([...asked].sort()).toEqual(["ev-mei-1", "ev-rina-1"]);
  });

  it("asks once to serve a file, and serves another tenant's pack to no one", async () => {
    asked.length = 0;
    expect(await fiscoFile(env, mine[0] ?? "", "pack.json")).not.toBeNull();
    expect(asked).toEqual(["ev-mei-1"]);
    expect(await fiscoFile(env, "fm-0000000000000100", "pack.json")).toBeNull();
  });
});
