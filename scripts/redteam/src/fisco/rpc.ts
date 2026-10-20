/**
 * The replay's JSON-RPC access to the local FISCO BCOS mirror (and, for sepolia-code.ts only, to Sepolia).
 *
 * Plain JSON-RPC over fetch rather than a viem client, so the exact node objects (tx, receipt, block) are kept as
 * served and a refused send keeps its JSON-RPC error ({code, message, data}). Fail closed:
 *   - the mirror's URL must be http(s) on the literal 127.0.0.1, with no userinfo (checked at construction and again
 *     before every send). `localhost` is refused: it goes through the resolver and may reach [::1], which another
 *     local process can hold while the node listens on 127.0.0.1 only;
 *   - redirects are never followed (fetch `redirect: "error"`, and a 3xx or a redirected answer is refused): the
 *     guard checks the URL string, so a node answering "307 Location: <elsewhere>" must not move a signed tx (or the
 *     Sepolia capture's requests) to another host (run-11 C3);
 *   - eth_chainId must be 20200 before every send; a failure of that check is a GuardError, never a node refusal;
 *   - node-supplied text (JSON-RPC error messages) is cleaned of control characters (`nodeText`) before anything
 *     prints or records it;
 *   - an answer body is read up to MAX_RPC_BODY_BYTES (4 MiB) and refused beyond it, whether its Content-Length says
 *     so or it streams more, before any of it is parsed.
 * No error text carries the URL (a provider URL can hold a key).
 */
import type { Hex } from "viem";
import { FISCO_CHAIN_ID } from "../../../../tools/verify-evidence/src/fisco/pack";

export class GuardError extends Error {
  override readonly name = "GuardError";
}

/** A JSON-RPC error answer (FISCO may refuse a send with {code: 16, message, data: null}). */
export class JsonRpcError extends Error {
  override readonly name = "JsonRpcError";
  constructor(
    readonly code: number,
    message: string,
    readonly data: unknown,
  ) {
    super(message);
  }
}

export type Transport = (method: string, params: readonly unknown[]) => Promise<unknown>;

export const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_MESSAGE = 500;
/** The largest JSON-RPC answer read (the biggest real one, a FISCO block with its txs, is far below). */
export const MAX_RPC_BODY_BYTES = 4 * 1024 * 1024;
/** C0/C1 controls (escape sequences, newlines, BEL), format characters (bidi overrides, zero-width) and line/paragraph separators. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/** Node-supplied text made safe to print or record: every control/format character becomes "?", then clipped to `max`. */
export function nodeText(text: string, max: number = Number.POSITIVE_INFINITY): string {
  return text.replace(UNPRINTABLE, "?").slice(0, max);
}

/** The parsed URL when it is http(s)://127.0.0.1 without userinfo; else GuardError (URL not echoed). */
export function assertLoopbackUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new GuardError("the RPC URL does not parse");
  }
  const ok = (u.protocol === "http:" || u.protocol === "https:") && u.hostname === LOOPBACK_HOST && u.username === "" && u.password === "";
  if (!ok) throw new GuardError(`the RPC URL is not a loopback http(s) URL on ${LOOPBACK_HOST}`);
  return u;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Whether fetch failed because the server answered a redirect (`redirect: "error"`): only to word the error. */
function isRedirectRefusal(error: unknown): boolean {
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  return cause instanceof Error && /redirect/i.test(cause.message);
}

/**
 * The answer's body as text, read up to `max` bytes; a declared or streamed larger body is refused (and cancelled).
 * A failed read reports only its error class (a socket error can name the peer).
 */
