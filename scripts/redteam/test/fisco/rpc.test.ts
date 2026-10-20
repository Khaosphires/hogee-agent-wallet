import { afterEach, describe, expect, it } from "vitest";
import { assertLoopbackUrl, FiscoRpc, GuardError, httpTransport, JsonRpcError, LEDGER_METHODS, LedgerRpc, nodeText, Rpc, type Transport } from "../../src/fisco/rpc";
import { httpFixture, methodOf, rpcAnswer, type HttpFixture } from "./http-fixture";

/** A transport that answers from a table and records every call. */
function fake(answers: Record<string, unknown | ((params: readonly unknown[]) => unknown)>): Transport & { calls: string[] } {
  const calls: string[] = [];
  const t = (async (method: string, params: readonly unknown[]) => {
    calls.push(method);
    const a = answers[method];
    if (a === undefined) throw new JsonRpcError(-32601, `no ${method}`, null);
    return typeof a === "function" ? (a as (p: readonly unknown[]) => unknown)(params) : a;
  }) as Transport & { calls: string[] };
  t.calls = calls;
  return t;
}

describe("assertLoopbackUrl", () => {
  it.each(["http://127.0.0.1:8545", "http://127.0.0.1:8646/"])("accepts %s", (url) => {
    expect(assertLoopbackUrl(url).hostname).toBe("127.0.0.1");
  });

  it.each([
    // localhost goes through the resolver and may reach [::1], which another local process can hold (run-11 H-replay).
    "http://localhost:8545",
    "http://localhost:8646",
    "http://[::1]:8545",
    "http://10.0.0.5:8545",
    "https://rpc.example.com",
    "http://127.0.0.1.example.com:8545",
    "http://localhost.example.com:8545",
    "http://user:pw@127.0.0.1:8545",
    "http://evil.com@127.0.0.1:8545",
    "http://127.0.0.2:8545",
    "http://0.0.0.0:8545",
    "ws://127.0.0.1:8545",
    "file:///tmp/x",
    "not a url",
  ])("refuses %s", (url) => {
    expect(() => assertLoopbackUrl(url)).toThrow(GuardError);
  });

  it("never echoes the URL in its error (a provider URL can carry a key)", () => {
    const url = "https://eth-sepolia.example.com/v2/SECRETKEY1234567890";
    expect(() => assertLoopbackUrl(url)).toThrow(/not a loopback/);
    try {
      assertLoopbackUrl(url);
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("SECRETKEY");
    }
  });
});

describe("Rpc", () => {
  it("passes JSON-RPC errors through with code and data", async () => {
    const rpc = new Rpc(
      fake({
        eth_sendRawTransaction: () => {
          throw new JsonRpcError(16, "execution reverted", null);
        },
      }),
    );
    await expect(rpc.request("eth_sendRawTransaction", ["0x00"])).rejects.toMatchObject({ code: 16, data: null });
  });
});

describe("FiscoRpc guards", () => {
  it("refuses a chain id other than 20200 before sending", async () => {
    const t = fake({ eth_chainId: "0xaa36a7", eth_sendRawTransaction: "0x" + "1".repeat(64) });
    const rpc = new FiscoRpc("http://127.0.0.1:8646", t);
    await expect(rpc.sendRawTransaction("0x00")).rejects.toThrow(GuardError);
    expect(t.calls).toEqual(["eth_chainId"]);
  });

  it("checks the chain id before every send", async () => {
    const t = fake({ eth_chainId: "0x4ee8", eth_sendRawTransaction: `0x${"ab".repeat(32)}` });
    const rpc = new FiscoRpc("http://127.0.0.1:8646", t);
    await rpc.sendRawTransaction("0x01");
    await rpc.sendRawTransaction("0x02");
    expect(t.calls).toEqual(["eth_chainId", "eth_sendRawTransaction", "eth_chainId", "eth_sendRawTransaction"]);
  });

  it("refuses a non-loopback URL at construction", () => {
    expect(() => new FiscoRpc("http://192.168.1.10:8545", fake({}))).toThrow(GuardError);
  });

  it("refuses a malformed chain id answer", async () => {
    const rpc = new FiscoRpc("http://127.0.0.1:8646", fake({ eth_chainId: 20200 }));
    await expect(rpc.requireChain()).rejects.toThrow(GuardError);
  });

  it("turns a JSON-RPC error from the pre-send chain check into a GuardError, never a send refusal (run-11 H-replay)", async () => {
    const t = fake({
      eth_chainId: () => {
        throw new JsonRpcError(16, "busy", null);
      },
      eth_sendRawTransaction: `0x${"ab".repeat(32)}`,
    });
    const error: unknown = await new FiscoRpc("http://127.0.0.1:8646", t).sendRawTransaction("0x01").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GuardError);
    expect(error).not.toBeInstanceOf(JsonRpcError);
    expect(t.calls).toEqual(["eth_chainId"]);
  });
});

