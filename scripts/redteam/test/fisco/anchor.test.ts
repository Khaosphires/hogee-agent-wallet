/**
 * fisco:anchor (the TypeScript half of scripts/fisco/anchor.sh) against a fake Sepolia node: `text` prints the
 * pack's anchor text and calldata; `check-raw` gates a signed tx before it is published; `capture` asks the chain id
 * first, polls the receipt, refuses a failed or reorged one, and writes the sidecar exclusively (never over a file or
 * through a link) only after checkSepoliaAnchor accepts it. Nothing here signs a real key or touches a network.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { keccak256, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkSepoliaAnchor } from "../../../../tools/verify-evidence/src/fisco/anchor";
import { ANCHOR_KEY, anchorPack, BLOCK, OTHER_KEY, SIGNER, sidecarOf, type AnchorPack } from "../../../../tools/verify-evidence/test/fisco/anchor-fixture";
import { anchorMain, captureAnchor, checkRawTx, readAnchorPack } from "../../src/fisco/anchor";
import { GuardError, JsonRpcError, Rpc, type Transport } from "../../src/fisco/rpc";

let a: AnchorPack;
let good: { raw: Hex; receipt: Record<string, unknown> };
const roots: string[] = [];
const newRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), "fisco-anchor-"));
  roots.push(d);
  return d;
};

beforeAll(async () => {
  a = await anchorPack();
  const s = JSON.parse(await sidecarOf(a)) as { rawSignedTx: Hex; receipt: Record<string, unknown> };
  good = { raw: s.rawSignedTx, receipt: s.receipt };
}, 60_000);
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** <root>/fisco/<packId>/ on disk; returns the pack folder. */
function packDir(files: Readonly<Record<string, string>> = a.files, folder = a.packId): string {
  const dir = join(newRoot(), "fisco", folder);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}
const rawFile = (raw: string): string => {
  const p = join(newRoot(), "raw.hex");
  writeFileSync(p, `${raw}\n`);
  return p;
};
const sidecarPath = (dir: string): string => join(dirname(dir), "anchors", `${a.packId}.sepolia.json`);

interface Node {
  chainId?: string;
  /** Receipts served in turn (null = not yet mined); the last one repeats. */
  receipts?: unknown[];
  block?: unknown;
}

function fakeSepolia(node: Node = {}): Transport & { methods: string[] } {
  const methods: string[] = [];
  let i = 0;
  const t: Transport = async (method) => {
    methods.push(method);
    if (method === "eth_chainId") return node.chainId ?? "0xaa36a7";
    if (method === "eth_getTransactionReceipt") {
      const list = node.receipts ?? [good.receipt];
      return list[Math.min(i++, list.length - 1)] ?? null;
    }
    if (method === "eth_getBlockByNumber") return "block" in node ? node.block : { ...BLOCK, miner: `0x${"0".repeat(40)}`, transactions: [] };
    throw new JsonRpcError(-32601, "no such method", null);
  };
  return Object.assign(t, { methods });
}

const noSleep = { sleep: async () => undefined, now: () => new Date("2026-10-20T08:00:00Z") };
const capture = (dir: string, t: Transport, o: Partial<Parameters<typeof captureAnchor>[3]> = {}) => captureAnchor(new Rpc(t), readAnchorPack(dir), good.raw, { signer: SIGNER, ...noSleep, ...o });

describe("fisco:anchor text", () => {
  it("prints the pack's anchor text and its ASCII calldata", async () => {
    const lines: string[] = [];
    await anchorMain(["text", "--pack", packDir()], undefined, {}, (l) => lines.push(l));
    expect(lines).toEqual([`text: ${a.text}`, `calldata: 0x${Buffer.from(a.text, "ascii").toString("hex")}`]);
  });

  it("refuses a pack that does not load, or a folder not named after its packId", () => {
    expect(() => readAnchorPack(packDir({ ...a.files, "chain.json": "{}" }))).toThrow(/does not load/);
    expect(() => readAnchorPack(packDir(a.files, "fm-0000000000000000"))).toThrow(/not named after its packId/);
  });
});

