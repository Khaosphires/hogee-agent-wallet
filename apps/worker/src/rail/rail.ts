/**
 * PayoutRail (§9.1): the off-chain leg of a settlement. XenditRail (test mode) and MockRail (the loop and the evals),
 * chosen by PAYOUT_RAIL. A rail is idempotent on `idempotencyKey` with Xendit's rule: the same key with the same body
 * returns the original payout; the same key with another body is refused (PayoutConflictError). So a crash between
 * the payout call and the DB write never pays twice, and a tampered row can never reuse a key for a different payout.
 *
 * Destinations are the exact account fields the founder signed the hash of (T1): `payees.xendit_account_ref` holds
 * JCS({channel, accountNumber, holderName}) and the worker recomputes payoutAccountHash from these very fields before
 * paying them (jobs/settle-verify.ts).
 */
import { jcs } from '@hogee/core';
import { encodePacked, keccak256, type Hex } from 'viem';
import { z } from 'zod';
import { accountNumberPattern } from './channels';

export type PayoutStatus = 'SUCCEEDED' | 'PENDING' | 'FAILED';

export interface PayoutDestination {
  readonly channel: string;
  readonly accountNumber: string;
  readonly holderName: string;
}

export interface PayoutRequest {
  /** payoutIdempotencyKey(…): ≤ 100 chars. */
  readonly idempotencyKey: string;
  /** `${txHash}:${attempt}` (§9.1). */
  readonly referenceId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  /** The payee's registered TEST account (never free text). */
  readonly destination: PayoutDestination;
}

export interface PayoutResult {
  readonly payoutId: string;
  readonly status: PayoutStatus;
  /** Rail failure code, e.g. INVALID_DESTINATION, TEMPORARY_TRANSFER_ERROR (raw; may not fit bytes32). */
  readonly failureCode?: string;
}

export interface PayoutRail {
  readonly name: string;
  requestPayout(req: PayoutRequest): Promise<PayoutResult>;
  getPayout(payoutId: string): Promise<PayoutResult>;
  /** The payout created for this attempt's key, or null when the rail has never seen it. */
  findPayout(key: { readonly idempotencyKey: string; readonly referenceId: string }): Promise<PayoutResult | null>;
}

/** Same idempotency key, different body: the rail refuses (Xendit: DUPLICATE_ERROR); the worker halts. */
export class PayoutConflictError extends Error {
  override readonly name = 'PayoutConflictError';
}

/** Failure codes worth a retry with the next attempt (§9.1); every other failure is final (failSettlement). */
export const RETRYABLE_FAILURES: ReadonlySet<string> = new Set(['TEMPORARY_TRANSFER_ERROR']);

/**
 * §9.1 idempotency-key, bound to the chain: keccak256(spendId ‖ invoiceHash ‖ attempt). spendId (= settlementId) and
 * invoiceHash come from the finalized on-chain spend, and `attempt` is the rail-backed attempt index (settle.ts), never
 * a DB column, so neither a plan_version nor a payout_attempt written into the DB can mint a second key.
 */
export function payoutIdempotencyKey(a: { settlementId: Hex; invoiceHash: Hex; attempt: number }): string {
  return keccak256(encodePacked(['bytes32', 'bytes32', 'uint32'], [a.settlementId, a.invoiceHash, a.attempt]));
}

/** The account number's form follows its channel (channels.ts): digits for a bank account, a proxy for PayNow. */
const Account = z
  .strictObject({
    channel: z.string().min(1).max(64),
    accountNumber: z.string().min(1).max(34),
    holderName: z.string().min(1).max(200),
  })
  .refine((a) => accountNumberPattern(a.channel).test(a.accountNumber));

/** The canonical `payees.xendit_account_ref` for an account: JCS({channel, accountNumber, holderName}). */
export function payoutAccountRef(d: PayoutDestination): string {
  return jcs({ channel: d.channel, accountNumber: d.accountNumber, holderName: d.holderName });
}

/** The account a ref names, or null unless it is exactly the canonical JCS of a valid account. */
export function parsePayoutAccountRef(ref: string | null): PayoutDestination | null {
  if (typeof ref !== 'string') return null;
  try {
    const parsed = Account.safeParse(JSON.parse(ref));
    if (!parsed.success || payoutAccountRef(parsed.data) !== ref) return null;
    return parsed.data;
  } catch {
    return null;
  }
}
