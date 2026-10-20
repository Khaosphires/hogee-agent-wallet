import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EVIDENCE_TASK_IDS } from "@hogee/core";
import { hashesFileOf, verifyBundle, type BundleFiles } from "@hogee/verify-evidence";
import { SAMPLE_RUN_PREFIX, isSampleRun, packCounts, packStatus, recordedLabel, refusalsIn, taskName } from "./proof-model";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
/** The tracked final-2 Sepolia export and the committed Anvil REPLAY pack (docs/decisions/int-e2e-author.md). */
const FINAL_2 = "ev-74756ea61a72ae7c";
const ANVIL_PACK = "ev-cdc4cc7916471c1e";
/** The fixture sample as the mock serves it (api-mock evidence.ts sampleRunId). */
const SAMPLE = `${SAMPLE_RUN_PREFIX}mock-rina-evidence-3`;

describe("which pack is a labelled sample (audit run-10 v-2)", () => {
  it("is decided by the reserved run id the mock serves its sample and example under", () => {
    expect(SAMPLE_RUN_PREFIX).toBe("sample:");
    expect(isSampleRun(SAMPLE)).toBe(true);
    expect(isSampleRun(`${SAMPLE_RUN_PREFIX}run-example-001`)).toBe(true);
    // An exported pack, the sample's own bare id (an evidence/ folder could take it) and lookalikes are not samples.
    for (const runId of [FINAL_2, "mock-rina-evidence-3", "run-example-001", "Sample:x", "sample-x", "sample", SAMPLE_RUN_PREFIX, ` ${SAMPLE}`]) {
      expect(isSampleRun(runId), runId).toBe(false);
    }
  });
});

describe("packStatus: never a faked pass", () => {
  it("says every check passed only for a verified pack, with where and when it was recorded", () => {
    const s = packStatus("verified", { runId: FINAL_2, mode: "mock" }, "Recorded on Sepolia · 19 Oct");
    expect(s).toEqual({ tone: "verified", title: "Every check passed", line: "Recorded on Sepolia · 19 Oct", showCount: true });
  });

  it("calls the mock's own sample a sample when it doesn't check, in grey, without its count", () => {
    for (const result of ["failed", "unreadable"] as const) {
      const s = packStatus(result, { runId: SAMPLE, mode: "mock" }, null);
      expect(s.tone).toBe("sample");
      expect(s.title).toBe("Sample proof pack");
      expect(s.showCount).toBe(false);
      expect(s.title).not.toMatch(/verified|passed/i);
    }
  });

  // Audit run-10 v-2: in practice mode an exported evidence/ pack that fails (changed bytes, a hand-edited row) was
  // shown as a grey "Sample proof pack" with no count, only because the session was mock.
  it("keeps a recorded pack's failure red with its count in practice mode too", () => {
    expect(packStatus("failed", { runId: FINAL_2, mode: "mock" }, "Recorded on Sepolia · 19 Oct")).toMatchObject({ tone: "failed", title: "Not verified", showCount: true });
    expect(packStatus("unreadable", { runId: FINAL_2, mode: "mock" }, null)).toMatchObject({ tone: "failed", title: "Not verified", showCount: false });
    // The sample's bare id is not its identity: an evidence/ folder may carry it.
    expect(packStatus("failed", { runId: "mock-rina-evidence-3", mode: "mock" }, null).tone).toBe("failed");
  });

  it("keeps a real failure red with its count in live and replay mode, whatever the run id", () => {
    for (const mode of ["live", "replay"] as const) {
      for (const runId of [FINAL_2, SAMPLE]) {
        expect(packStatus("failed", { runId, mode }, null)).toMatchObject({ tone: "failed", title: "Not verified", showCount: true });
        expect(packStatus("unreadable", { runId, mode }, null)).toMatchObject({ tone: "failed", title: "Not verified", showCount: false });
      }
    }
    // The mode not known yet is never treated as practice mode.
    expect(packStatus("failed", { runId: SAMPLE, mode: undefined }, null).tone).toBe("failed");
  });

  it("says nothing about the result while checking", () => {
    expect(packStatus("checking", { runId: FINAL_2, mode: "live" }, null)).toMatchObject({ tone: "checking", showCount: false });
  });
});

const passed = (chainId: number) => ({ ok: true, anchor: { chainId } }) as const;

