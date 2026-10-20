/**
 * Explorer links are pinned by chain id (G0-DECISIONS §16 M5, §18 L2) and must be exactly the links the verifier
 * accepts: the same map, `<base>/tx/<hash>` and `<base>/address/<address>#code`.
 */
import { describe, expect, it } from "vitest";
import { codeUrlOf, PINNED_EXPLORERS as VERIFIER_EXPLORERS, txUrlOf } from "@hogee/verify-evidence";
import { addressUrl, blockUrl, chainLabel, explorerOf, PINNED_EXPLORERS, txLinkOf, txUrl } from "./explorer";

const SEPOLIA = 11_155_111;
const ANVIL = 31_337;
const HASH = `0x${"ab".repeat(32)}`;
const ADDR = `0x${"cd".repeat(20)}`;

describe("pinned explorers", () => {
  it("pins the same explorers as tools/verify-evidence", () => {
    expect(PINNED_EXPLORERS).toEqual(VERIFIER_EXPLORERS);
  });

  it("builds exactly the verifier's tx and code links on Sepolia", () => {
    const base = "https://sepolia.etherscan.io";
    expect(txUrl(SEPOLIA, HASH)).toBe(`${base}/tx/${HASH}`);
    expect(txUrl(SEPOLIA, HASH)).toBe(txUrlOf(base, HASH));
    expect(addressUrl(SEPOLIA, ADDR)).toBe(`${base}/address/${ADDR}#code`);
    expect(addressUrl(SEPOLIA, ADDR)).toBe(codeUrlOf(base, ADDR));
    expect(blockUrl(SEPOLIA, 7_123_456)).toBe(`${base}/block/7123456`);
  });

  it("lowercases checksummed hex, as the verifier compares it", () => {
    expect(txUrl(SEPOLIA, HASH.toUpperCase().replace("0X", "0x"))).toBe(`https://sepolia.etherscan.io/tx/${HASH}`);
    expect(addressUrl(SEPOLIA, "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01")).toBe("https://sepolia.etherscan.io/address/0xabcdef0123456789abcdef0123456789abcdef01#code");
  });

  it("gives Anvil and unknown chains no link at all", () => {
    expect(explorerOf(ANVIL)).toBeNull();
    expect(txUrl(ANVIL, HASH)).toBeNull();
    expect(addressUrl(ANVIL, ADDR)).toBeNull();
    expect(blockUrl(ANVIL, 1)).toBeNull();
    expect(explorerOf(1)).toBeNull();
    expect(explorerOf(undefined)).toBeNull();
    expect(explorerOf(null)).toBeNull();
    expect(explorerOf(Number.NaN)).toBeNull();
  });

  it("refuses a malformed hash, address or block instead of building a link from it", () => {
    for (const bad of ["", "0x", HASH.slice(0, -1), `${HASH}00`, `${HASH.slice(0, -1)}g`, `${HASH}/../../address/x`, `https://evil.example/tx/${HASH}`]) {
      expect(txUrl(SEPOLIA, bad), bad).toBeNull();
    }
    for (const bad of ["", ADDR.slice(0, -1), `${ADDR}#x`, `${ADDR}?a=1`, HASH]) expect(addressUrl(SEPOLIA, bad), bad).toBeNull();
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) expect(blockUrl(SEPOLIA, bad), String(bad)).toBeNull();
  });

  it("names the chains people see", () => {
    expect(chainLabel(SEPOLIA)).toBe("Sepolia · 11155111");
    expect(chainLabel(ANVIL)).toBe("Anvil (local) · 31337");
    expect(chainLabel(5)).toBe("chain 5");
    // REG-BRIEF (fisco-proof): the FISCO BCOS mirror's local chain is named, and never linked to any explorer.
    expect(chainLabel(20_200)).toBe("FISCO BCOS (local) · 20200");
    expect(explorerOf(20_200)).toBeNull();
    expect(txUrl(20_200, `0x${"ab".repeat(32)}`)).toBeNull();
    expect(Object.keys(PINNED_EXPLORERS)).toEqual(["11155111"]);
  });
});

describe("where a transaction hash links (run-9 critic gap 3)", () => {
  it("live: the row's chain first, else the session's; a local chain gets no link", () => {
    expect(txLinkOf(HASH, { mode: "live", sessionChainId: SEPOLIA })).toEqual({ href: txUrl(SEPOLIA, HASH), note: null, tag: null });
    expect(txLinkOf(HASH, { mode: "live", sessionChainId: SEPOLIA, bundleChainId: ANVIL }).href).toBeNull();
    expect(txLinkOf(HASH, { mode: "live", sessionChainId: ANVIL, bundleChainId: SEPOLIA }).href).toBe(txUrl(SEPOLIA, HASH));
    expect(txLinkOf(HASH, { mode: "live", sessionChainId: ANVIL })).toEqual({ href: null, note: "no public website shows this blockchain", tag: null });
  });

  it("replay: a hash the offline demo minted never links, even on a Sepolia session, and says so", () => {
    const minted = txLinkOf(HASH, { mode: "replay", sessionChainId: SEPOLIA });
    expect(minted.href).toBeNull();
    expect(minted.tag).toBe("replay");
    // ux-money (A10.19): the same meaning in plain words: a recording, made offline, not a real receipt.
    expect(minted.note).toMatch(/recording/);
    expect(minted.note).toMatch(/not a real receipt/);
  });

  it("replay: only a hash an evidence bundle row records on a chain with a pinned explorer links", () => {
    expect(txLinkOf(HASH, { mode: "replay", sessionChainId: SEPOLIA, bundleChainId: SEPOLIA })).toEqual({ href: txUrl(SEPOLIA, HASH), note: null, tag: null });
    expect(txLinkOf(HASH, { mode: "replay", sessionChainId: SEPOLIA, bundleChainId: ANVIL })).toEqual({ href: null, note: "no public website shows this blockchain", tag: null });
    expect(txLinkOf("0x1234", { mode: "replay", bundleChainId: SEPOLIA }).href).toBeNull();
  });

  it("mock, or no session yet: never a link", () => {
    for (const mode of ["mock", undefined] as const) {
      const link = txLinkOf(HASH, { mode, sessionChainId: SEPOLIA, bundleChainId: SEPOLIA });
      expect(link.href, String(mode)).toBeNull();
      expect(link.tag, String(mode)).toBeNull();
    }
    expect(txLinkOf(HASH, { mode: "mock", sessionChainId: SEPOLIA }).note).toBe("practice data: not on a blockchain");
  });
});
