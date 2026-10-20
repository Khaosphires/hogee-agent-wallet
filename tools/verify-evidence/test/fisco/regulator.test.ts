/**
 * The v2 regulator rules: each tampering of the ledger copy, the regulator's steps, the native receipts or the
 * probe-only rows fails the check that owns it (and a forger who keeps hashes.json consistent gets no further).
 */
import { encodeFunctionData, keccak256, toHex, type Hex } from "viem";
import { hashObject } from "@hogee/core";
import { iTreasuryAbi } from "@hogee/chain";
import { beforeAll, describe, expect, it } from "vitest";
import { FISCO_CHECKS, verifyFiscoPack, type SourceIdentity } from "../../src/fisco/index";
import { ACCOUNT_MANAGER_ABI, SYSTEM } from "../../src/fisco/system";
import { FKEYS, tag, word } from "./fixture";
import { buildPack } from "./fixture-steps";
import { edit, resign, txFile, type Files } from "./tamper";

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
const step = (v: { steps: { id: string }[] }, id: string) => v.steps.find((s) => s.id === id) as any;
const txPath = (id: string) => `txs/${(stepTx[id] as Hex).toLowerCase()}.json`;
const blockOfTx = (id: string): bigint => BigInt(JSON.parse(pack[txPath(id)] as string).block.number);
/** Edits node4's copy and recomputes node0Keccak, so only the rule under test can catch it. */
const editLedger = (files: Files, change: (l: any) => void) =>
  edit(files, "ledger.json", (l) => {
    change(l);
    l.node0Keccak = hashObject(l.blocks);
  });
/** Moves a step's tx to another block number (receipt, block and native receipt together). */
const moveTo = (files: Files, id: string, n: bigint) =>
  edit(files, txPath(id), (t) => {
    t.block.number = toHex(n);
    t.receipt.blockNumber = toHex(n);
    t.native.blockNumber = Number(n);
  });

describe("the v2 fixture", () => {
  it("passes all 15 checks, the regulator's two among them (13 before v2)", () => {
    const r = run(pack);
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.checks.map((c) => c.name)).toEqual(Object.values(FISCO_CHECKS));
    expect(r.checks).toHaveLength(15);
    expect(r.checks.slice(-2).map((c) => c.name)).toEqual(["regulator ledger", "regulator powers"]);
    // run-12 reworded the ok-line to what is proven offline (run12.test.ts pins the new text).
    expect(detailOf(pack, FISCO_CHECKS.ledger)).toMatch(/node0's digest of the same blocks was recorded at capture/);
    expect(detailOf(pack, FISCO_CHECKS.refusals)).toMatch(/3 probe-only calls passed/);
  });
});

