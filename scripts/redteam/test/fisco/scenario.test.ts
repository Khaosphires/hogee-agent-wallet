/**
 * The whole v2 scenario (scenario.ts) through the real StepRunner on the fake FISCO node: the final-2 bundle as the
 * source (evidence/ev-74756ea61a72ae7c, read from disk), the regulator's system contracts emulated (fake-system.ts),
 * Hogee's contracts answered by a cursor over the catalogue (a refusal's probe reverts and its tx mines 0x0; every read
 * decodes as zeros). It shows the dispatch, the order and the one-SPEND rule end to end; Hogee's contract logic itself
 * is the checker's and the live run's to prove.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hogeeDomain, hogeeDomainSeparator, hogeeErrorAbi, iMilestoneEscrowAbi, iTreasuryAbi, toBytes32Tag } from "@hogee/chain";
import { decodeFunctionData, encodeErrorResult, encodeFunctionResult, keccak256, toFunctionSelector, zeroAddress, type Abi, type AbiFunction, type AbiParameter, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { CATALOGUE, isChainRefusal, type CatalogueEntry } from "../../../../tools/verify-evidence/src/fisco/catalogue";
import { FINAL_2, FISCO_CHAIN_TAG, type DeployedName } from "../../../../tools/verify-evidence/src/fisco/pack";
import { NativeRpc } from "../../src/fisco/native-rpc";
import { Reader } from "../../src/fisco/reads";
import { FiscoRpc } from "../../src/fisco/rpc";
import { StepRunner, type StepCall, type StepResult } from "../../src/fisco/runner";
import { runScenario } from "../../src/fisco/scenario";
import { softFounder } from "../../src/fisco/sign";
import { readSepoliaBundle } from "../../src/fisco/source";
import { fakeNode } from "./fake-node";
import { FakeSystem } from "./fake-system";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
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
/** Every Hogee read decodes as zeros (static fields 0, dynamic arrays empty). */
const ZEROS = `0x${"00".repeat(32 * 40)}` as Hex;

function zeroOf(p: AbiParameter): unknown {
  if (p.type.endsWith("]")) return [];
  if (p.type === "tuple") return Object.fromEntries(((p as { components: readonly AbiParameter[] }).components ?? []).map((c) => [c.name, zeroOf(c)]));
  if (p.type === "bool") return false;
  if (p.type === "address") return zeroAddress;
  if (p.type === "string") return "";
  if (p.type === "bytes") return "0x";
  if (p.type.startsWith("bytes")) return `0x${"00".repeat(Number(p.type.slice(5)))}`;
  return 0n;
}

const fnOf = (abi: Abi, name: string): AbiFunction => abi.find((f): f is AbiFunction => f.type === "function" && f.name === name) as AbiFunction;

/** The calls the scenario reads before its steps: each domain contract's separator, and the open order. */
function presets(): Record<string, Hex> {
  const out: Record<string, Hex> = {};
  const sel = toFunctionSelector("function domainSeparator()");
  for (const name of ["PlanRegistry", "Treasury", "MilestoneEscrow"] as const) {
    out[`${contracts[name]}:${sel}`] = hogeeDomainSeparator(hogeeDomain({ verifyingContract: contracts[name], chainTag: toBytes32Tag(FISCO_CHAIN_TAG), deploymentId: toBytes32Tag(FINAL_2.deploymentId) }));
  }
  const order = fnOf(iMilestoneEscrowAbi as Abi, "order");
  const zero = zeroOf((order.outputs as readonly AbiParameter[])[0] as AbiParameter) as Record<string, unknown>;
  out[`${contracts.MilestoneEscrow}:${toFunctionSelector(order)}`] = encodeFunctionResult({ abi: [order], functionName: "order", result: { ...zero, exists: true } } as never);
  return out;
}

/** A Hogee refusal's revert data (the step's expected error, zero arguments). */
function revertOf(name: string | undefined): Hex {
  const err = hogeeErrorAbi.find((x) => x.name === name);
  if (!err) throw new Error(`no ABI error ${String(name)}`);
  return encodeErrorResult({ abi: [err], errorName: err.name, args: err.inputs.map(zeroOf) } as never);
}

