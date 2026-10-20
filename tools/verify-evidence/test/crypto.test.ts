/**
 * parseSignedTx: a raw signed tx is read only in its one canonical form. The signer is recovered from the signature
 * over the re-serialised unsigned tx, so a malleated twin (the high-s signature, EIP-2) or a non-canonical RLP
 * encoding (a zero written as 0x00) of the same signed tx recovers the same signer under another keccak256: both are
 * refused, and every canonical type (legacy with and without EIP-155, EIP-2930, EIP-1559) still reads back.
 */
import { concatHex, fromRlp, keccak256, serializeTransaction, toRlp, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";
import { parseSignedTx, type ParsedTx } from "../src/crypto";
import { highSTwin } from "./fisco/anchor-fixture";

const KEY = privateKeyToAccount(`0x${"a1".repeat(32)}`);
const base = { nonce: 3, to: KEY.address, value: 0n, data: "0x686f676565" as Hex, gas: 30_000n } as const;
const raws: Record<"legacy155" | "legacyPre155" | "eip2930" | "eip1559", Hex> = { legacy155: "0x", legacyPre155: "0x", eip2930: "0x", eip1559: "0x" };

beforeAll(async () => {
  raws.legacy155 = await KEY.signTransaction({ ...base, type: "legacy", chainId: 20200, gasPrice: 0n });
  raws.legacyPre155 = await KEY.signTransaction({ ...base, type: "legacy", gasPrice: 1n } as never);
  raws.eip2930 = await KEY.signTransaction({ ...base, type: "eip2930", chainId: 11_155_111, gasPrice: 2n, accessList: [] });
  raws.eip1559 = await KEY.signTransaction({ ...base, type: "eip1559", chainId: 11_155_111, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
});

const parsed = (raw: Hex): ParsedTx => {
  const tx = parseSignedTx(raw);
  if (typeof tx === "string") throw new Error(tx);
  return tx;
};

/** The typed tx's RLP list with field `i` replaced (a zero quantity written as 0x00, say). */
function reencodeTyped(raw: Hex, i: number, value: Hex): Hex {
  const fields = fromRlp(`0x${raw.slice(4)}`, "hex") as Hex[];
  return concatHex([raw.slice(0, 4) as Hex, toRlp(fields.map((f, j) => (j === i ? value : f)))]);
}

describe("parseSignedTx", () => {
  it("reads every canonical type back: hash = keccak256(raw), signer, to, data, nonce, chain", () => {
    for (const [name, raw] of Object.entries(raws)) {
      const tx = parsed(raw);
      expect(tx, name).toEqual({
        hash: keccak256(raw),
        from: KEY.address.toLowerCase(),
        to: KEY.address.toLowerCase(),
        data: base.data,
        nonce: 3,
        chainId: name === "legacyPre155" ? null : name === "legacy155" ? 20200 : 11_155_111,
      });
    }
  });

  it("refuses the high-s twin of each type (EIP-2), though it recovers the same signer under another hash", () => {
    for (const [name, raw] of Object.entries(raws)) {
      const twin = highSTwin(raw);
      expect(keccak256(twin), name).not.toBe(keccak256(raw));
      expect(parseSignedTx(twin), name).toMatch(/high s/);
    }
  });

  it("refuses a non-canonical encoding of the same signed tx (a zero nonce or value written as 0x00)", async () => {
    const zero = await KEY.signTransaction({ ...base, nonce: 0, type: "eip1559", chainId: 11_155_111, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
    expect(parsed(zero).nonce).toBe(0);
    for (const [field, at] of [["nonce", 1], ["value", 6]] as const) {
      const odd = reencodeTyped(zero, at, "0x00");
      expect(odd, field).not.toBe(zero);
      expect(parseSignedTx(odd), field).toMatch(/canonical/);
    }
    const legacyFields = fromRlp(raws.legacy155, "hex") as Hex[];
    const oddLegacy = toRlp(legacyFields.map((f, j) => (j === 1 ? "0x00" : f)));
    expect(parseSignedTx(oddLegacy)).toMatch(/canonical/);
  });

  it("still refuses what never parsed or recovered: junk, unsigned, trailing bytes", async () => {
    expect(parseSignedTx("0x00")).toMatch(/does not parse/);
    expect(parseSignedTx(`${raws.eip1559}00`)).toMatch(/does not parse/);
    const unsigned = serializeTransaction({ ...base, type: "eip1559", chainId: 11_155_111, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
    expect(parseSignedTx(unsigned)).toMatch(/unsigned/);
  });
});
