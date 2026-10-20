/**
 * Writer → verifyFiscoPack round trip on reg-check's independent v2 fixture (tools/verify-evidence/test/fisco): a fake
 * Web3 node serves the fixture's chain (every pack tx, its receipt and block, and the regulator's observer proposal,
 * re-signed from the fixture's key) as node0 and node4; the replay's own captureLedger and withHeadAtEnd rebuild
 * ledger.json and chain.json from it; writePack writes the pack (schemas, secret scan, hashes.json, packId); and the
 * pack read back from disk passes every one of the checker's checks. A forged node4 copy fails "regulator ledger".
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData, keccak256, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FISCO_CHECKS, verifyFiscoPack, type FiscoOptions } from "../../../../tools/verify-evidence/src/fisco/index";
import { ChainFile, LedgerFile, PackFile, TxFile, type FiscoReceipt } from "../../../../tools/verify-evidence/src/fisco/pack";
import { COMMITTEE_MANAGER_ABI, OBSERVER_PROPOSAL, PROPOSAL_LOG, SYSTEM } from "../../../../tools/verify-evidence/src/fisco/system";
import { readBundleDir } from "../../../../tools/verify-evidence/src/read-dir";
import { FKEYS } from "../../../../tools/verify-evidence/test/fisco/fixture";
import { buildPack } from "../../../../tools/verify-evidence/test/fisco/fixture-steps";
import { withHeadAtEnd, type ChainStart } from "../../src/fisco/capture";
import { captureLedger } from "../../src/fisco/ledger";
import { JsonRpcError, LedgerRpc, Rpc, type Transport } from "../../src/fisco/rpc";
import { keySecretForms } from "../../src/fisco/sign";
import { jsonFile, writePack } from "../../src/fisco/writer";

/** The node id reg-check's fixture puts in its observer proposal (chain.json keeps only its keccak). */
const FIXTURE_NODE_ID = "node4-fixture-id";
const fast = { timeoutMs: 1_000, pollMs: 1, sleep: async () => {} };
const temps: string[] = [];
afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

type Files = Record<string, string>;
let fx: Awaited<ReturnType<typeof buildPack>>;
let opts: FiscoOptions;

beforeAll(async () => {
  fx = await buildPack();
  opts = { sepoliaBundle: fx.source.files, source: fx.identity };
}, 60_000);

const parse = <T>(files: Files, path: string, schema: { parse(v: unknown): T }): T => schema.parse(JSON.parse(files[path] as string));
const hex = (n: number): string => `0x${n.toString(16)}`;

/** A Web3 node serving the fixture's chain: blocks from ledger.json, tx objects and receipts from txs/ (+ the proposal). */
async function servedChain(files: Files): Promise<{ t: Transport; head: { number: number; hash: string } }> {
  const ledger = parse(files, "ledger.json", LedgerFile);
  const chain = parse(files, "chain.json", ChainFile);
  const txs = new Map<string, { tx: Record<string, unknown>; receipt: Record<string, unknown> }>();
  for (const [path, text] of Object.entries(files)) {
    if (!path.startsWith("txs/")) continue;
    const f = TxFile.parse(JSON.parse(text));
    if (f.tx && f.receipt) txs.set(f.hash, { tx: f.tx, receipt: f.receipt });
  }
  // The proposal is not in txs/ (chain-up, not a step): rebuild it exactly as the fixture signed it.
  const data = encodeFunctionData({ abi: COMMITTEE_MANAGER_ABI, functionName: OBSERVER_PROPOSAL.function, args: [FIXTURE_NODE_ID, 0, true, OBSERVER_PROPOSAL.blockNumberInterval] });
  const raw = await FKEYS.regulator.signTransaction({ type: "legacy", chainId: 20_200, nonce: 0, to: SYSTEM.CommitteeManager, data, gas: 15_000_000n, gasPrice: 0n, value: 0n });
  const hash = keccak256(raw);
  if (hash !== chain.observerNode.proposalTx) throw new Error("the fixture's observer proposal is not the one rebuilt here");
  const at = ledger.blocks[chain.observerNode.proposalBlock] as { number: number; hash: string };
  const n = hex(at.number);
  txs.set(hash, {
    tx: { hash, from: FKEYS.regulator.address.toLowerCase(), to: SYSTEM.CommitteeManager, input: data, nonce: "0x0", blockNumber: n, blockHash: at.hash, gas: hex(15_000_000), gasPrice: "0x0", value: "0x0", type: "0x0" },
    receipt: {
      transactionHash: hash, transactionIndex: "0x0", blockHash: at.hash, blockNumber: n, from: FKEYS.regulator.address.toLowerCase(), to: SYSTEM.CommitteeManager, status: "0x1", gasUsed: "0x5208", contractAddress: null,
      logs: [{ address: PROPOSAL_LOG.address, topics: [PROPOSAL_LOG.topic0], data: PROPOSAL_LOG.data, blockNumber: n, blockHash: at.hash, transactionHash: hash, transactionIndex: "0x307830", logIndex: "0x0", removed: false }],
    },
  });
  const head = ledger.head;
  const t: Transport = async (method, params) => {
    switch (method) {
      case "eth_chainId":
        return "0x4ee8";
      case "eth_blockNumber":
        return hex(head.number);
      case "eth_getBlockByNumber": {
        const b = ledger.blocks[Number(BigInt(String(params[0])))];
        if (!b) return null;
        const full = params[1] === true;
        return { number: hex(b.number), hash: b.hash, parentHash: b.parentHash, timestamp: hex(b.timestamp), transactions: b.txs.map((x) => (full ? txs.get(x.hash)?.tx : x.hash)) };
      }
      case "eth_getTransactionReceipt":
        return txs.get(String(params[0]).toLowerCase())?.receipt ?? null;
      default:
        throw new JsonRpcError(-32601, `no ${method}`, null);
    }
  };
  return { t, head };
}

