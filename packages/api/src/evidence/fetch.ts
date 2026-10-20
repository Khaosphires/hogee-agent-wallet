/**
 * Raw chain data for the bundle, exactly as the node serves it (eth_getTransactionReceipt, eth_getBlockByNumber):
 * a receipt for EVERY tx a row names, whatever its DB state (run-6: the row labels must not choose what the bundle
 * shows), the receipt and signed bytes of each CANCELLED row's nonce consumer, and the number / hash / parent /
 * timestamp of every receipt's block. Read-only. The export is refused (EvidenceChainError) instead of shipping a bundle
 * that cannot verify or is not settled:
 *   - a row that names a tx whose receipt the node lacks (in flight: SIGNED, BROADCAST, DROPPED, PENDING), except a
 *     CANCELLED row, whose consumer must be mined instead;
 *   - a row whose label disagrees with its receipt (mined but labelled unmined, or the wrong status);
 *   - a receipt above the `finalized` head (receipts at `latest` can still be reorged out). The head is read first, so
 *     the first non-final receipt refuses before the rest are read (run-6 re-check M1; ready.ts refuses most such
 *     exports before the run is claimed).
 * Orphans are not enumerated (no eth_getLogs scan; the worker's T29 safety pause is the live control).
 */
import { RawBlock, RawReceipt, type ChainActionEntry, type PaymentEntry } from "@hogee/verify-evidence";
import { formatTransaction, keccak256, serializeTransaction, type Hex, type RpcTransaction } from "viem";
import type { z } from "zod";
import type { HogeePublicClient } from "../chain-lib";

export const MINED_PAYMENT_STATES: ReadonlySet<string> = new Set(["INCLUDED", "FINALIZED", "SETTLEMENT_REQUESTED", "SETTLED", "SETTLEMENT_FAILED", "REVERTED"]);
export const MINED_ACTION_STATES: ReadonlySet<string> = new Set(["INCLUDED", "FINALIZED", "REVERTED"]);
/** RPC reads in flight at once (public Sepolia endpoints rate-limit bursts). */
const CONCURRENCY = 4;

export class EvidenceChainError extends Error {
  override readonly name = "EvidenceChainError";
}

export interface ChainData {
  /** Raw receipts by lowercase tx hash. */
  readonly receipts: ReadonlyMap<string, z.infer<typeof RawReceipt>>;
  readonly blocks: z.infer<typeof RawBlock>[];
}

/** A row that names a tx, as the fetch checks it against the node. */
export interface RowRef {
  readonly id: string;
  readonly state: string;
  readonly mined: boolean;
  readonly cancelled: boolean;
}

/** One tx to read: the rows that name it, or the CANCELLED row whose nonce it consumed (its bytes are filled in). */
export interface TxToFetch {
  readonly hash: string;
  readonly rows: readonly RowRef[];
  readonly consumerOf?: PaymentEntry;
}

/** Every tx a row names (whatever its state) and every CANCELLED row's nonce consumer, by lowercase hash. */
export function minedTxHashes(payments: readonly PaymentEntry[], actions: readonly ChainActionEntry[]): TxToFetch[] {
  const out = new Map<string, { hash: string; rows: RowRef[]; consumerOf?: PaymentEntry }>();
  const add = (hash: string, row: RowRef | null, consumerOf?: PaymentEntry) => {
    const h = hash.toLowerCase();
    const t = out.get(h) ?? { hash: h, rows: [] };
    if (row) t.rows.push(row);
    if (consumerOf) t.consumerOf = consumerOf;
    out.set(h, t);
  };
  for (const e of payments) {
    const p = e.payment;
    if (p.txHash) add(p.txHash, { id: p.paymentId, state: p.state, mined: MINED_PAYMENT_STATES.has(p.state), cancelled: p.state === "CANCELLED" });
    if (e.nonceConsumedBy) add(e.nonceConsumedBy.txHash, null, e);
  }
  for (const a of actions) if (a.txHash) add(a.txHash, { id: a.actionId, state: a.state, mined: MINED_ACTION_STATES.has(a.state), cancelled: false });
  return [...out.values()].sort((a, b) => (a.hash < b.hash ? -1 : 1));
}

/** Runs `fn` over `items`, CONCURRENCY at a time; after the first failure no further item is started. */
async function pooled<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next;
      next += 1;
      try {
        out[i] = await fn(items[i] as T);
      } catch (error: unknown) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return out;
}

export type Request = (args: { method: string; params: unknown[] }) => Promise<unknown>;

/** The signed bytes of a mined legacy / EIP-2930 / EIP-1559 tx, rebuilt from eth_getTransactionByHash; null if not. */
export function rawTxOf(rpc: RpcTransaction): Hex | null {
  const tx = formatTransaction(rpc);
  if (!tx.to || !tx.r || !tx.s) return null;
  const base = { nonce: tx.nonce, gas: tx.gas, to: tx.to, value: tx.value, data: tx.input };
  try {
    if (tx.type === "eip1559" && tx.yParity !== undefined) {
      return serializeTransaction({ ...base, type: "eip1559", chainId: tx.chainId as number, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, accessList: tx.accessList ?? [] }, { r: tx.r, s: tx.s, yParity: tx.yParity });
    }
    if (tx.type === "eip2930" && tx.yParity !== undefined) {
      return serializeTransaction({ ...base, type: "eip2930", chainId: tx.chainId as number, gasPrice: tx.gasPrice, accessList: tx.accessList ?? [] }, { r: tx.r, s: tx.s, yParity: tx.yParity });
    }
    if (tx.type === "legacy" && tx.v !== undefined) {
      return serializeTransaction({ ...base, type: "legacy", gasPrice: tx.gasPrice, ...(tx.chainId === undefined ? {} : { chainId: tx.chainId }) }, { r: tx.r, s: tx.s, v: tx.v });
    }
  } catch {
    return null;
  }
  return null;
}

