import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, toHex, type Hex } from "viem";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { httpsNativeTransport, NATIVE_TLS_FILES, NativeRpc, readNativeTls, type NativeTransport } from "../../src/fisco/native-rpc";
import { GuardError, JsonRpcError } from "../../src/fisco/rpc";
import { tlsFixture, tlsServer, type TlsFixture, type TlsServer } from "./tls-fixture";

const HASH = keccak256(toHex("native-receipt")) as Hex;
/** The shape P1 saw from 3.17.1 (20 Oct): status int, blockNumber int, gasUsed decimal text, log addresses without 0x. */
const served = (over: Record<string, unknown> = {}) => ({
  version: 0,
  contractAddress: "",
  checksumContractAddress: "",
  gasUsed: "24112",
  status: 22,
  output: "0x08c379a0",
  blockNumber: 31,
  transactionHash: HASH,
  hash: keccak256(toHex("receipt")),
  from: "0x1111111111111111111111111111111111111111",
  to: "0x2222222222222222222222222222222222222222",
  logEntries: [],
  message: "",
  input: "0x",
  extraData: "",
  transactionProof: null,
  ...over,
});

/** A transport answering `result` (or `error`) and recording the request bodies. */
function fake(answer: (req: { method: string; params: unknown[] }) => unknown): NativeTransport & { bodies: string[] } {
  const bodies: string[] = [];
  const t = (async (body: string) => {
    bodies.push(body);
    const req = JSON.parse(body) as { id: number; method: string; params: unknown[] };
    const a = answer(req);
    if (a instanceof JsonRpcError) return { jsonrpc: "2.0", id: req.id, error: { code: a.code, message: a.message } };
    return { jsonrpc: "2.0", id: req.id, result: a };
  }) as NativeTransport & { bodies: string[] };
  t.bodies = bodies;
  return t;
}

const fast = { timeoutMs: 1_000, pollMs: 1, sleep: async () => {} };

describe("NativeRpc (injected transport)", () => {
  it("asks getTransactionReceipt(group0, \"\", hash, false) and keeps the receipt as served", async () => {
    const t = fake(() => served());
    const r = await new NativeRpc(t).receipt(HASH);
    expect(r).toEqual(served());
    expect(JSON.parse(t.bodies[0] as string)).toMatchObject({ jsonrpc: "2.0", method: "getTransactionReceipt", params: ["group0", "", HASH, false] });
  });

  it("answers null when the node serves no receipt yet", async () => {
    expect(await new NativeRpc(fake(() => null)).receipt(HASH)).toBeNull();
  });

  it.each([
    ["a receipt for another tx", { transactionHash: keccak256("0x01") }],
    ["a hex blockNumber", { blockNumber: "0x1f" }],
    ["a string status", { status: "22" }],
    ["a status over 255", { status: 256 }],
    ["a non-hex output", { output: "Account's status is abnormal" }],
  ])("refuses %s", async (_label, over) => {
    await expect(new NativeRpc(fake(() => served(over))).receipt(HASH)).rejects.toThrow(GuardError);
  });

  it("refuses a hash that is not lowercase 0x + 64 hex before asking", async () => {
    const t = fake(() => served());
    await expect(new NativeRpc(t).receipt(HASH.toUpperCase() as Hex)).rejects.toThrow(GuardError);
    expect(t.bodies).toEqual([]);
  });

  it("cleans a node's error text (no terminal escapes)", async () => {
    const error: unknown = await new NativeRpc(fake(() => new JsonRpcError(-32000, "x\u001b]0;t\u0007\r\nok", null))).receipt(HASH).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JsonRpcError);
    expect((error as Error).message).toBe("x?]0;t???ok");
  });

  it("waits until the receipt is served (null and JSON-RPC errors retried), then returns it", async () => {
    let n = 0;
    const t = fake(() => (++n === 1 ? null : n === 2 ? new JsonRpcError(-32603, "not found", null) : served({ status: 0 })));
    expect((await new NativeRpc(t).receiptWhenServed(HASH, fast)).status).toBe(0);
    expect(t.bodies).toHaveLength(3);
  });

  it("stops at once on a transport failure, and after the timeout when never served", async () => {
    const broken: NativeTransport = async () => {
      throw new Error("native RPC: the request failed (ECONNREFUSED)");
    };
    await expect(new NativeRpc(broken).receiptWhenServed(HASH, fast)).rejects.toThrow(/ECONNREFUSED/);
    await expect(new NativeRpc(fake(() => null)).receiptWhenServed(HASH, { ...fast, timeoutMs: 0 })).rejects.toThrow(/not served/);
  });
});

