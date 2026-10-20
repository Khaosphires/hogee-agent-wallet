/**
 * Audit run-12 rules (fix12-check): the ledger ok-line says only what is proven offline; chain.json's node counts are
 * the mirror's 5 nodes; the observer proposal is bound to chain-up (before the first deploy, at most headAtStart, the
 * regulator's nonce 0 with G0 its nonce 1); the regulator's key is none of the other roles'; steps mined in one block
 * follow seq order by transactionIndex; hashes.json and pack.json pins are own keys, never inherited ones. Each forgery
 * keeps hashes.json (and packId, node0Keccak) consistent, so only the rule under test can catch it.
 */
import { keccak256, toHex, type Hex } from "viem";
import { hashObject } from "@hogee/core";
import { beforeAll, describe, expect, it } from "vitest";
import { FISCO_CHECKS, verifyFiscoPack, type SourceIdentity } from "../../src/fisco/index";
import { packIdOf, ROLES } from "../../src/fisco/pack";
import { FKEYS } from "./fixture";
import { buildPack } from "./fixture-steps";
import { edit, reindex, resign, type Files } from "./tamper";

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

const run = (files: Files) => verifyFiscoPack(files, { sepoliaBundle: sourceFiles, source: identity });
const failed = (files: Files) => run(files).checks.filter((c) => !c.ok).map((c) => c.name);
const detailOf = (files: Files, name: string) => run(files).checks.find((c) => c.name === name)?.detail ?? "";
const txPath = (hash: string) => `txs/${hash.toLowerCase()}.json`;
const stepPath = (id: string) => txPath(stepTx[id] as Hex);
const step = (v: { steps: { id: string }[] }, id: string) => v.steps.find((s) => s.id === id) as any;
const editLedger = (files: Files, change: (l: any) => void) =>
  edit(files, "ledger.json", (l) => {
    change(l);
    l.node0Keccak = hashObject(l.blocks);
  });
const REGULATOR = FKEYS.regulator.address.toLowerCase();

