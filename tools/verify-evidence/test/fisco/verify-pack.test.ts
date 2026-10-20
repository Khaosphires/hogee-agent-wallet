/** verifyFiscoPack: the independent fixture pack passes every check; each tampering fails the check that owns it. */
import { encodeFunctionData, keccak256, toHex, type Hex } from "viem";
import { p256 } from "@noble/curves/p256";
import { hashObject } from "@hogee/core";
import { iMilestoneEscrowAbi, iTreasuryAbi } from "@hogee/chain";
import { beforeAll, describe, expect, it } from "vitest";
import { FISCO_CHECKS, verifyFiscoPack, type FiscoOptions, type SourceIdentity } from "../../src/fisco/index";
import { CODE_NAMES, creationInput, FKEYS, FSIDE, PARAMS, runtimeOf, slotValues, SSIDE, type Side } from "./fixture";
import { buildPack } from "./fixture-steps";
import { edit, reindex, resign, swap, txFile, type Files } from "./tamper";

let pack: Files;
let sourceFiles: Files;
let stepTx: Readonly<Record<string, Hex>>;
let identity: SourceIdentity;

beforeAll(async () => {
  const fx = await buildPack();
  pack = fx.files;
  sourceFiles = fx.source.files;
  stepTx = fx.stepTx;
  identity = fx.identity;
}, 60_000);

const opts = (o: Partial<FiscoOptions> = {}): FiscoOptions => ({ sepoliaBundle: sourceFiles, source: identity, ...o });
const run = (files: Files, o: Partial<FiscoOptions> = {}) => verifyFiscoPack(files, opts(o));
const failed = (files: Files, o: Partial<FiscoOptions> = {}) => run(files, o).checks.filter((c) => !c.ok).map((c) => c.name);
const detailOf = (files: Files, name: string) => run(files).checks.find((c) => c.name === name)?.detail ?? "";
const step = (v: { steps: { id: string }[] }, id: string) => v.steps.find((s) => s.id === id) as any;

/**
 * The run-11 C4 forgery: one shared constructor value (loosenTimelockSeconds) changed in the source broadcast AND,
 * consistently, in the FISCO Treasury deploy (re-signed by the deployer), deployment.json, code/ and code-sepolia/,
 * with broadcastKeccak and hashes.json recomputed (v2: and node4's ledger copy, input keccak and node0Keccak). Only a
 * pinned source broadcast tells it from the real one.
 */
async function forgeLoosen(files: Files, loosen: bigint): Promise<{ files: Files; broadcastKeccak: Hex }> {
  const params = { ...PARAMS, loosen };
  const fside: Side = { ...FSIDE, params };
  const sside: Side = { ...SSIDE, params };
  let out = swap(files, creationInput("Treasury", SSIDE), creationInput("Treasury", sside));
  const deployTx = JSON.parse(out["deployment.json"] as string).contracts.Treasury.deployTx as Hex;
  const [oldInput, newInput] = [creationInput("Treasury", FSIDE), creationInput("Treasury", fside)];
  const re = await resign(out, deployTx, FKEYS.deployer, (tx) => ({ ...tx, data: newInput }));
  out = swap(re.files, oldInput, newInput);
  out = edit(out, "ledger.json", (l) => {
    for (const b of l.blocks) for (const t of b.txs) if (t.hash === re.hash.toLowerCase()) t.inputKeccak = keccak256(newInput);
    l.node0Keccak = hashObject(l.blocks);
  });
  for (const [dir, side] of [["code", fside], ["code-sepolia", sside]] as const) for (const n of CODE_NAMES) out[`${dir}/${n}.hex`] = `${runtimeOf(n, slotValues(side, n))}\n`;
  const broadcastKeccak = keccak256(toHex(out["sepolia-broadcast.json"] as string));
  out = edit(out, "deployment.json", (d) => {
    d.params.loosenTimelockSeconds = String(loosen);
    d.sepolia.broadcastKeccak = broadcastKeccak;
  });
  return { files: out, broadcastKeccak };
}

