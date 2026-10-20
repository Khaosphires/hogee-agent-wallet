/**
 * run-6 v-6: a consistently rewritten bundle (hashes.json, logsBloom and SUMMARY.md regenerated with the public
 * helpers) must still fail: the status flip, a Spent dropped from its receipt, the founder-key swap (T27's route) and
 * a moved PlanCommitted fail offline; the anchor is reported; the online mode compares it with a node.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { p256 } from "@noble/curves/p256";
import { encodeAbiParameters, toHex, type Hex } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { main, RPC_ENV } from "../src/cli";
import { parseRpcUrl, RPC_URL_REFUSAL } from "../src/online";
import { loadBundle, type BundleFiles } from "../src/load";
import { readBundleDir } from "../src/read-dir";
import { fileText } from "../src/util";
import { anchorLines, anchorOf, explorerOf, explorerProblems, hashesFileOf, logsBloom, ONLINE_CHECK, receiptPath, summaryMarkdown, summarySourceOf, verifyBundle, verifyOnline, type VerifyResult } from "../src/index";
import { buildFixture, CHAIN_ID, DEPLOYMENT_ID, editJson, passkeyAssert, rehash, type Fixture } from "./fixture";

const failed = (r: VerifyResult): string[] => r.checks.filter((c) => !c.ok).map((c) => c.name);
const detail = (r: VerifyResult, name: string): string => r.checks.find((c) => c.name === name)?.detail ?? "";

/** The attacker regenerates SUMMARY.md with the public generator, then hashes.json. */
function regenerate(files: Record<string, string>): Record<string, string> {
  const b = loadBundle(rehash(files)).bundle;
  if (!b) throw new Error("the edited bundle does not load");
  return rehash({ ...files, "SUMMARY.md": summaryMarkdown(summarySourceOf(b)) });
}

/** A node that serves `files`' receipts and blocks (`edit` changes what it serves). */
function nodeOf(files: Record<string, string>, edit: (method: string, params: unknown[], result: unknown) => unknown = (_m, _p, r) => r) {
  const blocks = JSON.parse(files["blocks.json"] as string) as { number: string }[];
  const answer = (method: string, params: unknown[]): unknown => {
    if (method === "eth_chainId") return toHex(CHAIN_ID);
    if (method === "eth_getCode") return "0x6080";
    if (method === "eth_getTransactionReceipt") {
      const f = files[receiptPath(params[0] as string)];
      return f ? (JSON.parse(f) as unknown) : null;
    }
    if (method === "eth_getBlockByNumber") return blocks.find((x) => x.number === params[0]) ?? null;
    return null;
  };
  return async (_url: string, init: { body: string }) => {
    const { id, method, params } = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id, result: edit(method, params, answer(method, params)) }) };
  };
}

let fx: Fixture;
let one: Fixture;
beforeAll(async () => {
  fx = await buildFixture();
  one = await buildFixture({ spends: [{ line: "LOGISTICS", amount: 1_000n, ref: 1, after: 60 }] });
});