describe("regulator ledger: the ok-line states what is proven offline", () => {
  it("says the pack's txs sit in node4's served copy and node0's digest was recorded at capture", () => {
    const detail = detailOf(pack, FISCO_CHECKS.ledger);
    expect(detail).toMatch(/^the pack's \d+ txs sit in node4's served copy of blocks 0\.\.\d+/);
    expect(detail).toMatch(/node0's digest of the same blocks was recorded at capture/);
    expect(detail).not.toMatch(/equal to node0's/);
  });
});

describe("chain.json node counts (the UI shows them as fact)", () => {
  it.each([
    ["nodeCount 4", { nodeCount: 4 }],
    ["sealerCount 5", { sealerCount: 5 }],
    ["observerCount 0", { observerCount: 0 }],
    ["6 nodes with 2 observers", { nodeCount: 6, observerCount: 2 }],
  ])("fails %s", (_what, counts) => {
    const files = edit(pack, "chain.json", (c) => Object.assign(c, counts));
    expect(failed(files)).toEqual([FISCO_CHECKS.ledger]);
    expect(detailOf(files, FISCO_CHECKS.ledger)).toMatch(/not the mirror's 5 nodes \(4 sealers, 1 observer\)/);
  });
});

describe("the observer proposal is bound to chain-up", () => {
  it("fails a proposal block after chain.json headAtStart", () => {
    const files = edit(pack, "chain.json", (c) => void (c.headAtStart = 0));
    expect(failed(files)).toContain(FISCO_CHECKS.ledger);
    expect(detailOf(files, FISCO_CHECKS.ledger)).toMatch(/the observer proposal \(block 1\) is after headAtStart 0/);
  });

  it("fails a proposal mined after the first deploy (blocks 1 and 2 swapped consistently)", () => {
    const deploy = JSON.parse(pack["deployment.json"] as string).contracts.PlanRegistry.deployTx as Hex;
    const ledger = JSON.parse(pack["ledger.json"] as string);
    const b1 = ledger.blocks[1];
    let files = editLedger(pack, (l) => void ([l.blocks[1].txs, l.blocks[2].txs] = [l.blocks[2].txs, l.blocks[1].txs]));
    files = edit(files, txPath(deploy), (t) => {
      const n = toHex(b1.number);
      t.block = { number: n, hash: b1.hash, parentHash: b1.parentHash, timestamp: toHex(b1.timestamp), transactions: [deploy] };
      Object.assign(t.receipt, { blockNumber: n, blockHash: b1.hash });
      Object.assign(t.tx, { blockNumber: n, blockHash: b1.hash });
      t.native.blockNumber = b1.number;
    });
    files = edit(files, "chain.json", (c) => void (c.observerNode.proposalBlock = 2));
    expect(failed(files)).toEqual([FISCO_CHECKS.ledger]);
    expect(detailOf(files, FISCO_CHECKS.ledger)).toMatch(/the observer proposal \(block 2\) is not before the first deploy \(block 1\)/);
  });

  it("fails a G0 that is not the regulator's nonce 1", async () => {
    const g0 = stepTx.G0 as Hex;
    const moved = await resign(pack, g0, FKEYS.regulator, (tx) => ({ ...tx, nonce: 2 }));
    let files = editLedger(moved.files, (l) => {
      for (const b of l.blocks) for (const t of b.txs) if (t.hash === moved.hash.toLowerCase()) t.nonce = 2;
    });
    files = edit(files, "steps.json", (v) => void (step(v, "G0").nonce = { before: 2, after: 3 }));
    expect(failed(files)).toContain(FISCO_CHECKS.ledger);
    expect(detailOf(files, FISCO_CHECKS.ledger)).toMatch(/G0 is the regulator's nonce 2, not 1/);
  });
});

describe("regulator powers: the regulator's key is its own", () => {
  it.each(ROLES.filter((r) => r !== "regulator"))("fails a regulator that is also the %s", (role) => {
    const files = edit(pack, "deployment.json", (d) => void (d.roles[role] = REGULATOR));
    expect(failed(files)).toContain(FISCO_CHECKS.powers);
    expect(detailOf(files, FISCO_CHECKS.powers)).toContain(`the regulator's address is also the ${role}'s`);
  });
});

describe("receipts and blocks: steps in one block follow seq order by transactionIndex", () => {
  /** Moves S12's tx into S11's block (receipts, logs, blocks and native receipt together), in the order given. */
  function sameBlock(files: Files, order: "seq" | "reversed"): Files {
    const [a, b] = [stepTx.S11 as Hex, stepTx.S12 as Hex];
    const blockA = JSON.parse(files[txPath(a)] as string).block;
    const list = order === "seq" ? [a, b] : [b, a];
    const at = (h: Hex) => toHex(list.indexOf(h));
    let out = edit(files, txPath(a), (t) => {
      t.block.transactions = list;
      t.receipt.transactionIndex = at(a);
    });
    out = edit(out, txPath(b), (t) => {
      t.block = { ...blockA, transactions: list };
      Object.assign(t.receipt, { blockNumber: blockA.number, blockHash: blockA.hash, transactionIndex: at(b) });
      for (const l of t.receipt.logs) Object.assign(l, { blockNumber: blockA.number, blockHash: blockA.hash });
      Object.assign(t.tx, { blockNumber: blockA.number, blockHash: blockA.hash });
      t.native.blockNumber = Number(BigInt(blockA.number));
    });
    return out;
  }

  it("accepts two steps in one block in seq order", () => {
    expect(failed(sameBlock(pack, "seq"))).not.toContain(FISCO_CHECKS.receipts);
  });

  it("fails a later step at a lower index of the same block", () => {
    const files = sameBlock(pack, "reversed");
    expect(failed(files)).toContain(FISCO_CHECKS.receipts);
    expect(detailOf(files, FISCO_CHECKS.receipts)).toMatch(/#\d+ S12: index 0 of block 0x[0-9a-f]+ is not after #\d+ S11's index 1/);
  });
});

describe("own keys only: an inherited name is never a listed or pinned file", () => {
  it("fails hashes.json listing a path the pack lacks, even one named like an Object property", () => {
    const hashes = JSON.parse(pack["hashes.json"] as string);
    hashes.files.toString = keccak256(toHex("x"));
    const files = { ...pack, "hashes.json": `${JSON.stringify(hashes, null, 2)}\n` };
    // A pack-files problem stops the pack there: every later check reads "not run".
    expect(failed(files)[0]).toBe(FISCO_CHECKS.files);
    expect(detailOf(files, FISCO_CHECKS.files)).toContain("toString is listed in hashes.json but missing");
  });

  it("fails pack.json pinning a source file the bundle lacks, even one named like an Object property", () => {
    const p = JSON.parse(pack["pack.json"] as string);
    p.sourceBundle.files.constructor = keccak256(toHex("x"));
    p.packId = packIdOf(p);
    const files = reindex({ ...pack, "pack.json": `${JSON.stringify(p, null, 2)}\n` });
    expect(failed(files)).toEqual([FISCO_CHECKS.t28]);
    expect(detailOf(files, FISCO_CHECKS.t28)).toContain("pack.json pins constructor, which the source bundle lacks");
  });
});

describe("code identity: each artifact's runtime code is the one its creation code carries", () => {
  const artifactsEdit = (files: Files, change: (c: any) => void) => edit(files, "artifacts.json", (a) => change(a.contracts));

  it("holds for the fixture: every deployedBytecode sits in its creation code, TreasuryGovernance's creation code in Treasury's", () => {
    const a = JSON.parse(pack["artifacts.json"] as string).contracts;
    for (const n of Object.keys(a)) expect(a[n].bytecode.slice(2)).toContain(a[n].deployedBytecode.slice(2));
    expect(a.Treasury.bytecode.slice(2)).toContain(a.TreasuryGovernance.bytecode.slice(2));
  });

  it("fails a creation code that does not carry its runtime code (TreasuryGovernance: no deploy tx pins it)", () => {
    const files = artifactsEdit(pack, (c) => void (c.TreasuryGovernance.bytecode = `0x60806040${"ab".repeat(40)}`));
    expect(failed(files)).toEqual([FISCO_CHECKS.code]);
    expect(detailOf(files, FISCO_CHECKS.code)).toContain("TreasuryGovernance: the creation bytecode does not carry its deployedBytecode");
  });

  it("fails a TreasuryGovernance creation code that Treasury's creation code does not carry", () => {
    const files = artifactsEdit(pack, (c) => void (c.TreasuryGovernance.bytecode = `0x60806041${c.TreasuryGovernance.deployedBytecode.slice(2)}`));
    expect(failed(files)).toEqual([FISCO_CHECKS.code]);
    expect(detailOf(files, FISCO_CHECKS.code)).toContain("Treasury's creation bytecode does not carry TreasuryGovernance's");
  });

  it("finds the runtime code only at a byte boundary", () => {
    const files = artifactsEdit(pack, (c) => void (c.TreasuryGovernance.bytecode = `0x6${c.TreasuryGovernance.deployedBytecode.slice(2)}0`));
    expect(detailOf(files, FISCO_CHECKS.code)).toContain("TreasuryGovernance: the creation bytecode does not carry its deployedBytecode");
  });
});