describe("verifyFiscoPack: a valid pack", () => {
  it("passes every check", () => {
    const r = run(pack);
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.name)).toEqual(Object.values(FISCO_CHECKS));
    expect(r.packId).toMatch(/^fm-[0-9a-f]{16}$/);
  });

  it("says plainly what it does not recompute", () => {
    expect(detailOf(pack, FISCO_CHECKS.receipts)).toMatch(/header hashes are not recomputed/);
  });

  it("fails closed without the source bundle", () => {
    const r = verifyFiscoPack(pack, { source: identity });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === FISCO_CHECKS.t28)?.ok).toBe(false);
  });

  it("pins final-2 when no source identity is given (the CLI never passes one)", () => {
    expect(verifyFiscoPack(pack, { sepoliaBundle: sourceFiles }).ok).toBe(false);
  });

  it("says when the artifacts are the pack's own, not rebuilt", () => {
    expect(run(pack).checks.find((c) => c.name === FISCO_CHECKS.code)).toMatchObject({ ok: true, detail: expect.stringMatching(/artifacts from the pack, not rebuilt/) });
    const art = JSON.parse(pack["artifacts.json"] as string).contracts;
    expect(run(pack, { artifacts: art }).checks.find((c) => c.name === FISCO_CHECKS.code)).toMatchObject({ ok: true, detail: expect.stringMatching(/artifacts equal the local forge build/) });
  });

  it("compares the pack's artifacts with a local forge build when given", () => {
    const art = JSON.parse(pack["artifacts.json"] as string).contracts;
    expect(run(pack, { artifacts: art }).ok).toBe(true);
    const other = { ...art, SalesOracle: { ...art.SalesOracle, bytecode: `${art.SalesOracle.bytecode}00` } };
    expect(failed(pack, { artifacts: other })).toContain(FISCO_CHECKS.code);
  });
});

describe("check 1: pack files", () => {
  it("fails an unlisted, a missing and a modified file", () => {
    expect(failed(reindex({ ...pack, "notes.txt": "hi\n" }))).toContain(FISCO_CHECKS.files);
    const { "t28.json": _t, ...missing } = pack;
    expect(failed(reindex(missing))).toContain(FISCO_CHECKS.files);
    expect(failed({ ...pack, "chain.json": (pack["chain.json"] as string).replace('"nodeCount": 5', '"nodeCount": 4') })).toContain(FISCO_CHECKS.files);
  });

  it("fails an unknown key and a wrong pack id", () => {
    expect(failed(edit(pack, "chain.json", (c) => void (c.rpcUrl = "http://127.0.0.1:8545")))).toContain(FISCO_CHECKS.files);
    expect(failed(edit(pack, "pack.json", (p) => void (p.packId = "fm-0000000000000000")))).toContain(FISCO_CHECKS.files);
  });
});