describe("readNativeTls", () => {
  const temps: string[] = [];
  afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const dir = (): string => {
    const d = mkdtempSync(join(tmpdir(), "fisco-sdk-"));
    temps.push(d);
    for (const f of Object.values(NATIVE_TLS_FILES)) writeFileSync(join(d, f), `-----BEGIN ${f}-----\n`);
    return d;
  };

  it("reads ca.crt, sdk.crt and sdk.key", () => {
    const t = readNativeTls(dir());
    expect(t.ca.toString()).toContain("ca.crt");
    expect(t.key.toString()).toContain("sdk.key");
  });

  it("refuses a linked file, a linked folder, a missing file and an oversize file, without echoing the path", () => {
    const linked = dir();
    rmSync(join(linked, "sdk.key"));
    writeFileSync(join(linked, "elsewhere"), "x");
    symlinkSync(join(linked, "elsewhere"), join(linked, "sdk.key"));
    expect(() => readNativeTls(linked)).toThrow(/sdk\.key is not a regular file/);
    const real = dir();
    const link = join(mkdtempSync(join(tmpdir(), "fisco-sdk-link-")), "sdk");
    temps.push(join(link, ".."));
    symlinkSync(real, link);
    expect(() => readNativeTls(link)).toThrow(/not a real folder/);
    const missing = dir();
    rmSync(join(missing, "ca.crt"));
    expect(() => readNativeTls(missing)).toThrow(/ca\.crt could not be read/);
    const big = dir();
    writeFileSync(join(big, "sdk.crt"), "x".repeat(16 * 1024 + 1));
    expect(() => readNativeTls(big)).toThrow(/over 16384 bytes/);
    try {
      readNativeTls(missing);
    } catch (e: unknown) {
      expect(String((e as Error).message)).not.toContain(missing);
    }
    mkdirSync(join(big, "sub"));
    expect(() => readNativeTls(join(big, "nope"))).toThrow(/does not exist/);
  });
});

describe("httpsNativeTransport against a real TLS server (127.0.0.1, ephemeral port, test-made RSA certificates)", () => {
  let tls: TlsFixture;
  const open: TlsServer[] = [];
  beforeAll(() => {
    tls = tlsFixture();
  }, 60_000);
  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });
  afterAll(() => rmSync(tls.root, { recursive: true, force: true }));
  const serve = async (...a: Parameters<typeof tlsServer>): Promise<TlsServer> => {
    const s = await tlsServer(...a);
    open.push(s);
    return s;
  };
  const answer = (body: string) => ({ status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: (JSON.parse(body) as { id: number }).id, result: served({ status: 18 }) }) });

  it("verifies the node against the chain CA (no hostname check: FISCO certificates carry no IP SAN) and presents the SDK certificate", async () => {
    const s = await serve(tls.node, tls.ca, answer);
    const rpc = NativeRpc.fromTlsDir(tls.sdkDir, { port: s.port });
    expect((await rpc.receipt(HASH))?.status).toBe(18);
    expect(s.bodies).toHaveLength(1);
  });

  it("refuses a node whose certificate another CA signed (nothing is answered)", async () => {
    const s = await serve(tls.foreignNode, tls.ca, answer);
    await expect(NativeRpc.fromTlsDir(tls.sdkDir, { port: s.port }).receipt(HASH)).rejects.toThrow(/native RPC: the request failed/);
    expect(s.bodies).toEqual([]);
  });

  it.each([301, 307, 308])("refuses a %i redirect", async (status) => {
    const s = await serve(tls.node, tls.ca, () => ({ status, headers: { location: "https://127.0.0.1:1/" } }));
    await expect(NativeRpc.fromTlsDir(tls.sdkDir, { port: s.port }).receipt(HASH)).rejects.toThrow(/redirect; refused/);
  });

  it("refuses a non-200 answer and a non-JSON body", async () => {
    const s = await serve(tls.node, tls.ca, () => ({ status: 500 }));
    await expect(NativeRpc.fromTlsDir(tls.sdkDir, { port: s.port }).receipt(HASH)).rejects.toThrow(/HTTP 500/);
    const t = await serve(tls.node, tls.ca, () => ({ status: 200, body: "<html>" }));
    await expect(httpsNativeTransport(readNativeTls(tls.sdkDir), { port: t.port })("{}")).rejects.toThrow(/not JSON/);
  });
});
