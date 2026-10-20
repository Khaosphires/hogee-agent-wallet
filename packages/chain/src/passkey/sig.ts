/**
 * The on-chain `Sig` for a passkey (§8.7, §26.9): kind 1, data = `abi.encode(WebAuthn.WebAuthnAuth)`.
 *
 * contracts/src/HogeeSigs.sol decodes the data with OZ `WebAuthn.tryDecodeAuth` and accepts both Solidity's
 * `abi.encode(auth)` (one leading 0x20 offset word, what this file produces) and the flat tuple. The golden hash
 * of vector 1's data is pinned in both test/passkey.test.ts and contracts/test/PasskeyVectors.t.sol.
 */
import { encodeAbiParameters, type Hex } from 'viem';
import { HOGEE_KINDS } from '../kinds';
import type { OnchainSig } from '../tx-builder';
import { P256_HALF_N, P256_N, PasskeyEncodingError, type WebAuthnAuth } from './encode';

/** OZ `WebAuthn.WebAuthnAuth` as an ABI tuple, in the Solidity struct's field order. */
export const WEBAUTHN_AUTH_ABI = {
  type: 'tuple',
  components: [
    { name: 'r', type: 'bytes32' },
    { name: 's', type: 'bytes32' },
    { name: 'challengeIndex', type: 'uint256' },
    { name: 'typeIndex', type: 'uint256' },
    { name: 'authenticatorData', type: 'bytes' },
    { name: 'clientDataJSON', type: 'string' },
  ],
} as const;

/**
 * `Sig.data` for kind 1. Refuses what the contract would reject anyway (r or s out of range, high-s, negative or
 * unsafe indices), so a doomed signature is never relayed.
 */
export function webAuthnSigData(auth: WebAuthnAuth): Hex {
  const r = BigInt(auth.r);
  const s = BigInt(auth.s);
  if (r === 0n || r >= P256_N) throw new PasskeyEncodingError('WebAuthnAuth: r out of range');
  if (s === 0n || s > P256_HALF_N) throw new PasskeyEncodingError('WebAuthnAuth: s must be low-s (0 < s <= n/2)');
  for (const [name, index] of [
    ['challengeIndex', auth.challengeIndex],
    ['typeIndex', auth.typeIndex],
  ] as const) {
    if (!Number.isSafeInteger(index) || index < 0) throw new PasskeyEncodingError(`WebAuthnAuth: bad ${name}`);
  }
  return encodeAbiParameters(
    [WEBAUTHN_AUTH_ABI],
    [
      {
        r: auth.r,
        s: auth.s,
        challengeIndex: BigInt(auth.challengeIndex),
        typeIndex: BigInt(auth.typeIndex),
        authenticatorData: auth.authenticatorData,
        clientDataJSON: auth.clientDataJSON,
      },
    ],
  );
}

/** The `Sig{kind: 1, data}` that PlanRegistry / Treasury / MilestoneEscrow verify against the founder's passkey. */
export function webAuthnSig(auth: WebAuthnAuth): OnchainSig {
  return { kind: HOGEE_KINDS.SIG_WEBAUTHN, data: webAuthnSigData(auth) };
}
