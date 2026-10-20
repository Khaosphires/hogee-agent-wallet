/**
 * Optional online mode (`HOGEE_VERIFY_RPC=<url> make verify`, or the explorer with its own fetch): compares the bundle's
 * anchor with a node, so VERIFIED can be checked against the chain instead of only for internal consistency.
 * Browser-safe: global fetch only. For every receipt in the bundle, eth_getTransactionReceipt must serve the same
 * consensus fields byte for byte (hashes, indices, from, to, status, gas, bloom, and every log's address, topics,
 * data and position; provider-specific extra fields are not compared); every block in blocks.json must have the same
 * hash, parent and time; every row tx the bundle shows unmined (a CANCELLED row's own tx) must have no receipt; the
 * chain id must match and every deployment contract must have code. That proves the bundle's txs and blocks are on
 * that chain; it does not prove the contracts are Hogee's deployment (a forger's own contracts have code too, and no
 * committed deployment manifest carries a code hash to pin): the addresses must still be compared with the announced
 * deployment (run-6 re-check L4). The RPC URL is never printed (it may hold a key):
 * it is parsed up front (an unparsable or credentialed URL gets one fixed refusal), and no fetch or node error text is
 * ever echoed, only our own messages and the error's class (run-6 re-check L3).
 */
import { loadBundle, type BundleFiles } from "./load";
import { RawReceipt } from "./bundle";
import { CONTRACT_NAMES } from "./summary";
import { Problems, type VerifyCheck } from "./util";

export const ONLINE_CHECK = "chain anchor (online, --rpc)";
const CONCURRENCY = 4;
const RECEIPT_KEYS = ["transactionHash", "transactionIndex", "blockHash", "blockNumber", "from", "to", "status", "logsBloom", "gasUsed", "cumulativeGasUsed", "contractAddress"] as const;
const LOG_KEYS = ["address", "topics", "data", "logIndex", "transactionIndex", "transactionHash", "blockHash", "blockNumber"] as const;

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface OnlineOptions {
  /** Defaults to the global fetch. */
  readonly fetch?: Fetch;
}

/** The one refusal for a bad --rpc URL: fixed text, so the URL (which may carry a key) is never echoed. */
export const RPC_URL_REFUSAL = "the RPC URL must be a valid http(s) URL without a user name or password";

/** The RPC URL, or null when it is not http(s), does not parse, or carries credentials (fetch would echo it). */
export function parseRpcUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  return url;
}

/** An error whose message we wrote (method, HTTP status, JSON-RPC code): never the URL, never the node's text. */
class RpcError extends Error {
  override readonly name = "RpcError";
}

const QUANTITY_RE = /^0x[0-9a-fA-F]{1,64}$/;

const low = (v: unknown): unknown => (typeof v === "string" ? v.toLowerCase() : Array.isArray(v) ? v.map(low) : v ?? null);

/** The consensus fields of a receipt, lowercased, as one canonical JSON string. */
export function receiptConsensus(r: Record<string, unknown>): string {
  const logs = (Array.isArray(r.logs) ? r.logs : []) as Record<string, unknown>[];
  const out: Record<string, unknown> = {};
  for (const k of RECEIPT_KEYS) out[k] = low(r[k]);
  out.logs = logs.map((l) => Object.fromEntries(LOG_KEYS.map((k) => [k, low(l[k])])));
  return JSON.stringify(out);
}

async function pooled<T>(items: readonly T[], fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
}

export async function verifyOnline(files: BundleFiles, rpcUrl: string, opts: OnlineOptions = {}): Promise<VerifyCheck> {
  const p = new Problems(ONLINE_CHECK);
  const url = parseRpcUrl(rpcUrl);
  if (!url) {
    p.add(RPC_URL_REFUSAL);
    return p.result("");
  }
  const loaded = loadBundle(files);
  const b = loaded.bundle;
  if (!b) {
    p.add("not run: the bundle's files are missing or invalid");
    return p.result("");
  }
  const doFetch = opts.fetch ?? (globalThis.fetch as unknown as Fetch);
  let id = 0;
  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    id += 1;
    const res = await doFetch(url.href, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    if (!res.ok) throw new RpcError(`${method}: HTTP ${Number(res.status)}`);
    const body = (await res.json()) as { result?: unknown; error?: { code?: unknown } };
    if (body.error) throw new RpcError(`${method}: JSON-RPC error ${typeof body.error.code === "number" ? body.error.code : "(no code)"}`);
    return body.result ?? null;
  };
  try {
    const chainId = await rpc("eth_chainId", []);
    const valid = typeof chainId === "string" && QUANTITY_RE.test(chainId);
    if (!valid || BigInt(chainId) !== BigInt(b.contracts.chainId)) p.add(`the node is on chain ${valid ? chainId : "(an invalid chain id)"}, not ${b.contracts.chainId}`);
    for (const name of CONTRACT_NAMES) {
      const c = b.contracts.contracts[name];
      if (!c) continue;
      const code = await rpc("eth_getCode", [c.address, "latest"]);
      if (typeof code !== "string" || code === "0x") p.add(`${name} ${c.address} has no code on the node`);
    }
    await pooled([...b.receipts.entries()], async ([hash, mine]) => {
      const theirs = await rpc("eth_getTransactionReceipt", [hash]);
      const parsed = RawReceipt.safeParse(theirs);
      if (!parsed.success) return p.add(`${hash}: the node has no receipt for it`);
      if (receiptConsensus(parsed.data) !== receiptConsensus(mine)) p.add(`${hash}: the node's receipt differs from the bundle's (status, logs, block or gas)`);
    });
    await pooled([...b.blocks], async (block) => {
      const theirs = (await rpc("eth_getBlockByNumber", [block.number, false])) as Record<string, unknown> | null;
      const same = theirs && [["hash", block.hash], ["parentHash", block.parentHash], ["timestamp", block.timestamp]].every(([k, v]) => low(theirs[k as string]) === low(v));
      if (!same) p.add(`block ${BigInt(block.number)}: the node's block differs from blocks.json`);
    });
    const unmined = b.payments.flatMap((e) => (e.payment.txHash && !b.receipts.has(e.payment.txHash.toLowerCase()) ? [e.payment.txHash.toLowerCase()] : []));
    await pooled(unmined, async (hash) => {
      if ((await rpc("eth_getTransactionReceipt", [hash])) !== null) p.add(`${hash}: the bundle shows it unmined, but the node has its receipt`);
    });
  } catch (error: unknown) {
    // fetch's own TypeError can quote the URL ("Failed to parse URL from …"): only our messages, else the class name.
    p.add(`the node could not be read: ${error instanceof RpcError ? error.message : error instanceof Error ? error.name : "unknown error"}`);
  }
  return p.result(`${b.receipts.size} receipts and ${b.blocks.length} blocks equal the node's`);
}