describe("recordedLabel: the verified anchor's chain, never the manifest's (audit run-10 v-3)", () => {
  it("names the anchor's chain and the UTC day of the export", () => {
    expect(recordedLabel(passed(11_155_111), 1, "2026-10-19T07:08:32.806Z")).toBe("Recorded on Sepolia · 19 Oct");
    expect(recordedLabel(passed(31_337), 1, "2026-10-18T23:59:00Z")).toBe("Recorded on Anvil (local) · 18 Oct");
    expect(recordedLabel(passed(5), 1, "2026-10-18T23:59:00Z")).toBe("Recorded on chain 5 · 18 Oct");
  });

  it("is null for a pack that didn't pass, has no anchor, or lists no deployment or several", () => {
    expect(recordedLabel({ ok: false, anchor: { chainId: 11_155_111 } }, 1, "2026-10-19T07:08:32Z")).toBeNull();
    expect(recordedLabel({ ok: true, anchor: null }, 1, "2026-10-19T07:08:32Z")).toBeNull();
    expect(recordedLabel(undefined, 1, "2026-10-19T07:08:32Z")).toBeNull();
    expect(recordedLabel(passed(11_155_111), 0, "2026-10-19T07:08:32Z")).toBeNull();
    expect(recordedLabel(passed(11_155_111), 2, "2026-10-19T07:08:32Z")).toBeNull();
  });

  it("is null without a readable time", () => {
    expect(recordedLabel(passed(11_155_111), 1, undefined)).toBeNull();
    expect(recordedLabel(passed(11_155_111), 1, "yesterday")).toBeNull();
  });
});

/** A pack folder as text for text files, bytes otherwise, so a test can edit the JSON (the Proof page itself passes bytes: served-pack.ts). */
function packFiles(runId: string): Record<string, string | Uint8Array> {
  const dir = join(ROOT, "evidence", runId);
  const out: Record<string, string | Uint8Array> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(dir, full).split(sep).join("/")] = /\.(json|jsonl|md|txt|csv)$/i.test(name) ? readFileSync(full, "utf8") : new Uint8Array(readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

describe("recordedLabel on an altered pack (audit run-10 v-3 validation plan)", () => {
  // The committed Anvil pack with the real final-2 Sepolia entry put first in its manifest and hashes.json recomputed.
  it("never says Recorded on Sepolia for a pack whose verified anchor is a local chain", () => {
    const files = packFiles(ANVIL_PACK);
    const createdAt = (JSON.parse(files["contracts.json"] as string) as { exportedAt: string }).exportedAt;
    const control = verifyBundle(files as BundleFiles);
    expect(control.ok, JSON.stringify(control.checks.filter((c) => !c.ok))).toBe(true);
    expect(control.anchor?.chainId).toBe(31_337);
    expect(recordedLabel(control, 1, createdAt)).toBe("Recorded on Anvil (local) · 18 Oct");

    const final2 = (JSON.parse(readFileSync(join(ROOT, "evidence", FINAL_2, "manifest.json"), "utf8")) as { deployments: Record<string, unknown> }).deployments;
    const manifest = JSON.parse(files["manifest.json"] as string) as { deployments: Record<string, unknown> };
    const forgedManifest = { ...manifest, deployments: { "final-2": final2["final-2"], ...manifest.deployments } };
    const unhashed = { ...files, "manifest.json": `${JSON.stringify(forgedManifest, null, 2)}\n` };
    const forged = { ...unhashed, "hashes.json": hashesFileOf(unhashed as BundleFiles) };
    const result = verifyBundle(forged as BundleFiles);
    // Whether or not the verifier accepts the extra entry (it fails the pack since run-10, audit.ts checkRows), the
    // anchor still names the local chain: the first manifest entry (Sepolia) is not what the verifier binds.
    expect(result.anchor?.chainId).toBe(31_337);
    expect(Object.values(forgedManifest.deployments)).toHaveLength(2);
    expect(recordedLabel(result, Object.keys(forgedManifest.deployments).length, createdAt)).toBeNull();
  });
});

describe("task names", () => {
  it("has a plain name for every task id, never the run's own title", () => {
    for (const id of EVIDENCE_TASK_IDS) {
      expect(taskName(id), id).toMatch(/\S/);
      expect(taskName(id), id).not.toMatch(/mock|0x|revert/i);
    }
  });
});

describe("counts", () => {
  it("counts passes, receipts and refusals from the rows", () => {
    const rows = [
      { outcome: "pass", layer: "onchain_success" },
      { outcome: "pass", layer: "onchain_revert" },
      { outcome: "fail", layer: "agent_refusal" },
      { outcome: "pass", layer: "offchain" },
    ] as const;
    expect(packCounts(rows)).toEqual({ passed: 3, total: 4, receipts: 2, refusals: 1 });
  });

  it("counts the refusals in the activity record, unknown while it loads", () => {
    expect(refusalsIn(undefined)).toBeUndefined();
    expect(refusalsIn([{ kind: "DENIAL" }, { kind: "POLICY_VERDICT", verdict: "DENY" }, { kind: "TX", verdict: null }])).toBe(2);
  });
});