describe("v-6: consistently rewritten bundles", () => {
  it("a regenerated SUMMARY.md passes; an edited one fails", () => {
    expect(verifyBundle(regenerate(fx.files)).ok).toBe(true);
    const edited = rehash({ ...fx.files, "SUMMARY.md": (fx.files["SUMMARY.md"] as string).replace("2 payments", "1 payments") });
    const r = verifyBundle(edited);
    expect(failed(r)).toEqual(["SUMMARY.md (regenerated)"]);
  });

  it("status flip: a successful spend shown as a blocked attack fails (the replay accepts the call)", () => {
    const tx = one.spendTxs[0] as string;
    let files = editJson(one.files, receiptPath(tx), (r) => {
      r.status = "0x0";
      r.logs = [];
      r.logsBloom = logsBloom([]);
    });
    files = editJson(files, "payments.json", (p) => {
      p[0].payment.state = "REVERTED";
      p[0].payment.revertReason = "CapExceeded";
    });
    files = editJson(files, "evidence.json", (rows) => {
      rows.push({ taskId: "T4", title: "Spend over the cap is blocked", expected: "revert", expectedError: "CapExceeded", layer: "onchain_revert", outcome: "pass", txHash: tx, chainId: CHAIN_ID, deploymentId: DEPLOYMENT_ID, contract: "Treasury", function: "spend", revertReason: "CapExceeded", artifacts: [receiptPath(tx)] });
    });
    const r = verifyBundle(regenerate(files));
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(["event replay (caps, payees, duplicates)"]);
    expect(detail(r, "event replay (caps, payees, duplicates)")).toMatch(/reverted, but the plan rules accept the call/);
  });

  it("a Spent dropped from its successful receipt fails", () => {
    const files = editJson(fx.files, receiptPath(fx.spendTxs[1] as string), (r) => {
      r.logs = [];
      r.logsBloom = logsBloom([]);
    });
    const r = verifyBundle(regenerate(files));
    expect(failed(r)).toEqual(expect.arrayContaining(["receipts", "event sources (calldata ↔ events)"]));
    expect(detail(r, "event sources (calldata ↔ events)")).toMatch(/a successful spend emits 0 Spent events/);
  });

  it("founder-key swap: the log's key and a re-signed passkey fail against the lender-signed calldata", () => {
    const other = "66".repeat(32);
    const pub = p256.getPublicKey(other, false);
    const [qx, qy] = [toHex(pub.slice(1, 33)), toHex(pub.slice(33, 65))];
    const actions = JSON.parse(fx.files["chain-actions.json"] as string) as { actionId: string; txHash: string }[];
    const keyTx = actions.find((a) => a.actionId === "act-key")?.txHash as string;
    let files = editJson(fx.files, receiptPath(keyTx), (r) => {
      r.logs[0].data = encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [qx, qy]); // unindexed: the bloom is unchanged
    });
    files = editJson(files, "signatures.json", (s) => {
      s[0].submission.passkey = passkeyAssert(s[0].digest as Hex, other);
    });
    const r = verifyBundle(regenerate(files));
    expect(failed(r)).toEqual(expect.arrayContaining(["event sources (calldata ↔ events)", "founder signatures (ECDSA, P-256)"]));
    expect(detail(r, "event sources (calldata ↔ events)")).toMatch(/FounderKeyRegistered event differs from the signed registerFounderKey calldata/);
    expect(detail(r, "founder signatures (ECDSA, P-256)")).toMatch(/P-256 signature does not verify/);
  });

  it("re-check L6: with the openFacility row and receipt dropped, the founder key has no lender to check: fails closed", () => {
    const actions = JSON.parse(fx.files["chain-actions.json"] as string) as { actionId: string; txHash: string }[];
    const openTx = actions.find((a) => a.actionId === "act-open")?.txHash as string;
    const openBlock = (JSON.parse(fx.files[receiptPath(openTx)] as string) as { blockNumber: string }).blockNumber;
    let files = Object.fromEntries(Object.entries(fx.files).filter(([k]) => k !== receiptPath(openTx)));
    files = editJson(files, "chain-actions.json", (a) => a.splice(a.findIndex((x: { actionId: string }) => x.actionId === "act-open"), 1));
    files = editJson(files, "blocks.json", (bl) => bl.splice(bl.findIndex((x: { number: string }) => x.number === openBlock), 1));
    const r = verifyBundle(regenerate(files));
    expect(failed(r)).toEqual(["founder signatures (ECDSA, P-256)"]);
    expect(detail(r, "founder signatures (ECDSA, P-256)")).toMatch(/0 FacilityOpened events/);
  });

  it("founder-key swap, full route: the commit's bytes dropped and PlanCommitted moved into another receipt fails", () => {
    const actions = JSON.parse(fx.files["chain-actions.json"] as string) as { actionId: string; txHash: string }[];
    const keyTx = actions.find((a) => a.actionId === "act-key")?.txHash as string;
    const commit = JSON.parse(fx.files[receiptPath(fx.commitTx)] as string) as { logs: Record<string, string>[] };
    const planCommitted = commit.logs[commit.logs.length - 1] as Record<string, string>;
    let files = Object.fromEntries(Object.entries(fx.files).filter(([k]) => k !== receiptPath(fx.commitTx)));
    files = editJson(files, "chain-actions.json", (a) => {
      const row = a.find((x: { actionId: string }) => x.actionId === "act-commit");
      Object.assign(row, { state: "BROADCAST", rawSignedTx: null, block: null });
    });
    files = editJson(files, receiptPath(keyTx), (r) => {
      r.logs.push({ ...planCommitted, transactionHash: r.transactionHash, blockHash: r.blockHash, blockNumber: r.blockNumber, logIndex: "0x1" });
      r.logsBloom = logsBloom(r.logs);
    });
    files = editJson(files, "evidence.json", (rows) => {
      Object.assign(rows[0], { txHash: keyTx, artifacts: ["plans.json", "signatures.json", receiptPath(keyTx)] });
      delete rows[0].block;
    });
    const r = verifyBundle(regenerate(files));
    expect(failed(r)).toEqual(expect.arrayContaining(["transactions", "receipts", "plan approvals", "event sources (calldata ↔ events)"]));
    expect(detail(r, "plan approvals")).toMatch(/commit tx's receipt has no PlanCommitted|carries no signed commitPlan tx/);
    expect(detail(r, "event sources (calldata ↔ events)")).toMatch(/registerFounderKey cannot emit PlanCommitted/);
  });
});