/**
 * The runner, with the step it is running visible to the fake node, and that step's own expected error (T28a's is
 * derived from the Sepolia release's expiry: SignatureExpired once it has passed, as the contract would revert).
 */
class CursorRunner extends StepRunner {
  current: CatalogueEntry | null = null;
  currentError: string | undefined;
  readonly results: StepResult[] = [];
  override async run(c: StepCall): Promise<StepResult> {
    this.current = c.entry;
    this.currentError = c.expectedError ?? c.entry.expectedError;
    const r = await super.run(c);
    this.results.push(r);
    return r;
  }
}

async function scenario() {
  let runner: CursorRunner | null = null;
  const hogeeRefusal = (): CatalogueEntry | null => {
    const e = runner?.current;
    return e && e.expected === "refused" && !isChainRefusal(e.expectedError) ? e : null;
  };
  const node = fakeNode({
    system: new FakeSystem(signers.regulator.address, DEPLOYER),
    calls: presets(),
    probe: (call) => {
      if (!call.from) return { ret: ZEROS };
      const e = hogeeRefusal();
      return e ? { revert: revertOf(runner?.currentError) } : { ok: true };
    },
    send: () => (hogeeRefusal() ? "mine-revert" : "mine-ok"),
  });
  const rpc = new FiscoRpc("http://127.0.0.1:8646", node);
  runner = new CursorRunner(rpc, new NativeRpc(node.native), contracts as Record<DeployedName, Hex>, signers, { receiptTimeoutMs: 1_000, pollMs: 1, sleep: async () => {} });
  const result = await runScenario({
    runner,
    reader: new Reader(rpc, contracts),
    src: readSepoliaBundle(join(ROOT, "evidence", FINAL_2.runId)),
    contracts,
    signers: { lender: signers.lender, agent: signers.agent, regulator: signers.regulator },
    deployer: DEPLOYER,
    founder: softFounder(),
    nowSeconds: () => BigInt(Math.floor(Date.now() / 1000)),
    sleep: async () => {},
    randomNonce: () => BigInt(keccak256(generatePrivateKey())),
  });
  return { node, runner, result };
}

describe("runScenario (pack v2) on the fake FISCO node", () => {
  it("runs the 37 catalogue steps in order: the regulator's stops between S15 and S16, one SPEND for F1/C1/M1/C3/R17", async () => {
    const { node, runner, result } = await scenario();
    expect(runner.steps.map((s) => s.id)).toEqual(CATALOGUE.map((e) => e.id));
    expect(runner.steps).toHaveLength(37);
    expect(result.plan.planHash).toMatch(/^0x[0-9a-f]{64}$/);
    const by = new Map(runner.results.map((r) => [r.step.id, r]));
    const input = (id: string): string => (node.txs.get(String(by.get(id)?.tx?.hash)) as { input: string }).input;
    const spend = input("R17");
    expect([input("F1"), input("M1"), by.get("C1")?.step.call?.data, by.get("C3")?.step.call?.data]).toEqual([spend, spend, spend, spend]);
    const d17 = decodeFunctionData({ abi: iTreasuryAbi as Abi, data: input("D17") as Hex });
    expect(d17.functionName).toBe("recordDenied");
    expect(d17.args?.at(-1)).toBe(keccak256(spend as Hex));
    expect(Object.fromEntries(["F1", "M1", "R17", "G0", "V1"].map((id) => [id, by.get(id)?.tx?.native?.status]))).toEqual({ F1: 22, M1: 18, R17: 16, G0: 0, V1: 0 });
    expect(["C1", "C2", "C3"].map((id) => by.get(id)?.tx)).toEqual([null, null, null]);
    expect(by.get("S15")?.step.reads).toEqual([]);
    expect(by.get("G3")?.step.reads).toEqual([{ label: "treasuryAdmin", before: DEPLOYER, after: signers.regulator.address.toLowerCase() }]);
    // The agent's first tx is S6 (G0 registered it before); the regulator sent G0..G6, V1, V2 from nonce 0.
    expect(runner.steps.find((s) => s.signerRole === "agent")?.id).toBe("S6");
    expect(node.nonces.get(signers.regulator.address.toLowerCase())).toBe(9);
  }, 60_000);
});
