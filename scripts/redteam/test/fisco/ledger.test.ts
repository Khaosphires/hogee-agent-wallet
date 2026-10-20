import { hashObject } from "@hogee/core";
import { encodeFunctionData, keccak256, stringToHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { LedgerFile } from "../../../../tools/verify-evidence/src/fisco/pack";
import { COMMITTEE_MANAGER_ABI, PROPOSAL_LOG, SYSTEM } from "../../../../tools/verify-evidence/src/fisco/system";
import { captureLedger, LedgerError, ledgerFileOf } from "../../src/fisco/ledger";
import { LedgerRpc, Rpc, type Transport } from "../../src/fisco/rpc";
import { fakeNode, type FakeNode } from "./fake-node";
import { FakeSystem } from "./fake-system";

const regulator = privateKeyToAccount(generatePrivateKey());
const deployer = privateKeyToAccount(generatePrivateKey());
const agent = privateKeyToAccount(generatePrivateKey());
const REG = regulator.address.toLowerCase() as Hex;
const NODE_ID = "a1".repeat(64);
const fast = { timeoutMs: 1_000, pollMs: 1, sleep: async () => {} };
const proposal = (nodeId = NODE_ID, weight = 0) => encodeFunctionData({ abi: COMMITTEE_MANAGER_ABI, functionName: "createSetConsensusWeightProposal", args: [nodeId, weight, true, 1000n] });

async function send(node: FakeNode, from: PrivateKeyAccount, to: Hex | null, data: Hex): Promise<Hex> {
  const nonce = node.nonces.get(from.address.toLowerCase()) ?? 0;
  const raw = await from.signTransaction({ type: "legacy", chainId: 20_200, nonce, gas: 3_000_000n, gasPrice: 0n, ...(to ? { to } : {}), data });
  return (await node("eth_sendRawTransaction", [raw])) as Hex;
}

/** Chain-up and a short run: the observer proposal (block 1), a CREATE, a regulator call and an agent call. */
async function chain(o: { proposals?: readonly Hex[]; proposer?: PrivateKeyAccount } = {}): Promise<FakeNode> {
  const node = fakeNode({ system: new FakeSystem(REG, deployer.address) });
  for (const p of o.proposals ?? [proposal()]) await send(node, o.proposer ?? regulator, SYSTEM.CommitteeManager, p);
  await send(node, deployer, null, "0x6080604052");
  await send(node, agent, "0x54b177ca733ea776474f370d84826981153c418e", "0x8456cb59");
  return node;
}

const head = (node: FakeNode) => ({ number: node.head, hash: String(node.blocks.get(node.head)?.hash) });
const node4Of = (t: Transport) => new LedgerRpc("http://127.0.0.1:8546", t);

describe("captureLedger: node4's copy of blocks 0..head, compared with node0's", () => {
  it("normalises every block and receipt to ledger.json, finds the observer proposal and hashes node0's blocks", async () => {
    const node = await chain();
    const c = await captureLedger(new Rpc(node), node4Of(node), head(node), REG, fast);
    expect(LedgerFile.parse(c.ledger)).toEqual(c.ledger);
    expect(c.ledger.blocks.map((b) => b.number)).toEqual([0, 1, 2, 3]);
    expect(c.ledger.head).toEqual({ number: 3, hash: head(node).hash });
    expect(c.ledger.node0Keccak).toBe(hashObject(c.ledger.blocks));
    const [prop, create, call] = [1, 2, 3].map((n) => c.ledger.blocks[n]?.txs[0]);
    expect(prop).toMatchObject({ from: REG, to: SYSTEM.CommitteeManager, nonce: 0, inputKeccak: keccak256(proposal()), receipt: { transactionIndex: 0, status: 1, gasUsed: "21000", logs: [{ address: PROPOSAL_LOG.address, topics: [PROPOSAL_LOG.topic0], data: PROPOSAL_LOG.data }] } });
    expect(prop?.receipt).not.toHaveProperty("contractAddress");
    expect(create).toMatchObject({ to: null, receipt: { contractAddress: expect.stringMatching(/^0x[0-9a-f]{40}$/) } });
    expect(call?.to).toBe("0x54b177ca733ea776474f370d84826981153c418e");
    expect(c.observerNode).toEqual({ index: 4, proposalTx: prop?.hash, proposalBlock: 1, weight: 0, nodeIdKeccak: keccak256(stringToHex(NODE_ID)) });
    expect(c.observerNodeId).toBe(NODE_ID);
    expect(JSON.stringify(c.ledger)).not.toContain(NODE_ID);
  });

  it("takes block 1's parent as served (FISCO serves block 0 under another hash) but checks every later link", async () => {
    const node = await chain();
    const reparent = (n: string, parentHash: string): Transport => async (m, p) => {
      const r = (await node(m, p)) as Record<string, unknown> | null;
      return m === "eth_getBlockByNumber" && Array.isArray(p) && p[0] === n && r ? { ...r, parentHash } : r;
    };
    const genesis = reparent("0x1", keccak256(stringToHex("native genesis")));
    await expect(captureLedger(new Rpc(genesis), node4Of(genesis), head(node), REG, fast)).resolves.toBeTruthy();
    const later = reparent("0x2", keccak256(stringToHex("other")));
    await expect(captureLedger(new Rpc(later), node4Of(later), head(node), REG, fast)).rejects.toThrow(/block 2: its parent is not block 1/);
  });

  it("waits for node4 to reach the head, and stops when it never does or is past it", async () => {
    const node = await chain();
    let polls = 0;
    const lagging: Transport = async (m, p) => (m === "eth_blockNumber" && polls++ < 3 ? `0x${(node.head - 1).toString(16)}` : node(m, p));
    await expect(captureLedger(new Rpc(node), node4Of(lagging), head(node), REG, fast)).resolves.toBeTruthy();
    const stuck: Transport = async (m, p) => (m === "eth_blockNumber" ? "0x1" : node(m, p));
    await expect(captureLedger(new Rpc(node), node4Of(stuck), head(node), REG, { ...fast, timeoutMs: 0 })).rejects.toThrow(/did not reach block 3/);
    const ahead: Transport = async (m, p) => (m === "eth_blockNumber" ? "0x9" : node(m, p));
    await expect(captureLedger(new Rpc(node), node4Of(ahead), head(node), REG, fast)).rejects.toThrow(/past node0's head/);
  });

  it.each([
    ["a receipt status", (r: Record<string, unknown>) => ({ ...r, status: "0x0" })],
    ["a receipt's gas", (r: Record<string, unknown>) => ({ ...r, gasUsed: "0x5209" })],
    ["a log's data", (r: Record<string, unknown>) => ({ ...r, logs: (r.logs as Record<string, unknown>[]).map((l) => ({ ...l, data: `0x${"0".repeat(63)}1` })) })],
  ])("stops when node4 serves %s other than node0's", async (_what, change) => {
    const node = await chain();
    const node4: Transport = async (m, p) => {
      const a = await node(m, p);
      return m === "eth_getTransactionReceipt" && a && (a as { blockNumber: string }).blockNumber === "0x1" ? change(a as Record<string, unknown>) : a;
    };
    await expect(captureLedger(new Rpc(node), node4Of(node4), head(node), REG, fast)).rejects.toThrow(/block 1: node4's copy differs from node0's/);
  });

  it("stops when node4 serves another block hash or drops a tx", async () => {
    const node = await chain();
    const forked: Transport = async (m, p) => {
      const a = (await node(m, p)) as Record<string, unknown> | null;
      return m === "eth_getBlockByNumber" && a?.number === "0x2" ? { ...a, transactions: [] } : a;
    };
    await expect(captureLedger(new Rpc(node), node4Of(forked), head(node), REG, fast)).rejects.toThrow(/block 2: node4's copy differs/);
  });

  it("stops when node0's head moved during the capture, or no longer has the head's hash", async () => {
    const node = await chain();
    // node0 is asked for its head once, after every block was read: a tx mined meanwhile moved it.
    const moving: Transport = async (m, p) => (m === "eth_blockNumber" ? `0x${(node.head + 1).toString(16)}` : node(m, p));
    await expect(captureLedger(new Rpc(moving), node4Of(node), head(node), REG, fast)).rejects.toThrow(/the head moved during the capture/);
    await expect(captureLedger(new Rpc(node), node4Of(node), { number: node.head, hash: keccak256("0x99") }, REG, fast)).rejects.toThrow(/another hash than the head/);
  });

  it("refuses a ledger without exactly one observer proposal by the regulator, weight 0", async () => {
    const none = await chain({ proposals: [] });
    await expect(captureLedger(new Rpc(none), node4Of(none), head(none), REG, fast)).rejects.toThrow(/0 observer proposals/);
    const two = await chain({ proposals: [proposal(), proposal("b2".repeat(64))] });
    await expect(captureLedger(new Rpc(two), node4Of(two), head(two), REG, fast)).rejects.toThrow(/2 observer proposals/);
    const sealer = await chain({ proposals: [proposal(NODE_ID, 1)] });
    await expect(captureLedger(new Rpc(sealer), node4Of(sealer), head(sealer), REG, fast)).rejects.toThrow(/weight-0 observer/);
    const other = await chain({ proposer: deployer });
    await expect(captureLedger(new Rpc(other), node4Of(other), head(other), REG, fast)).rejects.toThrow(LedgerError);
  });

  it("takes node4's tx objects from node4 by hash when it lists hashes only, never from node0 (post-fix re-check)", async () => {
    const node = await chain();
    const full = await captureLedger(new Rpc(node), node4Of(node), head(node), REG, fast);
    const asked0: string[] = [];
    const node0: Transport = async (m, p) => (asked0.push(m), node(m, p));
    const hashesOnly: Transport = async (m, p) => (m === "eth_getBlockByNumber" ? node(m, [p[0], false]) : node(m, p));
    expect((await captureLedger(new Rpc(node0), node4Of(hashesOnly), head(node), REG, fast)).ledger).toEqual(full.ledger);
    expect(asked0).not.toContain("eth_getTransactionByHash");
    // node4's own object is the one normalised and compared: another hash, none, or other content stops the capture.
    const byHash = (answer: (served: Record<string, unknown>) => unknown): Transport => async (m, p) => (m === "eth_getTransactionByHash" ? answer((await node(m, p)) as Record<string, unknown>) : hashesOnly(m, p));
    await expect(captureLedger(new Rpc(node), node4Of(byHash((t) => ({ ...t, hash: keccak256("0x77") }))), head(node), REG, fast)).rejects.toThrow(/node4 block 1: tx 0 is not served as a tx object with its hash/);
    await expect(captureLedger(new Rpc(node), node4Of(byHash(() => null)), head(node), REG, fast)).rejects.toThrow(/node4 block 1: tx 0 is not served as a tx object with its hash/);
    await expect(captureLedger(new Rpc(node), node4Of(byHash((t) => ({ ...t, input: "0x00" }))), head(node), REG, fast)).rejects.toThrow(/block 1: node4's copy differs from node0's/);
  });

  it("node0's tx objects come from node0 when it lists hashes only, and stop the capture when node0's object has another hash", async () => {
    const node = await chain();
    const hashesOnly: Transport = async (m, p) => (m === "eth_getBlockByNumber" ? node(m, [p[0], false]) : node(m, p));
    const lying: Transport = async (m, p) => (m === "eth_getTransactionByHash" ? { ...((await node(m, p)) as object), hash: keccak256("0x77") } : hashesOnly(m, p));
    await expect(captureLedger(new Rpc(lying), node4Of(node), head(node), REG, fast)).rejects.toThrow(/node0 block 1: tx 0 is not served as a tx object with its hash/);
  });

  it("stores node4's own blocks and digests node0's own (ledgerFileOf: never one node's array for both)", async () => {
    const node = await chain();
    const c = await captureLedger(new Rpc(node), node4Of(node), head(node), REG, fast);
    const node4Blocks = c.ledger.blocks;
    const node0Blocks = node4Blocks.map((b) => (b.number === 1 ? { ...b, timestamp: b.timestamp + 1 } : b));
    const built = ledgerFileOf(node0Blocks, node4Blocks, c.ledger.head);
    expect(built.blocks).toEqual(node4Blocks);
    expect(built.node0Keccak).toBe(hashObject(node0Blocks));
    expect(built.node0Keccak).not.toBe(hashObject(node4Blocks));
    expect(built.node).toBe("node4-observer");
  });

  it("reads node4 only through the allow-listed read methods (eth_getTransactionByHash when it lists hashes only)", async () => {
    const node = await chain();
    const seen: string[] = [];
    const spy: Transport = async (m, p) => {
      seen.push(m);
      return node(m, p);
    };
    await captureLedger(new Rpc(node), node4Of(spy), head(node), REG, fast);
    expect([...new Set(seen)].sort()).toEqual(["eth_blockNumber", "eth_getBlockByNumber", "eth_getTransactionReceipt"]);
    seen.length = 0;
    const hashesOnly: Transport = async (m, p) => (m === "eth_getBlockByNumber" ? spy(m, [p[0], false]) : spy(m, p));
    await captureLedger(new Rpc(node), node4Of(hashesOnly), head(node), REG, fast);
    expect([...new Set(seen)].sort()).toEqual(["eth_blockNumber", "eth_getBlockByNumber", "eth_getTransactionByHash", "eth_getTransactionReceipt"]);
  });
});
