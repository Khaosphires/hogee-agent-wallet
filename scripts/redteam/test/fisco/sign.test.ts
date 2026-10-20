import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keccak256, parseTransaction, recoverAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { hashMilestoneRelease, hogeeDomain, toBytes32Tag } from "@hogee/chain";
import { parseSignedTx } from "../../../../tools/verify-evidence/src/crypto";
import { passkeyProblem } from "../../../../tools/verify-evidence/src/crypto";
import { ecdsaSig, keySecretForms, signLegacy, softFounder } from "../../src/fisco/sign";

const to = "0x5c379feafe01a3ccf649f9407f744cafc355e15f" as Hex;

describe("signLegacy", () => {
  it("signs a legacy EIP-155 tx for chain 20200 at gas price 0 that parseSignedTx reads back", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const s = await signLegacy(account, { to, data: "0x8456cb59", nonce: 7, gas: 3_000_000n });
    expect(s.hash).toBe(keccak256(s.raw));
    const parsed = parseSignedTx(s.raw);
    if (typeof parsed === "string") throw new Error(parsed);
    expect(parsed.from).toBe(account.address.toLowerCase());
    expect(parsed.to).toBe(to);
    expect(parsed.data).toBe("0x8456cb59");
    expect(parsed.nonce).toBe(7);
    expect(parsed.chainId).toBe(20200);
    const tx = parseTransaction(s.raw);
    expect(tx.type).toBe("legacy");
    expect(tx.gasPrice ?? 0n).toBe(0n); // RLP 0x80: viem parses a zero gas price as absent
    expect(tx.gas).toBe(3_000_000n);
    expect(tx.v === 20200n * 2n + 35n || tx.v === 20200n * 2n + 36n).toBe(true);
  });

  it("refuses a zero gas limit (gas is always explicit)", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    await expect(signLegacy(account, { to, data: "0x", nonce: 0, gas: 0n })).rejects.toThrow(/gas/);
  });
});

describe("ecdsaSig", () => {
  it("is a kind-0 65-byte signature over the raw digest", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const digest = keccak256("0x1234");
    const sig = await ecdsaSig(account, digest);
    expect(sig.kind).toBe(0);
    expect(sig.data.length).toBe(2 + 130);
    expect(await recoverAddress({ hash: digest, signature: sig.data })).toBe(account.address);
  });
});

describe("softFounder", () => {
  it("signs a digest as a low-s passkey assertion that verifies under its key", () => {
    const founder = softFounder();
    const domain = hogeeDomain({ verifyingContract: to, chainTag: toBytes32Tag("fisco"), deploymentId: toBytes32Tag("final-2") });
    const digest = hashMilestoneRelease(domain, { orderId: toBytes32Tag("order-1"), idx: 1, amountMinor: 175_000n, evidenceHash: keccak256("0x01"), deploymentId: toBytes32Tag("final-2"), nonce: 9n, expiry: 2_000_000_000n });
    const { sig, assertion } = founder.sign(digest);
    expect(sig.kind).toBe(1);
    expect(passkeyProblem(digest, assertion, { qx: founder.qx, qy: founder.qy })).toBeNull();
    expect(passkeyProblem(keccak256("0x99"), assertion, { qx: founder.qx, qy: founder.qy })).not.toBeNull();
  });

  it("lists its private key forms for the secret scan", () => {
    expect(softFounder().secretForms().length).toBeGreaterThanOrEqual(4);
  });
});

describe("keySecretForms", () => {
  it("gives each key with and without 0x, never shorter than 16 chars", () => {
    const k = generatePrivateKey();
    const forms = keySecretForms([k]);
    expect(forms).toContain(k);
    expect(forms).toContain(k.slice(2));
    expect(forms.every((f) => f.length >= 16)).toBe(true);
  });

  it("includes the lower-case forms of a key given in upper or mixed case (what viem emits; run-11 H-replay)", () => {
    const k = generatePrivateKey();
    const upper = `0x${k.slice(2).toUpperCase()}` as `0x${string}`;
    const forms = keySecretForms([upper]);
    expect(forms).toContain(k);
    expect(forms).toContain(k.slice(2));
    expect(forms).toContain(k.slice(2).toUpperCase());
    expect(forms).toContain(Buffer.from(k.slice(2), "hex").toString("base64"));
  });

  it("includes the base64url and unpadded base64 forms (run-11b INFO)", () => {
    const k = generatePrivateKey();
    const bytes = Buffer.from(k.slice(2), "hex");
    const forms = keySecretForms([k]);
    expect(forms).toContain(bytes.toString("base64url"));
    expect(forms).toContain(bytes.toString("base64").replace(/=+$/, ""));
  });
});