describe("fisco:anchor check-raw", () => {
  it("passes the throwaway signer's self-send at the nonce read and names it", async () => {
    const lines: string[] = [];
    await anchorMain(["check-raw", "--pack", packDir(), "--raw", rawFile(good.raw), "--signer", SIGNER, "--nonce", "7"], undefined, {}, (l) => lines.push(l));
    expect(lines).toEqual([`ok: eip1559 tx ${keccak256(good.raw)} by ${SIGNER} to itself on chain 11155111, value 0, input = the anchor text, nonce 7, gas limit 30000, fee caps within the send limits`]);
  });

  it("needs the nonce read (--nonce) and refuses any other (audit run-12 v-2)", async () => {
    const dir = packDir();
    const raw = rawFile(good.raw);
    await expect(anchorMain(["check-raw", "--pack", dir, "--raw", raw, "--signer", SIGNER], undefined, {}, () => undefined)).rejects.toThrow(/--nonce/);
    for (const bad of ["8", "-1", "07", "x"]) {
      await expect(anchorMain(["check-raw", "--pack", dir, "--raw", raw, "--signer", SIGNER, "--nonce", bad], undefined, {}, () => undefined), bad).rejects.toThrow(/nonce/);
    }
  });

  it("refuses a tx the RPC could have shaped: not EIP-1559, gas over 60,000, fee caps over 50 / 2 gwei, another nonce (audit run-12 v-2)", async () => {
    const p = readAnchorPack(packDir());
    const sign = (edit: Record<string, unknown>) =>
      ANCHOR_KEY.signTransaction({ type: "eip1559", chainId: 11_155_111, nonce: 4, to: ANCHOR_KEY.address, value: 0n, data: p.calldata, gas: 31_720n, maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, ...edit } as never);
    expect(checkRawTx(await sign({}), p.calldata, SIGNER, 4)).toMatchObject({ type: "eip1559" });
    expect(checkRawTx(await sign({ gas: 60_000n, maxFeePerGas: 50_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n }), p.calldata, SIGNER, 4)).toMatchObject({ type: "eip1559" });
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ type: "legacy", maxFeePerGas: undefined, maxPriorityFeePerGas: undefined, gasPrice: 1_000_000_000n }, /legacy, not EIP-1559/],
      [{ type: "eip2930", maxFeePerGas: undefined, maxPriorityFeePerGas: undefined, gasPrice: 1_000_000_000n, accessList: [] }, /eip2930, not EIP-1559/],
      [{ gas: 60_001n }, /gas limit 60001 is over 60000/],
      [{ maxFeePerGas: 50_000_000_001n }, /max fee per gas 50000000001 wei is over 50 gwei/],
      [{ maxPriorityFeePerGas: 2_000_000_001n }, /max priority fee per gas 2000000001 wei is over 2 gwei/],
      [{ nonce: 5 }, /nonce 5, not the 4 read/],
    ];
    for (const [edit, why] of cases) {
      const raw = await sign(edit);
      expect(() => checkRawTx(raw, p.calldata, SIGNER, 4), String(why)).toThrow(why);
    }
  });

  it("refuses the wrong signer, chain, value, recipient or input", async () => {
    const p = readAnchorPack(packDir());
    expect(() => checkRawTx(good.raw, p.calldata, "0x46405e378F5AC837b8E18a96105e3ff3CCB22251")).toThrow(/not 0x46405e37/);
    const sign = async (edit: Record<string, unknown>, key = ANCHOR_KEY) =>
      key.signTransaction({ type: "eip1559", chainId: 11_155_111, nonce: 0, to: key.address, value: 0n, data: p.calldata, gas: 30_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, ...edit } as never);
    expect(() => checkRawTx(good.raw, p.calldata, OTHER_KEY.address)).toThrow(GuardError);
    expect(() => checkRawTx(good.raw, p.calldata, SIGNER)).not.toThrow();
    expect(() => checkRawTx(good.raw, `${p.calldata}00` as Hex, SIGNER)).toThrow(/not this pack's anchor text/);
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ chainId: 1 }, /chain 1/],
      [{ value: 1n }, /moves value/],
      [{ to: OTHER_KEY.address }, /own signer/],
      [{ data: "0x00" }, /not this pack's anchor text/],
    ];
    for (const [edit, why] of cases) {
      const raw = await sign(edit);
      expect(() => checkRawTx(raw, p.calldata, SIGNER)).toThrow(why);
    }
  });

  it("refuses a raw file that is a link or not one hex line", async () => {
    const dir = packDir();
    const real = rawFile(good.raw);
    const link = join(newRoot(), "link.hex");
    symlinkSync(real, link);
    await expect(anchorMain(["check-raw", "--pack", dir, "--raw", link, "--signer", SIGNER], undefined, {}, () => undefined)).rejects.toThrow(/not a small regular file/);
    await expect(anchorMain(["check-raw", "--pack", dir, "--raw", rawFile("hello"), "--signer", SIGNER], undefined, {}, () => undefined)).rejects.toThrow(/0x-hex/);
  });
});

