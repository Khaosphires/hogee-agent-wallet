/**
 * An in-memory stand-in for a FISCO BCOS 3.17.1 node (no network): chain 20200, legacy txs, one tx per block, no empty
 * blocks, Ethereum-shaped Web3 receipts, and the node's native receipts (status int, output hex, gasUsed decimal text,
 * log addresses without 0x; P1's live test, 20 Oct). With a FakeSystem it also emulates the regulator's system
 * contracts (fake-system.ts): the account freeze (from the next block), the method ban (immediate), the proposals, and
 * the chain's refusals (mined 0x0 with native 22 / 18; eth_call answered with JSON-RPC code 22 / 18).
 * Each test decides how eth_call probes and sends to Hogee contracts behave.
 */
import { getContractAddress, keccak256, parseTransaction, recoverTransactionAddress, type Hex } from "viem";
import type { NativeTransport } from "../../src/fisco/native-rpc";
import { JsonRpcError, type Transport } from "../../src/fisco/rpc";
import { isSystemAddress, type FakeSystem } from "./fake-system";

export type ProbeAnswer = { readonly ok: true } | { readonly ret: Hex } | { readonly revert: Hex } | { readonly error: JsonRpcError };
export type SendAnswer = "mine-ok" | "mine-revert" | { readonly refuse: { readonly code: number; readonly message: string } };

export interface FakeNodeOptions {
  readonly chainId?: string;
  probe?: (call: { from?: string; to: string; data: string }) => ProbeAnswer;
  send?: (raw: Hex) => SendAnswer;
  /** eth_call results by `to:selector` for read helpers. */
  readonly calls?: Record<string, Hex>;
  /** The regulator's system contracts; without it a call to 0x10003 / 0x1005 / 0x10001 is just another contract. */
  readonly system?: FakeSystem;
  /** Native getTransactionReceipt answers null this many times per hash before serving it (indexing lag). */
  readonly nativeLag?: number;
}

export interface FakeNode extends Transport {
  readonly methods: string[];
  readonly nonces: Map<string, number>;
  readonly receipts: Map<string, Record<string, unknown>>;
  readonly natives: Map<string, Record<string, unknown>>;
  readonly blocks: Map<number, Record<string, unknown>>;
  readonly txs: Map<string, Record<string, unknown>>;
  /** The node's native RPC (getTransactionReceipt only). */
  readonly native: NativeTransport & { readonly hashes: string[] };
  head: number;
}

const ZERO_BLOOM = `0x${"0".repeat(512)}`;
const hex = (n: number): string => `0x${n.toString(16)}`;
export const fakeBlockHash = (n: number): Hex => keccak256(`0x${n.toString(16).padStart(64, "0")}`);
/** FISCO 3.17.1 serves a Web3 log's transactionIndex as the hex of the ASCII text "0x0" (REG-FACTS, "Web3 quirks"). */
const QUIRKY_LOG_TX_INDEX = "0x307830";

interface Mined {
  readonly status: "0x1" | "0x0";
  readonly native: number;
  readonly output: Hex;
  readonly logs: readonly { address: string; topics: Hex[]; data: Hex }[];
}

