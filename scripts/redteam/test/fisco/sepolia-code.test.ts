import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters } from "viem";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { CodeMeta } from "../../../../tools/verify-evidence/src/fisco/pack";
import { captureSepoliaCode, failureLine, sepoliaCodeMain } from "../../src/fisco/sepolia-code";
import { GuardError, JsonRpcError, Rpc, type Transport } from "../../src/fisco/rpc";
import { httpFixture, type HttpFixture } from "./http-fixture";

const GOV = "0x322f48d1f770b2c73459b33848b49669b8df3df1";
const HEAD = { number: "0xb6a000", hash: `0x${"ab".repeat(32)}` };
const temps: string[] = [];
afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "fisco-code-"));
  temps.push(d);
  return d;
};

function fakeSepolia(chainId = "0xaa36a7"): Transport & { methods: string[]; blocks: string[] } {
  const methods: string[] = [];
  const blocks: string[] = [];
  const t = (async (method: string, params: readonly unknown[]) => {
    methods.push(method);
    if (method === "eth_chainId") return chainId;
    if (method === "eth_getBlockByNumber") return HEAD;
    if (method === "eth_call") {
      blocks.push(String(params[1]));
      return encodeAbiParameters([{ type: "address" }], [GOV]);
    }
    if (method === "eth_getCode") {
      blocks.push(String(params[1]));
      return `0x6080${String(params[0]).slice(2, 10)}`;
    }
    throw new JsonRpcError(-32601, "no such method", null);
  }) as Transport & { methods: string[]; blocks: string[] };
  return Object.assign(t, { methods, blocks });
}

describe("captureSepoliaCode", () => {
  it("writes the five codes and meta.json, every read pinned to one block", async () => {
    const out = tmp();
    const t = fakeSepolia();
    const { meta } = await captureSepoliaCode(new Rpc(t), out, new Date("2026-10-20T00:00:00Z"));
    expect(CodeMeta.parse(meta)).toMatchObject({ chainId: 11155111, blockNumber: 0xb6a000, blockHash: HEAD.hash, addresses: { Treasury: "0xe08872f9496d21053b52b1127ac30e87300564fa", TreasuryGovernance: GOV } });
    expect(readdirSync(join(out, "code-sepolia")).sort()).toEqual(["MilestoneEscrow.hex", "PlanRegistry.hex", "SalesOracle.hex", "Treasury.hex", "TreasuryGovernance.hex", "meta.json"]);
    expect(readFileSync(join(out, "code-sepolia/Treasury.hex"), "utf8")).toBe("0x6080e08872f9\n");
    expect(new Set(t.blocks)).toEqual(new Set(["0xb6a000"]));
  });

  it("refuses mainnet (chain 1) before any other call", async () => {
    const t = fakeSepolia("0x1");
    await expect(captureSepoliaCode(new Rpc(t), tmp())).rejects.toThrow(GuardError);
    expect(t.methods).toEqual(["eth_chainId"]);
  });

  it("refuses the FISCO mirror's chain too", async () => {
    await expect(captureSepoliaCode(new Rpc(fakeSepolia("0x4ee8")), tmp())).rejects.toThrow(/not Sepolia/);
  });

  it("refuses to overwrite an earlier capture", async () => {
    const out = tmp();
    await captureSepoliaCode(new Rpc(fakeSepolia()), out);
    await expect(captureSepoliaCode(new Rpc(fakeSepolia()), out)).rejects.toThrow(/already exists/);
  });

  it("refuses a code-sepolia planted while the capture runs (a symlink), writing nothing through it (run-11 H-replay)", async () => {
    const out = tmp();
    const victim = tmp();
    const base = fakeSepolia();
    let planted = false;
    const t = (async (m: string, p: readonly unknown[]) => {
      if (m === "eth_getCode" && !planted) {
        planted = true;
        symlinkSync(victim, join(out, "code-sepolia"));
      }
      return base(m, p);
    }) as Transport;
    await expect(captureSepoliaCode(new Rpc(t), out)).rejects.toThrow(/EEXIST|already exists/);
    expect(readdirSync(victim)).toEqual([]);
  });

  it("refuses a latest block whose number is not a JSON-RPC quantity, without echoing it (audit run-12)", async () => {
    for (const number of ["0x1\u001b[2J", "12345", "0x", "0x00ff", `0x${"f".repeat(17)}`, 7]) {
      const base = fakeSepolia();
      const t = (async (m: string, p: readonly unknown[]) => (m === "eth_getBlockByNumber" ? { ...HEAD, number } : base(m, p))) as Transport;
      const error: unknown = await captureSepoliaCode(new Rpc(t), tmp()).catch((e: unknown) => e);
      expect(error, String(number)).toBeInstanceOf(GuardError);
      expect((error as Error).message).toMatch(/latest block/);
      expect((error as Error).message).not.toContain("\u001b");
    }
  });

  it("refuses a governance() answer that is not one ABI word of hex, before decoding it (audit run-12)", async () => {
    for (const ret of ["0x\u001b]0;pwned\u0007", "not hex", "0x", `0x${"00".repeat(31)}`, 42]) {
      const base = fakeSepolia();
      const t = (async (m: string, p: readonly unknown[]) => (m === "eth_call" ? ret : base(m, p))) as Transport;
      const error: unknown = await captureSepoliaCode(new Rpc(t), tmp()).catch((e: unknown) => e);
      expect(error, String(ret)).toBeInstanceOf(GuardError);
      expect((error as Error).message).toMatch(/governance\(\)/);
      expect((error as Error).message).not.toContain("pwned");
    }
  });

  it("refuses an address without code", async () => {
    const base = fakeSepolia();
    const t = (async (m: string, p: readonly unknown[]) => (m === "eth_getCode" ? "0x" : base(m, p))) as Transport;
    await expect(captureSepoliaCode(new Rpc(t), tmp())).rejects.toThrow(/holds no code/);
  });
});

