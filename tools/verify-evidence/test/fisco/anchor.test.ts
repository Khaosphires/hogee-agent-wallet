/**
 * checkSepoliaAnchor: the sidecar's signed tx must be the signer's own value-0 self-send on Sepolia carrying exactly
 * the text recomputed from THIS pack, with a matching status-1 receipt and block; every tampering fails, and nothing
 * throws. The text's exact form is pinned here (the brief's format, byte for byte).
 */
import { keccak256, type Hex } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { anchorCalldataOf, anchorTextOf, ANCHOR_CHECK, ANCHOR_SIGNER, checkSepoliaAnchor, MAX_ANCHOR_BYTES, type AnchorResult } from "../../src/fisco/anchor";
import { loadPack } from "../../src/fisco/load";
import { ANCHOR_KEY, anchorPack, BLOCK, highSTwin, OTHER_KEY, SIGNER, sidecarOf, type AnchorPack } from "./anchor-fixture";
import { edit, reindex, type Files } from "./tamper";

let a: AnchorPack;
let good: string;

beforeAll(async () => {
  a = await anchorPack();
  good = await sidecarOf(a);
}, 60_000);

const check = (sidecar: string | Uint8Array | null, files: Files = a.files, required = false): AnchorResult => checkSepoliaAnchor(files, sidecar, { signer: SIGNER, required });
const fails = (r: AnchorResult, why: RegExp): void => {
  expect(r.ok).toBe(false);
  expect(r.anchor).toBeNull();
  expect(r.detail).toMatch(why);
};

describe("anchor text", () => {
  it("is the brief's exact ASCII line, computed from pack.json, the hashes.json bytes and chain.json", () => {
    const loaded = loadPack(a.files);
    const pack = loaded.pack as NonNullable<typeof loaded.pack>;
    const hashes = keccak256(new TextEncoder().encode(a.files["hashes.json"] as string));
    expect(a.text).toBe(`hogee-fisco-anchor v1 pack=${pack.pack.packId} hashes=${hashes} chain=20200 head=${pack.chain.headAtEnd} head-hash=${pack.chain.headHashAtEnd}`);
    expect(a.text).toMatch(/^[\x20-\x7e]+$/);
    expect(anchorCalldataOf("hi ")).toBe("0x686920");
    expect(anchorCalldataOf(a.text)).toBe(`0x${Buffer.from(a.text, "ascii").toString("hex")}`);
  });

  it("lowercases the head hash and refuses a pack without hashes.json", () => {
    const upper = { pack: { packId: "fm-0123456789abcdef" }, chain: { headAtEnd: 9, headHashAtEnd: `0x${"AB".repeat(32)}` } };
    expect(anchorTextOf(upper, a.files)).toContain(`head=9 head-hash=0x${"ab".repeat(32)}`);
    const { "hashes.json": _h, ...rest } = a.files;
    expect(() => anchorTextOf(upper, rest)).toThrow(/hashes\.json is missing/);
  });
});

