import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { iMilestoneEscrowAbi, webAuthnSigData } from "@hogee/chain";
import { decodeFunctionData, parseTransaction, type Hex } from "viem";
import { afterAll, describe, expect, it } from "vitest";
import { catalogueEntry } from "../../../../tools/verify-evidence/src/fisco/catalogue";
import { bundleFileHashes, findSepoliaTx, milestoneReleaseSignature, readSepoliaBundle, SourceError } from "../../src/fisco/source";

const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), "../../../../evidence/ev-74756ea61a72ae7c");
const T28_TX = "0x3b395fe9f54d2a3a6b2950863c0d599bcc959f5b67d6c00886e71d686af4d88d";
const temps: string[] = [];
afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

function copyBundle(): string {
  const d = mkdtempSync(join(tmpdir(), "fisco-src-"));
  temps.push(d);
  cpSync(BUNDLE, d, { recursive: true });
  return d;
}

describe("readSepoliaBundle", () => {
  const src = readSepoliaBundle(BUNDLE);

  it("reads the final-2 plan and its planHash", () => {
    expect(src.planHash).toBe("0x529bfdb37cd43bc96fe8aa2c1fd7465e1315e9f4aa24c23a749eb36a3e753583");
    expect(src.manifest.agent.address).toBe("0x6fa9497be1b6c38653ba261e00c7c0dd7e24e96a");
    expect(src.contracts.MilestoneEscrow).toBe("0xa5222ebe0be5ce769491f2f3396d14244d5d5761");
  });

  it("T28a calldata is byte-identical to the Sepolia release tx's calldata", () => {
    const entry = catalogueEntry("T28a");
    if (!entry?.sepolia) throw new Error("catalogue has no T28a sepolia spec");
    const tx = findSepoliaTx(src, entry.sepolia);
    expect(tx.hash).toBe(T28_TX);
    const payments = JSON.parse(readFileSync(join(BUNDLE, "payments.json"), "utf8")) as { payment: { txHash: string }; rawSignedTx: Hex }[];
    const row = payments.find((p) => p.payment.txHash === T28_TX);
    if (!row) throw new Error("no T28 row");
    expect(tx.raw).toBe(row.rawSignedTx);
    expect(tx.data).toBe(parseTransaction(row.rawSignedTx).data);
    const decoded = decodeFunctionData({ abi: iMilestoneEscrowAbi, data: tx.data });
    expect(decoded.functionName).toBe("releaseMilestone");
    const [release, sig] = decoded.args as unknown as [{ idx: number; amountMinor: bigint; expiry: bigint }, { kind: number; data: Hex }];
    expect(release.idx).toBe(1);
    expect(release.amountMinor).toBe(175_000n);
    expect(release.expiry).toBe(1_792_387_740n);
    // The calldata carries exactly the passkey assertion of the bundle's MilestoneRelease signature entry.
    const entrySig = milestoneReleaseSignature(src) as { submission: { passkey: Record<string, unknown> } };
    const { credentialId: _c, ...a } = entrySig.submission.passkey;
    expect(sig.kind).toBe(1);
    expect(sig.data).toBe(webAuthnSigData(a as never));
  });

  it("finds the two confirmSettlement rows in bundle order", () => {
    const a = findSepoliaTx(src, { source: "action", kind: "Treasury.confirmSettlement", nth: 0, compare: "calldata" });
    const b = findSepoliaTx(src, { source: "action", kind: "Treasury.confirmSettlement", nth: 1, compare: "calldata" });
    expect(a.hash).toBe("0x1a2be483785e32b0601a2996518b80e55df5a738b42cfe2a5b346bfb40a6de31");
    expect(b.hash).toBe("0xb00e0ac40e66cb9504ebddc60233da0def5b1e9c874fa2732511d1d525478117");
  });

  it("refuses an ambiguous spec without nth", () => {
    expect(() => findSepoliaTx(src, { source: "action", kind: "Treasury.confirmSettlement", compare: "calldata" })).toThrow(SourceError);
  });

  it("hashes every bundle file", () => {
    const h = bundleFileHashes(src);
    expect(Object.keys(h)).toContain(`receipts/${T28_TX}.json`);
    expect(Object.keys(h)).toContain("plans.json");
  });

  it("refuses a raw signed tx that does not hash to its row", () => {
    const d = copyBundle();
    const p = join(d, "payments.json");
    const rows = JSON.parse(readFileSync(p, "utf8")) as { rawSignedTx: string }[];
    const r0 = rows[0] as { rawSignedTx: string };
    r0.rawSignedTx = `${r0.rawSignedTx.slice(0, -2)}${r0.rawSignedTx.endsWith("00") ? "01" : "00"}`;
    writeFileSync(p, JSON.stringify(rows));
    expect(() => readSepoliaBundle(d)).toThrow(/keccak256\(rawSignedTx\)/);
  });

  it("refuses an edited manifest (planHash no longer matches)", () => {
    const d = copyBundle();
    const p = join(d, "plans.json");
    const plans = JSON.parse(readFileSync(p, "utf8")) as { manifest: { totalMinor: string } }[];
    (plans[0] as { manifest: { totalMinor: string } }).manifest.totalMinor = "1000001";
    writeFileSync(p, JSON.stringify(plans));
    expect(() => readSepoliaBundle(d)).toThrow(SourceError);
  });
});