describe("fisco:anchor capture", () => {
  it("polls the receipt, then writes a sidecar checkSepoliaAnchor accepts; a second capture refuses to overwrite", async () => {
    const dir = packDir();
    const t = fakeSepolia({ receipts: [null, null, good.receipt] });
    const { path } = await capture(dir, t);
    expect(path).toBe(sidecarPath(dir));
    expect(t.methods).toEqual(["eth_chainId", "eth_getTransactionReceipt", "eth_getTransactionReceipt", "eth_getTransactionReceipt", "eth_getBlockByNumber"]);
    const text = readFileSync(path, "utf8");
    const p = readAnchorPack(dir);
    expect(checkSepoliaAnchor(p.files, text, { signer: SIGNER })).toMatchObject({ ok: true, anchor: { blockNumber: 0x8a1b2c } });
    expect(JSON.parse(text)).toMatchObject({ format: "hogee.fisco-anchor/1", packId: a.packId, text: a.text, txHash: keccak256(good.raw), block: BLOCK, capturedAt: "2026-10-20T08:00:00.000Z" });
    const again = fakeSepolia();
    await expect(capture(dir, again)).rejects.toThrow(/already exists; refusing to overwrite/);
    expect(again.methods).toEqual([]);
  });

  it("refuses any chain but Sepolia before asking anything else", async () => {
    const dir = packDir();
    const t = fakeSepolia({ chainId: "0x1" });
    await expect(capture(dir, t)).rejects.toThrow(/not Sepolia/);
    expect(t.methods).toEqual(["eth_chainId"]);
    expect(existsSync(sidecarPath(dir))).toBe(false);
  });

  it("refuses a failed tx, a reorged block and a missing receipt at the timeout; writes nothing", async () => {
    const dir = packDir();
    await expect(capture(dir, fakeSepolia({ receipts: [{ ...good.receipt, status: "0x0" }] }))).rejects.toThrow(/status 0x0/);
    await expect(capture(dir, fakeSepolia({ block: { ...BLOCK, hash: `0x${"ee".repeat(32)}` } }))).rejects.toThrow(/reorg/);
    await expect(capture(dir, fakeSepolia({ block: null }))).rejects.toThrow(/reorg/);
    let clock = 0;
    await expect(capture(dir, fakeSepolia({ receipts: [null] }), { timeoutMs: 10_000, now: () => new Date((clock += 4_000)) })).rejects.toThrow(/before the timeout/);
    expect(existsSync(sidecarPath(dir))).toBe(false);
  });

  it("refuses a served receipt that does not match the sidecar (checkSepoliaAnchor gates the write)", async () => {
    const dir = packDir();
    await expect(capture(dir, fakeSepolia({ receipts: [{ ...good.receipt, transactionHash: keccak256("0x01") }] }))).rejects.toThrow(/does not check out/);
    expect(existsSync(sidecarPath(dir))).toBe(false);
  });

  it("never writes through a linked anchors folder or a planted link", async () => {
    const dir = packDir();
    const elsewhere = newRoot();
    symlinkSync(elsewhere, join(dirname(dir), "anchors"));
    await expect(capture(dir, fakeSepolia())).rejects.toThrow(/already exists|not a real folder/);
    const dir2 = packDir();
    mkdirSync(join(dirname(dir2), "anchors"));
    symlinkSync(join(elsewhere, "x.json"), sidecarPath(dir2));
    await expect(capture(dir2, fakeSepolia())).rejects.toThrow(/already exists/);
    expect(existsSync(join(elsewhere, "x.json"))).toBe(false);
  });

  it("takes the URL from SEPOLIA_RPC_URL_CAPTURE over --rpc, refuses plain http off loopback, prints the path", async () => {
    const urls: string[] = [];
    const lines: string[] = [];
    const dir = packDir();
    const argv = ["capture", "--pack", dir, "--raw", rawFile(good.raw), "--signer", SIGNER, "--rpc", "https://flag.example.test/"];
    await anchorMain(argv, (u) => (urls.push(u), fakeSepolia()), { SEPOLIA_RPC_URL_CAPTURE: "https://env.example.test/k" }, (l) => lines.push(l));
    expect(urls).toEqual(["https://env.example.test/k"]);
    expect(lines).toEqual([`anchored: Sepolia block ${0x8a1b2c}, tx ${keccak256(good.raw)}`, `sidecar: ${sidecarPath(dir)}`]);
    const plain = ["capture", "--pack", packDir(), "--raw", rawFile(good.raw), "--signer", SIGNER, "--rpc", "http://sepolia.example.test/"];
    await expect(anchorMain(plain, (u) => (urls.push(u), fakeSepolia()), {}, () => undefined)).rejects.toThrow(/must be https/);
    expect(urls).toHaveLength(1);
  });
});