describe("check 2: transactions", () => {
  it("fails a flipped calldata byte", () => {
    const h = stepTx.S4 as Hex;
    const raw = txFile(pack, h).rawSignedTx;
    const at = raw.length - 140;
    const flipped = `${raw.slice(0, at)}${raw[at] === "0" ? "1" : "0"}${raw.slice(at + 1)}`;
    expect(failed(swap(pack, raw, flipped))).toContain(FISCO_CHECKS.txs);
  });

  it("fails a type-2 tx and a tx signed for Sepolia's chain id", async () => {
    const h = stepTx.S4 as Hex;
    const t2 = await resign(pack, h, FKEYS.lender, (tx) => ({ ...tx, type: "eip1559", chainId: 20_200, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, gasPrice: undefined }));
    expect(failed(t2.files)).toContain(FISCO_CHECKS.txs);
    const sep = await resign(pack, h, FKEYS.lender, (tx) => ({ ...tx, chainId: 11_155_111 }));
    expect(failed(sep.files)).toContain(FISCO_CHECKS.txs);
  });

  it("fails a swapped signer role", () => {
    expect(failed(edit(pack, "steps.json", (v) => void (step(v, "S16").signerRole = "agent")))).toContain(FISCO_CHECKS.txs);
    expect(failed(edit(pack, "deployment.json", (d) => void ([d.roles.agent, d.roles.relayer] = [d.roles.relayer, d.roles.agent])))).toContain(FISCO_CHECKS.txs);
  });

  it("fails a served tx object whose hash, to, value, gas or chain id disagrees with the raw bytes (run-11b LOW-1)", () => {
    const path = `txs/${(stepTx.S4 as Hex).toLowerCase()}.json`;
    const tampers: [string, (t: any) => void][] = [
      ["hash", (t) => void (t.tx.hash = stepTx.S5)],
      ["to", (t) => void (t.tx.to = `0x${"11".repeat(20)}`)],
      ["to", (t) => void (t.tx.to = null)],
      ["value", (t) => void (t.tx.value = "0x1")],
      ["gas", (t) => void (t.tx.gas = "0x5208")],
      ["chainId", (t) => void (t.tx.chainId = "0xaa36a7")],
    ];
    for (const [field, change] of tampers) {
      const r = run(edit(pack, path, change));
      expect(r.ok).toBe(false);
      expect(r.checks.find((c) => c.name === FISCO_CHECKS.txs)?.detail).toContain(`served tx object disagrees with the raw bytes (${field}`);
    }
    const deployTx = JSON.parse(pack["deployment.json"] as string).contracts.PlanRegistry.deployTx as Hex;
    const created = run(edit(pack, `txs/${deployTx.toLowerCase()}.json`, (t) => void (t.tx.to = `0x${"22".repeat(20)}`)));
    expect(created.checks.find((c) => c.name === FISCO_CHECKS.txs)?.detail).toContain("disagrees with the raw bytes (to");
  });

  it("compares the served tx's to, value, gas and chain id only when served", () => {
    const path = `txs/${(stepTx.S4 as Hex).toLowerCase()}.json`;
    const bare = edit(pack, path, (t) => {
      for (const k of ["to", "value", "gas", "chainId"]) delete t.tx[k];
    });
    expect(failed(bare)).toEqual([]);
  });

  it("fails a nonce gap", async () => {
    const h = stepTx.S4 as Hex;
    const moved = await resign(pack, h, FKEYS.lender, (tx) => ({ ...tx, nonce: (tx.nonce as number) + 1 }));
    expect(failed(moved.files)).toContain(FISCO_CHECKS.txs);
  });
});

describe("check 3: receipts and blocks", () => {
  it("fails a status flip and a log on a reverted tx", () => {
    const path = `txs/${(stepTx.S4 as Hex).toLowerCase()}.json`;
    expect(failed(edit(pack, path, (t) => void (t.receipt.status = "0x0")))).toContain(FISCO_CHECKS.receipts);
    const r7 = `txs/${(stepTx.R7 as Hex).toLowerCase()}.json`;
    const s4 = JSON.parse(pack[path] as string);
    expect(failed(edit(pack, r7, (t) => void (t.receipt.logs = s4.receipt.logs)))).toContain(FISCO_CHECKS.receipts);
  });

  it("fails a millisecond timestamp and a block that does not hold the tx", () => {
    const path = `txs/${(stepTx.S10 as Hex).toLowerCase()}.json`;
    expect(failed(edit(pack, path, (t) => void (t.block.timestamp = toHex(BigInt(t.block.timestamp) * 1000n))))).toContain(FISCO_CHECKS.receipts);
    expect(failed(edit(pack, path, (t) => void (t.block.transactions = [`0x${"ab".repeat(32)}`])))).toContain(FISCO_CHECKS.receipts);
  });

  it("fails a log from a foreign address and a served bloom that disagrees", () => {
    const path = `txs/${(stepTx.S4 as Hex).toLowerCase()}.json`;
    expect(failed(edit(pack, path, (t) => void (t.receipt.logs[0].address = `0x${"99".repeat(20)}`)))).toContain(FISCO_CHECKS.receipts);
    expect(failed(edit(pack, path, (t) => void (t.receipt.logsBloom = `0x${"ff".repeat(256)}`)))).toContain(FISCO_CHECKS.receipts);
  });
});

