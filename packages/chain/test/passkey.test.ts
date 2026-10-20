/**
 * The passkey encoder (src/passkey, copied from P2 at G2) against P2's 20 browser vectors in e2e/vectors (read in
 * place since G2), the same files contracts/test/PasskeyVectors.t.sol verifies with OZ WebAuthn.verify.
 *
 * A vector holds the encoded struct, not the authenticator's DER signature, so each test rebuilds the DER (in both the
 * low-s and the high-s form an authenticator may return) and checks the encoder reproduces the vector exactly.
 * The remaining cases are P2's own unit tests, ported.
 */
import { createHash, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeAbiParameters, keccak256, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { HOGEE_KINDS } from '../src/index';
import {
  P256_HALF_N,
  P256_N,
  PasskeyEncodingError,
  WEBAUTHN_AUTH_ABI,
  assertChallengeMatches,
  bytesToBase64Url,
  bytesToHex,
  clientDataIndices,
  encodeWebAuthnAuth,
  hexToBytes,
  normalizeLowS,
  parseDerSignature,
  publicKeyFromSpki,
  toHex32,
  webAuthnSig,
  webAuthnSigData,
  type WebAuthnAuth,
} from '../src/passkey';

/** keccak256(abi.encode(auth)) of passkey-1.json; contracts/test/PasskeyVectors.t.sol pins the same value. */
const GOLDEN_SIG_DATA_HASH_1: Hex = '0x1efaa75223cb4cde9f18663679059e3478e78b65f2ed7d08e0be14a34e5055a6';
const VECTOR_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'e2e', 'vectors');
/** DER prefix of a P-256 SubjectPublicKeyInfo (id-ecPublicKey, prime256v1, 66-byte BIT STRING). */
const P256_SPKI_PREFIX = '3059301306072a8648ce3d020106082a8648ce3d030107034200';
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;

interface PasskeyVector extends WebAuthnAuth {
  readonly digest: Hex;
  readonly qx: Hex;
  readonly qy: Hex;
}

function loadVectors(): readonly { readonly name: string; readonly v: PasskeyVector }[] {
  return readdirSync(VECTOR_DIR)
    .filter((f) => /^passkey-\d+\.json$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
    .map((name) => ({ name, v: JSON.parse(readFileSync(join(VECTOR_DIR, name), 'utf8')) as PasskeyVector }));
}

const VECTORS = loadVectors();

const authOf = (v: PasskeyVector): WebAuthnAuth => ({
  r: v.r,
  s: v.s,
  challengeIndex: v.challengeIndex,
  typeIndex: v.typeIndex,
  authenticatorData: v.authenticatorData,
  clientDataJSON: v.clientDataJSON,
});

/** Minimal positive DER INTEGER (a 0x00 pad only when the top bit is set). */
function derInteger(x: bigint): Uint8Array {
  const hex = x.toString(16);
  let body = hexToBytes(hex.length % 2 === 0 ? hex : `0${hex}`);
  if ((body[0] ?? 0) & 0x80) body = Uint8Array.of(0, ...body);
  return Uint8Array.of(0x02, body.length, ...body);
}

/** The strict-DER ECDSA signature an authenticator returns. */
function derSignature(r: bigint, s: bigint): Uint8Array {
  const body = Uint8Array.of(...derInteger(r), ...derInteger(s));
  return Uint8Array.of(0x30, body.length, ...body);
}

function nodeKey(qx: Hex, qy: Hex): KeyObject {
  const b64 = (h: Hex) => Buffer.from(h.slice(2), 'hex').toString('base64url');
  return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64(qx), y: b64(qy) }, format: 'jwk' });
}

const keyAt = (json: Buffer, index: number, expected: string): boolean =>
  json.subarray(index, index + Buffer.byteLength(expected)).equals(Buffer.from(expected, 'utf8'));

/** The rules of OZ WebAuthn.verify(abi.encodePacked(digest), auth, qx, qy) with requireUV, in Node. */
function verifiesLikeOz(digest: Hex, auth: WebAuthnAuth, qx: Hex, qy: Hex): boolean {
  const authData = Buffer.from(auth.authenticatorData.slice(2), 'hex');
  const json = Buffer.from(auth.clientDataJSON, 'utf8');
  const challenge = Buffer.from(digest.slice(2), 'hex').toString('base64url');
  const flags = authData[32] ?? 0;
  const s = BigInt(auth.s);
  if (authData.length <= 36) return false;
  if (!keyAt(json, auth.typeIndex, '"type":"webauthn.get"')) return false;
  if (!keyAt(json, auth.challengeIndex, `"challenge":"${challenge}"`)) return false;
  if (!(flags & FLAG_UP) || !(flags & FLAG_UV) || (flags & FLAG_BS && !(flags & FLAG_BE))) return false;
  if (s === 0n || s > P256_HALF_N) return false;
  const message = Buffer.concat([authData, createHash('sha256').update(json).digest()]);
  const sig = Buffer.concat([Buffer.from(auth.r.slice(2), 'hex'), Buffer.from(auth.s.slice(2), 'hex')]);
  return verify('sha256', message, { key: nodeKey(qx, qy), dsaEncoding: 'ieee-p1363' }, sig);
}

