/**
 * Forced-revert sender for red-team evidence (§12.3, §13.1 principle 6): the call is sent with an explicit
 * gas limit, skipping `eth_estimateGas` (which would refuse a reverting call), so the revert is MINED and
 * has a clickable tx hash. Etherscan decodes the custom error from the verified source; we decode it too.
 *
 * It uses the normal crash-safe path: a `chain_actions` row (e.g. kind `Treasury.spend`, refId = the red-team
 * case such as `T1`), a Postgres nonce, raw tx stored before broadcast. The row is INCLUDED when the receipt
 * arrives; `advanceFinality` moves it to REVERTED (with the decoded error) only once that receipt is at
 * `finalized` (§12.3: evidence rows use finalized), since a non-final revert can still be reorged away.
 *
 * viem's `waitForTransactionReceipt` returns the receipt of a REPLACEMENT when another tx is mined at the
 * stored nonce. That receipt is never recorded as the row's: `sendForcedRevert` throws TxReplacedError and
 * leaves the row open, and recovery settles it (a same-call twin is recorded INCLUDED, anything else is
 * `unresolved`).
 */
import type { Db } from '@hogee/db';
import type { Hex } from 'viem';
import type { HogeePublicClient } from './clients';
import { assertGasLimit, type TxSigner } from './fees';
import { lookupRevert, type DecodedRevert } from './revert';
import { sendStored, signAndStore } from './sender';
import type { SignDeployment } from './sign-binding';
import { pgSignedRowStore, type SignedRowStore, type SignTarget } from './targets';
import type { TxRequest } from './tx-builder';

/** §12.3: "e.g. 500k". Enough for any Hogee entry point to reach its revert. */
export const DEFAULT_FORCED_REVERT_GAS = 500_000n;

export type ForcedRevertClient = Pick<
  HogeePublicClient,
  | 'estimateFeesPerGas'
  | 'estimateGas'
  | 'getTransactionCount'
  | 'sendRawTransaction'
  | 'waitForTransactionReceipt'
  | 'getTransaction'
  | 'getTransactionReceipt'
  | 'call'
  | 'readContract'
  | 'request'
>;

export interface ForcedRevertParams {
  /** The `chain_actions` row this send belongs to (state PENDING, not yet signed). */
  readonly action: { readonly facilityId: string; readonly id: string };
  /** Destination + calldata (any `gas` here is replaced by `gas` below). */
  readonly request: TxRequest;
  /** Explicit gas limit; default 500,000; must be ≤ 16,777,216. */
  readonly gas?: bigint;
  readonly account: TxSigner;
  readonly client: ForcedRevertClient;
  readonly chainId: number;
  readonly capWei: bigint;
  /** The facility's deployment; `request.to` must be its contract for the action kind (sign-binding.ts). */
  readonly deployment: SignDeployment;
  /** waitForTransactionReceipt timeout (default 180 s: Sepolia can take several slots). */
  readonly receiptTimeoutMs?: number;
}

export interface ForcedRevertResult {
  readonly txHash: Hex;
  readonly nonce: bigint;
  readonly blockNumber: bigint;
  readonly gasUsed: bigint;
  /** `success` means the attack was NOT blocked on-chain: a red-team failure the caller must report. */
  readonly status: 'reverted' | 'success';
  /** Decoded custom error, e.g. { name: 'PayeeNotBound', args: [] }; null if undecodable or not reverted. */
  readonly error: DecodedRevert | null;
  readonly decodedVia: 'trace' | 'call-replay' | null;
}

export class TxReplacedError extends Error {
  override readonly name = 'TxReplacedError';
  constructor(
    readonly storedTxHash: Hex,
    readonly minedTxHash: Hex,
  ) {
    super('another tx was mined at the stored nonce; the row is left open for recovery');
  }
}

/**
 * Marks the forced-revert row INCLUDED from `receipt`, only when it is the receipt of the stored bytes
 * (else TxReplacedError and nothing is written). false when the row already moved on (e.g. recovery).
 */
export async function recordForcedRevertReceipt(
  store: Pick<SignedRowStore, 'transition'>,
  target: SignTarget,
  storedTxHash: Hex,
  receipt: { readonly transactionHash: Hex; readonly blockNumber: bigint },
): Promise<boolean> {
  if (receipt.transactionHash.toLowerCase() !== storedTxHash.toLowerCase()) throw new TxReplacedError(storedTxHash, receipt.transactionHash);
  return store.transition(target, { from: ['PENDING', 'BROADCAST'], to: 'INCLUDED', txHash: storedTxHash, block: receipt.blockNumber });
}

/** The request with an explicit, capped gas limit, so the sender never calls `eth_estimateGas`. */
export function forcedRevertRequest(request: TxRequest, gas: bigint = DEFAULT_FORCED_REVERT_GAS): TxRequest {
  return Object.freeze({ ...request, gas: assertGasLimit(gas) });
}

/**
 * Signs + stores, broadcasts, waits for the receipt, marks the row INCLUDED and decodes the revert. Throws
 * TxReplacedError when the receipt is another tx's (the row stays open for recovery).
 */
export async function sendForcedRevert(db: Db, p: ForcedRevertParams): Promise<ForcedRevertResult> {
  const target: SignTarget = { table: 'chain_actions', facilityId: p.action.facilityId, id: p.action.id };
  const stored = await signAndStore(db, {
    target,
    request: forcedRevertRequest(p.request, p.gas),
    account: p.account,
    client: p.client,
    chainId: p.chainId,
    capWei: p.capWei,
    deployment: p.deployment,
  });
  await sendStored(db, p.client, stored);
  const receipt = await p.client.waitForTransactionReceipt({ hash: stored.txHash, timeout: p.receiptTimeoutMs ?? 180_000 });
  await recordForcedRevertReceipt(pgSignedRowStore(db), target, stored.txHash, receipt);
  const base = { txHash: stored.txHash, nonce: stored.nonce, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed };
  if (receipt.status === 'success') return { ...base, status: 'success', error: null, decodedVia: null };
  const lookup = await lookupRevert(p.client, stored.txHash);
  return { ...base, status: 'reverted', error: lookup.decoded, decodedVia: lookup.via };
}