describe("LedgerRpc (node4, the regulator's observer: read-only from our side)", () => {
  const all = () => fake({ eth_chainId: "0x4ee8", eth_blockNumber: "0x2", eth_getBlockByNumber: {}, eth_getTransactionReceipt: null, eth_getTransactionByHash: null, web3_clientVersion: "FISCO", eth_sendRawTransaction: `0x${"ab".repeat(32)}`, eth_call: "0x", eth_getTransactionCount: "0x0" });

  it("accepts only http://127.0.0.1:8546", () => {
    expect(() => new LedgerRpc("http://127.0.0.1:8546", all())).not.toThrow();
    for (const url of ["http://127.0.0.1:8545", "http://localhost:8546", "http://127.0.0.1", "https://example.com:8546", "http://u:p@127.0.0.1:8546"]) {
      expect(() => new LedgerRpc(url, all())).toThrow(GuardError);
    }
  });

  it("passes the six read methods (eth_getTransactionByHash: node4's own tx objects, post-fix re-check)", async () => {
    const t = all();
    const rpc = new LedgerRpc("http://127.0.0.1:8546", t);
    await rpc.chainId();
    await rpc.blockNumber();
    await rpc.blockWithTxs(1);
    await rpc.receipt(`0x${"cd".repeat(32)}`);
    await rpc.tx(`0x${"cd".repeat(32)}`);
    await rpc.request("web3_clientVersion");
    const six = ["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getTransactionReceipt", "eth_getTransactionByHash", "web3_clientVersion"];
    expect(t.calls).toEqual(six);
    expect([...LEDGER_METHODS].sort()).toEqual([...six].sort());
  });

  it("refuses eth_sendRawTransaction (node4 would forward it), eth_call and anything else, before the transport sees it", async () => {
    const t = all();
    const rpc = new LedgerRpc("http://127.0.0.1:8546", t);
    await expect(rpc.request("eth_sendRawTransaction", ["0x01"])).rejects.toThrow(GuardError);
    await expect(rpc.call({ to: "0x0000000000000000000000000000000000010003", data: "0x" })).rejects.toThrow(GuardError);
    await expect(rpc.nonceOf("0x0000000000000000000000000000000000010003")).rejects.toThrow(GuardError);
    await expect(rpc.request("eth_sendTransaction", [{}])).rejects.toThrow(/not a ledger read/);
    expect(t.calls).toEqual([]);
  });
});

describe("nodeText", () => {
  it("replaces control and bidi characters (terminal escapes, newlines, overrides) and clips", () => {
    const cleaned = nodeText("rev\u001b[2Jert\u0007\n\r\u0000\u009b\u202e\u2066x\u2028y", 500);
    expect(cleaned).toBe("rev?[2Jert???????x?y");
    expect(/[\p{Cc}\p{Cf}]/u.test(cleaned)).toBe(false);
    expect(nodeText("abcdef", 3)).toBe("abc");
    expect(nodeText("FISCO BCOS 3.17.1", 200)).toBe("FISCO BCOS 3.17.1");
  });
});