describe("v-6: the anchor", () => {
  it("names the contracts, the newest block and every tx with a receipt", () => {
    const r = verifyBundle(fx.files);
    const blocks = JSON.parse(fx.files["blocks.json"] as string) as { number: string; hash: string }[];
    const newest = blocks.reduce((a, b) => (BigInt(b.number) > BigInt(a.number) ? b : a));
    expect(r.anchor).toMatchObject({ chainId: CHAIN_ID, deploymentId: DEPLOYMENT_ID, head: { number: Number(BigInt(newest.number)), hash: newest.hash } });
    expect(Object.keys(r.anchor?.contracts ?? {})).toEqual(["PlanRegistry", "Treasury", "MilestoneEscrow", "SalesOracle"]);
    expect(r.anchor?.txHashes).toEqual(Object.keys(fx.files).filter((k) => k.startsWith("receipts/")).map((k) => k.slice(9, -5)).sort());
    expect(fx.files["SUMMARY.md"]).toMatch(/VERIFIED means the bundle is internally consistent/);
    for (const tx of r.anchor?.txHashes ?? []) expect(fx.files["SUMMARY.md"]).toContain(tx);
  });

  it("is null when the bundle does not load", () => {
    expect(verifyBundle({}).anchor).toBeNull();
  });
});

