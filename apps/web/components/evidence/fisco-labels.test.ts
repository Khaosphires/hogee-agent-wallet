import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkSepoliaAnchor, FISCO_CHECKS } from "@hogee/verify-evidence/fisco";
import { anchorPack, SIGNER, sidecarOf } from "../../../../tools/verify-evidence/test/fisco/anchor-fixture";
import { FISCO_CHECK_LABELS, fiscoCheckLabel, fiscoCheckRow, MAX_ROW_DETAIL } from "./fisco-labels";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
/** The wording lint's checker (scripts/lint-wording), as lib/reason-labels.test.ts imports it. */
const { checkText } = (await import(join(ROOT, "scripts/lint-wording/index.mjs"))) as { checkText: (text: string) => readonly { term: string }[] };

describe("FISCO check labels", () => {
  it("name every check the verifier reports, the folder check and the Sepolia timestamp", () => {
    for (const name of [...Object.values(FISCO_CHECKS), "pack folder", "Sepolia timestamp"]) {
      expect(Object.hasOwn(FISCO_CHECK_LABELS, name), name).toBe(true);
    }
  });

  it("are plain English without banned words, and an unknown check keeps its own name", () => {
    for (const { label, explain } of Object.values(FISCO_CHECK_LABELS)) expect(checkText(`${label} ${explain}`).map((f) => f.term), label).toEqual([]);
    expect(fiscoCheckLabel("something new")).toEqual({ label: "something new", explain: "" });
    expect(fiscoCheckLabel("toString").label).toBe("toString");
  });

  it("claim no more than the browser proves: code from the pack's artifacts, node4's served copy, a Sepolia time confirmed on Etherscan", () => {
    const code = FISCO_CHECK_LABELS["code identity"]?.explain ?? "";
    expect(code).not.toMatch(/byte for byte/);
    expect(code).toContain("build artifacts taken from the pack");
    expect(code).toContain("make verify-fisco");
    expect(FISCO_CHECK_LABELS["regulator ledger"]?.explain).not.toMatch(/holds the same blocks/);
    expect(FISCO_CHECK_LABELS["regulator ledger"]?.explain).toMatch(/served/);
    expect(FISCO_CHECK_LABELS["Sepolia timestamp"]?.explain).toMatch(/Etherscan/);
  });
});

describe("a check row", () => {
  const CODE = "5 contracts: FISCO = source = artifact outside the immutables, 103 immutable words explained; artifacts from the pack, not rebuilt (no local forge build given)";

  it("carries a passing check's own detail, so its caveat travels with the pass (as the CLI prints it)", () => {
    expect(fiscoCheckRow({ name: "code identity", ok: true, detail: CODE })).toEqual({ ...fiscoCheckLabel("code identity"), state: "passed", detail: CODE });
    const anchor = fiscoCheckRow({ name: "Sepolia timestamp", ok: true, detail: "Sepolia block 7 at …; inclusion is confirmed online (--anchor-rpc) or on Etherscan" });
    expect(anchor.detail).toContain("confirmed online (--anchor-rpc) or on Etherscan");
  });

  it("keeps the real anchor ok-line whole: its \"as stated by the sidecar … only --anchor-rpc or Etherscan confirms them\" caveat is never cut (post-fix re-check)", async () => {
    const a = await anchorPack();
    const r = checkSepoliaAnchor(a.files, await sidecarOf(a), { signer: SIGNER });
    expect(r).toMatchObject({ ok: true, anchored: true });
    expect(r.detail?.length).toBeGreaterThan(300);
    const row = fiscoCheckRow({ name: "Sepolia timestamp", ok: true, detail: r.detail });
    expect(row.detail).toBe(r.detail);
    expect(row.detail).toMatch(/ as stated by the sidecar \(.*only --anchor-rpc or Etherscan confirms them: https:\/\/sepolia\.etherscan\.io\/tx\/0x[0-9a-f]{64}\)$/);
  });

  it("escapes and caps every detail, passing or not, and says failed or not run", () => {
    expect(fiscoCheckRow({ name: "plan", ok: true, detail: "ok‮​x" }).detail).toBe("ok??x");
    expect(MAX_ROW_DETAIL).toBe(600);
    expect(fiscoCheckRow({ name: "plan", ok: true, detail: "y".repeat(700) }).detail).toHaveLength(600);
    expect(fiscoCheckRow({ name: "plan", ok: false, detail: "planHash differs" })).toMatchObject({ state: "failed", detail: "planHash differs" });
    expect(fiscoCheckRow({ name: "plan", ok: false, detail: "not run: the pack's files are missing" }).state).toBe("not-run");
    expect(fiscoCheckRow({ name: "plan", ok: true }).detail).toBeNull();
  });
});