async function boundedText(res: Response, method: string, max: number): Promise<string> {
  const tooLarge = `${method}: the RPC answer is larger than ${max} bytes; refused`;
  const declared = Number(res.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(tooLarge);
  }
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let next: Awaited<ReturnType<typeof reader.read>>;
    try {
      next = await reader.read();
    } catch (error: unknown) {
      throw new Error(`${method}: the RPC answer could not be read (${error instanceof Error ? error.name : "error"})`);
    }
    if (next.done) break;
    total += next.value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error(tooLarge);
    }
    chunks.push(next.value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

const parseOrNull = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

/**
 * JSON-RPC 2.0 over HTTP POST to exactly `url`: a redirect is an error (never followed), so nothing (no signed tx, no
 * request body, nothing the node encodes into a Location) leaves for another host. Errors never include the URL.
 */
export function httpTransport(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Transport {
  let id = 0;
  return async (method, params) => {
    id += 1;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error: unknown) {
      throw new Error(`${method}: the RPC request failed (${isRedirectRefusal(error) ? "a redirect, refused" : error instanceof Error ? error.name : "error"})`);
    }
    // Belt and braces: `redirect: "error"` already throws above; a fetch that followed one anyway is refused here.
    if (res.redirected || res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) throw new Error(`${method}: the RPC answered a redirect; refused`);
    if (!res.ok) throw new Error(`${method}: the RPC answered HTTP ${res.status}`);
    const body = parseOrNull(await boundedText(res, method, MAX_RPC_BODY_BYTES));
    if (!isRecord(body)) throw new Error(`${method}: the RPC answer is not a JSON object`);
    if (isRecord(body.error)) {
      const code = typeof body.error.code === "number" ? body.error.code : -1;
      const message = typeof body.error.message === "string" ? nodeText(body.error.message, MAX_MESSAGE) : "error";
      throw new JsonRpcError(code, message, body.error.data ?? null);
    }
    if (!("result" in body)) throw new Error(`${method}: the RPC answer has no result`);
    return body.result;
  };
}

export class Rpc {
  constructor(protected readonly transport: Transport) {}

  request<T = unknown>(method: string, params: readonly unknown[] = []): Promise<T> {
    return this.transport(method, params) as Promise<T>;
  }

  async chainId(): Promise<number> {
    const raw = await this.request("eth_chainId");
    if (typeof raw !== "string" || !/^0x[0-9a-fA-F]+$/.test(raw)) throw new GuardError("eth_chainId answered a non-quantity");
    return Number(BigInt(raw));
  }

  async blockNumber(): Promise<number> {
    return Number(BigInt(await this.request<string>("eth_blockNumber")));
  }

  async nonceOf(address: Hex): Promise<number> {
    return Number(BigInt(await this.request<string>("eth_getTransactionCount", [address, "latest"])));
  }

  /** eth_getBlockByNumber(number, true) as served: the block with its full tx objects (the regulator's ledger). */
  blockWithTxs(n: number): Promise<Record<string, unknown> | null> {
    return this.request("eth_getBlockByNumber", [`0x${n.toString(16)}`, true]);
  }

  /** eth_getBlockByNumber(number | "latest", false) as served. */
  block(tag: number | "latest"): Promise<Record<string, unknown> | null> {
    return this.request("eth_getBlockByNumber", [typeof tag === "number" ? `0x${tag.toString(16)}` : tag, false]);
  }

  receipt(hash: Hex): Promise<Record<string, unknown> | null> {
    return this.request("eth_getTransactionReceipt", [hash]);
  }

  tx(hash: Hex): Promise<Record<string, unknown> | null> {
    return this.request("eth_getTransactionByHash", [hash]);
  }

  code(address: Hex, block: number | "latest"): Promise<Hex> {
    return this.request("eth_getCode", [address, typeof block === "number" ? `0x${block.toString(16)}` : block]);
  }

  call(tx: { from?: Hex; to: Hex; data: Hex; gas?: bigint }, block: number | "latest" = "latest"): Promise<Hex> {
    const req = { ...(tx.from ? { from: tx.from } : {}), to: tx.to, data: tx.data, ...(tx.gas ? { gas: `0x${tx.gas.toString(16)}` } : {}) };
    return this.request("eth_call", [req, typeof block === "number" ? `0x${block.toString(16)}` : block]);
  }
}

/** The mirror's RPC: loopback only, and chain 20200 checked before every send. */
export class FiscoRpc extends Rpc {
  private readonly url: string;

  constructor(url: string, transport?: Transport) {
    assertLoopbackUrl(url);
    super(transport ?? httpTransport(url));
    this.url = url;
  }

  async requireChain(): Promise<void> {
    const id = await this.chainId();
    if (id !== FISCO_CHAIN_ID) throw new GuardError(`the RPC serves chain ${id}, not the FISCO mirror's ${FISCO_CHAIN_ID}`);
  }

  /**
   * eth_sendRawTransaction of exactly `raw`, after both guards. Returns the node's tx hash. Any failure of the guards
   * (a JSON-RPC error from eth_chainId included) is a GuardError, so the runner never records it as the node refusing
   * a tx that was never sent.
   */
  async sendRawTransaction(raw: Hex): Promise<Hex> {
    assertLoopbackUrl(this.url);
    try {
      await this.requireChain();
    } catch (error: unknown) {
      if (error instanceof GuardError) throw error;
      const what = error instanceof JsonRpcError ? `JSON-RPC error ${error.code}` : error instanceof Error ? error.name : "error";
      throw new GuardError(`the pre-send eth_chainId check failed (${what}); not sent`);
    }
    return this.request<Hex>("eth_sendRawTransaction", [raw]);
  }
}

/** node4 (the regulator's observer node) serves Web3 here; nothing else is accepted for the ledger capture. */
export const LEDGER_RPC_PORT = "8546";
/** The only methods the ledger capture may call on node4. */
export const LEDGER_METHODS = ["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getTransactionReceipt", "eth_getTransactionByHash", "web3_clientVersion"] as const;

/** A transport that refuses (GuardError, nothing sent) every method outside `allowed`. */
export function allowListTransport(t: Transport, allowed: readonly string[]): Transport {
  return async (method, params) => {
    if (!allowed.includes(method)) throw new GuardError(`${nodeText(method, 60)} is not a ledger read; refused`);
    return t(method, params);
  };
}

/**
 * The regulator's ledger: node4's Web3 RPC at http://127.0.0.1:8546, read-only from our side. FISCO's Web3 service is
 * not read-only server-side (an observer forwards a sent tx to the sealers), so the client refuses every method but
 * the six reads the capture needs (ledger.ts; eth_getTransactionByHash for node4's own tx objects when its block lists
 * hashes only), before the transport sees it.
 */
export class LedgerRpc extends Rpc {
  constructor(url: string, transport?: Transport) {
    const u = assertLoopbackUrl(url);
    if (u.protocol !== "http:" || u.port !== LEDGER_RPC_PORT) throw new GuardError(`the ledger RPC must be http://${LOOPBACK_HOST}:${LEDGER_RPC_PORT}`);
    super(allowListTransport(transport ?? httpTransport(url), LEDGER_METHODS));
  }
}
