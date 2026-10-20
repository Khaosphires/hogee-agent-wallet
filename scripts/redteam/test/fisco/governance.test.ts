/**
 * The regulator's stops on the fake FISCO node (fake-system.ts emulates AccountManager 0x10003, ContractAuth 0x1005 and
 * CommitteeManager 0x10001 as P1 saw them live): the catalogue's G/V/F/M/C steps through the real StepRunner and
 * governance.ts, in catalogue order, with the same SPEND bytes for F1, C1, M1 and C3.
 */
import { buildRecordDenied, buildSpend, lineKeyToLineId, shortIdToBytes32, toBytes32Tag } from "@hogee/chain";
import { decodeFunctionData, encodeFunctionResult, keccak256, toFunctionSelector, type Abi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { CATALOGUE, catalogueEntry, type CatalogueEntry } from "../../../../tools/verify-evidence/src/fisco/catalogue";
import { COMMITTEE_MANAGER_ABI, CONTRACT_AUTH_ABI, SPEND_SELECTOR, SYSTEM } from "../../../../tools/verify-evidence/src/fisco/system";
import { chainStepReads, checkChainStep, checkGovResult, govData, govStepCall, ScenarioError, type GovContext } from "../../src/fisco/governance";
import { NativeRpc, type NativeTransport } from "../../src/fisco/native-rpc";
import { Reader } from "../../src/fisco/reads";
import { FiscoRpc, type Transport } from "../../src/fisco/rpc";
import { StepRunner, type ReadSpec, type StepCall, type StepResult } from "../../src/fisco/runner";
import { fakeNode, type FakeNode } from "./fake-node";
import { FakeSystem } from "./fake-system";

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
const DEPLOYER = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Hex;
const AGENT = signers.agent.address.toLowerCase() as Hex;
const REGULATOR = signers.regulator.address.toLowerCase() as Hex;
const fast = { receiptTimeoutMs: 1_000, pollMs: 1, sleep: async () => {} };
const entry = (id: string): CatalogueEntry => catalogueEntry(id) as CatalogueEntry;
/** R17's spend (SPEND), built once. */
const SPEND = buildSpend({ lineId: lineKeyToLineId("PLATFORM_FEES"), payeeId: shortIdToBytes32("shopee-sg-fees"), amountMinor: 10_000n, invoiceHash: keccak256("0x01"), planVersion: 1, decisionId: keccak256("0x02"), rationaleHash: keccak256("0x03") }).data;
/** R17's three reads, stubbed (the fake node runs no Hogee contract). */
const SPEND_READS: ReadSpec[] = [{ label: "Treasury.paused()", read: async () => "false" }];
/** The steps from G0 to C3 that the regulator's story needs, in catalogue order. */
const STORY = CATALOGUE.filter((e) => e.governance || ["F1", "M1", "C1", "C2", "C3"].includes(e.id)).map((e) => e.id);

interface Rig {
  readonly node: FakeNode;
  readonly runner: StepRunner;
  readonly ctx: GovContext;
}

function rig(o: { governor?: string; t?: (node: FakeNode) => Transport; native?: (node: FakeNode) => NativeTransport } = {}): Rig {
  const node = fakeNode({ system: new FakeSystem(o.governor ?? REGULATOR, DEPLOYER) });
  const t = o.t?.(node) ?? node;
  const rpc = new FiscoRpc("http://127.0.0.1:8646", t);
  const runner = new StepRunner(rpc, new NativeRpc(o.native?.(node) ?? node.native), contracts, signers, fast);
  return { node, runner, ctx: { reader: new Reader(rpc, contracts), agent: AGENT, regulator: REGULATOR, deployer: DEPLOYER } };
}

function callOf(e: CatalogueEntry, ctx: GovContext): StepCall {
  if (e.governance) return govStepCall(e, ctx);
  if (e.id === "C2") {
    const data = buildRecordDenied({ lineId: lineKeyToLineId("PLATFORM_FEES"), decisionId: keccak256("0x05"), reasonCode: toBytes32Tag("PermissionDenied"), proposalHash: keccak256(SPEND) }).data;
    return { entry: e, data, gas: 2_000_000n, reads: chainStepReads(e, [], ctx) };
  }
  return { entry: e, data: SPEND, gas: 2_000_000n, reads: chainStepReads(e, SPEND_READS, ctx) };
}

/** Runs one step as scenario.ts does: the runner, then the governance and chain-step checks. */
async function step(r: Rig, id: string): Promise<StepResult> {
  const e = entry(id);
  const result = await r.runner.run(callOf(e, r.ctx));
  if (e.governance) checkGovResult(e, result, r.ctx);
  checkChainStep(e, result);
  return result;
}

async function story(r: Rig, ids: readonly string[] = STORY): Promise<Map<string, StepResult>> {
  const out = new Map<string, StepResult>();
  for (const id of ids) out.set(id, await step(r, id));
  return out;
}

const sends = (node: FakeNode): number => node.methods.filter((m) => m === "eth_sendRawTransaction").length;

describe("governance.ts: G/V calldata from the catalogue's symbolic arguments", () => {
  const { ctx } = rig();
  it("resolves agent, regulator, Treasury, spend.selector and literal numbers", () => {
    const g3 = decodeFunctionData({ abi: COMMITTEE_MANAGER_ABI as Abi, data: govData(entry("G3"), ctx) });
    expect(g3).toMatchObject({ functionName: "createResetAdminProposal", args: [signers.regulator.address, expect.stringMatching(/^0x/i), 1000n] });
    expect(String(g3.args?.[1]).toLowerCase()).toBe(contracts.Treasury);
    const g5 = decodeFunctionData({ abi: CONTRACT_AUTH_ABI as Abi, data: govData(entry("G5"), ctx) });
    expect(g5.functionName).toBe("closeMethodAuth");
    expect((g5.args as unknown[]).map((a) => String(a).toLowerCase())).toEqual([contracts.Treasury, SPEND_SELECTOR, AGENT]);
    expect(() => govData(entry("S1"), ctx)).toThrow(ScenarioError);
  });
});

describe("the regulator's three stops on the fake chain (G0 … C3)", () => {
  it("freezes, confirms, refuses F1 at chain level (22), unfreezes, bans spend, refuses M1 (18), lets C2 pass, lifts the ban", async () => {
    const r = rig();
    const res = await story(r);
    expect([...res.keys()]).toEqual(["G0", "G1", "V1", "F1", "G2", "V2", "C1", "G3", "G4", "G5", "M1", "C2", "G6", "C3"]);
    const f1 = res.get("F1") as StepResult;
    const m1 = res.get("M1") as StepResult;
    expect(f1.step).toMatchObject({ probe: { ok: false, error: "AccountFrozen" }, outcome: { kind: "mined-reverted" } });
    expect(f1.tx?.native?.status).toBe(22);
    expect(m1.step).toMatchObject({ probe: { ok: false, error: "PermissionDenied" }, outcome: { kind: "mined-reverted" } });
    expect(m1.tx?.native?.status).toBe(18);
    // One SPEND: F1 and M1 sent, C1 and C3 probed, byte for byte.
    const sent = (x: StepResult) => (r.node.txs.get(String(x.tx?.hash)) as { input: string }).input;
    expect([sent(f1), sent(m1), res.get("C1")?.step.call?.data, res.get("C3")?.step.call?.data]).toEqual([SPEND, SPEND, SPEND, SPEND]);
    // Block order: G1 < V1 < F1 < G2 < V2 ≤ C1 < G3 < G4 < G5 < M1 ≤ C2 < G6 ≤ C3.
    const block = (id: string): number => (res.get(id)?.tx ? Number(res.get(id)?.tx?.native?.blockNumber) : Number(res.get(id)?.step.call?.block));
    const order = ["G1", "V1", "F1", "G2", "V2", "G3", "G4", "G5", "M1", "G6"].map(block);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(block("C1")).toBe(block("V2"));
    expect(block("C2")).toBe(block("M1"));
    expect(block("C3")).toBe(block("G6"));
    expect(res.get("G3")?.step.reads).toEqual([{ label: "treasuryAdmin", before: DEPLOYER, after: REGULATOR }]);
    expect(res.get("G1")?.step.reads).toEqual([]);
    expect(res.get("V1")?.step.reads).toEqual([{ label: "accountStatus", before: "0", after: "1" }]);
    // The agent's nonce: F1 and M1 consumed one each; the probe-only steps none.
    expect(r.node.nonces.get(AGENT)).toBe(2);
  });

  it("stops before sending when a freeze would return -51900 (trap 1: the agent sent a tx before G0 registered it)", async () => {
    const r = rig();
    await r.node("eth_sendRawTransaction", [await signers.agent.signTransaction({ type: "legacy", chainId: 20_200, nonce: 0, gas: 2_000_000n, gasPrice: 0n, to: contracts.Treasury, data: "0x01" })]);
    const before = sends(r.node);
    await expect(step(r, "G1")).rejects.toThrow(/G1: the eth_call before sending returned -51900, expected 0/);
    expect(sends(r.node)).toBe(before);
  });

  it("stops before sending when the regulator is not the chain's governor (-50000)", async () => {
    const r = rig({ governor: DEPLOYER });
    await expect(step(r, "G0")).rejects.toThrow(/returned -50000, expected 0/);
    expect(sends(r.node)).toBe(0);
  });

  it("stops when the native output is not the catalogue's (a G step answering 1 after mining)", async () => {
    const r = rig({
      native: (node) => async (body) => {
        const a = (await node.native(body)) as { result: Record<string, unknown> | null };
        return a.result ? { ...a, result: { ...a.result, output: `0x${"0".repeat(63)}1` } } : a;
      },
    });
    await expect(step(r, "G0")).rejects.toThrow(/G0: the native receipt output returned 1, expected 0/);
  });

  it("stops when V1 does not read the account frozen on chain (G1 skipped)", async () => {
    const r = rig();
    await story(r, ["G0"]);
    await expect(step(r, "V1")).rejects.toThrow(/V1: the native receipt output returned 0, expected 1/);
  });

  it("stops when G3 did not make the regulator Treasury's admin", async () => {
    const stale = encodeFunctionResult({ abi: CONTRACT_AUTH_ABI, functionName: "getAdmin", result: DEPLOYER });
    const getAdmin = toFunctionSelector("function getAdmin(address)");
    const r = rig({ t: (node) => async (m, p) => (m === "eth_call" && String((p[0] as { data: string }).data).startsWith(getAdmin) ? stale : node(m, p)) });
    await expect(step(r, "G3")).rejects.toThrow(/G3: treasuryAdmin after was 0x[0-9a-f]{40}, expected/);
  });

  it("stops when F1's native status is a contract revert (16), not the chain's refusal (22)", async () => {
    const r = rig({
      native: (node) => async (body) => {
        const a = (await node.native(body)) as { result: Record<string, unknown> | null };
        return a.result && a.result.status === 22 ? { ...a, result: { ...a.result, status: 16 } } : a;
      },
    });
    await story(r, ["G0", "G1", "V1"]);
    await expect(step(r, "F1")).rejects.toThrow(/F1: native status 16, not 22 \(AccountFrozen\)/);
  });

  it("system addresses are the fixed FISCO 3.x ones", () => {
    expect(SYSTEM).toEqual({ AccountManager: "0x0000000000000000000000000000000000010003", CommitteeManager: "0x0000000000000000000000000000000000010001", ContractAuth: "0x0000000000000000000000000000000000001005" });
  });
});
