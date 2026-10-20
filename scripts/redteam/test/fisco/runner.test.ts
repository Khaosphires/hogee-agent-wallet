import { buildPause, buildRecordDenied, buildSpend, lineKeyToLineId, shortIdToBytes32, toBytes32Tag } from "@hogee/chain";
import { encodeErrorResult, encodeFunctionData, keccak256, parseAbi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { catalogueEntry, type CatalogueEntry } from "../../../../tools/verify-evidence/src/fisco/catalogue";
import { Step, TxFile } from "../../../../tools/verify-evidence/src/fisco/pack";
import { ACCOUNT_MANAGER_ABI, CONTRACT_AUTH_ABI, SPEND_SELECTOR, SYSTEM } from "../../../../tools/verify-evidence/src/fisco/system";
import { NativeRpc, type NativeTransport } from "../../src/fisco/native-rpc";
import { FiscoRpc, GuardError, JsonRpcError, type Transport } from "../../src/fisco/rpc";
import { probeErrorOf, StepError, StepRunner, type ReadSpec } from "../../src/fisco/runner";
import { fakeNode, type FakeNode, type FakeNodeOptions } from "./fake-node";
import { errorString, FakeSystem } from "./fake-system";

const contracts = {
  PlanRegistry: "0xd9673db352e15db1f2f88420abe61798ccfd1a98",
  Treasury: "0xefd7b669fb86ecd4b22ded8cc8195fc07903a5e4",
  MilestoneEscrow: "0x5c379feafe01a3ccf649f9407f744cafc355e15f",
  SalesOracle: "0x3a93f8777bc11dffe0eb258c5383783d5fc849fb",
} as const;
const signers = {
  lender: privateKeyToAccount(generatePrivateKey()),
  oracle: privateKeyToAccount(generatePrivateKey()),
  agent: privateKeyToAccount(generatePrivateKey()),
  relayer: privateKeyToAccount(generatePrivateKey()),
  regulator: privateKeyToAccount(generatePrivateKey()),
};
const DEPLOYER = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
const fast = { receiptTimeoutMs: 1_000, pollMs: 1, sleep: async () => {} };
const entry = (id: string): CatalogueEntry => {
  const e = catalogueEntry(id);
  if (!e) throw new Error(`no ${id}`);
  return e;
};
const CAP = encodeErrorResult({ abi: parseAbi(["error CapExceeded()"]), errorName: "CapExceeded" });
const r7 = buildSpend({ lineId: lineKeyToLineId("LOGISTICS"), payeeId: shortIdToBytes32("spx-sg-logistics"), amountMinor: 30_000n, invoiceHash: keccak256("0x01"), planVersion: 1, decisionId: keccak256("0x02"), rationaleHash: keccak256("0x03") }).data;

function runner(opts: FakeNodeOptions, native?: NativeTransport) {
  const node = fakeNode(opts);
  return { node, runner: runnerOn(node, node, native) };
}
const runnerOn = (node: FakeNode, t: Transport = node, native?: NativeTransport) => new StepRunner(new FiscoRpc("http://127.0.0.1:8646", t), new NativeRpc(native ?? node.native), contracts, signers, fast);

function counter(): ReadSpec & { n: number } {
  const r = { label: "Treasury.pocket(LOGISTICS).spentMinor", n: 0, read: async () => String(r.n) };
  return r;
}

describe("StepRunner", () => {
  it("records an ok step as mined with the exact raw bytes it sent", async () => {
    const { runner: r } = runner({});
    const { step, tx: served } = await r.run({ entry: entry("S16"), data: buildPause().data, gas: 1_000_000n });
    const tx = TxFile.parse(served);
    expect(Step.parse(step).outcome.kind).toBe("mined");
    expect(tx.rawSource).toBe("sent");
    expect(keccak256(tx.rawSignedTx as Hex)).toBe(tx.hash);
    expect(step.nonce).toEqual({ before: 0, after: 1 });
    expect(step.reads).toEqual([]);
    expect(tx.block?.transactions).toEqual([tx.hash]);
  });

  it("records a refusal mined with status 0x0 (mined-reverted), its probe error and unchanged reads", async () => {
    const read = counter();
    const { runner: r } = runner({ probe: () => ({ revert: CAP }), send: () => "mine-revert" });
    const { step, tx } = await r.run({ entry: entry("R7"), data: r7, gas: 2_000_000n, reads: [read] });
    expect(Step.parse(step)).toMatchObject({ expected: "refused", expectedError: "CapExceeded", probe: { ok: false, error: "CapExceeded" }, outcome: { kind: "mined-reverted" } });
    expect(step.reads).toEqual([{ label: read.label, before: "0", after: "0" }]);
    expect(step.nonce).toEqual({ before: 0, after: 1 });
    expect(tx?.receipt?.status).toBe("0x0");
  });

  it("records a refusal the RPC refused (code 16, no receipt, nonce unmoved)", async () => {
    const { node, runner: r } = runner({ probe: () => ({ revert: CAP }), send: () => ({ refuse: { code: 16, message: "revert" } }) });
    const { step, tx } = await r.run({ entry: entry("R7"), data: r7, gas: 2_000_000n, reads: [counter()] });
    expect(step.outcome).toMatchObject({ kind: "rpc-refused", rpcError: { code: 16, message: "revert" } });
    expect(step.nonce).toEqual({ before: 0, after: 0 });
    expect(TxFile.parse(tx)).toMatchObject({ tx: null, receipt: null, block: null, rawSource: "sent" });
    expect(node.head).toBe(0);
  });

  it("never sends a refusal whose probe succeeds", async () => {
    const { node, runner: r } = runner({ probe: () => ({ ok: true }) });
    await expect(r.run({ entry: entry("R7"), data: r7, gas: 2_000_000n })).rejects.toThrow(/probe of an expected refusal succeeded/);
    expect(node.methods).not.toContain("eth_sendRawTransaction");
  });

  it("never sends a refusal whose probe fails with another error than the step's expected one (post-fix re-check)", async () => {
    const PAUSED = encodeErrorResult({ abi: parseAbi(["error Paused()"]), errorName: "Paused" });
    for (const probe of [() => ({ revert: PAUSED }), () => ({ error: new JsonRpcError(-32000, "out of gas", null) })]) {
      const { node, runner: r } = runner({ probe });
      await expect(r.run({ entry: entry("R7"), data: r7, gas: 2_000_000n, reads: [counter()] })).rejects.toThrow(/R7: the probe of an expected refusal failed with (Paused|rpc -32000: out of gas), not CapExceeded; not sent/);
      expect(node.methods).not.toContain("eth_sendRawTransaction");
      expect(r.steps).toEqual([]);
    }
    // The step's own expected error (c.expectedError, T28a's derived one) is the one compared, not the catalogue's.
    const { node, runner: r } = runner({ probe: () => ({ revert: CAP }) });
    await expect(r.run({ entry: entry("R7"), data: r7, gas: 2_000_000n, expectedError: "Paused" })).rejects.toThrow(/failed with CapExceeded, not Paused; not sent/);
    await expect(r.run({ entry: { ...entry("R7"), expectedError: undefined }, data: r7, gas: 2_000_000n })).rejects.toThrow(/not \(no expected error\); not sent/);
    expect(node.methods).not.toContain("eth_sendRawTransaction");
    const { runner: paused } = runner({ probe: () => ({ revert: PAUSED }), send: () => "mine-revert" });
    const { step } = await paused.run({ entry: entry("R7"), data: r7, gas: 2_000_000n, expectedError: "Paused" });
    expect(step).toMatchObject({ expectedError: "Paused", probe: { ok: false, error: "Paused" }, outcome: { kind: "mined-reverted" } });
  });

  it("stops when an expected refusal is mined successfully", async () => {
    let probed = 0;
    const { runner: r } = runner({ probe: () => (probed++ === 0 ? { revert: CAP } : { ok: true }), send: () => "mine-ok" });
    await expect(r.run({ entry: entry("R7"), data: r7, gas: 2_000_000n })).rejects.toThrow(/expected refusal was mined/);
  });

  it("stops when an ok step reverts", async () => {
    const { runner: r } = runner({ send: () => "mine-revert" });
    await expect(r.run({ entry: entry("S16"), data: buildPause().data, gas: 1_000_000n })).rejects.toThrow(StepError);
  });

  it("refuses calldata of another function than the catalogue's", async () => {
    const { node, runner: r } = runner({});
    await expect(r.run({ entry: entry("S16"), data: r7, gas: 1_000_000n })).rejects.toThrow(/calls spend/);
    expect(node.methods).toEqual([]);
  });

  it("refuses to send on another chain", async () => {
    const { runner: r } = runner({ chainId: "0x1" });
    await expect(r.run({ entry: entry("S16"), data: buildPause().data, gas: 1_000_000n })).rejects.toThrow(/not the FISCO mirror/);
  });

  it("fails the run, recording nothing, when the pre-send chain check answers a JSON-RPC error (run-11 H-replay)", async () => {
    const node = fakeNode({ probe: () => ({ revert: CAP }) });
    const t: Transport = async (m, p) => {
      if (m === "eth_chainId") throw new JsonRpcError(16, "node busy", null);
      return node(m, p);
    };
    const r = runnerOn(node, t);
    await expect(r.run({ entry: entry("R7"), data: r7, gas: 2_000_000n, reads: [counter()] })).rejects.toThrow(GuardError);
    expect(r.steps).toEqual([]);
    expect(node.methods).not.toContain("eth_sendRawTransaction");
  });

  it("refuses a late receipt (send refused, receipt found) whose status is neither 0x1 nor 0x0", async () => {
    const node = fakeNode({ probe: () => ({ revert: CAP }), send: () => "mine-revert" });
    const t: Transport = async (m, p) => {
      if (m !== "eth_sendRawTransaction") return node(m, p);
      const hash = String(await node(m, p));
      node.receipts.set(hash, { ...node.receipts.get(hash), status: "0x2" });
      throw new JsonRpcError(16, "late", null);
    };
    const r = runnerOn(node, t);
    await expect(r.run({ entry: entry("R7"), data: r7, gas: 2_000_000n })).rejects.toThrow(/status 0x2/);
    expect(r.steps).toEqual([]);
  });

  // A refusal is now sent only when its probe names the expected error, so a node's free-text probe error reaches
  // steps.json through an expected-ok step (still sent when its probe fails: a time-gated call), and the refusal text
  // through a refusal whose probe named its error.
  it("strips control characters from node-supplied probe and refusal text before it reaches steps.json", async () => {
    const { runner: r } = runner({ probe: () => ({ revert: CAP }), send: () => ({ refuse: { code: 16, message: "no\u001b]0;title\u0007pe" } }) });
    const tag: ReadSpec = { label: "PlanRegistry.chainTag()", read: async () => "fis\u001b[1mco" };
    const { step } = await r.run({ entry: entry("R7"), data: r7, gas: 2_000_000n, reads: [tag] });
    expect(step.reads).toEqual([{ label: tag.label, before: "fis?[1mco", after: "fis?[1mco" }]);
    expect(step.outcome.rpcError?.message).toBe("no?]0;title?pe");
    const { runner: ok } = runner({ probe: () => ({ error: new JsonRpcError(-32000, "bad\u001b[2J\nthing", null) }) });
    const { step: s16 } = await ok.run({ entry: entry("S16"), data: buildPause().data, gas: 1_000_000n });
    expect(s16.probe.error).toBe("rpc -32000: bad?[2J?thing");
  });

  it("cleans an OSC title sequence and CR/LF in node errors (probe.error, outcome.rpcError.message; P1 / audit critic)", async () => {
    const { runner: r } = runner({ probe: () => ({ revert: CAP }), send: () => ({ refuse: { code: 16, message: "refused\u001b]0;x\u0007\r\nok" } }) });
    const { step } = await r.run({ entry: entry("R7"), data: r7, gas: 2_000_000n });
    expect(step.outcome.rpcError?.message).toBe("refused?]0;x???ok");
    expect(JSON.stringify(step)).not.toMatch(/\\u001b|\\u0007|\\r|\\n/);
    const { runner: ok } = runner({ probe: () => ({ error: new JsonRpcError(3, "reverted\u001b]0;x\u0007\r\n#9 S15 mined", null) }) });
    const { step: s16 } = await ok.run({ entry: entry("S16"), data: buildPause().data, gas: 1_000_000n });
    expect(s16.probe.error).toBe("rpc 3: reverted?]0;x???#9 S15 mined");
    expect(JSON.stringify(s16)).not.toMatch(/\\u001b|\\u0007|\\r|\\n/);
  });

  it("snapshots reads at the current block", async () => {
    const { runner: r } = runner({});
    expect(await r.snapshot([counter()])).toEqual({ block: 0, reads: [{ label: "Treasury.pocket(LOGISTICS).spentMinor", value: "0" }] });
  });
});

describe("StepRunner: native receipts, the regulator's calls and probe-only steps (pack v2)", () => {
  const agent = signers.agent.address.toLowerCase();
  const regulator = signers.regulator.address.toLowerCase();
  const sysNode = (opts: FakeNodeOptions = {}) => fakeNode({ ...opts, system: new FakeSystem(regulator, DEPLOYER) });
  const spend = buildSpend({ lineId: lineKeyToLineId("PLATFORM_FEES"), payeeId: shortIdToBytes32("shopee-sg-fees"), amountMinor: 10_000n, invoiceHash: keccak256("0x01"), planVersion: 1, decisionId: keccak256("0x02"), rationaleHash: keccak256("0x03") }).data;
  const account = (status: number) => encodeFunctionData({ abi: ACCOUNT_MANAGER_ABI, functionName: "setAccountStatus", args: [agent as Hex, status] });
  const confirm = encodeFunctionData({ abi: ACCOUNT_MANAGER_ABI, functionName: "getAccountStatus", args: [agent as Hex] });

  it("keeps each mined tx's native receipt (retried until served): status 0 for mined, 16 for a contract revert", async () => {
    const node = fakeNode({ probe: () => ({ revert: CAP }), send: () => (node.head === 0 ? "mine-ok" : "mine-revert"), nativeLag: 2 });
    const r = runnerOn(node);
    const ok = await r.run({ entry: entry("S16"), data: buildPause().data, gas: 1_000_000n });
    expect(TxFile.parse(ok.tx).native).toMatchObject({ status: 0, transactionHash: ok.tx?.hash, blockNumber: 1, output: "0x" });
    const refused = await r.run({ entry: entry("R7"), data: r7, gas: 2_000_000n });
    expect(refused.tx?.native).toMatchObject({ status: 16, blockNumber: 2 });
    expect(node.native.hashes.filter((h) => h === ok.tx?.hash)).toHaveLength(3);
  });

  it("stops when the native receipt disagrees with the Web3 receipt (status or block)", async () => {
    for (const lie of [{ status: 16 }, { blockNumber: 9 }]) {
      const node = fakeNode({});
      const native: NativeTransport = async (body) => {
        const a = (await node.native(body)) as { result: Record<string, unknown> | null };
        return { ...a, result: a.result ? { ...a.result, ...lie } : null };
      };
      await expect(runnerOn(node, node, native).run({ entry: entry("S16"), data: buildPause().data, gas: 1_000_000n })).rejects.toThrow(/native receipt/);
    }
  });

  it("names the chain's own probe refusals by JSON-RPC code: 22 AccountFrozen, 18 PermissionDenied", () => {
    expect(probeErrorOf(new JsonRpcError(22, "", errorString("Account's status is abnormal")))).toBe("AccountFrozen");
    expect(probeErrorOf(new JsonRpcError(18, "", errorString("Call permission denied")))).toBe("PermissionDenied");
    expect(probeErrorOf(new JsonRpcError(3, "execution reverted", CAP))).toBe("CapExceeded");
  });

  it("sends the regulator's allow-listed system call to its fixed address, and refuses any other system function unsent", async () => {
    const node = sysNode();
    const r = runnerOn(node);
    const { step, tx } = await r.run({ entry: entry("G0"), data: account(0), gas: 3_000_000n, checkProbe: () => {} });
    expect(step).toMatchObject({ contract: "AccountManager", signerRole: "regulator", outcome: { kind: "mined" } });
    expect(String(tx?.receipt?.to)).toBe(SYSTEM.AccountManager);
    expect(tx?.native).toMatchObject({ status: 0, output: `0x${"0".repeat(64)}` });
    const isGovernor = encodeFunctionData({ abi: parseAbi(["function isGovernor(address) view returns (bool)"]), functionName: "isGovernor", args: [regulator as Hex] });
    const before = node.methods.length;
    await expect(r.run({ entry: entry("G0"), data: isGovernor, gas: 3_000_000n })).rejects.toThrow(/allow-listed AccountManager/);
    await expect(r.run({ entry: entry("G1"), data: confirm, gas: 3_000_000n })).rejects.toThrow(/calls getAccountStatus, the catalogue says setAccountStatus/);
    expect(node.methods.length).toBe(before);
  });

  it("stops a governance step unsent when its probe fails or checkProbe refuses the return value", async () => {
    const node = sysNode();
    const r = runnerOn(node);
    await expect(r.run({ entry: entry("G1"), data: account(1), gas: 3_000_000n, checkProbe: () => { throw new StepError("output -51900, not 0"); } })).rejects.toThrow(/-51900/);
    const banned = encodeFunctionData({ abi: CONTRACT_AUTH_ABI, functionName: "setMethodAuthType", args: [contracts.Treasury, SPEND_SELECTOR, 2] });
    const failing: Transport = async (m, p) => (m === "eth_call" ? Promise.reject(new JsonRpcError(-32000, "no", null)) : node(m, p));
    await expect(runnerOn(node, failing).run({ entry: entry("G4"), data: banned, gas: 3_000_000n, checkProbe: () => {} })).rejects.toThrow(/probe failed/);
    expect(node.methods).not.toContain("eth_sendRawTransaction");
    expect(r.steps).toEqual([]);
  });

  it("records a frozen agent's spend as mined 0x0 with native 22, its nonce consumed (F1 after G0, G1, V1)", async () => {
    const node = sysNode();
    const r = runnerOn(node);
    await r.run({ entry: entry("G0"), data: account(0), gas: 3_000_000n, checkProbe: () => {} });
    await r.run({ entry: entry("G1"), data: account(1), gas: 3_000_000n, checkProbe: () => {} });
    const v1 = await r.run({ entry: entry("V1"), data: confirm, gas: 3_000_000n, checkProbe: () => {} });
    expect(BigInt(String(v1.tx?.native?.output))).toBe(1n);
    const { step, tx } = await r.run({ entry: entry("F1"), data: spend, gas: 2_000_000n });
    expect(step).toMatchObject({ expectedError: "AccountFrozen", probe: { ok: false, error: "AccountFrozen" }, outcome: { kind: "mined-reverted" }, nonce: { before: 0, after: 1 } });
    expect(tx?.native).toMatchObject({ status: 22, output: errorString("Account's status is abnormal") });
    expect(tx?.receipt?.logs).toEqual([]);
  });

  it("probe-only: records the exact call and its block, sends nothing, the nonce unchanged", async () => {
    const node = sysNode();
    const r = runnerOn(node);
    await r.run({ entry: entry("G0"), data: account(0), gas: 3_000_000n, checkProbe: () => {} });
    const sends = node.methods.filter((m) => m === "eth_sendRawTransaction").length;
    const status: ReadSpec = { label: "accountStatus", read: async () => "0" };
    const { step, tx } = await r.run({ entry: entry("C1"), data: spend, gas: 2_000_000n, reads: [status] });
    expect(tx).toBeNull();
    expect(Step.parse(step)).toMatchObject({ outcome: { kind: "probe-only" }, probe: { ok: true }, call: { from: agent, to: contracts.Treasury, data: spend, block: 1 }, nonce: { before: 0, after: 0 }, reads: [{ label: "accountStatus", before: "0", after: "0" }] });
    expect(step.outcome.txHash).toBeUndefined();
    expect(node.methods.filter((m) => m === "eth_sendRawTransaction")).toHaveLength(sends);
    expect(r.txs.size).toBe(1);
  });

  it("probe-only: a failing probe stops the run and records nothing (C2 while the agent is frozen)", async () => {
    const node = sysNode();
    const r = runnerOn(node);
    await r.run({ entry: entry("G0"), data: account(0), gas: 3_000_000n, checkProbe: () => {} });
    await r.run({ entry: entry("G1"), data: account(1), gas: 3_000_000n, checkProbe: () => {} });
    await r.run({ entry: entry("V1"), data: confirm, gas: 3_000_000n, checkProbe: () => {} });
    const denied = buildRecordDenied({ lineId: lineKeyToLineId("PLATFORM_FEES"), decisionId: keccak256("0x05"), reasonCode: toBytes32Tag("PermissionDenied"), proposalHash: keccak256(spend) }).data;
    await expect(r.run({ entry: entry("C2"), data: denied, gas: 2_000_000n })).rejects.toThrow(/probe-only call failed \(AccountFrozen\)/);
    expect(r.steps.map((s) => s.id)).toEqual(["G0", "G1", "V1"]);
  });
});