/** The node's view of one tx must agree with every row that names it. */
function checkRows(t: TxToFetch, receipt: z.infer<typeof RawReceipt> | null): void {
  for (const row of t.rows) {
    if (!receipt) {
      if (row.mined) throw new EvidenceChainError(`no valid receipt for ${row.id}'s mined tx ${t.hash}`);
      if (!row.cancelled) throw new EvidenceChainError(`${row.id} is ${row.state} and its tx ${t.hash} is not mined: export again once the worker has settled it`);
      continue;
    }
    if (!row.mined) throw new EvidenceChainError(`${row.id} is ${row.state} but its tx ${t.hash} is mined: export again once the worker has recorded it`);
    const reverted = row.state === "REVERTED";
    if (reverted !== (receipt.status === "0x0")) throw new EvidenceChainError(`${row.id} is ${row.state} but the receipt of ${t.hash} says ${receipt.status === "0x0" ? "reverted" : "succeeded"}`);
  }
  if (t.consumerOf && !receipt) throw new EvidenceChainError(`the tx ${t.hash} that consumed ${t.consumerOf.payment.paymentId}'s nonce is not mined`);
}

/** Fills a CANCELLED row's nonceConsumedBy.rawSignedTx from the node (rebuilt and checked against its hash). */
async function fillConsumer(request: Request, t: TxToFetch): Promise<void> {
  const e = t.consumerOf;
  if (!e?.nonceConsumedBy) return;
  const rpc = (await request({ method: "eth_getTransactionByHash", params: [t.hash] })) as RpcTransaction | null;
  const raw = rpc ? rawTxOf(rpc) : null;
  if (!raw || keccak256(raw).toLowerCase() !== t.hash) throw new EvidenceChainError(`the signed bytes of ${t.hash}, which consumed ${e.payment.paymentId}'s nonce, cannot be rebuilt`);
  // The entry was collected before any chain read (its runId is fixed by then); only the consumer's public bytes are added.
  (e.nonceConsumedBy as { rawSignedTx: string | null }).rawSignedTx = raw;
}

/** The `finalized` head's number; receipts above it are not exported. */
export async function finalizedHead(request: Request): Promise<bigint> {
  const raw = (await request({ method: "eth_getBlockByNumber", params: ["finalized", false] })) as { number?: unknown } | null;
  if (!raw || typeof raw.number !== "string") throw new EvidenceChainError("the node has no finalized block");
  return BigInt(raw.number);
}

export async function fetchChainData(client: Pick<HogeePublicClient, "request">, txHashes: readonly (string | TxToFetch)[]): Promise<ChainData> {
  const request = client.request as unknown as Request;
  const list: TxToFetch[] = txHashes.map((t) => (typeof t === "string" ? { hash: t.toLowerCase(), rows: [{ id: t, state: "FINALIZED", mined: true, cancelled: false }] } : t));
  const finalized = await finalizedHead(request);
  const receipts = new Map<string, z.infer<typeof RawReceipt>>();
  await pooled(list, async (t) => {
    const raw = await request({ method: "eth_getTransactionReceipt", params: [t.hash] });
    const parsed = raw === null ? null : RawReceipt.safeParse(raw);
    if (parsed && !parsed.success) throw new EvidenceChainError(`the node served an invalid receipt for ${t.hash}`);
    const receipt = parsed?.data ?? null;
    if (receipt && receipt.transactionHash.toLowerCase() !== t.hash) throw new EvidenceChainError(`the node answered another receipt for ${t.hash}`);
    checkRows(t, receipt);
    if (receipt && BigInt(receipt.blockNumber) > finalized) {
      throw new EvidenceChainError(`tx ${t.hash} is not final yet (block ${BigInt(receipt.blockNumber)} > finalized ${finalized}): export again once it is`);
    }
    if (receipt) receipts.set(t.hash, receipt);
    if (receipt && t.consumerOf) await fillConsumer(request, t);
  });
  const numbers = [...new Set([...receipts.values()].map((r) => r.blockNumber.toLowerCase()))].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  const blocks = await pooled(numbers, async (n) => {
    const raw = (await request({ method: "eth_getBlockByNumber", params: [n, false] })) as Record<string, unknown> | null;
    const block = RawBlock.safeParse(raw ? { number: raw.number, hash: raw.hash, parentHash: raw.parentHash, timestamp: raw.timestamp } : null);
    if (!block.success) throw new EvidenceChainError(`no valid block ${n}`);
    return block.data;
  });
  for (const r of receipts.values()) {
    const block = blocks.find((b) => b.number.toLowerCase() === r.blockNumber.toLowerCase());
    if (!block || block.hash.toLowerCase() !== r.blockHash.toLowerCase()) throw new EvidenceChainError(`receipt ${r.transactionHash} is not in the canonical block ${r.blockNumber} (reorg?)`);
  }
  return { receipts, blocks };
}
