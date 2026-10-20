/**
 * The FISCO BCOS native JSON-RPC (node0's RPC service, https://127.0.0.1:20200), read-only and for one method only:
 * `getTransactionReceipt`. It is the only place the chain's own status code is served (Web3 says 0x0 for every refused
 * tx; native says 16 revert, 18 PermissionDenied, 22 AccountFrozen) and the return data of a system-contract call
 * (G/V steps' `output`). Fail closed:
 *   - node:https to the literal 127.0.0.1 only, POST "/", no proxy agent; a redirect (any 3xx) or any status but 200 is
 *     refused, never followed;
 *   - TLS: ca/cert/key from the --native-tls folder (chain-up.sh's snapshot of `nodes/127.0.0.1/sdk/`), the node's
 *     certificate verified against that CA (`rejectUnauthorized: true`); the hostname check is skipped because FISCO's
 *     node certificates carry no IP SAN (P1's live test, 20 Oct: RSA-2048, default TLS settings);
 *   - the files are read without following links, each a regular file under 16 KiB;
 *   - one method on an allow-list; the answer is capped, parsed and shape-checked before anyone uses it;
 *   - errors never carry a path, a request or a body: only our own text, a Node error code, or cleaned node text.
 * The transport is injectable for tests.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { request } from "node:https";
import { join } from "node:path";
import type { Hex } from "viem";
import { GuardError, JsonRpcError, LOOPBACK_HOST, nodeText } from "./rpc";

/** FISCO 3.x: the node's RPC port (node0) and group; the result fields we rely on (P1's live test, 20 Oct). */
export const NATIVE_RPC_PORT = 20_200;
export const NATIVE_GROUP = "group0";
export const NATIVE_METHODS = ["getTransactionReceipt"] as const;
export type NativeMethod = (typeof NATIVE_METHODS)[number];
/** The three files chain-up.sh snapshots into D/facts/sdk/. */
export const NATIVE_TLS_FILES = { ca: "ca.crt", cert: "sdk.crt", key: "sdk.key" } as const;

const MAX_TLS_FILE_BYTES = 16 * 1024;
/** A deploy receipt serves the creation input (≤ 2 × 49,152 hex chars): well under this. */
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const HASH_RE = /^0x[0-9a-f]{64}$/;
const HEX_RE = /^0x([0-9a-fA-F]{2})*$/;

export interface NativeTls {
  readonly ca: Buffer;
  readonly cert: Buffer;
  readonly key: Buffer;
}

/** A native receipt as served (kept whole for the pack); only the fields below are relied on. */
export type NativeReceiptServed = Record<string, unknown> & {
  readonly transactionHash: string;
  readonly blockNumber: number;
  readonly status: number;
  readonly output: string;
};

/** Parsed JSON-RPC answer body (unknown shape) for a request body. */
export type NativeTransport = (body: string) => Promise<unknown>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const errnoOf = (error: unknown): string => {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{1,60}$/.test(code) ? code : error instanceof Error ? error.name : "error";
};

/** One TLS file: not a link, a regular file of at most 16 KiB, the same inode as named (O_NOFOLLOW). */
function readTlsFile(dir: string, name: string): Buffer {
  const path = join(dir, name);
  let fd: number;
  try {
    const l = lstatSync(path);
    if (l.isSymbolicLink() || !l.isFile()) throw new GuardError(`native TLS: ${name} is not a regular file`);
    if (l.size > MAX_TLS_FILE_BYTES) throw new GuardError(`native TLS: ${name} is over ${MAX_TLS_FILE_BYTES} bytes`);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const f = fstatSync(fd);
    if (f.ino !== l.ino || f.dev !== l.dev || !f.isFile()) {
      closeSync(fd);
      throw new GuardError(`native TLS: ${name} changed while it was opened`);
    }
  } catch (error: unknown) {
    if (error instanceof GuardError) throw error;
    throw new GuardError(`native TLS: ${name} could not be read (${errnoOf(error)})`);
  }
  try {
    const buf = Buffer.alloc(MAX_TLS_FILE_BYTES + 1);
    let n = 0;
    for (;;) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
      if (n > MAX_TLS_FILE_BYTES) throw new GuardError(`native TLS: ${name} is over ${MAX_TLS_FILE_BYTES} bytes`);
    }
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/** ca.crt, sdk.crt and sdk.key from `dir` (a real folder, not a link). */
export function readNativeTls(dir: string): NativeTls {
  let d;
  try {
    d = lstatSync(dir);
  } catch {
    throw new GuardError("native TLS: the --native-tls folder does not exist");
  }
  if (d.isSymbolicLink() || !d.isDirectory()) throw new GuardError("native TLS: --native-tls is not a real folder");
  return { ca: readTlsFile(dir, NATIVE_TLS_FILES.ca), cert: readTlsFile(dir, NATIVE_TLS_FILES.cert), key: readTlsFile(dir, NATIVE_TLS_FILES.key) };
}

export interface HttpsNativeOptions {
  /** Default 20200. Only the tests pass another (an ephemeral port of their own TLS fixture); the CLI never does. */
  readonly port?: number;
  readonly timeoutMs?: number;
}

/** POST of `body` to https://127.0.0.1:<port>/ with the chain's client certificate; the parsed JSON answer. */
export function httpsNativeTransport(tls: NativeTls, opts: HttpsNativeOptions = {}): NativeTransport {
  const port = opts.port ?? NATIVE_RPC_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new GuardError("native RPC: bad port");
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return (body) =>
    new Promise<unknown>((resolve, reject) => {
      const fail = (why: string) => reject(new Error(`native RPC: ${why}`));
      const req = request(
        {
          host: LOOPBACK_HOST,
          port,
          method: "POST",
          path: "/",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
          ca: tls.ca,
          cert: tls.cert,
          key: tls.key,
          rejectUnauthorized: true,
          // FISCO node certificates have no IP SAN: the chain is still verified against the chain's own CA.
          checkServerIdentity: () => undefined,
          agent: false,
          timeout,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status !== 200) {
            res.resume();
            fail(status >= 300 && status < 400 ? "the node answered a redirect; refused" : `the node answered HTTP ${status}`);
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > MAX_ANSWER_BYTES) {
              res.destroy();
              fail(`the answer is over ${MAX_ANSWER_BYTES} bytes`);
              return;
            }
            chunks.push(c);
          });
          res.on("error", (e) => fail(`the answer failed (${errnoOf(e)})`));
          res.on("end", () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
              fail("the answer is not JSON");
            }
          });
        },
      );
      req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
      req.on("error", (e) => fail(`the request failed (${errnoOf(e)})`));
      req.end(body);
    });
}

