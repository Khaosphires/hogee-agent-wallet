/**
 * The mock's FISCO BCOS mirror packs (src/fisco.ts; REG-BRIEF fisco-proof): served with the live API's reader, but
 * only while the demo may read the pack's source Sepolia bundle (evidence.ts ownsEvidenceRun), REPLAY included, and
 * never under a sample's reserved id. Over HTTP, the tracked pack is listed and its files and missing anchor are inert.
 * Run: pnpm --filter @hogee/api-mock test
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MEI_IDS, RINA_IDS, exampleBundleManifest, exampleEvidenceBundle } from "@hogee/core";
import { readEnv, type MockEnv } from "../src/env";
import { SAMPLE_RUN_PREFIX } from "../src/evidence";
import { fiscoAnchor, fiscoFile, fiscoPacks } from "../src/fisco";

const { app } = await import("../src/index");

const MEI_PACK = "fm-0123456789abcdef";
const RINA_PACK = "fm-1111111111111111";
const SAMPLE_PACK = "fm-2222222222222222";
const ANVIL_PACK = "fm-3333333333333333";

let tmp = "";
let env: MockEnv;
const evidence = () => join(tmp, "evidence");

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

/** evidence/<name>/: a bundle of `facilityId` on `chainId` that the mock's tenant check reads. */
function bundle(name: string, facilityId: string = MEI_IDS.facilityId, chainId: number = MEI_IDS.chainId): void {
  const dir = join(evidence(), name);
  const deployment = Object.values(exampleBundleManifest.deployments)[0];
  write(join(dir, "manifest.json"), JSON.stringify({ ...exampleBundleManifest, runId: name, deployments: { [MEI_IDS.deploymentId]: { ...deployment, chainId } } }));
  write(join(dir, "evidence.json"), JSON.stringify(exampleEvidenceBundle.rows));
  write(join(dir, "contracts.json"), JSON.stringify({ runId: name, facilityId, exportedAt: "2026-10-18T10:00:00Z", deploymentId: MEI_IDS.deploymentId, chainId }));
}

/** evidence/fisco/<packId>/ mirroring `runId`. */
function pack(packId: string, runId: string): void {
  const dir = join(evidence(), "fisco", packId);
  write(join(dir, "pack.json"), JSON.stringify({ format: "hogee.fisco-mirror/2", packId, createdAt: "2026-10-20T08:00:00.000Z", gitCommit: "abcdef1", sourceBundle: { runId, files: {} } }));
  write(join(dir, "steps.json"), "{}");
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "hogee-mock-fisco-"));
  mkdirSync(join(tmp, "fixtures"), { recursive: true });
  bundle("ev-mei-1");
  bundle("ev-rina-1", RINA_IDS.facilityId);
  bundle("ev-mei-anvil", MEI_IDS.facilityId, 31_337);
  pack(MEI_PACK, "ev-mei-1");
  pack(RINA_PACK, "ev-rina-1");
  pack(SAMPLE_PACK, `${SAMPLE_RUN_PREFIX}mock-rina-evidence-3`);
  pack(ANVIL_PACK, "ev-mei-anvil");
  write(join(evidence(), "fisco", "anchors", `${MEI_PACK}.sepolia.json`), '{"format":"hogee.fisco-anchor/1"}');
  write(join(evidence(), "fisco", "anchors", `${RINA_PACK}.sepolia.json`), "{}");
  env = { ...readEnv(), country: "SG", repoRoot: tmp, fixturesDir: join(tmp, "fixtures"), replayRunId: undefined };
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("FISCO mirror packs in the mock", () => {
  it("lists only the packs of the demo's own Sepolia bundles, with their files and anchor flag", async () => {
    expect(await fiscoPacks(env)).toEqual([{ packId: MEI_PACK, createdAt: "2026-10-20T08:00:00.000Z", files: ["pack.json", "steps.json"], anchored: true }]);
  });

  it("serves the demo's pack and its anchor, and nothing of another tenant's, a sample's or another chain's", async () => {
    expect(await (await fiscoFile(env, MEI_PACK, "steps.json"))?.text()).toBe("{}");
    expect((await fiscoAnchor(env, MEI_PACK))?.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    for (const packId of [RINA_PACK, SAMPLE_PACK, ANVIL_PACK]) {
      expect(await fiscoFile(env, packId, "pack.json"), packId).toBeNull();
      expect(await fiscoAnchor(env, packId), packId).toBeNull();
    }
  });

  it("in REPLAY, serves only the packs of the replayed run (an Anvil run too)", async () => {
    const replay = { ...env, replayRunId: "ev-mei-anvil" };
    expect((await fiscoPacks(replay)).map((p) => p.packId)).toEqual([ANVIL_PACK]);
    expect(await fiscoFile(replay, MEI_PACK, "pack.json")).toBeNull();
  });

  it("follows the demo's country: Malaysia sees Rina's pack only", async () => {
    const my = { ...env, country: "MY" as const };
    expect((await fiscoPacks(my)).map((p) => p.packId)).toEqual([RINA_PACK]);
  });
});

describe("FISCO routes over HTTP (the tracked pack)", () => {
  it("lists the tracked pack, serves its files inert, and answers a missing anchor with NOT_FOUND", async () => {
    const list = await app.request("/api/evidence/fisco");
    expect(list.status).toBe(200);
    expect(list.headers.get("x-content-type-options")).toBe("nosniff");
    const packs = (await list.json()) as { packId: string; files: string[]; anchored: boolean }[];
    const tracked = packs[0];
    expect(tracked?.packId).toMatch(/^fm-[0-9a-f]{16}$/);
    expect(tracked?.files).toContain("pack.json");

    const file = await app.request(`/api/evidence/fisco/${tracked?.packId}/files/pack.json`);
    expect(file.status).toBe(200);
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(file.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(file.headers.get("cache-control")).toBe("no-store");
    expect(((await file.json()) as { packId: string }).packId).toBe(tracked?.packId);

    const anchor = await app.request(`/api/evidence/fisco/${tracked?.packId}/anchor`);
    expect(anchor.status).toBe(tracked?.anchored ? 200 : 404);
    expect(anchor.headers.get("x-content-type-options")).toBe("nosniff");

    for (const path of [`/api/evidence/fisco/${tracked?.packId}/files/..%2F..%2Fev-74756ea61a72ae7c%2Fmanifest.json`, "/api/evidence/fisco/fm-0000000000000000/files/pack.json", "/api/evidence/fisco/anchors/anchor"]) {
      const res = await app.request(path);
      expect([404, 422], path).toContain(res.status);
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
    }
  });

  it("still reads /api/evidence/runs and a run as before (the fisco paths come first, never as a run id)", async () => {
    const runs = await app.request("/api/evidence/runs");
    expect(runs.status).toBe(200);
    const fiscoAsRun = await app.request("/api/evidence/fisco");
    expect(Array.isArray(await fiscoAsRun.json())).toBe(true);
  });
});