describe("P2's browser vectors (e2e/vectors)", () => {
  it('has 20 vectors, numbered 1..20, each with exactly the nine fields', () => {
    expect(VECTORS.map((x) => x.name)).toEqual(Array.from({ length: 20 }, (_, i) => `passkey-${i + 1}.json`));
    for (const { v } of VECTORS) {
      expect(Object.keys(v).sort()).toEqual(
        ['authenticatorData', 'challengeIndex', 'clientDataJSON', 'digest', 'qx', 'qy', 'r', 's', 'typeIndex'].sort(),
      );
    }
  });

  it.each(VECTORS)('$name: the DER assertion encodes to exactly the vector, from low-s and high-s DER', ({ v }) => {
    const raw = {
      authenticatorData: hexToBytes(v.authenticatorData),
      clientDataJSON: new TextEncoder().encode(v.clientDataJSON),
    };
    const r = BigInt(v.r);
    const s = BigInt(v.s);
    expect(encodeWebAuthnAuth({ ...raw, signature: derSignature(r, s) }, v.digest)).toEqual(authOf(v));
    expect(encodeWebAuthnAuth({ ...raw, signature: derSignature(r, P256_N - s) }, v.digest)).toEqual(authOf(v));
  });

  it.each(VECTORS)('$name: the struct passes the OZ WebAuthn.verify rules (requireUV) in Node', ({ v }) => {
    expect(clientDataIndices(v.clientDataJSON)).toEqual({ challengeIndex: v.challengeIndex, typeIndex: v.typeIndex });
    expect(() => assertChallengeMatches(v.clientDataJSON, v.digest)).not.toThrow();
    expect(verifiesLikeOz(v.digest, authOf(v), v.qx, v.qy)).toBe(true);
    expect(verifiesLikeOz(v.digest, { ...authOf(v), s: toHex32(P256_N - BigInt(v.s)) }, v.qx, v.qy)).toBe(false);
  });

  it.each(VECTORS)('$name: Sig.data decodes back to the struct and HogeeSigs can read both encodings', ({ v }) => {
    const sig = webAuthnSig(authOf(v));
    expect(sig.kind).toBe(HOGEE_KINDS.SIG_WEBAUTHN);
    expect(sig.data.slice(0, 66)).toBe(toHex32(0x20n)); // Solidity abi.encode(struct): one offset word
    const [decoded] = decodeAbiParameters([WEBAUTHN_AUTH_ABI], sig.data);
    expect({ ...decoded, challengeIndex: Number(decoded.challengeIndex), typeIndex: Number(decoded.typeIndex) }).toEqual(
      authOf(v),
    );
  });

  it('Sig.data is byte-identical to Solidity abi.encode(auth) (golden shared with PasskeyVectors.t.sol)', () => {
    const first = VECTORS[0];
    if (!first) throw new Error('no vectors');
    expect(keccak256(webAuthnSigData(authOf(first.v)))).toBe(GOLDEN_SIG_DATA_HASH_1);
  });

  it('the vectors key is a valid P-256 SPKI point, and publicKeyFromSpki recovers it', () => {
    const first = VECTORS[0];
    if (!first) throw new Error('no vectors');
    const spki = hexToBytes(`${P256_SPKI_PREFIX}04${first.v.qx.slice(2)}${first.v.qy.slice(2)}`);
    expect(() => createPublicKey({ key: Buffer.from(spki), format: 'der', type: 'spki' })).not.toThrow();
    expect(publicKeyFromSpki(spki)).toEqual({ qx: first.v.qx, qy: first.v.qy });
  });

  it('refuses a vector assertion presented for another digest', () => {
    const first = VECTORS[0];
    if (!first) throw new Error('no vectors');
    const other = toHex32(BigInt(first.v.digest) ^ 1n);
    expect(() => assertChallengeMatches(first.v.clientDataJSON, other)).toThrow(/not this digest/);
  });
});

describe('webAuthnSigData', () => {
  const first = VECTORS[0];
  if (!first) throw new Error('no vectors');
  const auth = authOf(first.v);

  it.each([
    ['high-s', { s: toHex32(P256_N - BigInt(auth.s)) }, /low-s/],
    ['s = 0', { s: toHex32(0n) }, /low-s/],
    ['r = 0', { r: toHex32(0n) }, /r out of range/],
    ['r = n', { r: toHex32(P256_N) }, /r out of range/],
    ['negative index', { challengeIndex: -1 }, /challengeIndex/],
    ['fractional index', { typeIndex: 1.5 }, /typeIndex/],
  ] as const)('refuses %s (the contract would reject it)', (_name, patch, message) => {
    expect(() => webAuthnSigData({ ...auth, ...patch })).toThrow(message);
  });
});

// ---- P2's unit tests (apps/web/lib/passkey-encode.test.ts), ported ----------------------------------------