describe("checks 4-5: deploy inputs and code identity", () => {
  it("fails constructor arguments that differ from the source broadcast", () => {
    const lender = JSON.parse(pack["deployment.json"] as string).roles.lender.slice(2) as string;
    const bad = (pack["sepolia-broadcast.json"] as string).replace(lender, "9".repeat(40));
    const files = edit({ ...pack, "sepolia-broadcast.json": bad }, "deployment.json", (d) => void (d.sepolia.broadcastKeccak = keccak256(toHex(bad))));
    expect(failed(files)).toContain(FISCO_CHECKS.deploy);
  });

  it("fails a broadcast copy whose keccak is not the one recorded", () => {
    expect(failed(reindex({ ...pack, "sepolia-broadcast.json": `${pack["sepolia-broadcast.json"]} ` }))).toContain(FISCO_CHECKS.deploy);
  });

  it("pins the source broadcast's path: a broadcastFile naming another (missing) run file fails", () => {
    const files = edit(pack, "deployment.json", (d) => void (d.sepolia.broadcastFile = String(d.sepolia.broadcastFile).replace(/run-[0-9]+\.json$/, "run-2.json")));
    expect(failed(files)).toEqual([FISCO_CHECKS.deploy]);
    expect(detailOf(files, FISCO_CHECKS.deploy)).toMatch(/pinned/);
  });

  it("pins the source broadcast's keccak256: other constructor values made consistent everywhere fail (run-11 C4)", async () => {
    const forged = await forgeLoosen(pack, 7_200n);
    // Internally consistent: it would verify against an identity that pinned the forged broadcast instead…
    expect(run(forged.files, { source: { ...identity, broadcastKeccak: forged.broadcastKeccak } }).checks.filter((c) => !c.ok)).toEqual([]);
    // …so the pin alone refuses it.
    expect(failed(forged.files)).toEqual([FISCO_CHECKS.deploy]);
    expect(detailOf(forged.files, FISCO_CHECKS.deploy)).toMatch(/pinned/);
  });

  it("fails a changed non-immutable byte, a length change and an unexplained immutable word", () => {
    const code = pack["code/Treasury.hex"] as string;
    expect(failed(reindex({ ...pack, "code/Treasury.hex": `${code.slice(0, 4)}ff${code.slice(6)}` }))).toContain(FISCO_CHECKS.code);
    expect(failed(reindex({ ...pack, "code/Treasury.hex": `${code.trim()}00\n` }))).toContain(FISCO_CHECKS.code);
    const art = JSON.parse(pack["artifacts.json"] as string).contracts.Treasury.immutableReferences as Record<string, { start: number }[]>;
    const start = (Object.values(art)[4]?.[0]?.start ?? 0) * 2 + 2;
    const forged = `${code.slice(0, start)}${"ab".repeat(32)}${code.slice(start + 64)}`;
    expect(failed(reindex({ ...pack, "code/Treasury.hex": forged }))).toContain(FISCO_CHECKS.code);
  });
});

