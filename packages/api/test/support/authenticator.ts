/**
 * A software WebAuthn authenticator for tests: a P-256 key generated at runtime, "none" attestation for registration
 * and assertions over any challenge (low-s, UP+UV set). Lets the tests drive the real verification code and the
 * on-chain OZ WebAuthn.verify path without a browser. Nothing here is a committed key.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

const b64u = (b: Uint8Array | Buffer | string): string => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string): Buffer => createHash("sha256").update(b).digest();
const hex32 = (b: Buffer): `0x${string}` => `0x${b.toString("hex").padStart(64, "0")}`;

// ---- tiny CBOR encoder (maps, ints, byte/text strings) for attestation objects ----
type CborValue = number | string | Uint8Array | Map<CborValue, CborValue>;
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}
export function cbor(v: CborValue): Buffer {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v, "utf8")]);
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  const parts = [head(5, v.size)];
  for (const [k, x] of v) parts.push(cbor(k), cbor(x));
  return Buffer.concat(parts);
}

export interface AssertionOptions {
  readonly origin?: string;
  readonly uv?: boolean;
  readonly up?: boolean;
  /** Return the high-s twin of the signature (must be refused). */
  readonly highS?: boolean;
  readonly type?: string;
}

export class SoftAuthenticator {
  readonly credentialId: Buffer = randomBytes(16);
  private readonly privateKey: KeyObject;
  readonly qx: `0x${string}`;
  readonly qy: `0x${string}`;
  private counter = 0;

  constructor(readonly rpId = "localhost") {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.qx = hex32(Buffer.from(jwk.x as string, "base64url"));
    this.qy = hex32(Buffer.from(jwk.y as string, "base64url"));
  }

  get credentialIdB64(): string {
    return b64u(this.credentialId);
  }

  /**
   * The private key in the forms a writer could leak (JWK `d` as base64url and hex, PKCS8 DER as hex and base64), only
   * for secret scans that compare them with written files (red-team, run-7 re-check L5). Never written anywhere.
   */
  secretForms(): string[] {
    const d = this.privateKey.export({ format: "jwk" }).d as string;
    const der = this.privateKey.export({ format: "der", type: "pkcs8" });
    return [d, Buffer.from(d, "base64url").toString("hex"), der.toString("hex"), der.toString("base64")];
  }

  private authData(flags: number, attested?: Buffer, rpId = this.rpId): Buffer {
    this.counter += 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    return Buffer.concat([sha256(rpId), Buffer.from([flags]), counter, ...(attested ? [attested] : [])]);
  }

  /** navigator.credentials.create() JSON (@simplewebauthn/browser shape) for a server challenge. */
  register(challengeB64: string, opts: { origin?: string; rpId?: string; uv?: boolean; type?: string } = {}) {
    const cose = cbor(
      new Map<CborValue, CborValue>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(this.qx.slice(2), "hex")],
        [-3, Buffer.from(this.qy.slice(2), "hex")],
      ]),
    );
    const idLen = Buffer.from([this.credentialId.length >> 8, this.credentialId.length & 0xff]);
    const attested = Buffer.concat([Buffer.alloc(16), idLen, this.credentialId, cose]);
    const flags = 0x01 | (opts.uv === false ? 0 : 0x04) | 0x40;
    const authData = this.authData(flags, attested, opts.rpId);
    const attestationObject = cbor(new Map<CborValue, CborValue>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    const clientDataJSON = JSON.stringify({ type: opts.type ?? "webauthn.create", challenge: challengeB64, origin: opts.origin ?? "http://localhost:3000", crossOrigin: false });
    return {
      id: this.credentialIdB64,
      rawId: this.credentialIdB64,
      type: "public-key" as const,
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ["internal"] },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** navigator.credentials.get() encoded for POST /api/signatures/:id/submit (the client encoder's output). */
  assert(challenge: Uint8Array, opts: AssertionOptions = {}) {
    const flags = (opts.up === false ? 0 : 0x01) | (opts.uv === false ? 0 : 0x04);
    const authenticatorData = this.authData(flags);
    const clientDataJSON = JSON.stringify({ type: opts.type ?? "webauthn.get", challenge: b64u(challenge), origin: opts.origin ?? "http://localhost:3000", crossOrigin: false });
    const message = Buffer.concat([authenticatorData, sha256(clientDataJSON)]);
    const raw = sign("sha256", message, { key: this.privateKey, dsaEncoding: "ieee-p1363" });
    const r = BigInt(`0x${raw.subarray(0, 32).toString("hex")}`);
    let s = BigInt(`0x${raw.subarray(32).toString("hex")}`);
    const low = s > P256_N / 2n ? P256_N - s : s;
    s = opts.highS ? P256_N - low : low;
    const toHex = (x: bigint) => `0x${x.toString(16).padStart(64, "0")}` as `0x${string}`;
    return {
      credentialId: this.credentialIdB64,
      r: toHex(r),
      s: toHex(s),
      challengeIndex: clientDataJSON.indexOf('"challenge"'),
      typeIndex: clientDataJSON.indexOf('"type"'),
      authenticatorData: `0x${authenticatorData.toString("hex")}` as `0x${string}`,
      clientDataJSON,
    };
  }
}
