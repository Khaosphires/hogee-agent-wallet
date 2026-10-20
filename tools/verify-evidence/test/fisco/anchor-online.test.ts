/**
 * confirmSepoliaAnchor through a fake fetch: Sepolia's chain id first (nothing else is asked on any other chain),
 * the node's receipt and block must equal the sidecar's, redirects and odd URLs are refused, and neither the URL nor
 * the node's text ever reaches a detail.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ANCHOR_ONLINE_CHECK, ANCHOR_RPC_REFUSAL, confirmSepoliaAnchor, parseAnchorRpcUrl, type AnchorFetch } from "../../src/fisco/anchor-online";
import { anchorPack, BLOCK, sidecarOf } from "./anchor-fixture";

const URL_WITH_KEY = "https://sepolia.example.test/v3/SECRETKEY123";
let good: string;
let receipt: Record<string, unknown>;

beforeAll(async () => {
  good = await sidecarOf(await anchorPack());
  receipt = JSON.parse(good).receipt as Record<string, unknown>;
}, 60_000);

interface Node {
  chainId?: string;
  receipt?: unknown;
  block?: unknown;
  status?: number;
  redirected?: boolean;
  error?: { code: number; message: string };
  throws?: Error;
}

function fakeFetch(node: Node): AnchorFetch & { methods: string[]; redirects: string[] } {
  const methods: string[] = [];
  const redirects: string[] = [];
  const f = (async (_url, init) => {
    if (node.throws) throw node.throws;
    redirects.push(init.redirect);
    const { method } = JSON.parse(init.body) as { method: string };
    methods.push(method);
    const served = (key: "receipt" | "block", otherwise: unknown): unknown => (key in node ? node[key] : otherwise);
    const result = method === "eth_chainId" ? (node.chainId ?? "0xaa36a7") : method === "eth_getTransactionReceipt" ? served("receipt", receipt) : method === "eth_getBlockByNumber" ? served("block", { ...BLOCK, miner: "0x00" }) : null;
    return { ok: (node.status ?? 200) === 200, status: node.status ?? 200, redirected: node.redirected ?? false, json: async () => (node.error ? { jsonrpc: "2.0", id: 1, error: node.error } : { jsonrpc: "2.0", id: 1, result }) };
  }) as AnchorFetch & { methods: string[]; redirects: string[] };
  return Object.assign(f, { methods, redirects });
}

const confirm = (node: Node, url = URL_WITH_KEY) => {
  const f = fakeFetch(node);
  return confirmSepoliaAnchor(good, url, { fetch: f }).then((r) => ({ r, f }));
};

describe("confirmSepoliaAnchor", () => {
  it("passes when the node serves the same receipt and block, never following redirects", async () => {
    const { r, f } = await confirm({});
    expect(r).toMatchObject({ name: ANCHOR_ONLINE_CHECK, ok: true });
    expect(f.methods).toEqual(["eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByNumber"]);
    expect(new Set(f.redirects)).toEqual(new Set(["error"]));
  });

  it("ignores provider extras and letter case, not consensus fields", async () => {
    expect((await confirm({ receipt: { ...receipt, blockTimestamp: "0x1", from: String(receipt.from).toUpperCase().replace("0X", "0x") } })).r.ok).toBe(true);
  });

  it("fails when the node's receipt differs", async () => {
    const { r } = await confirm({ receipt: { ...receipt, gasUsed: "0x5ef5" } });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/the node's receipt differs/);
  });

  it("fails when the node has no receipt (not included)", async () => {
    const { r } = await confirm({ receipt: null });
    expect(r.detail).toMatch(/has no receipt/);
  });

  it("fails when the node's block differs (another hash, parent or time)", async () => {
    for (const block of [{ ...BLOCK, hash: `0x${"cd".repeat(32)}` }, { ...BLOCK, parentHash: `0x${"cd".repeat(32)}` }, { ...BLOCK, timestamp: "0x68f56a01" }]) {
      const { r } = await confirm({ block });
      expect(r.ok).toBe(false);
      expect(r.detail).toMatch(/the node's block differs/);
    }
    expect((await confirm({ block: null })).r.ok).toBe(false);
  });

  it("asks nothing else of a node on another chain (mainnet)", async () => {
    const { r, f } = await confirm({ chainId: "0x1" });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/not on Sepolia/);
    expect(f.methods).toEqual(["eth_chainId"]);
  });

  it("refuses a redirected answer, an HTTP error and a JSON-RPC error without echoing the node", async () => {
    expect((await confirm({ redirected: true })).r.detail).toMatch(/redirect; refused/);
    expect((await confirm({ status: 302 })).r.detail).toMatch(/redirect; refused/);
    expect((await confirm({ status: 500 })).r.detail).toMatch(/HTTP 500/);
    const { r } = await confirm({ error: { code: -32000, message: "evil \u001b[2J text" } });
    expect(r.detail).toMatch(/JSON-RPC error -32000/);
    expect(r.detail).not.toContain("evil");
  });

  it("never prints the URL, even when fetch's own error quotes it", async () => {
    const { r } = await confirm({ throws: new TypeError(`Failed to fetch ${URL_WITH_KEY}`) });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/could not be read: TypeError/);
    expect(JSON.stringify(r)).not.toContain("SECRETKEY123");
  });

  it("refuses plain http (except on 127.0.0.1), userinfo and junk before any request", async () => {
    for (const bad of ["http://sepolia.example.test/", "http://localhost:8545/", "https://user:pw@sepolia.example.test/", "ftp://127.0.0.1/", "not a url"]) {
      const { r, f } = await confirm({}, bad);
      expect(r).toMatchObject({ ok: false, detail: ANCHOR_RPC_REFUSAL });
      expect(f.methods).toEqual([]);
    }
    expect(parseAnchorRpcUrl("http://127.0.0.1:8647")?.port).toBe("8647");
    expect(parseAnchorRpcUrl(URL_WITH_KEY)?.protocol).toBe("https:");
  });

  it("does not run on a sidecar that does not parse", async () => {
    const f = fakeFetch({});
    const r = await confirmSepoliaAnchor("{}", URL_WITH_KEY, { fetch: f });
    expect(r.detail).toMatch(/^not run: the sidecar does not match its schema/);
    expect(f.methods).toEqual([]);
  });
});