describe("checks 6-7: plan and signatures", () => {
  it("fails a manifest edit", () => {
    expect(failed(edit(pack, "plan.json", (p) => void (p.manifest.lines[2].perTxCapMinor = "30000")))).toContain(FISCO_CHECKS.plan);
  });

  it("fails a false 'same as the source' claim", () => {
    expect(failed(edit(pack, "plan.json", (p) => void (p.sepoliaPlanHash = `0x${"12".repeat(32)}`)))).toContain(FISCO_CHECKS.plan);
    expect(failed(edit(pack, "plan.json", (p) => void (p.diffFromSepolia = ["/agent/address"])))).toContain(FISCO_CHECKS.plan);
  });

  it("fails a high-s passkey signature", async () => {
    const h = stepTx.S15 as Hex;
    const t = txFile(pack, h);
    const n = p256.CURVE.n;
    const data = (await import("viem")).parseTransaction(t.rawSignedTx).data as Hex;
    const { decodeFunctionData } = await import("viem");
    const [req, sig] = decodeFunctionData({ abi: iMilestoneEscrowAbi, data }).args as unknown as [Record<string, unknown>, { kind: number; data: Hex }];
    const { decodeAbiParameters, encodeAbiParameters } = await import("viem");
    const params = [{ type: "tuple", components: [{ name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }, { name: "challengeIndex", type: "uint256" }, { name: "typeIndex", type: "uint256" }, { name: "authenticatorData", type: "bytes" }, { name: "clientDataJSON", type: "string" }] }] as const;
    const [w] = decodeAbiParameters(params, sig.data);
    const high = encodeAbiParameters(params, [{ ...w, s: toHex(n - BigInt(w.s), { size: 32 }) }]);
    const forged = await resign(pack, h, FKEYS.relayer, (tx) => ({ ...tx, data: encodeFunctionData({ abi: iMilestoneEscrowAbi, functionName: "releaseMilestone", args: [req as never, { kind: 1, data: high }] }) }));
    expect(failed(forged.files)).toContain(FISCO_CHECKS.signatures);
  });

  it("fails a stage release the lender did not sign", async () => {
    const h = stepTx.S12 as Hex;
    const data = (await import("viem")).parseTransaction(txFile(pack, h).rawSignedTx).data as Hex;
    const { decodeFunctionData } = await import("viem");
    const [req] = decodeFunctionData({ abi: iTreasuryAbi, data }).args as unknown as [Record<string, unknown>];
    const sig = await FKEYS.agent.sign({ hash: keccak256(toHex("not the digest")) });
    const forged = await resign(pack, h, FKEYS.relayer, (tx) => ({ ...tx, data: encodeFunctionData({ abi: iTreasuryAbi, functionName: "releaseStage", args: [req as never, { kind: 0, data: sig }] }) }));
    expect(failed(forged.files)).toContain(FISCO_CHECKS.signatures);
  });

  it("fails a founder key that is not the registered one", () => {
    expect(failed(edit(pack, "deployment.json", (d) => void (d.founderKey.qx = `0x${"11".repeat(32)}`)))).toContain(FISCO_CHECKS.signatures);
  });
});

describe("check 8: mirror parity", () => {
  it("fails a mirrored call whose arguments differ from final-2's", async () => {
    const forged = await resign(pack, stepTx.S4 as Hex, FKEYS.lender, (tx) => ({ ...tx, data: encodeFunctionData({ abi: iTreasuryAbi, functionName: "fund", args: [999_999n] }) }));
    expect(failed(forged.files)).toContain(FISCO_CHECKS.parity);
  });

  it("fails a link to the wrong source tx", () => {
    expect(failed(edit(pack, "steps.json", (v) => void (step(v, "S4").links.sepoliaTx = step(v, "S1").links.sepoliaTx)))).toContain(FISCO_CHECKS.parity);
  });
});

