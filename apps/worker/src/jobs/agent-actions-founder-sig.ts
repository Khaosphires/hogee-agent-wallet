/**
 * Founder-signed payments (OwnerSpend, MilestoneRelease) as the relayer submits them. The relayer gains no authority:
 * the founder's signature is what the contract verifies. The worker does not re-verify it cryptographically (the API
 * verified it at submit, the contract verifies again), but it does check that the signed struct is EXACTLY the payment
 * row it is about to send, so a row edited after the founder signed is never relayed.
 *
 * signature_requests.signature_json is the API-validated submit body (core SignatureSubmitBody):
 *   {ecdsa: {signature}}  → Sig{kind 0, data: the 65-byte signature}
 *   {passkey: assertion}  → Sig{kind 1, data: abi.encode(WebAuthn.WebAuthnAuth)} (as packages/api signing/verify.ts
 *                           webAuthnSigData; HogeeSigs accepts the leading 0x20 offset word).
 */
import { HOGEE_KINDS, shortIdToBytes32, toBytes32Tag, type OnchainSig } from '@hogee/chain';
import { SignatureSubmitBody, type PasskeyAssertion } from '@hogee/core';
import { encodeAbiParameters, type Hex } from 'viem';

/** Not relayable: the row is marked POLICY_DENIED with an ALERT trace and never signed. */
export class FounderRelayRefusal extends Error {
  override readonly name = 'FounderRelayRefusal';
  constructor(readonly reason: string) {
    super(reason);
  }
}

export const WEBAUTHN_AUTH_PARAMS = [
  {
    type: 'tuple',
    components: [
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
      { name: 'challengeIndex', type: 'uint256' },
      { name: 'typeIndex', type: 'uint256' },
      { name: 'authenticatorData', type: 'bytes' },
      { name: 'clientDataJSON', type: 'string' },
    ],
  },
] as const;

/** Sig.data for kind 1: abi.encode(WebAuthn.WebAuthnAuth). */
export function passkeySigData(a: PasskeyAssertion): Hex {
  return encodeAbiParameters(WEBAUTHN_AUTH_PARAMS, [
    {
      r: a.r as Hex,
      s: a.s as Hex,
      challengeIndex: BigInt(a.challengeIndex),
      typeIndex: BigInt(a.typeIndex),
      authenticatorData: a.authenticatorData as Hex,
      clientDataJSON: a.clientDataJSON,
    },
  ]).toLowerCase() as Hex;
}

/** The on-chain Sig of a stored submit body; anything but one valid body is refused, never repaired. */
export function founderSigOf(signatureJson: unknown): OnchainSig {
  const body = SignatureSubmitBody.safeParse(signatureJson);
  if (!body.success) throw new FounderRelayRefusal('the stored founder signature is not a valid submit body');
  if ('ecdsa' in body.data) return { kind: HOGEE_KINDS.SIG_ECDSA, data: body.data.ecdsa.signature.toLowerCase() as Hex };
  return { kind: HOGEE_KINDS.SIG_WEBAUTHN, data: passkeySigData(body.data.passkey) };
}

type Expectation = readonly [field: string, signed: unknown, row: unknown];

const firstMismatch = (checks: readonly Expectation[]): string | null => {
  for (const [field, signed, row] of checks) if (String(signed).toLowerCase() !== String(row).toLowerCase()) return field;
  return null;
};

/** The payment row (and deployment) an OwnerSpend must match field by field. */
export interface OwnerSpendExpect {
  readonly lineId: Hex;
  readonly payeeId: string;
  readonly amountMinor: string;
  readonly invoiceHash: Hex;
  readonly deploymentId: string;
}

/** Null when the signed OwnerSpend (viem message) is the row; else the first field that differs (never a value). */
export function ownerSpendMismatch(msg: Readonly<Record<string, unknown>>, e: OwnerSpendExpect): string | null {
  return firstMismatch([
    ['lineId', msg.lineId, e.lineId],
    ['payeeId', msg.payeeId, shortIdToBytes32(e.payeeId, 'payeeId')],
    ['amountMinor', msg.amountMinor, BigInt(e.amountMinor)],
    ['invoiceHash', msg.invoiceHash, e.invoiceHash],
    ['deploymentId', msg.deploymentId, toBytes32Tag(e.deploymentId)],
  ]);
}

/** The payment row, the stored inspection evidence and the deployment a MilestoneRelease must match. */
export interface ReleaseExpect {
  readonly orderId: string;
  readonly idx: number;
  readonly amountMinor: string;
  /** escrow_milestones.evidence_hash (POST /api/escrow/:orderId/inspection); zero when none was uploaded. */
  readonly evidenceHash: Hex;
  readonly deploymentId: string;
}

export function milestoneReleaseMismatch(msg: Readonly<Record<string, unknown>>, e: ReleaseExpect): string | null {
  return firstMismatch([
    ['orderId', msg.orderId, shortIdToBytes32(e.orderId, 'orderId')],
    ['idx', msg.idx, e.idx],
    ['amountMinor', msg.amountMinor, BigInt(e.amountMinor)],
    ['evidenceHash', msg.evidenceHash, e.evidenceHash],
    ['deploymentId', msg.deploymentId, toBytes32Tag(e.deploymentId)],
  ]);
}