describe("checkSepoliaAnchor", () => {
  it("accepts the captured sidecar and reports block, UTC time and the Etherscan URL", () => {
    const r = check(good);
    expect(r).toMatchObject({ name: ANCHOR_CHECK, ok: true, anchored: true });
    const txHash = JSON.parse(good).txHash as string;
    expect(r.anchor).toEqual({
      packId: a.packId,
      text: a.text,
      txHash,
      signer: SIGNER,
      txType: "eip1559",
      blockNumber: 0x8a1b2c,
      blockHash: BLOCK.hash,
      timestamp: 0x68f56a00,
      utc: new Date(0x68f56a00 * 1000).toISOString(),
      etherscanUrl: `https://sepolia.etherscan.io/tx/${txHash}`,
    });
    expect(r.detail).toContain(`block ${0x8a1b2c}`);
    expect(r.detail).toContain(new Date(0x68f56a00 * 1000).toISOString());
    expect(r.detail).toContain(`https://sepolia.etherscan.io/tx/${txHash}`);
    expect(check(new TextEncoder().encode(good)).ok).toBe(true);
  });

  it("says the block and time are as stated by the sidecar: a real anchor's raw tx with rewritten block fields still passes offline", async () => {
    const moved = { number: "0x8a1b00", hash: keccak256("0x0b"), parentHash: keccak256("0x0c"), timestamp: "0x60000000" };
    const forged = await sidecarOf(a, { edit: (s) => ((s.block = moved), (s.receipt.blockNumber = moved.number), (s.receipt.blockHash = moved.hash)) });
    const r = check(forged);
    expect(r).toMatchObject({ ok: true, anchor: { blockNumber: 0x8a1b00, timestamp: 0x60000000 } });
    for (const detail of [r.detail, check(good).detail]) {
      expect(detail).toMatch(/block \d+ at \S+ as stated by the sidecar/);
      expect(detail).toMatch(/anyone holding the public raw tx can rewrite them; only --anchor-rpc or Etherscan confirms them/);
    }
  });

  it("accepts a legacy (EIP-155) self-send too", async () => {
    const legacy = await sidecarOf(a, { tx: (t) => ({ type: "legacy", chainId: t.chainId, nonce: t.nonce, to: t.to, value: 0n, data: t.data, gas: t.gas, gasPrice: 1_000_000_000n }) });
    expect(check(legacy)).toMatchObject({ ok: true, anchor: { txType: "legacy" } });
  });

  it("not anchored passes unless an anchor is required", () => {
    expect(check(null)).toMatchObject({ ok: true, anchored: false, anchor: null, detail: expect.stringMatching(/^not anchored/) });
    expect(check(null, a.files, true)).toMatchObject({ ok: false, anchored: false, anchor: null, detail: expect.stringMatching(/required/) });
  });

  it("pins the hogee-deployer when no test signer is given", () => {
    expect(ANCHOR_SIGNER).toBe("0x46405e378F5AC837b8E18a96105e3ff3CCB22251");
    fails(checkSepoliaAnchor(a.files, good), /not the hogee-deployer 0x46405e378f5ac837b8e18a96105e3ff3ccb22251/);
  });

  describe("any pack edit fails it", () => {
    it("a re-indexed edit of chain.json (the head moves)", () => {
      fails(check(good, edit(a.files, "chain.json", (c) => (c.headAtEnd += 1))), /not the one recomputed from this pack/);
    });

    it("a re-indexed edit of a tx file (hashes.json changes)", () => {
      const tx = Object.keys(a.files).find((p) => p.startsWith("txs/")) as string;
      fails(check(good, edit(a.files, tx, (t) => (t.tx = { ...t.tx, extra: 1 }))), /not the one recomputed from this pack/);
    });

    it("an edit without re-indexing (the pack no longer loads)", () => {
      const files = { ...a.files, "steps.json": (a.files["steps.json"] as string).replace("\n}", ' \n}') };
      fails(check(good, files), /the pack does not load/);
    });

    it("an extra file (re-indexed)", () => {
      fails(check(good, reindex({ ...a.files, "notes.txt": "x" })), /the pack does not load/);
    });
  });

  it("refuses another signer", async () => {
    fails(check(await sidecarOf(a, { key: OTHER_KEY, edit: (s) => ((s.receipt.from = SIGNER), (s.receipt.to = SIGNER)) })), /not the hogee-deployer/);
  });

  it("refuses chain 1 (mainnet)", async () => {
    fails(check(await sidecarOf(a, { tx: (t) => ({ ...t, chainId: 1 }) })), /chain 1, not Sepolia/);
  });

  it("refuses a value of 1 wei", async () => {
    fails(check(await sidecarOf(a, { tx: (t) => ({ ...t, value: 1n }) })), /moves value \(1 wei\)/);
  });

  it("refuses a tx to another address", async () => {
    fails(check(await sidecarOf(a, { tx: (t) => ({ ...t, to: OTHER_KEY.address }) })), /not sent to its own signer/);
  });

  it("refuses another input (one byte of the text)", async () => {
    const data = anchorCalldataOf(a.text.replace("chain=20200", "chain=20201"));
    fails(check(await sidecarOf(a, { tx: (t) => ({ ...t, data }) })), /input is not the anchor text/);
  });

  it("refuses a failed receipt (status 0x0)", async () => {
    fails(check(await sidecarOf(a, { edit: (s) => (s.receipt.status = "0x0") })), /status is 0x0/);
  });

  it("refuses a block hash that is not the receipt's", async () => {
    fails(check(await sidecarOf(a, { edit: (s) => (s.block.hash = keccak256("0x01")) })), /block hash is not the block's/);
    fails(check(await sidecarOf(a, { edit: (s) => (s.block.number = "0x8a1b2d") })), /block number is not the block's/);
  });

  it("refuses the high-s twin of the signed tx (same signer, another hash: not the tx Sepolia holds)", async () => {
    const twin = highSTwin(JSON.parse(good).rawSignedTx as Hex);
    const hash = keccak256(twin);
    fails(check(await sidecarOf(a, { edit: (s) => ((s.rawSignedTx = twin), (s.txHash = hash), (s.receipt.transactionHash = hash)) })), /high s/);
  });

  it("refuses a txHash that is not keccak256(rawSignedTx)", async () => {
    const other = keccak256("0x02");
    fails(check(await sidecarOf(a, { edit: (s) => ((s.txHash = other), (s.receipt.transactionHash = other)) })), /txHash is not keccak256\(rawSignedTx\)/);
  });

  it("refuses a receipt for another tx, with logs, or from someone else", async () => {
    fails(check(await sidecarOf(a, { edit: (s) => (s.receipt.transactionHash = keccak256("0x03")) })), /receipt is for another tx/);
    fails(check(await sidecarOf(a, { edit: (s) => s.receipt.logs.push({ address: SIGNER, topics: [], data: "0x", logIndex: "0x0", transactionIndex: "0x3", transactionHash: s.txHash, blockHash: BLOCK.hash, blockNumber: BLOCK.number }) })), /has logs/);
    fails(check(await sidecarOf(a, { edit: (s) => (s.receipt.to = OTHER_KEY.address.toLowerCase()) })), /from\/to is not the signer/);
  });

  it("refuses a sidecar for another pack id, or with another text", async () => {
    fails(check(await sidecarOf(a, { edit: (s) => (s.packId = "fm-0000000000000000") })), /for fm-0000000000000000, not this pack/);
    fails(check(await sidecarOf(a, { edit: (s) => (s.text = s.text.replace(/head=\d+/, "head=1")) })), /not the one recomputed/);
  });

  it("refuses a sidecar off its strict schema, not JSON, or over the cap", async () => {
    fails(check(await sidecarOf(a, { edit: (s) => (s.note = "x") })), /does not match its schema/);
    fails(check(await sidecarOf(a, { edit: (s) => (s.format = "hogee.fisco-anchor/2") })), /schema at format/);
    fails(check(await sidecarOf(a, { edit: (s) => (s.text = `${s.text}‮`) })), /schema at text/);
    fails(check("{"), /not UTF-8 JSON/);
    fails(check(new Uint8Array([0xff, 0xfe])), /not UTF-8 JSON/);
    const big = good.replace('"capturedAt"', `"pad": "${"x".repeat(MAX_ANCHOR_BYTES)}", "capturedAt"`);
    fails(check(big), /larger than 65536 bytes/);
  });

  it("never throws, whatever the bytes", () => {
    for (const junk of ["null", "[]", '{"format":"hogee.fisco-anchor/1"}', "\u0000"]) expect(check(junk).ok).toBe(false);
    const raw = JSON.parse(good) as { rawSignedTx: Hex };
    fails(check(good.replace(raw.rawSignedTx, "0x00")), /does not parse|keccak256/);
  });
});
