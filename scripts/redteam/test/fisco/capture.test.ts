import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, parseTransaction, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { FINAL_2, type TxFile } from "../../../../tools/verify-evidence/src/fisco/pack";
import { CaptureError, chainFile, parseGenesis, rebuildLegacy, withHeadAtEnd } from "../../src/fisco/capture";
import { broadcastText, deployParams, parseArrayArg, readSepoliaBroadcast, SEPOLIA_BROADCAST_FILE } from "../../src/fisco/deployment";
import { jsonDiffPointers } from "../../src/fisco/scenario";
import { Rpc, type Transport } from "../../src/fisco/rpc";
import { signLegacy } from "../../src/fisco/sign";
import { fakeNode } from "./fake-node";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

const GENESIS = `[chain]
    sm_crypto=false
    group_id=group0
[web3]
    chain_id=20200
[consensus]
    consensus_type=pbft
    block_tx_count_limit=1000
    leader_period=1
    node.0=aaaa:1:1
    node.1=bbbb:1:1
    node.2=cccc:1:1
    node.3=dddd:1:1
[tx]
    gas_limit=3000000000
[features]
    feature_evm_cancun=1
    feature_evm_timestamp=1
    feature_evm_address=1
`;

const ADMIN = "0x4aa1b6a0f6dd7f0bbc8a0d7b3c0ec96f9d8dd1fe";
const AUTH_GENESIS = `${GENESIS}[executor]
    is_wasm=false
    is_auth_check=true
    auth_admin_account=${ADMIN.toUpperCase().replace("0X", "0x")}
    is_serial_execute=false
`;

describe("parseGenesis", () => {
  it("reads consensus, sealer count, tx gas limit and features (never node ids)", () => {
    const g = parseGenesis(GENESIS);
    expect(g).toEqual({ consensus: "pbft", sealerCount: 4, txGasLimit: "3000000000", features: { feature_evm_cancun: 1, feature_evm_timestamp: 1, feature_evm_address: 1 }, auth: { check: false, admin: null } });
    expect(JSON.stringify(g)).not.toContain("aaaa");
  });

  it("reads [executor] is_auth_check and auth_admin_account (lowercased), and refuses an admin that is not an address", () => {
    expect(parseGenesis(AUTH_GENESIS).auth).toEqual({ check: true, admin: ADMIN });
    expect(parseGenesis(AUTH_GENESIS.replace("is_auth_check=true", "is_auth_check=false")).auth.check).toBe(false);
    expect(() => parseGenesis(AUTH_GENESIS.replace(/auth_admin_account=.*/, "auth_admin_account=regulator"))).toThrow(/not an address/);
  });

  it("refuses a genesis without sealers or with a non-boolean feature", () => {
    expect(() => parseGenesis("[consensus]\nconsensus_type=pbft\n")).toThrow(CaptureError);
    expect(() => parseGenesis(`${GENESIS}    feature_x=2\n`)).toThrow(/feature_x/);
  });
});

describe("chainFile", () => {
  it("keeps the node's web3_clientVersion as printable text only (control and bidi characters replaced; run-11 H-replay)", async () => {
    const node = fakeNode();
    const t: Transport = async (m, p) => (m === "web3_clientVersion" ? "FISCO BCOS\u001b]0;x\u0007 3.17.1\u202e\n" : node(m, p));
    const c = await chainFile(new Rpc(t), parseGenesis(AUTH_GENESIS), 5, 0);
    expect(c.clientVersion).toBe("FISCO BCOS?]0;x? 3.17.1??");
    expect(c).toMatchObject({ chainId: 20200, sealerCount: 4, observerCount: 1, consensus: "pbft", auth: { check: true, admin: ADMIN } });
  });

  it("refuses, before anything is read from the node, a genesis without auth checks or without an admin", async () => {
    const node = fakeNode();
    await expect(chainFile(new Rpc(node), parseGenesis(GENESIS), 5, 0)).rejects.toThrow(/is_auth_check=true/);
    await expect(chainFile(new Rpc(node), parseGenesis(AUTH_GENESIS.replace(/\s+auth_admin_account=.*\n/, "\n")), 5, 0)).rejects.toThrow(/auth_admin_account/);
    expect(node.methods).toEqual([]);
  });
});

describe("rebuildLegacy", () => {
  it("re-serialises a served legacy tx to the bytes that hash to its hash", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { raw, hash } = await signLegacy(account, { to: "0x5c379feafe01a3ccf649f9407f744cafc355e15f", data: "0x6080", nonce: 3, gas: 5_000_000n });
    const t = parseTransaction(raw);
    const served = { hash, type: "0x0", nonce: toHex(t.nonce ?? 0), gasPrice: "0x0", gas: toHex(t.gas ?? 0n), value: "0x0", input: t.data, to: t.to, v: toHex(t.v ?? 0n), r: t.r, s: t.s };
    expect(rebuildLegacy(served)).toBe(raw);
    expect(() => rebuildLegacy({ ...served, nonce: "0x4" })).toThrow(/does not hash/);
    expect(() => rebuildLegacy({ ...served, type: "0x2" })).toThrow(/not legacy/);
    // A node that omits zero fields or names the calldata `data`: same bytes, still checked by the hash.
    const { value: _v, gasPrice: _g, input, ...sparse } = served;
    expect(rebuildLegacy({ ...sparse, data: input })).toBe(raw);
    expect(() => rebuildLegacy({ ...sparse, data: input, value: "0x1" })).toThrow(/does not hash/);
  });

  it("reads a served v of 0 or 1 as the y-parity of an EIP-155 tx (FISCO 3.17.1 serves v that way)", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { raw, hash } = await signLegacy(account, { to: "0x5c379feafe01a3ccf649f9407f744cafc355e15f", data: "0x6080", nonce: 3, gas: 5_000_000n });
    const t = parseTransaction(raw);
    const yParity = (t.v ?? 0n) - (35n + 2n * 20_200n);
    expect([0n, 1n]).toContain(yParity);
    const served = { hash, type: "0x0", nonce: toHex(t.nonce ?? 0), gasPrice: "0x0", gas: toHex(t.gas ?? 0n), value: "0x0", input: t.data, to: t.to, v: toHex(yParity), r: t.r, s: t.s };
    expect(rebuildLegacy(served)).toBe(raw);
    // The other parity is a different signature: it must not hash to the tx hash.
    expect(() => rebuildLegacy({ ...served, v: toHex(1n - yParity) })).toThrow(/does not hash/);
    // v = 27/28 still means "rebuild as EIP-155 on 20200"; a v for another chain id fails closed.
    expect(() => rebuildLegacy({ ...served, v: toHex(35n + 2n * 11_155_111n + yParity) })).toThrow(/does not hash/);
  });
});