export function fakeNode(opts: FakeNodeOptions = {}): FakeNode {
  const nonces = new Map<string, number>();
  const receipts = new Map<string, Record<string, unknown>>();
  const natives = new Map<string, Record<string, unknown>>();
  const txs = new Map<string, Record<string, unknown>>();
  const blocks = new Map<number, Record<string, unknown>>([[0, { number: "0x0", hash: fakeBlockHash(0), parentHash: `0x${"0".repeat(64)}`, timestamp: hex(1_792_400_000), transactions: [] }]]);
  const methods: string[] = [];
  const nativeAsked = new Map<string, number>();
  const sys = opts.system;
  const nonceOf = (a: string): number => nonces.get(a.toLowerCase()) ?? 0;

  /** What a tx from `from` does when mined in block `n`. */
  function execute(from: string, to: string | null, data: Hex, raw: Hex, n: number): Mined | { refuse: { code: number; message: string } } {
    const refused = sys?.refusal(from, to, data, n);
    if (refused) return { status: "0x0", native: refused.code, output: refused.data, logs: [] };
    const target = sys ? isSystemAddress(to) : null;
    if (sys && target) {
      const r = sys.execute(target, from, data, { block: n, mined: true, nonceOf });
      return { status: "0x1", native: 0, output: r.output, logs: r.logs };
    }
    const answer = opts.send?.(raw) ?? "mine-ok";
    if (typeof answer === "object") return answer;
    return answer === "mine-ok" ? { status: "0x1", native: 0, output: "0x", logs: [] } : { status: "0x0", native: 16, output: "0x", logs: [] };
  }

  async function send(raw: Hex): Promise<Hex> {
    const hash = keccak256(raw);
    const from = (await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase();
    const parsed = parseTransaction(raw);
    const to = parsed.to?.toLowerCase() ?? null;
    const n = node.head + 1;
    const r = execute(from, to, (parsed.data ?? "0x") as Hex, raw, n);
    if ("refuse" in r) throw new JsonRpcError(r.refuse.code, r.refuse.message, null);
    node.head = n;
    const nonce = parsed.nonce ?? 0;
    const created = to === null ? getContractAddress({ from: from as Hex, nonce: BigInt(nonce) }).toLowerCase() : null;
    blocks.set(n, { number: hex(n), hash: fakeBlockHash(n), parentHash: fakeBlockHash(n - 1), timestamp: hex(1_792_400_000 + n * 2), transactions: [hash] });
    nonces.set(from, nonceOf(from) + 1);
    txs.set(hash, { hash, from, to, input: parsed.data ?? "0x", nonce: hex(nonce), blockNumber: hex(n), blockHash: fakeBlockHash(n), transactionIndex: "0x0", gas: hex(Number(parsed.gas ?? 0n)), gasPrice: "0x0", value: "0x0", type: "0x0" });
    const logs = r.logs.map((l, i) => ({ ...l, blockNumber: hex(n), blockHash: fakeBlockHash(n), transactionHash: hash, transactionIndex: QUIRKY_LOG_TX_INDEX, logIndex: hex(i), removed: false }));
    receipts.set(hash, { transactionHash: hash, transactionIndex: "0x0", blockHash: fakeBlockHash(n), blockNumber: hex(n), from, to, status: r.status, logs, logsBloom: ZERO_BLOOM, gasUsed: "0x5208", type: "0x0", ...(created ? { contractAddress: created } : {}) });
    natives.set(hash, {
      version: 0, contractAddress: created ?? "", checksumContractAddress: "", gasUsed: "21000", status: r.native, output: r.output, blockNumber: n, transactionHash: hash,
      hash: keccak256(`${hash}00`), from, to: to ?? "", logEntries: r.logs.map((l) => ({ address: l.address.slice(2), topics: l.topics, data: l.data })), message: "", input: parsed.data ?? "0x", extraData: "", transactionProof: null,
    });
    return hash;
  }

  function call(c: { from?: string; to: string; data: string }): Hex {
    const head = node.head;
    if (sys && c.from) {
      const refused = sys.refusal(c.from, c.to, c.data, head);
      if (refused) throw new JsonRpcError(refused.code, "", refused.data);
    }
    const target = sys ? isSystemAddress(c.to) : null;
    if (sys && target) return sys.execute(target, c.from ?? `0x${"0".repeat(40)}`, c.data as Hex, { block: head, mined: false, nonceOf }).output;
    const preset = opts.calls?.[`${c.to.toLowerCase()}:${c.data.slice(0, 10)}`];
    if (preset) return preset;
    const a = opts.probe?.(c) ?? { ok: true };
    if ("ok" in a) return "0x";
    if ("ret" in a) return a.ret;
    if ("revert" in a) throw new JsonRpcError(3, "execution reverted", a.revert);
    throw a.error;
  }

  const node = (async (method: string, params: readonly unknown[]) => {
    methods.push(method);
    switch (method) {
      case "eth_chainId":
        return opts.chainId ?? "0x4ee8";
      case "web3_clientVersion":
        return "FISCO BCOS/3.17.1 fake";
      case "eth_blockNumber":
        return hex(node.head);
      case "eth_getTransactionCount":
        return hex(nonceOf(String(params[0])));
      case "eth_call":
        return call(params[0] as { from?: string; to: string; data: string });
      case "eth_sendRawTransaction":
        return send(params[0] as Hex);
      case "eth_getTransactionReceipt":
        return receipts.get(String(params[0]).toLowerCase()) ?? null;
      case "eth_getTransactionByHash":
        return txs.get(String(params[0]).toLowerCase()) ?? null;
      case "eth_getBlockByNumber": {
        const tag = String(params[0]);
        const b = blocks.get(tag === "latest" ? node.head : Number(BigInt(tag)));
        if (!b || params[1] !== true) return b ?? null;
        return { ...b, transactions: (b.transactions as string[]).map((h) => txs.get(h)) };
      }
      default:
        throw new JsonRpcError(-32601, `method ${method} not found`, null);
    }
  }) as FakeNode;

  const hashes: string[] = [];
  const native = (async (body: string) => {
    const req = JSON.parse(body) as { id: number; method: string; params: unknown[] };
    if (req.method !== "getTransactionReceipt") return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "no such method" } };
    const h = String(req.params[2]).toLowerCase();
    hashes.push(h);
    const asked = (nativeAsked.get(h) ?? 0) + 1;
    nativeAsked.set(h, asked);
    const served = asked > (opts.nativeLag ?? 0) ? (natives.get(h) ?? null) : null;
    return { jsonrpc: "2.0", id: req.id, result: served };
  }) as NativeTransport & { hashes: string[] };
  native.hashes = hashes;

  Object.assign(node, { methods, nonces, receipts, natives, blocks, txs, native, head: 0 });
  return node;
}