const keys = () => generateKeyPairSync('ec', { namedCurve: 'P-256' });
const p1363 = (r: bigint, s: bigint) => Buffer.concat([hexToBytes(toHex32(r)), hexToBytes(toHex32(s))]);
const verifies = (key: KeyObject, msg: Uint8Array, r: bigint, s: bigint) =>
  verify('sha256', msg, { key, dsaEncoding: 'ieee-p1363' }, p1363(r, s));

describe('parseDerSignature', () => {
  it('returns r and s that verify as an IEEE-P1363 signature', () => {
    const { privateKey, publicKey } = keys();
    for (let i = 0; i < 25; i += 1) {
      const msg = Buffer.from(`message ${i}`);
      const der = sign('sha256', msg, { key: privateKey, dsaEncoding: 'der' });
      const { r, s } = parseDerSignature(der);
      expect(verifies(publicKey, msg, r, s)).toBe(true);
    }
  });

  it('round-trips the test DER builder', () => {
    for (const { v } of VECTORS) expect(parseDerSignature(derSignature(BigInt(v.r), BigInt(v.s)))).toEqual({ r: BigInt(v.r), s: BigInt(v.s) });
  });

  it.each([
    ['wrong outer tag', '31060201010201ff'],
    ['length mismatch', '30070201010201ff'],
    ['non-minimal integer', '300702020001020101'],
    ['negative integer', '3006020181020101'],
    ['trailing bytes', '30060201010201010000'],
    ['zero r', '3006020100020101'],
  ])('rejects %s', (_name, hex) => {
    expect(() => parseDerSignature(hexToBytes(hex))).toThrow(PasskeyEncodingError);
  });
});

describe('normalizeLowS', () => {
  it('flips high-s to n − s and the signature still verifies', () => {
    const { privateKey, publicKey } = keys();
    let seenHigh = 0;
    for (let i = 0; i < 64 && seenHigh < 3; i += 1) {
      const msg = Buffer.from(`low-s ${i}`);
      const { r, s } = parseDerSignature(sign('sha256', msg, { key: privateKey, dsaEncoding: 'der' }));
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
    expect(seenHigh, 'about half of raw signatures are high-s').toBeGreaterThan(0);
  });
});

describe('clientDataIndices', () => {
  it('returns byte offsets of the type and challenge keys', () => {
    const json = '{"type":"webauthn.get","challenge":"abc","origin":"http://localhost:3000"}';
    expect(clientDataIndices(json)).toEqual({ typeIndex: 1, challengeIndex: 23 });
  });

  it('counts UTF-8 bytes, not UTF-16 units, before the key', () => {
    const json = '{"x":"é","challenge":"abc","type":"webauthn.get"}';
    const idx = clientDataIndices(json);
    expect(idx.challengeIndex).toBe(json.indexOf('"challenge"') + 1);
    expect(new TextDecoder().decode(new TextEncoder().encode(json).subarray(idx.typeIndex, idx.typeIndex + 6))).toBe('"type"');
  });
});

describe('publicKeyFromSpki', () => {
  it('matches the JWK x and y', () => {
    const { publicKey } = keys();
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const { qx, qy } = publicKeyFromSpki(new Uint8Array(spki));
    expect(qx).toBe(bytesToHex(new Uint8Array(Buffer.from(jwk.x, 'base64url'))));
    expect(qy).toBe(bytesToHex(new Uint8Array(Buffer.from(jwk.y, 'base64url'))));
  });
});

describe('encodeWebAuthnAuth', () => {
  it('encodes a simulated authenticator assertion that verifies over authData ‖ sha256(clientData)', () => {
    const { privateKey, publicKey } = keys();
    const digest = bytesToHex(new Uint8Array(createHash('sha256').update('PlanApproval').digest()));
    const clientDataJSON = JSON.stringify({
      type: 'webauthn.get',
      challenge: bytesToBase64Url(hexToBytes(digest)),
      origin: 'http://localhost:3000',
      crossOrigin: false,
    });
    const authenticatorData = new Uint8Array(
      Buffer.concat([createHash('sha256').update('localhost').digest(), Buffer.from([0x05, 0, 0, 0, 1])]),
    );
    const message = Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()]);
    const signature = sign('sha256', message, { key: privateKey, dsaEncoding: 'der' });
    const auth = encodeWebAuthnAuth(
      { signature, authenticatorData, clientDataJSON: new TextEncoder().encode(clientDataJSON) },
      digest,
    );
    expect(BigInt(auth.s) <= P256_HALF_N).toBe(true);
    expect(verifies(publicKey, message, BigInt(auth.r), BigInt(auth.s))).toBe(true);
    expect(clientDataJSON.slice(auth.typeIndex, auth.typeIndex + 6)).toBe('"type"');
    expect(clientDataJSON.slice(auth.challengeIndex, auth.challengeIndex + 11)).toBe('"challenge"');
    expect(auth.authenticatorData).toBe(bytesToHex(authenticatorData));
  });

  it('refuses an assertion over a different digest', () => {
    const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge: 'AAAA' }));
    expect(() =>
      encodeWebAuthnAuth(
        { signature: new Uint8Array(), authenticatorData: new Uint8Array(), clientDataJSON },
        `0x${'11'.repeat(32)}`,
      ),
    ).toThrow(/not this digest/);
  });
});