describe("httpTransport against a real HTTP server (127.0.0.1, ephemeral ports)", () => {
  const open: HttpFixture[] = [];
  const serve = async (...a: Parameters<typeof httpFixture>): Promise<HttpFixture> => {
    const f = await httpFixture(...a);
    open.push(f);
    return f;
  };
  afterEach(async () => {
    await Promise.all(open.splice(0).map((f) => f.close()));
  });

  it("returns a plain JSON-RPC result", async () => {
    const node = await serve((hit) => rpcAnswer(hit, "0x4ee8"));
    await expect(httpTransport(node.url)("eth_chainId", [])).resolves.toBe("0x4ee8");
    expect(node.hits.map(methodOf)).toEqual(["eth_chainId"]);
  });

  it.each([301, 302, 303, 307, 308])("refuses a %i redirect: the call throws and the redirect target gets nothing (run-11 C3)", async (status) => {
    const recorder = await serve((hit) => (hit.method === "POST" ? rpcAnswer(hit, `0x${"ab".repeat(32)}`) : { status: 200, body: "{}" }));
    const node = await serve(() => ({ status, headers: { location: `${recorder.url}leak?d=keystore` } }));
    await expect(httpTransport(node.url)("eth_sendRawTransaction", ["0x01"])).rejects.toThrow(/eth_sendRawTransaction: the RPC (request failed|answered a redirect)/);
    expect(node.hits).toHaveLength(1);
    expect(recorder.hits).toEqual([]);
  });

  it("FiscoRpc: a node that passes the chain guard and then redirects the send gets the raw tx nowhere", async () => {
    const recorder = await serve((hit) => rpcAnswer(hit, `0x${"ab".repeat(32)}`));
    const node = await serve((hit) => (methodOf(hit) === "eth_chainId" ? rpcAnswer(hit, "0x4ee8") : { status: 307, headers: { location: `${recorder.url}x` } }));
    await expect(new FiscoRpc(node.url).sendRawTransaction("0xf86c0a")).rejects.toThrow(Error);
    expect(node.hits.map(methodOf)).toEqual(["eth_chainId", "eth_sendRawTransaction"]);
    expect(recorder.hits).toEqual([]);
  });

  it("Rpc (the Sepolia capture's client): a 302 to another host is refused, nothing is fetched there", async () => {
    const recorder = await serve(() => ({ status: 200, body: "{}" }));
    const node = await serve(() => ({ status: 302, headers: { location: `${recorder.url}internal` } }));
    await expect(new Rpc(httpTransport(node.url)).chainId()).rejects.toThrow(/eth_chainId/);
    expect(recorder.hits).toEqual([]);
  });

  it("refuses an answer body over 4 MiB, declared or streamed, before parsing it; one at the cap is read", async () => {
    const CAP = 4 * 1024 * 1024;
    const bodyOf = (size: number): string => {
      const skeleton = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" });
      return JSON.stringify({ jsonrpc: "2.0", id: 1, result: `0x${"0".repeat(size - skeleton.length)}` });
    };
    const over = bodyOf(CAP + 1);
    const declared = await serve(() => ({ status: 200, body: over }));
    await expect(httpTransport(declared.url)("eth_getBlockByNumber", ["0x1", true])).rejects.toThrow(/eth_getBlockByNumber: the RPC answer is larger than 4194304 bytes; refused/);
    const streamed = await serve(() => ({ status: 200, headers: { "transfer-encoding": "chunked" }, body: over }));
    await expect(httpTransport(streamed.url)("eth_getBlockByNumber", ["0x1", true])).rejects.toThrow(/larger than 4194304 bytes/);
    const atCap = await serve(() => ({ status: 200, headers: { "transfer-encoding": "chunked" }, body: bodyOf(CAP) }));
    await expect(httpTransport(atCap.url)("eth_getBlockByNumber", ["0x1", true])).resolves.toHaveLength(CAP - JSON.stringify({ jsonrpc: "2.0", id: 1, result: "" }).length);
  });

  it("cleans control characters out of a node's JSON-RPC error message", async () => {
    const node = await serve((hit) => rpcAnswer(hit, null, { code: 16, message: "revert\u001b]0;pwned\u0007\u001b[2J" }));
    const error: unknown = await httpTransport(node.url)("eth_sendRawTransaction", ["0x01"]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JsonRpcError);
    expect((error as JsonRpcError).code).toBe(16);
    expect((error as JsonRpcError).message).toBe("revert?]0;pwned??[2J");
  });

  it("cleans an OSC title sequence and CR/LF out of a node's error message (P1 / audit critic)", async () => {
    const node = await serve((hit) => rpcAnswer(hit, null, { code: -32000, message: "x\u001b]0;x\u0007\r\nFAKE: ok\u007f\u009b" }));
    const error: unknown = await httpTransport(node.url)("eth_call", []).catch((e: unknown) => e);
    expect((error as JsonRpcError).message).toBe("x?]0;x???FAKE: ok??");
  });
});