describe("withHeadAtEnd", () => {
  const chain = { headAtStart: 4, headAtEnd: 4 } as never;
  const observerNode = { index: 4 as const, proposalTx: keccak256("0x0a"), proposalBlock: 1, weight: 0 as const, nodeIdKeccak: keccak256("0x0b") };
  const end = (headAtEnd: number) => ({ headAtEnd, headHashAtEnd: keccak256("0x0c").toUpperCase().replace("0X", "0x"), observerNode });
  const tx = (gasPrice: string, type = "0x0") => ({ hash: keccak256("0x01"), tx: { hash: keccak256("0x01"), gasPrice, type } }) as unknown as TxFile;
  it("accepts txs that all paid gas price 0, and keeps the end head's hash (lowercase) and node4's observer proposal", () => {
    expect(withHeadAtEnd(chain, end(27), [tx("0x0")])).toMatchObject({ headAtEnd: 27, headHashAtEnd: keccak256("0x0c"), observerNode });
  });
  it("refuses a tx that paid a gas price or is not legacy, and a head that went back", () => {
    expect(() => withHeadAtEnd(chain, end(27), [tx("0x3b9aca00")])).toThrow(/gas price/);
    expect(() => withHeadAtEnd(chain, end(27), [tx("0x0", "0x2")])).toThrow(/legacy/);
    expect(() => withHeadAtEnd(chain, end(3), [])).toThrow(/backwards/);
  });
});

describe("deploy inputs", () => {
  it("reads final-2's constructor inputs from the tracked Sepolia broadcast", () => {
    const p = deployParams(JSON.parse(readFileSync(join(ROOT, SEPOLIA_BROADCAST_FILE), "utf8")));
    expect(p).toMatchObject({ coolingSeconds: "120", loosenTimelockSeconds: "120", judgingWindowEnd: "1796083199" });
    expect(p.platformPayeeIds).toHaveLength(8);
    expect(p.platformPayoutHashes[0]).toBe("0x6307fed7f5396036d2b9d3aff080a4cda068f1d0d3511661fe792a1f8d2282b6");
  });

  it("reads the tracked Sepolia broadcast once: the pack's text is exactly the hashed bytes (run-11b LOW-2)", () => {
    const b = readSepoliaBroadcast(join(ROOT, SEPOLIA_BROADCAST_FILE));
    expect(keccak256(b.bytes)).toBe(FINAL_2.broadcastKeccak);
    expect(Buffer.from(b.text, "utf8").equals(Buffer.from(b.bytes))).toBe(true);
  });

  it("refuses bytes that are not UTF-8 and keeps a byte-order mark (the text must encode back to the same bytes)", () => {
    expect(() => broadcastText(new Uint8Array([0x7b, 0xff, 0x7d]))).toThrow(CaptureError);
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]);
    expect(Buffer.from(broadcastText(bom), "utf8").equals(Buffer.from(bom))).toBe(true);
  });

  it("cli.ts writes sepolia-broadcast.json from the one read it hashed, never a second read of the file", () => {
    const cli = readFileSync(join(ROOT, "scripts/redteam/src/fisco/cli.ts"), "utf8");
    expect(cli.match(/SEPOLIA_BROADCAST_FILE\)/g) ?? []).toHaveLength(1);
    expect(cli).toContain("[PACK_FILES.sepoliaBroadcast, sepoliaBroadcast.text]");
  });

  it("parses forge's printed arrays", () => {
    expect(parseArrayArg("[0xAB, 0xcd]")).toEqual(["0xab", "0xcd"]);
    expect(parseArrayArg("[]")).toEqual([]);
    expect(() => parseArrayArg("0xab")).toThrow(CaptureError);
  });
});

describe("jsonDiffPointers", () => {
  it("lists the leaves that differ (RFC 6901 escaping)", () => {
    expect(jsonDiffPointers({ a: { b: 1, c: [1, 2] }, "x/y": 1 }, { a: { b: 2, c: [1, 3] }, "x/y": 1 })).toEqual(["/a/b", "/a/c/1"]);
    expect(jsonDiffPointers({ "x/y": 1 }, { "x/y": 2 })).toEqual(["/x~1y"]);
    expect(jsonDiffPointers({ a: 1 }, { a: 1 })).toEqual([]);
  });
});
