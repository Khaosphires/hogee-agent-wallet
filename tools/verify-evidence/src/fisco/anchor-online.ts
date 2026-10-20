/**
 * Opt-in online confirmation of a Sepolia anchor (`verify-fisco … --anchor-rpc <url>` or HOGEE_ANCHOR_RPC): asks a
 * Sepolia node whether the sidecar's tx is in its chain at the sidecar's block. Browser-safe (global fetch only).
 * Fail closed and quiet, like online.ts:
 *   - the URL must be https, or plain http on the literal 127.0.0.1 only, without userinfo; it is never printed;
 *   - eth_chainId must be 11155111 before any other call (any other chain is refused and nothing else is asked);
 *   - redirects are never followed (`redirect: "error"`, and a redirected answer is refused);
 *   - eth_getTransactionReceipt's consensus fields must equal the sidecar's (receiptConsensus), and
 *     eth_getBlockByNumber's hash, parent hash and time must equal the sidecar's block;
 *   - only our own messages and an error's class name are reported, never the node's text or the URL.
 * This proves inclusion as that node sees it; it does not re-run the offline check (checkSepoliaAnchor does).
 */
import { RawReceipt } from "../bundle";
import { parseRpcUrl, receiptConsensus } from "../online";
import { Problems, type VerifyCheck } from "../util";
import { ANCHOR_CHAIN_ID, parseAnchorSidecar } from "./anchor";

export const ANCHOR_ONLINE_CHECK = "Sepolia timestamp (online)";
export const ANCHOR_RPC_ENV = "HOGEE_ANCHOR_RPC";
/** Fixed text, so a URL that may carry a key is never echoed. */
export const ANCHOR_RPC_REFUSAL = "the anchor RPC URL must be https (plain http only on 127.0.0.1), without a user name or password";
const LOOPBACK = "127.0.0.1";
const TIMEOUT_MS = 30_000;
const QUANTITY_RE = /^0x[0-9a-fA-F]{1,64}$/;

export type AnchorFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; redirect: "error"; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; redirected?: boolean; json(): Promise<unknown> }>;

export interface AnchorOnlineOptions {
  /** Defaults to the global fetch. */
  readonly fetch?: AnchorFetch;
}

/** The URL when it is https, or http on 127.0.0.1, without userinfo; else null. */
export function parseAnchorRpcUrl(raw: string): URL | null {
  const url = parseRpcUrl(raw);
  if (!url) return null;
  return url.protocol === "https:" || url.hostname === LOOPBACK ? url : null;
}

/** An error whose message we wrote (method, HTTP status, JSON-RPC code): never the URL, never the node's text. */
class AnchorRpcError extends Error {
  override readonly name = "AnchorRpcError";
}

const low = (v: unknown): unknown => (typeof v === "string" ? v.toLowerCase() : v ?? null);

export async function confirmSepoliaAnchor(sidecar: Uint8Array | string, rpcUrl: string, opts: AnchorOnlineOptions = {}): Promise<VerifyCheck> {
  const p = new Problems(ANCHOR_ONLINE_CHECK);
  const url = parseAnchorRpcUrl(rpcUrl);
  if (!url) {
    p.add(ANCHOR_RPC_REFUSAL);
    return p.result("");
  }
  const parsed = parseAnchorSidecar(sidecar);
  if ("problem" in parsed) {
    p.add(`not run: ${parsed.problem}`);
    return p.result("");
  }
  const s = parsed.sidecar;
  const doFetch = opts.fetch ?? (globalThis.fetch as unknown as AnchorFetch);
  let id = 0;
  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    id += 1;
    const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(TIMEOUT_MS) : undefined;
    const res = await doFetch(url.href, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      redirect: "error",
      ...(signal ? { signal } : {}),
    });
    if (res.redirected === true || (res.status >= 300 && res.status < 400)) throw new AnchorRpcError(`${method}: the node answered a redirect; refused`);
    if (!res.ok) throw new AnchorRpcError(`${method}: HTTP ${Number(res.status)}`);
    const body = (await res.json()) as { result?: unknown; error?: { code?: unknown } } | null;
    if (!body || typeof body !== "object") throw new AnchorRpcError(`${method}: the answer is not a JSON object`);
    if (body.error) throw new AnchorRpcError(`${method}: JSON-RPC error ${typeof body.error.code === "number" ? body.error.code : "(no code)"}`);
    return body.result ?? null;
  };
  try {
    const chainId = await rpc("eth_chainId", []);
    if (typeof chainId !== "string" || !QUANTITY_RE.test(chainId) || BigInt(chainId) !== BigInt(ANCHOR_CHAIN_ID)) {
      p.add(`the node is not on Sepolia (${ANCHOR_CHAIN_ID}); nothing else was asked`);
      return p.result("");
    }
    const theirs = RawReceipt.safeParse(await rpc("eth_getTransactionReceipt", [s.txHash]));
    if (!theirs.success) p.add(`${s.txHash}: the node has no receipt for it`);
    else if (receiptConsensus(theirs.data) !== receiptConsensus(s.receipt)) p.add(`${s.txHash}: the node's receipt differs from the sidecar's (status, block or gas)`);
    const block = (await rpc("eth_getBlockByNumber", [s.block.number, false])) as Record<string, unknown> | null;
    const same = block !== null && typeof block === "object" && (["hash", "parentHash", "timestamp"] as const).every((k) => low(block[k]) === low(s.block[k]));
    if (!same) p.add(`block ${BigInt(s.block.number)}: the node's block differs from the sidecar's (hash, parent or time)`);
  } catch (error: unknown) {
    // fetch's own TypeError can quote the URL: only our messages, else the class name.
    p.add(`the node could not be read: ${error instanceof AnchorRpcError ? error.message : error instanceof Error ? error.name : "unknown error"}`);
  }
  return p.result(`the node on chain ${ANCHOR_CHAIN_ID} serves the same receipt for ${s.txHash} and the same block ${BigInt(s.block.number)}`);
}