/** The replay's own chain.json and ledger.json for the served chain, then the pack writer; the folder read back. */
async function roundTrip(files: Files, node4?: (t: Transport) => Transport): Promise<{ written: Record<string, Uint8Array>; dir: string }> {
  const { t, head } = await servedChain(files);
  const chain = parse(files, "chain.json", ChainFile);
  const captured = await captureLedger(new Rpc(t), new LedgerRpc("http://127.0.0.1:8546", node4 ? node4(t) : t), head, chain.auth.admin as Hex, fast);
  const { headHashAtEnd: _h, observerNode: _o, ...start } = chain;
  const txFiles = Object.entries(files).filter(([p]) => p.startsWith("txs/")).map(([, text]) => TxFile.parse(JSON.parse(text)));
  const rebuilt = withHeadAtEnd(start as ChainStart, { headAtEnd: head.number, headHashAtEnd: head.hash, observerNode: captured.observerNode }, txFiles);
  const pack = parse(files, "pack.json", PackFile);
  const { packId: _id, ...core } = pack;
  const others = Object.entries(files).filter(([p]) => p !== "pack.json" && p !== "hashes.json");
  const out = mkdtempSync(join(tmpdir(), "fisco-roundtrip-"));
  temps.push(out);
  const secrets = [captured.observerNodeId, ...keySecretForms([`0x${"88".repeat(32)}` as Hex])];
  const { dir, packId } = writePack(out, core, new Map([...others, ["chain.json", jsonFile(rebuilt)], ["ledger.json", jsonFile(captured.ledger)]]), secrets);
  expect(packId).toBe(pack.packId);
  const read = readBundleDir(dir);
  expect(read.refused).toEqual([]);
  return { written: read.files as Record<string, Uint8Array>, dir };
}

describe("writer → verifyFiscoPack round trip on reg-check's v2 fixture", () => {
  it("the fixture itself verifies, the regulator ledger and powers checks included", () => {
    const r = verifyFiscoPack(fx.files, opts);
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.checks.map((c) => c.name)).toEqual(expect.arrayContaining([FISCO_CHECKS.ledger, FISCO_CHECKS.powers]));
  });

  it("captureLedger rebuilds the fixture's ledger.json and observer node from the served chain", async () => {
    const { t, head } = await servedChain(fx.files);
    const chain = parse(fx.files, "chain.json", ChainFile);
    const c = await captureLedger(new Rpc(t), new LedgerRpc("http://127.0.0.1:8546", t), head, chain.auth.admin as Hex, fast);
    expect(c.ledger).toEqual(parse(fx.files, "ledger.json", LedgerFile));
    expect(c.observerNode).toEqual(chain.observerNode);
  });

  it("the pack the replay's writer writes (its own chain.json and ledger.json) passes every check", async () => {
    const { written } = await roundTrip(fx.files);
    const r = verifyFiscoPack(written, opts);
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.checks.map((c) => c.name)).toEqual(Object.values(FISCO_CHECKS));
    expect(r.ok).toBe(true);
  });

  it("a node4 that served one receipt differently never gets written; a forged ledger file fails the regulator ledger check", async () => {
    const lying = (t: Transport): Transport => async (m, p) => {
      const a = (await t(m, p)) as FiscoReceipt | null;
      return m === "eth_getTransactionReceipt" && a?.blockNumber === "0x3" ? { ...a, gasUsed: "0x1" } : a;
    };
    await expect(roundTrip(fx.files, lying)).rejects.toThrow(/block 3: node4's copy differs/);
    const { written } = await roundTrip(fx.files);
    const ledger = JSON.parse(Buffer.from(written["ledger.json"] as Uint8Array).toString("utf8")) as LedgerFile;
    const forged = { ...ledger, blocks: ledger.blocks.map((b) => (b.number === 3 ? { ...b, txs: b.txs.map((x) => ({ ...x, receipt: { ...x.receipt, gasUsed: "1" } })) } : b)) };
    const failed = verifyFiscoPack({ ...written, "ledger.json": jsonFile(forged) }, opts).checks.filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toContain(FISCO_CHECKS.ledger);
  });
});