describe("checks 9-10: refusals and recorded denials", () => {
  const refusedAtRpc = (v: any, id: string) => {
    const s = step(v, id);
    s.outcome = { kind: "rpc-refused", txHash: s.outcome.txHash, rpcError: { code: 16, message: "reverted" } };
    s.nonce.after = s.nonce.before;
  };
  const noReceipt = (files: Files, id: string) => edit(files, `txs/${(stepTx[id] as Hex).toLowerCase()}.json`, (t) => Object.assign(t, { tx: null, receipt: null, block: null, native: null }));

  it("fails a refusal whose reads changed, whose probe succeeded or whose nonce moved at the RPC", () => {
    expect(failed(edit(pack, "steps.json", (v) => void (step(v, "R7").reads[0].after = "30000")))).toContain(FISCO_CHECKS.refusals);
    expect(failed(edit(pack, "steps.json", (v) => void (step(v, "R7").probe = { ok: true })))).toContain(FISCO_CHECKS.refusals);
    const rpc = edit(noReceipt(pack, "R9b"), "steps.json", (v) => {
      refusedAtRpc(v, "R9b");
      step(v, "R9b").nonce.after += 1;
    });
    expect(failed(rpc)).toContain(FISCO_CHECKS.refusals);
  });

  it("accepts a refusal at the RPC only when the node's error names the derived error", () => {
    const atRpc = (message: string) =>
      edit(noReceipt(pack, "R9b"), "steps.json", (v) => {
        refusedAtRpc(v, "R9b");
        step(v, "R9b").outcome.rpcError.message = message;
      });
    expect(failed(atRpc("execution reverted: NotOwner()"))).not.toContain(FISCO_CHECKS.refusals);
    expect(failed(atRpc("reverted"))).toContain(FISCO_CHECKS.refusals);
    expect(failed(atRpc("execution reverted: Paused()"))).toContain(FISCO_CHECKS.refusals);
    expect(failed(atRpc("NotOwner, or else Paused"))).toContain(FISCO_CHECKS.refusals);
  });

  it("fails an expected refusal that succeeded (T28 accepted)", () => {
    const path = `txs/${(stepTx.T28a as Hex).toLowerCase()}.json`;
    // v2: a consistent forger also edits the native status (0 for a success).
    const accepted = edit(edit(pack, path, (t) => Object.assign(t.receipt, { status: "0x1" }) && Object.assign(t.native, { status: 0 })), "steps.json", (v) => void (step(v, "T28a").outcome.kind = "mined"));
    const names = failed(accepted);
    expect(names).toContain(FISCO_CHECKS.refusals);
    expect(names).toContain(FISCO_CHECKS.t28);
    expect(names).not.toContain(FISCO_CHECKS.receipts);
    // …and the regulator's copy of the ledger still says it reverted.
    expect(names).toContain(FISCO_CHECKS.ledger);
  });

  it("fails an error the offline rule does not derive", () => {
    expect(failed(edit(pack, "steps.json", (v) => void (step(v, "R7").expectedError = "Paused")))).toContain(FISCO_CHECKS.refusals);
  });

  it("fails a denial whose proposal hash is not the refused calldata", async () => {
    const forged = await resign(pack, stepTx.D7 as Hex, FKEYS.agent, (tx) => ({ ...tx, data: encodeFunctionData({ abi: iTreasuryAbi, functionName: "recordDenied", args: [`0x${Buffer.from("LOGISTICS").toString("hex").padEnd(64, "0")}`, keccak256(toHex("dd7")), `0x${Buffer.from("CapExceeded").toString("hex").padEnd(64, "0")}`, keccak256(toHex("other"))] }) }));
    expect(failed(forged.files)).toContain(FISCO_CHECKS.denials);
  });
});

describe("checks 11-12: T28 and final state", () => {
  it("fails a T28 copy that is not the source bundle's", () => {
    expect(failed(edit(pack, "t28.json", (t) => void (t.sepoliaSignature.refId = "order-other")))).toContain(FISCO_CHECKS.t28);
  });

  it("fails a T28a whose calldata is not the source tx's", async () => {
    const forged = await resign(pack, stepTx.T28a as Hex, FKEYS.relayer, (tx) => ({ ...tx, data: `${tx.data as string}00` }));
    expect(failed(forged.files)).toContain(FISCO_CHECKS.t28);
  });

  it("fails a source bundle that does not verify or is not the pinned one", () => {
    const bad = { ...sourceFiles, "plans.json": (sourceFiles["plans.json"] as string).replace('"version": 1', '"version": 1 ') };
    expect(failed(pack, { sepoliaBundle: bad })).toContain(FISCO_CHECKS.t28);
  });

  it("fails final reads that disagree with the events", () => {
    expect(failed(edit(pack, "steps.json", (v) => void (v.final.reads = v.final.reads.map((r: { label: string; value: string }) => (r.label === "paused" ? { ...r, value: "false" } : r)))))).toContain(FISCO_CHECKS.final);
  });
});
