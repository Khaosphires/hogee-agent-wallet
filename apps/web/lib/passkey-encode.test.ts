import { createHash, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  P256_HALF_N,
  P256_N,
  PasskeyEncodingError,
  bytesToBase64Url,
  bytesToHex,
  clientDataIndices,
  encodeWebAuthnAuth,
  hexToBytes,
  normalizeLowS,
  parseDerSignature,
  publicKeyFromSpki,
  toHex32,
} from "./passkey-encode";

const keys = () => generateKeyPairSync("ec", { namedCurve: "P-256" });
const p1363 = (r: bigint, s: bigint) => Buffer.concat([hexToBytes(toHex32(r)), hexToBytes(toHex32(s))]);
const verifies = (key: KeyObject, msg: Uint8Array, r: bigint, s: bigint) => verify("sha256", msg, { key, dsaEncoding: "ieee-p1363" }, p1363(r, s));

describe("parseDerSignature", () => {
  it("returns r and s that verify as an IEEE-P1363 signature", () => {
    const { privateKey, publicKey } = keys();
    for (let i = 0; i < 25; i += 1) {
      const msg = Buffer.from(`message ${i}`);
      const der = sign("sha256", msg, { key: privateKey, dsaEncoding: "der" });
      const { r, s } = parseDerSignature(der);
      expect(verifies(publicKey, msg, r, s)).toBe(true);
    }
  });

  it.each([
    ["wrong outer tag", "31060201010201ff"],
    ["length mismatch", "30070201010201ff"],
    ["non-minimal integer", "300702020001020101"],
    ["negative integer", "3006020181020101"],
    ["trailing bytes", "30060201010201010000"],
    ["zero r", "3006020100020101"],
  ])("rejects %s", (_name, hex) => {
    expect(() => parseDerSignature(hexToBytes(hex))).toThrow(PasskeyEncodingError);
  });
});

describe("normalizeLowS", () => {
  it("flips high-s to n − s and the signature still verifies", () => {
    const { privateKey, publicKey } = keys();
    let seenHigh = 0;
    for (let i = 0; i < 64 && seenHigh < 3; i += 1) {
      const msg = Buffer.from(`low-s ${i}`);
      const { r, s } = parseDerSignature(sign("sha256", msg, { key: privateKey, dsaEncoding: "der" }));
      const low = normalizeLowS(s);
      expect(low <= P256_HALF_N).toBe(true);
      expect(verifies(publicKey, msg, r, low)).toBe(true);
      if (s > P256_HALF_N) {
        seenHigh += 1;
        expect(low).toBe(P256_N - s);
      } else {
        expect(low).toBe(s);
      }
    }
    expect(seenHigh, "about half of raw signatures are high-s").toBeGreaterThan(0);
  });
});

describe("clientDataIndices", () => {
  it("returns byte offsets of the type and challenge keys", () => {
    const json = '{"type":"webauthn.get","challenge":"abc","origin":"http://localhost:3000"}';
    expect(clientDataIndices(json)).toEqual({ typeIndex: 1, challengeIndex: 23 });
  });

  it("counts UTF-8 bytes, not UTF-16 units, before the key", () => {
    const json = '{"x":"é","challenge":"abc","type":"webauthn.get"}';
    const idx = clientDataIndices(json);
    expect(idx.challengeIndex).toBe(json.indexOf('"challenge"') + 1);
    expect(new TextDecoder().decode(new TextEncoder().encode(json).subarray(idx.typeIndex, idx.typeIndex + 6))).toBe('"type"');
  });
});

describe("publicKeyFromSpki", () => {
  it("matches the JWK x and y", () => {
    const { publicKey } = keys();
    const spki = publicKey.export({ type: "spki", format: "der" });
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const { qx, qy } = publicKeyFromSpki(new Uint8Array(spki));
    expect(qx).toBe(bytesToHex(new Uint8Array(Buffer.from(jwk.x, "base64url"))));
    expect(qy).toBe(bytesToHex(new Uint8Array(Buffer.from(jwk.y, "base64url"))));
  });
});

describe("encodeWebAuthnAuth", () => {
  it("encodes a simulated authenticator assertion that verifies over authData ‖ sha256(clientData)", () => {
    const { privateKey, publicKey } = keys();
    const digest = bytesToHex(new Uint8Array(createHash("sha256").update("PlanApproval").digest()));
    const clientDataJSON = JSON.stringify({ type: "webauthn.get", challenge: bytesToBase64Url(hexToBytes(digest)), origin: "http://localhost:3000", crossOrigin: false });
    const authenticatorData = new Uint8Array(Buffer.concat([createHash("sha256").update("localhost").digest(), Buffer.from([0x05, 0, 0, 0, 1])]));
    const message = Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]);
    const signature = sign("sha256", message, { key: privateKey, dsaEncoding: "der" });
    const auth = encodeWebAuthnAuth({ signature, authenticatorData, clientDataJSON: new TextEncoder().encode(clientDataJSON) }, digest);
    expect(BigInt(auth.s) <= P256_HALF_N).toBe(true);
    expect(verifies(publicKey, message, BigInt(auth.r), BigInt(auth.s))).toBe(true);
    expect(clientDataJSON.slice(auth.typeIndex, auth.typeIndex + 6)).toBe('"type"');
    expect(clientDataJSON.slice(auth.challengeIndex, auth.challengeIndex + 11)).toBe('"challenge"');
    expect(auth.authenticatorData).toBe(bytesToHex(authenticatorData));
  });

  it("refuses an assertion over a different digest", () => {
    const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: "webauthn.get", challenge: "AAAA" }));
    expect(() => encodeWebAuthnAuth({ signature: new Uint8Array(), authenticatorData: new Uint8Array(), clientDataJSON }, `0x${"11".repeat(32)}`)).toThrow(/not this digest/);
  });
});