describe("v-6: online mode (--rpc)", () => {
  it("passes when the node serves the bundle's receipts and blocks", async () => {
    const c = await verifyOnline(fx.files, "http://node.test", { fetch: nodeOf(fx.files) });
    expect(c).toMatchObject({ name: ONLINE_CHECK, ok: true });
  });

  it("catches the status flip the offline checks cannot see for a call outside the replay", async () => {
    const tx = fx.commitTx;
    const flipped = editJson(fx.files, receiptPath(tx), (r) => {
      r.status = "0x0";
    });
    const c = await verifyOnline(fx.files, "http://node.test", { fetch: nodeOf(flipped) });
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/node's receipt differs/);
  });

  it("fails on another block hash, another chain, or a missing contract", async () => {
    const otherBlock = await verifyOnline(fx.files, "http://node.test", { fetch: nodeOf(fx.files, (m, _p, r) => (m === "eth_getBlockByNumber" && r ? { ...(r as object), hash: `0x${"ab".repeat(32)}` } : r)) });
    expect(otherBlock.detail).toMatch(/node's block differs/);
    const otherChain = await verifyOnline(fx.files, "http://node.test", { fetch: nodeOf(fx.files, (m, _p, r) => (m === "eth_chainId" ? "0x1" : r)) });
    expect(otherChain.detail).toMatch(/on chain 0x1/);
    const noCode = await verifyOnline(fx.files, "http://node.test", { fetch: nodeOf(fx.files, (m, _p, r) => (m === "eth_getCode" ? "0x" : r)) });
    expect(noCode.detail).toMatch(/has no code/);
    expect((await verifyOnline(fx.files, "file:///etc/passwd")).ok).toBe(false);
  });
});

describe("v-6: the CLI says what VERIFIED means", () => {
  it("prints the anchor and the meaning; --rpc compares with the node", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { dirname, join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "hogee-anchor-"));
    try {
      for (const [path, body] of Object.entries(fx.files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), body);
      }
      const lines: string[] = [];
      expect(main([dir], (l) => lines.push(l))).toBe(0);
      const out = lines.join("\n");
      expect(out).toMatch(/Anchor \(compare with chain 31337\)/);
      expect(out).toMatch(/newest block/);
      expect(out).toMatch(/VERIFIED: every check passed\. VERIFIED means the bundle is internally consistent/);
      expect(out).toMatch(/compare the anchor above with Sepolia Etherscan, or run again with an RPC node \(HOGEE_VERIFY_RPC=<url> make verify/);
      const online: string[] = [];
      expect(await main([dir, "--rpc", "http://node.test"], (l) => online.push(l), { fetch: nodeOf(fx.files) })).toBe(0);
      expect(online.join("\n")).toMatch(/ok {3}chain anchor \(online, --rpc\)/);
      // re-check L4: online VERIFIED says what it does not prove (the forger's own contracts have code too).
      expect(online.join("\n")).toContain("It does not prove these contracts are Hogee's deployment: compare the contract addresses above with the announced deployment.");
      expect(online.join("\n")).not.toMatch(/node\.test/);
      expect(await main([dir, "--rpc", "http://node.test"], () => undefined, { fetch: nodeOf(editJson(fx.files, receiptPath(fx.commitTx), (r) => void (r.status = "0x0"))) })).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Audit run-10 v-3: the exporter writes exactly contracts.json's deployment into manifest.json. Any other entry is one
// the rest of the checks never bind (an altered pack could put a real Sepolia deployment there), so it fails the pack.
describe("audit run-10 v-3: manifest.json lists only the anchor's deployment", () => {
  const sepolia = (address: string) => ({ address, verifiedUrl: `https://sepolia.etherscan.io/address/${address}#code` });

  it("a rewritten bundle with another deployment listed first or last fails, and its anchor stays the bound one", () => {
    const extra = { chainId: 11_155_111, contracts: { PlanRegistry: sepolia(`0x${"a1".repeat(20)}`), Treasury: sepolia(`0x${"b2".repeat(20)}`) } };
    const first = editJson(fx.files, "manifest.json", (m) => (m.deployments = { "final-2": extra, ...m.deployments }));
    const last = editJson(fx.files, "manifest.json", (m) => (m.deployments = { ...m.deployments, "final-2": extra }));
    for (const files of [first, last]) {
      const r = verifyBundle(regenerate(files));
      expect(r.ok).toBe(false);
      expect(failed(r)).toEqual(["evidence rows"]);
      expect(detail(r, "evidence rows")).toContain(`manifest.json lists a deployment other than ${DEPLOYMENT_ID}`);
      expect(r.anchor?.chainId).toBe(CHAIN_ID);
      expect(r.anchor?.deploymentId).toBe(DEPLOYMENT_ID);
    }
    // The control: the exporter's single entry passes.
    expect(verifyBundle(regenerate(fx.files)).ok).toBe(true);
  });
});

// Run-10 skills re-check H-1: the bound deployment must list exactly contracts.json's contracts, as the exporter writes
// it. A name contracts.json lacks is bound by nothing, yet the Proof page lists and links it.
describe("re-check H-1: the bound deployment lists exactly contracts.json's contracts", () => {
  const TRACKED = ["ev-74756ea61a72ae7c", "ev-cdc4cc7916471c1e"];
  const packDir = (runId: string) => join(dirname(fileURLToPath(import.meta.url)), "../../../evidence", runId);
  const other = `0x${"c3".repeat(20)}`;
  const contractsOf = (files: BundleFiles, id: string) => (JSON.parse(fileText(files["manifest.json"] as Uint8Array) as string) as { deployments: Record<string, { contracts: Record<string, unknown> }> }).deployments[id]?.contracts ?? {};

  it("a contract name contracts.json lacks fails evidence rows (fixture: extra name, and an optional contract contracts.json omits)", () => {
    const extra = editJson(fx.files, "manifest.json", (m) => (m.deployments[DEPLOYMENT_ID].contracts.Escrow = { address: other, verifiedUrl: `http://localhost/anvil/address/${other}` }));
    const omitted = editJson(fx.files, "contracts.json", (c) => delete c.contracts.SalesOracle);
    // Names the schema accepts that a plain object inherits: they must not read as named by contracts.json.
    const inherited = ["constructor", "toString"].map((name) => [editJson(fx.files, "manifest.json", (m) => (m.deployments[DEPLOYMENT_ID].contracts[name] = { address: other, verifiedUrl: `http://localhost/anvil/address/${other}` })), name] as const);
    for (const [files, name] of [[extra, "Escrow"], [omitted, "SalesOracle"], ...inherited] as const) {
      const r = verifyBundle(regenerate(files));
      expect(r.ok).toBe(false);
      expect(failed(r)).toContain("evidence rows");
      expect(detail(r, "evidence rows")).toContain(`manifest.json lists ${name} in ${DEPLOYMENT_ID}, which contracts.json does not name`);
    }
  });

  it("the review's input fails: the tracked final-2 pack with an extra Escrow, re-hashed", () => {
    const { files } = readBundleDir(packDir("ev-74756ea61a72ae7c"));
    const manifest = JSON.parse(fileText(files["manifest.json"] as Uint8Array) as string) as { deployments: Record<string, { contracts: Record<string, unknown> }> };
    manifest.deployments["final-2"]!.contracts.Escrow = { address: other, verifiedUrl: `https://sepolia.etherscan.io/address/${other}#code` };
    const unhashed = { ...files, "manifest.json": `${JSON.stringify(manifest, null, 2)}\n` };
    const r = verifyBundle({ ...unhashed, "hashes.json": hashesFileOf(unhashed) });
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(["evidence rows"]);
    expect(detail(r, "evidence rows")).toContain("manifest.json lists Escrow in final-2, which contracts.json does not name");
  });

  it("both tracked packs still verify, read as the CLI reads them (bytes)", () => {
    for (const runId of TRACKED) {
      const { files, refused } = readBundleDir(packDir(runId));
      expect(refused, runId).toEqual([]);
      const r = verifyBundle(files);
      expect(r.ok, `${runId}: ${JSON.stringify(r.checks.filter((c) => !c.ok))}`).toBe(true);
      expect(Object.keys(contractsOf(files, r.anchor?.deploymentId ?? "")).sort(), runId).toEqual(Object.keys(r.anchor?.contracts ?? {}).sort());
    }
  });
});

describe("re-check M5: explorer links are pinned by chain id, never taken from the bundle", () => {
  const LOOKALIKE = "https://sepolia-etherscan.example";
  const structure = (r: VerifyResult) => detail(r, "bundle files");

  it("a local bundle that names an explorer, or links a contract or row anywhere, fails (and never echoes the URL)", () => {
    for (const files of [
      editJson(fx.files, "contracts.json", (c) => (c.explorer = LOOKALIKE)),
      editJson(fx.files, "contracts.json", (c) => (c.contracts.Treasury.verifiedUrl = `${LOOKALIKE}/address/x#code`)),
      editJson(fx.files, "evidence.json", (rows) => (rows[0].explorerUrl = `${LOOKALIKE}/tx/${rows[0].txHash}`)),
      editJson(fx.files, "manifest.json", (m) => (m.deployments[DEPLOYMENT_ID].contracts.Treasury.verifiedUrl = `${LOOKALIKE}/address/x`)),
    ]) {
      const r = verifyBundle(rehash(files));
      expect(r.ok).toBe(false);
      expect(failed(r)).toContain("bundle files");
      expect(structure(r)).toMatch(/explorer|verifiedUrl|explorerUrl/);
      expect(JSON.stringify(r)).not.toContain(LOOKALIKE);
    }
  });

  it("Sepolia pins https://sepolia.etherscan.io: links under it or null pass, a lookalike host or another site fails", () => {
    const base = explorerOf(11_155_111);
    expect(base).toBe("https://sepolia.etherscan.io");
    expect(explorerOf(CHAIN_ID)).toBeNull();
    const b = (explorer: string | null, verifiedUrl: string | null, explorerUrl?: string, manifestUrl = `${base}/address/0xb2#code`) => ({
      contracts: { chainId: 11_155_111, explorer, contracts: { PlanRegistry: { address: "0xa1", verifiedUrl, verified: verifiedUrl !== null }, Treasury: { address: "0xb2", verifiedUrl: null, verified: false } } },
      manifest: { deployments: { d: { chainId: 11_155_111, contracts: { Treasury: { address: "0xb2", verifiedUrl: manifestUrl } } } } },
      rows: explorerUrl ? [{ taskId: "S1", txHash: "0x01", explorerUrl }] : [],
    }) as unknown as Parameters<typeof explorerProblems>[0];
    expect(explorerProblems(b(base, `${base}/address/0xa1#code`, `${base}/tx/0x01`))).toEqual([]);
    expect(explorerProblems(b(base, `${base}/address/0xA1#code`, `${base}/tx/0x01`))).toEqual([]); // hex case is the same page
    expect(explorerProblems(b(base, null))).toEqual([]);
    expect(explorerProblems(b(null, null))).toHaveLength(1); // Sepolia must name its explorer
    expect(explorerProblems(b(base, `${base}.evil.example/address/0xa1`))).toHaveLength(1);
    expect(explorerProblems(b(base, null, `${LOOKALIKE}/tx/0x01`))).toHaveLength(1);
  });

  it("run-7 re-check L2: a link on the pinned explorer must be the row's own tx or the contract's own code page", () => {
    const base = explorerOf(11_155_111) as string;
    const b = (verifiedUrl: string | null, rows: readonly { txHash?: string; explorerUrl: string }[], manifestUrl = `${base}/address/0xb2#code`) =>
      ({
        contracts: { chainId: 11_155_111, explorer: base, contracts: { PlanRegistry: { address: "0xa1", verifiedUrl, verified: true }, Treasury: { address: "0xb2", verifiedUrl: null, verified: false } } },
        manifest: { deployments: { d: { chainId: 11_155_111, contracts: { Treasury: { address: "0xb2", verifiedUrl: manifestUrl } } } } },
        rows: rows.map((r) => ({ taskId: "S1", ...r })),
      }) as unknown as Parameters<typeof explorerProblems>[0];
    expect(explorerProblems(b(`${base}/address/0xa1#code`, [{ txHash: "0x01", explorerUrl: `${base}/tx/0x01` }]))).toEqual([]);
    expect(explorerProblems(b(`${base}/address/0xb2#code`, []))).toHaveLength(1); // another real contract
    expect(explorerProblems(b(`${base}/address/0xa1`, []))).toHaveLength(1); // not the code page
    expect(explorerProblems(b(`${base}/token/0xa1#code`, []))).toHaveLength(1);
    expect(explorerProblems(b(null, [{ txHash: "0x01", explorerUrl: `${base}/tx/0x02` }]))).toHaveLength(1); // another real tx
    expect(explorerProblems(b(null, [{ explorerUrl: `${base}/tx/0x01` }]))).toHaveLength(1); // a link on a row with no tx
    expect(explorerProblems(b(null, [{ txHash: "0x01", explorerUrl: `${base}/tx/0x01?x=1` }]))).toHaveLength(1);
    expect(explorerProblems(b(null, [], `${base}/address/0xa1#code`))).toHaveLength(1); // the manifest names another contract
    const problems = explorerProblems(b(`${base}/address/0xb2#code`, [{ txHash: "0x01", explorerUrl: `${base}/tx/0x02` }]));
    expect(problems.join(" ")).not.toMatch(/0xb2#code|tx\/0x02/); // never echoed
  });

  it("the printed anchor and SUMMARY.md links come from the pinned explorer", () => {
    const b = loadBundle(fx.files).bundle;
    if (!b) throw new Error("the fixture does not load");
    const sepolia = { ...b, contracts: { ...b.contracts, chainId: 11_155_111, explorer: "https://sepolia.etherscan.io" } };
    const lines = anchorLines(anchorOf(sepolia)).join("\n");
    expect(lines).toContain("Anchor (compare with https://sepolia.etherscan.io)");
    expect(lines).toContain(`https://sepolia.etherscan.io/tx/${fx.commitTx.toLowerCase()}`);
    const summary = summaryMarkdown(summarySourceOf(sepolia));
    expect(summary).toContain(`https://sepolia.etherscan.io/address/${b.contracts.contracts.Treasury.address.toLowerCase()}#code`);
    expect(anchorOf(b).explorer).toBeNull();
  });
});

describe("re-check L3: the RPC URL is never echoed", () => {
  const SECRET = "s3cr3t-key";

  it("a bad or credentialed URL gets one fixed refusal", async () => {
    for (const url of [`https://user:${SECRET}@node.test`, `https://:${SECRET}@node.test`, `http://no de/${SECRET}`, `ftp://node.test/${SECRET}`, SECRET]) {
      const c = await verifyOnline(fx.files, url, { fetch: nodeOf(fx.files) });
      expect(c.ok).toBe(false);
      expect(c.detail).toContain(RPC_URL_REFUSAL);
      expect(JSON.stringify(c)).not.toContain(SECRET);
    }
    expect(parseRpcUrl(`https://sepolia.example/v3/${SECRET}`)?.href).toBe(`https://sepolia.example/v3/${SECRET}`);
  });

  it("a fetch error that quotes the URL, or a node error text, is reported by class and code only", async () => {
    const url = `https://sepolia.example/v3/${SECRET}`;
    const throwing = async () => {
      throw new TypeError(`Failed to parse URL from ${url}`);
    };
    const thrown = await verifyOnline(fx.files, url, { fetch: throwing });
    expect(thrown.detail).toMatch(/the node could not be read: TypeError/);
    expect(JSON.stringify(thrown)).not.toContain(SECRET);
    const echoing = async (_u: string, init: { body: string }) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: (JSON.parse(init.body) as { id: number }).id, error: { code: -32000, message: `bad key ${SECRET}` } }) });
    const node = await verifyOnline(fx.files, url, { fetch: echoing });
    expect(node.detail).toMatch(/eth_chainId: JSON-RPC error -32000/);
    expect(JSON.stringify(node)).not.toContain(SECRET);
  });

  it("the CLI reads HOGEE_VERIFY_RPC, refuses a bad URL before anything else, and never prints it", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { dirname, join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "hogee-rpc-"));
    try {
      for (const [path, body] of Object.entries(fx.files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), body);
      }
      const out: string[] = [];
      expect(await main([dir, "--json"], (l) => out.push(l), { fetch: nodeOf(fx.files) }, { [RPC_ENV]: `http://node.test/${SECRET}` })).toBe(0);
      expect(out.join("\n")).toMatch(/chain anchor \(online, --rpc\)/);
      const refused: string[] = [];
      expect(main([dir, "--rpc", `https://u:${SECRET}@node.test`], (l) => refused.push(l), { fetch: nodeOf(fx.files) }, {})).toBe(2);
      expect(main([dir], (l) => refused.push(l), { fetch: nodeOf(fx.files) }, { [RPC_ENV]: `not a url ${SECRET}` })).toBe(2);
      expect(refused.join("\n")).toContain(RPC_URL_REFUSAL);
      expect([...out, ...refused].join("\n")).not.toContain(SECRET);
      // Offline when neither is set (an empty variable counts as unset).
      expect(main([dir], () => undefined, undefined, { [RPC_ENV]: "" })).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
