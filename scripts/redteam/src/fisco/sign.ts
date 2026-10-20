/**
 * Local signing for the mirror. Nothing here sends: the runner (runner.ts) sends the exact bytes signed here.
 *   - signLegacy: a legacy (type 0) EIP-155 tx for chain 20200 at gas price 0 with an explicit gas limit (FISCO BCOS
 *     3.x takes legacy txs only and charges nothing).
 *   - ecdsaSig: a kind-0 Hogee Sig over a raw EIP-712 digest (lender StageRelease; the agent's forged owner structs).
 *   - softFounder: the mirror's founder, a software passkey generated at runtime (SoftAuthenticator, the same one the
 *     API's live tests use); its signatures are the kind-1 Sig the relayer submits.
 * Keys never leave this process: keySecretForms / secretForms() only feed the pack's secret scan.
 */
import { webAuthnSig, type OnchainSig } from "@hogee/chain";
import { hexToBytes, keccak256, type Hex, type LocalAccount } from "viem";
import { FISCO_CHAIN_ID } from "../../../../tools/verify-evidence/src/fisco/pack";
import { SoftAuthenticator } from "../api-internals";

export interface LegacyCall {
  readonly to: Hex;
  readonly data: Hex;
  readonly nonce: number;
  readonly gas: bigint;
}

export interface SignedTx {
  readonly raw: Hex;
  readonly hash: Hex;
}

export async function signLegacy(account: LocalAccount, c: LegacyCall): Promise<SignedTx> {
  if (c.gas <= 0n) throw new Error("signLegacy: an explicit gas limit is required");
  if (!Number.isSafeInteger(c.nonce) || c.nonce < 0) throw new Error("signLegacy: bad nonce");
  const raw = await account.signTransaction({ type: "legacy", chainId: FISCO_CHAIN_ID, gasPrice: 0n, gas: c.gas, nonce: c.nonce, to: c.to, data: c.data, value: 0n });
  return { raw, hash: keccak256(raw) };
}

/** Sig{kind 0, 65-byte r‖s‖v} over the raw digest (no EIP-191 prefix), as HogeeSigs / ECDSA.tryRecover expect. */
export async function ecdsaSig(account: LocalAccount, digest: Hex): Promise<OnchainSig> {
  if (!account.sign) throw new Error("ecdsaSig: this account cannot sign a raw digest");
  return { kind: 0, data: await account.sign({ hash: digest }) };
}

/** The §26.6 passkey submission shape (core PasskeyAssertion). */
export interface Assertion {
  readonly credentialId: string;
  readonly r: Hex;
  readonly s: Hex;
  readonly challengeIndex: number;
  readonly typeIndex: number;
  readonly authenticatorData: Hex;
  readonly clientDataJSON: string;
}

export interface Founder {
  readonly qx: Hex;
  readonly qy: Hex;
  /** A WebAuthn assertion over the raw 32-byte digest (low-s, UP+UV) and its on-chain Sig. */
  sign(digest: Hex): { readonly sig: OnchainSig; readonly assertion: Assertion };
  secretForms(): string[];
}

export function softFounder(): Founder {
  const auth = new SoftAuthenticator("localhost");
  return {
    qx: auth.qx,
    qy: auth.qy,
    sign(digest) {
      const a = auth.assert(hexToBytes(digest));
      const assertion: Assertion = { credentialId: a.credentialId, r: a.r, s: a.s, challengeIndex: a.challengeIndex, typeIndex: a.typeIndex, authenticatorData: a.authenticatorData, clientDataJSON: a.clientDataJSON };
      const { credentialId: _id, ...auth712 } = assertion;
      return { sig: webAuthnSig(auth712), assertion };
    },
    secretForms: () => auth.secretForms(),
  };
}

/**
 * Each private key as it could leak into a file: with and without 0x, lower- and upper-case hex (viem emits
 * lower-case whatever case the key came in), base64 of its bytes, padded and unpadded, and base64url (unpadded, so a
 * padded copy is caught too: the scan matches substrings). The pack writer compares the hex forms
 * case-insensitively, so mixed case is caught too.
 */
export function keySecretForms(keys: readonly Hex[]): string[] {
  const out = keys.flatMap((k) => {
    const bare = k.replace(/^0x/i, "");
    const lower = bare.toLowerCase();
    const bytes = Buffer.from(lower, "hex");
    const b64 = bytes.toString("base64");
    return [k, bare, `0x${lower}`, lower, bare.toUpperCase(), b64, b64.replace(/=+$/, ""), bytes.toString("base64url")];
  });
  return [...new Set(out)].filter((f) => f.length >= 16);
}