describe("check: regulator ledger", () => {
  it("fails a dropped block, a broken parent link and a node0 digest that is off", () => {
    expect(failed(editLedger(pack, (l) => void l.blocks.splice(3, 1)))).toContain(FISCO_CHECKS.ledger);
    const parent = editLedger(pack, (l) => void (l.blocks[4].parentHash = keccak256(toHex("other"))));
    expect(failed(parent)).toEqual([FISCO_CHECKS.ledger]);
    expect(detailOf(parent, FISCO_CHECKS.ledger)).toMatch(/parentHash/);
    // FISCO's Web3 layer serves block 0 under another hash than the genesis hash block 1 names (P1's dry run, 20 Oct).
    expect(failed(editLedger(pack, (l) => void (l.blocks[1].parentHash = keccak256(toHex("native genesis")))))).toEqual([]);
    const off = edit(pack, "ledger.json", (l) => void (l.node0Keccak = keccak256(toHex("node0"))));
    expect(failed(off)).toEqual([FISCO_CHECKS.ledger]);
    expect(detailOf(off, FISCO_CHECKS.ledger)).toMatch(/differ from node0's/);
  });

  it("fails a head that is not chain.json's", () => {
    expect(failed(edit(pack, "chain.json", (c) => void (c.headHashAtEnd = keccak256(toHex("head")))))).toEqual([FISCO_CHECKS.ledger]);
    expect(failed(editLedger(pack, (l) => void l.blocks.pop()))).toContain(FISCO_CHECKS.ledger);
  });

  it("fails an extra agent tx before G0", () => {
    const extra = { hash: keccak256(toHex("early")), from: FKEYS.agent.address.toLowerCase(), to: SYSTEM.AccountManager, nonce: 0, inputKeccak: keccak256("0x"), receipt: { transactionIndex: 1, status: 1, gasUsed: "21000", logs: [] } };
    const files = editLedger(pack, (l) => void l.blocks[2].txs.push(extra));
    expect(failed(files)).toEqual([FISCO_CHECKS.ledger]);
    expect(detailOf(files, FISCO_CHECKS.ledger)).toMatch(/an agent tx before G0/);
  });

  it("fails a step whose receipt in node4's copy differs from txs/", () => {
    const s4 = (stepTx.S4 as Hex).toLowerCase();
    const files = editLedger(pack, (l) => {
      for (const b of l.blocks) for (const t of b.txs) if (t.hash === s4) t.receipt.status = 0;
    });
    expect(failed(files)).toEqual([FISCO_CHECKS.ledger]);
    expect(detailOf(files, FISCO_CHECKS.ledger)).toMatch(/receipt differs/);
  });

  it("fails an observer proposal that is not the one in node4's copy", () => {
    expect(failed(edit(pack, "chain.json", (c) => void (c.observerNode.proposalTx = keccak256(toHex("other")))))).toContain(FISCO_CHECKS.ledger);
    expect(failed(edit(pack, "chain.json", (c) => void (c.observerNode.proposalBlock = 2)))).toContain(FISCO_CHECKS.ledger);
  });
});

describe("check: regulator powers", () => {
  it("fails G1 re-signed to status 2 (abolish) and a G step re-signed by the agent", async () => {
    const abolish = await resign(pack, stepTx.G1 as Hex, FKEYS.regulator, (tx) => ({ ...tx, data: encodeFunctionData({ abi: ACCOUNT_MANAGER_ABI, functionName: "setAccountStatus", args: [FKEYS.agent.address, 2] }) }));
    const names = failed(abolish.files);
    expect(names).toContain(FISCO_CHECKS.powers);
    expect(names).toContain(FISCO_CHECKS.refusals);
    const byAgent = await resign(pack, stepTx.G4 as Hex, FKEYS.agent, (tx) => tx);
    expect(failed(byAgent.files)).toContain(FISCO_CHECKS.powers);
    expect(detailOf(byAgent.files, FISCO_CHECKS.powers)).toMatch(/G4: not signed by the regulator/);
  });

  it("fails a freeze whose native output is -51900 (trap 1: the account was never registered)", () => {
    const files = edit(pack, txPath("G1"), (t) => void (t.native.output = word(-51_900n)));
    const names = failed(files);
    expect(names).toContain(FISCO_CHECKS.powers);
    expect(names).toContain(FISCO_CHECKS.refusals);
    expect(detailOf(files, FISCO_CHECKS.powers)).toMatch(/G1: returned -51900/);
  });

  it("fails F1 before G1 and M1 before G5", () => {
    const late = moveTo(pack, "G1", blockOfTx("F1") + 1n);
    expect(failed(late)).toContain(FISCO_CHECKS.powers);
    expect(failed(late)).toContain(FISCO_CHECKS.refusals);
    const ban = moveTo(pack, "G5", blockOfTx("M1") + 1n);
    expect(failed(ban)).toContain(FISCO_CHECKS.powers);
    expect(failed(ban)).toContain(FISCO_CHECKS.refusals);
  });

  it("fails a probe of other calldata than R17's and a probe that did not pass", () => {
    const other = encodeFunctionData({ abi: iTreasuryAbi, functionName: "spend", args: [tag("PLATFORM_FEES"), tag("shopee-fees"), 1n, keccak256(toHex("inv")), 1, keccak256(toHex("d")), keccak256(toHex("r"))] });
    const files = edit(pack, "steps.json", (v) => void (step(v, "C1").call.data = other));
    expect(failed(files)).toEqual([FISCO_CHECKS.powers]);
    expect(detailOf(files, FISCO_CHECKS.powers)).toMatch(/C1: the probed calldata is not R17's/);
    const notOk = edit(pack, "steps.json", (v) => void (step(v, "C2").probe = { ok: false, error: "PermissionDenied" }));
    expect(failed(notOk)).toContain(FISCO_CHECKS.powers);
    expect(failed(notOk)).toContain(FISCO_CHECKS.refusals);
  });

  it("fails an auth admin that is not the regulator", () => {
    const files = edit(pack, "chain.json", (c) => void (c.auth.admin = FKEYS.lender.address.toLowerCase()));
    expect(failed(files)).toEqual([FISCO_CHECKS.powers]);
  });

  it("fails a missing G6 while C3 still probes ok", () => {
    const files = edit(pack, "steps.json", (v) => {
      v.steps = v.steps.filter((s: { id: string }) => s.id !== "G6").map((s: { seq: number }, i: number) => ({ ...s, seq: i + 1 }));
    });
    expect(failed(files)).toContain(FISCO_CHECKS.powers);
    expect(detailOf(files, FISCO_CHECKS.powers)).toMatch(/G6: the regulator's step is missing/);
  });

  it("fails final reads that leave the agent frozen", () => {
    const files = edit(pack, "steps.json", (v) => void (v.final.reads = v.final.reads.map((r: { label: string }) => (r.label === "agentAccountStatus" ? { ...r, value: "1" } : r))));
    expect(failed(files)).toContain(FISCO_CHECKS.powers);
    expect(failed(files)).toContain(FISCO_CHECKS.final);
  });

  it("fails a G3 whose admin read is not the regulator", () => {
    const files = edit(pack, "steps.json", (v) => void (step(v, "G3").reads[0].after = FKEYS.deployer.address.toLowerCase()));
    expect(failed(files)).toContain(FISCO_CHECKS.powers);
    expect(failed(files)).toContain(FISCO_CHECKS.refusals);
  });
});

describe("receipts: native status and system logs", () => {
  it("fails a contract refusal with native 0, F1 with native 16 and M1 with native 22", () => {
    for (const [id, status] of [["R7", 0], ["F1", 16], ["M1", 22]] as const) {
      const files = edit(pack, txPath(id), (t) => void (t.native.status = status));
      expect(failed(files), id).toContain(FISCO_CHECKS.receipts);
      expect(detailOf(files, FISCO_CHECKS.receipts), id).toMatch(new RegExp(`native status ${status}`));
    }
  });

  it("fails a missing native receipt and one of another block", () => {
    expect(failed(edit(pack, txPath("S4"), (t) => void (t.native = null)))).toContain(FISCO_CHECKS.receipts);
    expect(failed(edit(pack, txPath("S4"), (t) => void (t.native.blockNumber += 1)))).toContain(FISCO_CHECKS.receipts);
  });

  it("allows the proposal log on G3 only", () => {
    const g3 = JSON.parse(pack[txPath("G3")] as string).receipt.logs;
    expect(failed(edit(pack, txPath("G4"), (t) => void (t.receipt.logs = g3)))).toContain(FISCO_CHECKS.receipts);
    expect(failed(edit(pack, txPath("G3"), (t) => void (t.receipt.logs[0].topics = [keccak256(toHex("other"))])))).toContain(FISCO_CHECKS.receipts);
  });
});

describe("catalogue and refusals: probe-only rows and chain refusals", () => {
  it("fails probe-only on a step that is not a probe, and a probe recorded as sent", () => {
    const fake = edit(pack, "steps.json", (v) => {
      const s = step(v, "S4");
      s.outcome = { kind: "probe-only" };
      s.call = { from: FKEYS.lender.address.toLowerCase(), to: s.contract, data: "0x00", block: 1 };
    });
    expect(failed(fake)).toContain(FISCO_CHECKS.catalogue);
    const sent = edit(pack, "steps.json", (v) => {
      const s = step(v, "C1");
      delete s.call;
      s.outcome = { kind: "mined", txHash: stepTx.R17 };
    });
    expect(failed(sent)).toContain(FISCO_CHECKS.catalogue);
  });

  it("fails a probe-only step whose nonce moved", () => {
    expect(failed(edit(pack, "steps.json", (v) => void (step(v, "C3").nonce.after += 1)))).toContain(FISCO_CHECKS.txs);
  });

  it("fails a chain refusal whose probe reported another refusal, or that claims it was refused at the RPC", () => {
    expect(failed(edit(pack, "steps.json", (v) => void (step(v, "F1").probe.error = "PermissionDenied")))).toContain(FISCO_CHECKS.refusals);
    const rpc = edit(edit(pack, txPath("M1"), (t) => Object.assign(t, { tx: null, receipt: null, block: null, native: null })), "steps.json", (v) => {
      const s = step(v, "M1");
      s.outcome = { kind: "rpc-refused", txHash: s.outcome.txHash, rpcError: { code: 18, message: "Call permission denied" } };
      s.nonce.after = s.nonce.before;
    });
    expect(failed(rpc)).toContain(FISCO_CHECKS.refusals);
  });
});
