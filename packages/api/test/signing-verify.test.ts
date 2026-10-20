/**
 * Hard rule 5: signatures are VERIFIED server-side before anything is relayed, with the rules of
 * contracts/src/HogeeSigs.sol (OZ ECDSA.tryRecover / OZ WebAuthn.verify with requireUV) — and passkey registrations
 * are checked (challenge, origin, RP ID, UV, a P-256 key) before a key is stored.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { serializeSignature, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";
import { verifyEcdsaSignature, verifyPasskeyAssertion, webAuthnSigData } from "../src/services/signing/verify";
import { RegistrationError, issueRegistrationChallenge, parseRegistration } from "../src/services/signing/webauthn";
import { SoftAuthenticator } from "./support/authenticator";

const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const digest = (): Hex => `0x${randomBytes(32).toString("hex")}`;
const bytes = (h: Hex) => Buffer.from(h.slice(2), "hex");

describe("verifyEcdsaSignature (OZ ECDSA.tryRecover == ownerEOA)", () => {
  const owner = privateKeyToAccount(generatePrivateKey());

  it("accepts the owner's signature over the digest", async () => {
    const d = digest();
    const sig = await owner.sign({ hash: d });
    expect(await verifyEcdsaSignature(d, sig, owner.address.toLowerCase() as Hex)).toBe(true);
  });

  it("refuses a signature by anyone else, over another digest, or with no owner EOA", async () => {
    const d = digest();
    const other = privateKeyToAccount(generatePrivateKey());
    expect(await verifyEcdsaSignature(d, await other.sign({ hash: d }), owner.address)).toBe(false);
    expect(await verifyEcdsaSignature(digest(), await owner.sign({ hash: d }), owner.address)).toBe(false);
    expect(await verifyEcdsaSignature(d, await owner.sign({ hash: d }), null)).toBe(false);
  });

  it("refuses the high-s twin and a v outside 27/28 (OZ InvalidSignatureS / malformed)", async () => {
    const d = digest();
    const key = generatePrivateKey();
    const s = await sign({ hash: d, privateKey: key });
    const addr = privateKeyToAccount(key).address;
    const high = serializeSignature({ r: s.r, s: `0x${(SECP_N - BigInt(s.s)).toString(16).padStart(64, "0")}`, v: s.v === 27n ? 28n : 27n });
    expect(await verifyEcdsaSignature(d, high, addr)).toBe(false);
    const raw = serializeSignature(s);
    const badV = `${raw.slice(0, 130)}${"01"}` as Hex;
    expect(await verifyEcdsaSignature(d, badV, addr)).toBe(false);
  });
});

describe("verifyPasskeyAssertion (OZ WebAuthn.verify, requireUV, low-s)", () => {
  const auth = new SoftAuthenticator();
  const key = { qx: auth.qx, qy: auth.qy };

  it("accepts a fresh assertion over the digest", () => {
    const d = digest();
    expect(verifyPasskeyAssertion(d, auth.assert(bytes(d)), key)).toBe(true);
  });

  it.each([
    ["another challenge", (d: Hex) => auth.assert(bytes(digest())), true],
    ["webauthn.create type", (d: Hex) => auth.assert(bytes(d), { type: "webauthn.create" }), true],
    ["no user verification", (d: Hex) => auth.assert(bytes(d), { uv: false }), true],
    ["no user presence", (d: Hex) => auth.assert(bytes(d), { up: false }), true],
    ["the high-s twin", (d: Hex) => auth.assert(bytes(d), { highS: true }), true],
  ])("refuses %s", (_label, make) => {
    const d = digest();
    expect(verifyPasskeyAssertion(d, make(d), key)).toBe(false);
  });

  it("refuses a tampered authenticatorData, a moved challenge index and another key", () => {
    const d = digest();
    const a = auth.assert(bytes(d));
    const flipped = `${a.authenticatorData.slice(0, -2)}${a.authenticatorData.endsWith("00") ? "01" : "00"}` as Hex;
    expect(verifyPasskeyAssertion(d, { ...a, authenticatorData: flipped }, key)).toBe(false);
    expect(verifyPasskeyAssertion(d, { ...a, challengeIndex: a.challengeIndex + 1 }, key)).toBe(false);
    const other = new SoftAuthenticator();
    expect(verifyPasskeyAssertion(d, a, { qx: other.qx, qy: other.qy })).toBe(false);
  });

  it("refuses backup-state without backup-eligibility, short authenticatorData and r = 0", () => {
    const d = digest();
    const a = auth.assert(bytes(d));
    const flags = Number.parseInt(a.authenticatorData.slice(2 + 64, 2 + 66), 16) | 0x10;
    const bsOnly = `${a.authenticatorData.slice(0, 66)}${flags.toString(16).padStart(2, "0")}${a.authenticatorData.slice(68)}` as Hex;
    expect(verifyPasskeyAssertion(d, { ...a, authenticatorData: bsOnly }, key)).toBe(false);
    expect(verifyPasskeyAssertion(d, { ...a, authenticatorData: `0x${"00".repeat(36)}` }, key)).toBe(false);
    expect(verifyPasskeyAssertion(d, { ...a, r: `0x${"0".repeat(64)}` }, key)).toBe(false);
  });

  it("refuses an unregistered (zero) key", () => {
    const d = digest();
    expect(verifyPasskeyAssertion(d, auth.assert(bytes(d)), { qx: `0x${"0".repeat(64)}`, qy: `0x${"0".repeat(64)}` })).toBe(false);
  });

  it("encodes the WebAuthnAuth tuple the contract decodes", () => {
    const d = digest();
    const data = webAuthnSigData(auth.assert(bytes(d)));
    // abi.encode((bytes32,bytes32,uint256,uint256,bytes,string)): leading 0x20 offset word, which HogeeSigs accepts.
    expect(data.slice(0, 66)).toBe(`0x${"20".padStart(64, "0")}`);
  });
});

describe("parseRegistration (WebAuthn create, attestation none)", () => {
  const secret = Buffer.from(randomBytes(32));
  const binding = "fac-1|founder-1";
  const rp = { rpId: "localhost", origins: ["http://localhost:3000"] };

  it("returns the credential and its P-256 key for a valid ceremony", () => {
    const auth = new SoftAuthenticator();
    const challenge = issueRegistrationChallenge(secret, binding, Date.now());
    const out = parseRegistration(auth.register(challenge), { ...rp, secret, binding, nowMs: Date.now() });
    expect(out).toEqual({ credentialId: auth.credentialIdB64, qx: auth.qx, qy: auth.qy });
  });

  it.each([
    ["a challenge the server never issued", { challenge: "forged" }, "CHALLENGE"],
    ["another origin", { origin: "https://evil.example" }, "ORIGIN"],
    ["another RP ID", { rpId: "evil.example" }, "RP_ID"],
    ["no user verification", { uv: false }, "USER_VERIFICATION"],
    ["a get ceremony", { type: "webauthn.get" }, "TYPE"],
  ] as const)("refuses %s", (_l, opts, reason) => {
    const auth = new SoftAuthenticator();
    const issued = issueRegistrationChallenge(secret, binding, Date.now());
    const challenge = "challenge" in opts ? Buffer.from(opts.challenge).toString("base64url") : issued;
    const reg = auth.register(challenge, opts as never);
    expect(() => parseRegistration(reg, { ...rp, secret, binding, nowMs: Date.now() })).toThrow(new RegistrationError(reason));
  });

  it("refuses an expired challenge and one bound to another founder", () => {
    const auth = new SoftAuthenticator();
    const old = issueRegistrationChallenge(secret, binding, Date.now() - 10 * 60 * 1000);
    expect(() => parseRegistration(auth.register(old), { ...rp, secret, binding, nowMs: Date.now() })).toThrow(RegistrationError);
    const other = issueRegistrationChallenge(secret, "fac-2|founder-2", Date.now());
    expect(() => parseRegistration(auth.register(other), { ...rp, secret, binding, nowMs: Date.now() })).toThrow(RegistrationError);
  });

  it("refuses a credential id that is not the attested one, and garbage", () => {
    const auth = new SoftAuthenticator();
    const challenge = issueRegistrationChallenge(secret, binding, Date.now());
    const reg = auth.register(challenge);
    expect(() => parseRegistration({ ...reg, id: "AAAA", rawId: "AAAA" }, { ...rp, secret, binding, nowMs: Date.now() })).toThrow(RegistrationError);
    const junk = { ...reg, response: { ...reg.response, attestationObject: "o2NmbXRkbm9uZQ" } };
    expect(() => parseRegistration(junk, { ...rp, secret, binding, nowMs: Date.now() })).toThrow(RegistrationError);
  });
});
