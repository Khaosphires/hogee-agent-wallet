/**
 * Server-side signature checks with exactly the rules of contracts/src/HogeeSigs.sol, run BEFORE anything is relayed
 * (hard rule 5), so a forged or replayed signature never reaches the relayer:
 *   kind 0 (ECDSA): 65 bytes r‖s‖v, v ∈ {27, 28}, 0 < s ≤ n/2 (OZ ECDSA.tryRecover), the recovered address equals
 *                   the registered ownerEOA (never zero);
 *   kind 1 (WebAuthn): OZ WebAuthn.verify(digest, auth, qx, qy) with requireUV — authenticatorData > 36 bytes,
 *                   `"type":"webauthn.get"` at typeIndex, `"challenge":"<base64url(digest)>"` at challengeIndex (byte
 *                   offsets of the UTF-8 JSON), UP and UV set, BS only with BE, 0 < r < n, 0 < s ≤ n/2 (OZ P256),
 *                   and the P-256 signature over sha256(authenticatorData ‖ sha256(clientDataJSON)).
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { encodeAbiParameters, recoverAddress, type Hex } from "viem";
import type { PasskeyAssertion } from "@hogee/core";

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const ZERO32 = `0x${"0".repeat(64)}`;

const hexBytes = (h: string): Buffer | null => (/^0x([0-9a-fA-F]{2})*$/.test(h) ? Buffer.from(h.slice(2), "hex") : null);

export async function verifyEcdsaSignature(digest: Hex, signature: Hex, ownerEOA: Hex | null): Promise<boolean> {
  if (!ownerEOA || /^0x0{40}$/i.test(ownerEOA)) return false;
  const raw = hexBytes(signature);
  if (!raw || raw.length !== 65) return false;
  const r = BigInt(`0x${raw.subarray(0, 32).toString("hex")}`);
  const s = BigInt(`0x${raw.subarray(32, 64).toString("hex")}`);
  const v = raw[64] as number;
  if (v !== 27 && v !== 28) return false;
  if (r === 0n || r >= SECP256K1_N || s === 0n || s > SECP256K1_N / 2n) return false;
  try {
    const signer = await recoverAddress({ hash: digest, signature });
    return signer.toLowerCase() === ownerEOA.toLowerCase();
  } catch {
    return false;
  }
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;

function at(json: Buffer, index: number, expected: string): boolean {
  const want = Buffer.from(expected, "utf8");
  return Number.isSafeInteger(index) && index >= 0 && index + want.length <= json.length && json.subarray(index, index + want.length).equals(want);
}

export function verifyPasskeyAssertion(digest: Hex, a: PasskeyAssertion, key: { qx: Hex; qy: Hex }): boolean {
  if (key.qx === ZERO32 && key.qy === ZERO32) return false;
  const authData = hexBytes(a.authenticatorData);
  const digestBytes = hexBytes(digest);
  if (!authData || authData.length <= 36 || !digestBytes || digestBytes.length !== 32) return false;
  const json = Buffer.from(a.clientDataJSON, "utf8");
  if (!at(json, a.typeIndex, '"type":"webauthn.get"')) return false;
  if (!at(json, a.challengeIndex, `"challenge":"${digestBytes.toString("base64url")}"`)) return false;
  const flags = authData[32] as number;
  if (!(flags & FLAG_UP) || !(flags & FLAG_UV)) return false;
  if (flags & FLAG_BS && !(flags & FLAG_BE)) return false;
  const r = BigInt(a.r);
  const s = BigInt(a.s);
  if (r === 0n || r >= P256_N || s === 0n || s > P256_N / 2n) return false;
  try {
    const publicKey = createPublicKey({
      key: { kty: "EC", crv: "P-256", x: Buffer.from(key.qx.slice(2), "hex").toString("base64url"), y: Buffer.from(key.qy.slice(2), "hex").toString("base64url") },
      format: "jwk",
    });
    const message = Buffer.concat([authData, createHash("sha256").update(json).digest()]);
    const sig = Buffer.concat([Buffer.from(a.r.slice(2), "hex"), Buffer.from(a.s.slice(2), "hex")]);
    return verify("sha256", message, { key: publicKey, dsaEncoding: "ieee-p1363" }, sig);
  } catch {
    return false;
  }
}

/** Sig.data for kind 1: abi.encode(WebAuthn.WebAuthnAuth) (HogeeSigs accepts the leading 0x20 offset word). */
export function webAuthnSigData(a: PasskeyAssertion): Hex {
  return encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
          { name: "challengeIndex", type: "uint256" },
          { name: "typeIndex", type: "uint256" },
          { name: "authenticatorData", type: "bytes" },
          { name: "clientDataJSON", type: "string" },
        ],
      },
    ],
    [{ r: a.r as Hex, s: a.s as Hex, challengeIndex: BigInt(a.challengeIndex), typeIndex: BigInt(a.typeIndex), authenticatorData: a.authenticatorData as Hex, clientDataJSON: a.clientDataJSON }],
  );
}