describe("sepoliaCodeMain", () => {
  it("never writes the RPC URL into the capture", async () => {
    const out = tmp();
    const url = "https://eth-sepolia.example.com/v2/SECRET0123456789abcdef";
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => (writes.push(s), true)) as typeof process.stdout.write;
    try {
      await sepoliaCodeMain(["--", "--rpc", url, "--out", out], () => fakeSepolia());
    } finally {
      process.stdout.write = orig;
    }
    const dir = join(out, "code-sepolia");
    for (const f of readdirSync(dir)) expect(readFileSync(join(dir, f), "utf8")).not.toContain("SECRET");
    expect(writes.join("")).not.toContain("SECRET");
  });

  it("requires a URL (SEPOLIA_RPC_URL_CAPTURE or --rpc) and --out", async () => {
    await expect(sepoliaCodeMain(["--out", tmp()], undefined, {})).rejects.toThrow(/SEPOLIA_RPC_URL_CAPTURE.*--rpc/);
    await expect(sepoliaCodeMain(["--rpc", "https://rpc.example.com"], () => fakeSepolia(), {})).rejects.toThrow(/--out/);
  });

  it("reads the URL from SEPOLIA_RPC_URL_CAPTURE, preferred over --rpc (keeps it off argv; run-11 H-replay)", async () => {
    const seen: string[] = [];
    const quiet = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await sepoliaCodeMain(["--rpc", "https://other.example.com/v2/ARGV0123456789", "--out", tmp()], (u) => (seen.push(u), fakeSepolia()), { SEPOLIA_RPC_URL_CAPTURE: "https://eth-sepolia.example.com/v2/ENV0123456789abcd" });
      await sepoliaCodeMain(["--out", tmp()], (u) => (seen.push(u), fakeSepolia()), { SEPOLIA_RPC_URL_CAPTURE: "https://eth-sepolia.example.com/v2/ENV0123456789abcd" });
    } finally {
      process.stdout.write = quiet;
    }
    expect(seen).toEqual(["https://eth-sepolia.example.com/v2/ENV0123456789abcd", "https://eth-sepolia.example.com/v2/ENV0123456789abcd"]);
  });

  it.each(["http://rpc.example.com/v2/SECRET0123456789", "http://10.0.0.5:8545", "http://localhost:8545", "https://user:SECRET0123456789@rpc.example.com", "ftp://rpc.example.com", "not a url"])(
    "refuses %s before any request, without echoing it",
    async (url) => {
      const made: string[] = [];
      const error: unknown = await sepoliaCodeMain(["--out", tmp()], (u) => (made.push(u), fakeSepolia()), { SEPOLIA_RPC_URL_CAPTURE: url }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GuardError);
      expect(String((error as Error).message)).not.toContain("SECRET");
      expect(made).toEqual([]);
    },
  );

  it("accepts plain http only on 127.0.0.1 (a local relay)", async () => {
    const quiet = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await expect(sepoliaCodeMain(["--out", tmp()], () => fakeSepolia(), { SEPOLIA_RPC_URL_CAPTURE: "http://127.0.0.1:8545" })).resolves.toBeUndefined();
    } finally {
      process.stdout.write = quiet;
    }
  });
});

describe("failureLine (what the command prints when it fails)", () => {
  it("cleans control and bidi characters out of the error text, whatever threw it (audit run-12)", () => {
    expect(failureLine(new GuardError("a\u001b[2Jb\r\nok\u202e"))).toBe("fisco:sepolia-code failed: GuardError: a?[2Jb??ok?");
    expect(failureLine(new SyntaxError("Cannot convert 0x1\u001b]0;x\u0007 to a BigInt"))).toBe("fisco:sepolia-code failed: SyntaxError: Cannot convert 0x1?]0;x? to a BigInt");
    expect(failureLine(new Error("x".repeat(600))).length).toBeLessThanOrEqual("fisco:sepolia-code failed: Error: ".length + 500);
    expect(failureLine("thrown text")).toBe("fisco:sepolia-code failed: error");
  });
});

describe("sepoliaCodeMain over real HTTP (127.0.0.1, ephemeral ports)", () => {
  const open: HttpFixture[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((f) => f.close()));
  });

  it.each([302, 307])("a provider answering %i gets the capture refused; the redirect target gets nothing (run-11 C3)", async (status) => {
    const recorder = await httpFixture(() => ({ status: 200, body: "{}" }));
    const provider = await httpFixture(() => ({ status, headers: { location: `${recorder.url}admin` } }));
    open.push(recorder, provider);
    const out = tmp();
    await expect(sepoliaCodeMain(["--out", out], undefined, { SEPOLIA_RPC_URL_CAPTURE: provider.url })).rejects.toThrow(/eth_chainId/);
    expect(provider.hits).toHaveLength(1);
    expect(recorder.hits).toEqual([]);
    expect(existsSync(join(out, "code-sepolia"))).toBe(false);
  });
});