export interface NativeWait {
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly sleep: (ms: number) => Promise<void>;
}

/** Checks the fields the replay relies on; returns the receipt as served. */
export function nativeReceiptOf(v: unknown, hash: Hex): NativeReceiptServed {
  if (!isRecord(v)) throw new GuardError(`native receipt ${hash}: not an object`);
  const { transactionHash, blockNumber, status, output } = v;
  if (typeof transactionHash !== "string" || transactionHash.toLowerCase() !== hash) throw new GuardError(`native receipt ${hash}: served for another tx hash`);
  if (typeof blockNumber !== "number" || !Number.isSafeInteger(blockNumber) || blockNumber < 0) throw new GuardError(`native receipt ${hash}: blockNumber is not an int`);
  if (typeof status !== "number" || !Number.isInteger(status) || status < 0 || status > 255) throw new GuardError(`native receipt ${hash}: status is not an int 0..255`);
  if (typeof output !== "string" || !HEX_RE.test(output)) throw new GuardError(`native receipt ${hash}: output is not hex`);
  return v as NativeReceiptServed;
}

export class NativeRpc {
  private id = 0;

  constructor(private readonly transport: NativeTransport) {}

  /** The node0 native RPC with the chain's client certificate from `tlsDir`. */
  static fromTlsDir(tlsDir: string, opts: HttpsNativeOptions = {}): NativeRpc {
    return new NativeRpc(httpsNativeTransport(readNativeTls(tlsDir), opts));
  }

  private async request(method: NativeMethod, params: readonly unknown[]): Promise<unknown> {
    if (!(NATIVE_METHODS as readonly string[]).includes(method)) throw new GuardError(`native RPC: ${nodeText(String(method), 40)} is not allowed`);
    this.id += 1;
    const body: unknown = await this.transport(JSON.stringify({ jsonrpc: "2.0", id: this.id, method, params }));
    if (!isRecord(body)) throw new Error(`${method}: the native answer is not a JSON object`);
    if (isRecord(body.error)) {
      const code = typeof body.error.code === "number" ? body.error.code : -1;
      const message = typeof body.error.message === "string" ? nodeText(body.error.message, 300) : "error";
      throw new JsonRpcError(code, message, null);
    }
    if (!("result" in body)) throw new Error(`${method}: the native answer has no result`);
    return body.result;
  }

  /** getTransactionReceipt(group0, "", hash, false): the checked receipt, or null when not (yet) served. */
  async receipt(hash: Hex): Promise<NativeReceiptServed | null> {
    if (!HASH_RE.test(hash)) throw new GuardError("native RPC: the tx hash is not lowercase 0x + 64 hex");
    const r = await this.request("getTransactionReceipt", [NATIVE_GROUP, "", hash, false]);
    return r === null || r === undefined ? null : nativeReceiptOf(r, hash);
  }

  /**
   * The receipt once node0's native RPC serves it: a null answer or a JSON-RPC error (not yet indexed) is retried until
   * `timeoutMs`; a transport or TLS failure, or a malformed receipt, stops at once.
   */
  async receiptWhenServed(hash: Hex, w: NativeWait): Promise<NativeReceiptServed> {
    const deadline = Date.now() + w.timeoutMs;
    for (;;) {
      let r: NativeReceiptServed | null = null;
      try {
        r = await this.receipt(hash);
      } catch (error: unknown) {
        if (!(error instanceof JsonRpcError)) throw error;
      }
      if (r) return r;
      if (Date.now() > deadline) throw new GuardError(`native receipt ${hash}: not served within ${w.timeoutMs} ms`);
      await w.sleep(w.pollMs);
    }
  }
}

/**
 * The SDK key as it could leak into a pack file: the PEM body, each of its lines, and the DER bytes as hex (the pack
 * writer's secret scan matches substrings; hex case-insensitively). Only for that scan.
 */
export function tlsKeySecretForms(tls: Pick<NativeTls, "key">): string[] {
  const lines = tls.key
    .toString("utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 16 && !l.startsWith("-----"));
  const body = lines.join("");
  return [...new Set([...lines, body, Buffer.from(body, "base64").toString("hex")])].filter((f) => f.length >= 16);
}
