/**
 * fetch.ts reads a receipt for every row tx whatever its DB state (run-6 row-labelled view), adds each CANCELLED row's
 * nonce consumer (receipt and rebuilt signed bytes), and refuses in-flight, mislabelled or non-final state.
 */
import { examplePayment } from "@hogee/core";
import type { PaymentEntry } from "@hogee/verify-evidence";
import { keccak256, parseTransaction, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { EvidenceChainError, fetchChainData, minedTxHashes } from "../src/evidence/fetch";
import { assertExportReady } from "../src/evidence/ready";

const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const signer = privateKeyToAccount(`0x${"77".repeat(32)}`);

const receipt = (hash: string, block: number, status: "0x1" | "0x0" = "0x1") => ({
  transactionHash: hash, transactionIndex: "0x0", blockHash: h(1000 + block), blockNumber: toHex(block), from: signer.address.toLowerCase(), to: signer.address.toLowerCase(),
  status, logs: [], logsBloom: `0x${"0".repeat(512)}`, gasUsed: "0x5208", cumulativeGasUsed: "0x5208", contractAddress: null,
});

const payment = (id: string, state: string, txHash: string, consumer: string | null = null): PaymentEntry =>
  ({
    payment: { ...examplePayment, paymentId: id, state, txHash },
    orderId: null, milestoneIdx: null, nonceConsumedBy: consumer ? { txHash: consumer, rawSignedTx: null } : null, signerAddress: null, nonce: null, rawSignedTx: null,
  }) as PaymentEntry;

/** A node with `receipts` and `txs` (eth_getTransactionByHash), its finalized head at `finalized`; `calls` logs reads. */
function node(receipts: Record<string, unknown>, finalized: number, txs: Record<string, unknown> = {}, calls: string[] = []) {
  const request = async ({ method, params }: { method: string; params: unknown[] }) => {
    calls.push(`${method}:${String(params[0])}`);
    if (method === "eth_getTransactionReceipt") return receipts[params[0] as string] ?? null;
    if (method === "eth_getTransactionByHash") return txs[params[0] as string] ?? null;
    if (method === "eth_getBlockByNumber") {
      if (params[0] === "finalized") return { number: toHex(finalized) };
      const n = Number(BigInt(params[0] as string));
      return { number: toHex(n), hash: h(1000 + n), parentHash: h(999 + n), timestamp: toHex(1_700_000_000 + n) };
    }
    throw new Error(`unexpected ${method}`);
  };
  return { request } as unknown as Parameters<typeof fetchChainData>[0];
}

describe("evidence fetch: every row tx", () => {
  it("lists every row's tx whatever its state, and each CANCELLED row's consumer", () => {
    const list = minedTxHashes([payment("p1", "FINALIZED", h(1)), payment("p2", "BROADCAST", h(2)), payment("p3", "CANCELLED", h(3), h(4))], []);
    expect(list.map((t) => t.hash)).toEqual([h(1), h(2), h(3), h(4)]);
    expect(list.find((t) => t.hash === h(4))?.consumerOf?.payment.paymentId).toBe("p3");
  });

  it("refuses a row labelled unmined whose tx is mined, and an in-flight row", async () => {
    const mined = minedTxHashes([payment("p2", "DROPPED", h(2))], []);
    await expect(fetchChainData(node({ [h(2)]: receipt(h(2), 5) }, 100), mined)).rejects.toThrow(/p2 is DROPPED but its tx .* is mined/);
    await expect(fetchChainData(node({}, 100), mined)).rejects.toThrow(/p2 is DROPPED and its tx .* is not mined/);
  });

  it("refuses a row whose status disagrees with its receipt", async () => {
    await expect(fetchChainData(node({ [h(1)]: receipt(h(1), 5, "0x0") }, 100), minedTxHashes([payment("p1", "FINALIZED", h(1))], []))).rejects.toThrow(/receipt .* says reverted/);
  });

  it("refuses receipts above the finalized head", async () => {
    await expect(fetchChainData(node({ [h(1)]: receipt(h(1), 50) }, 40), minedTxHashes([payment("p1", "FINALIZED", h(1))], []))).rejects.toThrow(EvidenceChainError);
    await expect(fetchChainData(node({ [h(1)]: receipt(h(1), 50) }, 40), minedTxHashes([payment("p1", "FINALIZED", h(1))], []))).rejects.toThrow(/not final yet/);
  });

  it("adds a CANCELLED row's consumer: its receipt, and its signed bytes rebuilt from the node", async () => {
    const raw = await signer.signTransaction({ chainId: 31337, type: "eip1559", nonce: 7, to: signer.address, data: "0x", gas: 21_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, value: 0n });
    const consumer = keccak256(raw);
    const p = parseTransaction(raw);
    const rpcTx = {
      type: "0x2", chainId: toHex(31337), nonce: toHex(7), gas: toHex(21_000n), maxFeePerGas: "0x2", maxPriorityFeePerGas: "0x1", to: signer.address, value: "0x0", input: "0x", accessList: [],
      r: p.r, s: p.s, yParity: toHex(p.yParity as number), v: toHex(p.yParity as number), hash: consumer, from: signer.address, blockHash: h(1005), blockNumber: "0x5", transactionIndex: "0x0",
    };
    const cancelled = payment("p3", "CANCELLED", h(3), consumer);
    const data = await fetchChainData(node({ [consumer]: receipt(consumer, 5) }, 100, { [consumer]: rpcTx }), minedTxHashes([cancelled], []));
    expect([...data.receipts.keys()]).toEqual([consumer]);
    expect(cancelled.nonceConsumedBy?.rawSignedTx).toBe(raw as Hex);
    await expect(fetchChainData(node({ [consumer]: receipt(consumer, 5), [h(3)]: receipt(h(3), 6) }, 100, { [consumer]: rpcTx }), minedTxHashes([payment("p3", "CANCELLED", h(3), consumer)], []))).rejects.toThrow(/p3 is CANCELLED but its tx .* is mined/);
    await expect(fetchChainData(node({}, 100), minedTxHashes([payment("p3", "CANCELLED", h(3), consumer)], []))).rejects.toThrow(/consumed p3's nonce is not mined/);
  });
});

describe("evidence fetch: the finalized head is read first (run-6 re-check M1)", () => {
  it("reads `finalized` before any receipt and stops at the first non-final one", async () => {
    const calls: string[] = [];
    const late = Array.from({ length: 12 }, (_, i) => payment(`p${i}`, "FINALIZED", h(i + 1)));
    const receipts = Object.fromEntries(late.map((_, i) => [h(i + 1), receipt(h(i + 1), 50 + i)]));
    await expect(fetchChainData(node(receipts, 40, {}, calls), minedTxHashes(late, []))).rejects.toThrow(/is not final yet \(block 50 > finalized 40\)/);
    expect(calls[0]).toBe("eth_getBlockByNumber:finalized");
    // CONCURRENCY workers each read one receipt, then stop: the other receipts are never fetched.
    expect(calls.filter((c) => c.startsWith("eth_getTransactionReceipt")).length).toBeLessThan(late.length);
  });
});

describe("export readiness, before the run is claimed (run-6 re-check M1)", () => {
  /** Fake deps: the node's finalized head and the readiness query's one row. */
  const deps = (finalized: number, row: { in_flight: number; first_id: string | null; first_state: string | null; newest: string | null }) =>
    ({ client: node({}, finalized), db: { $client: { query: async () => ({ rows: [row] }) } } }) as unknown as Parameters<typeof assertExportReady>[0];
  const scope = { facilityId: "fac-1", founderId: "founder-1" };

  it("passes when nothing is in flight and the newest row block is final", async () => {
    await expect(assertExportReady(deps(100, { in_flight: 0, first_id: null, first_state: null, newest: "100" }), scope)).resolves.toBeUndefined();
    await expect(assertExportReady(deps(100, { in_flight: 0, first_id: null, first_state: null, newest: null }), scope)).resolves.toBeUndefined();
  });

  it("refuses a row in flight, naming it", async () => {
    await expect(assertExportReady(deps(100, { in_flight: 2, first_id: "act-9", first_state: "BROADCAST", newest: "90" }), scope)).rejects.toThrow(/2 row\(s\) still name a tx in flight \(first: act-9 is BROADCAST\)/);
  });

  it("refuses a newest row block above the finalized head", async () => {
    const e = assertExportReady(deps(40, { in_flight: 0, first_id: null, first_state: null, newest: "105" }), scope);
    await expect(e).rejects.toThrow(EvidenceChainError);
    await expect(assertExportReady(deps(40, { in_flight: 0, first_id: null, first_state: null, newest: "105" }), scope)).rejects.toThrow(/block 105, above the finalized block 40/);
  });
});
