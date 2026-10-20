/**
 * Shared on-chain reads for binding a settlement row to the chain (settle-verify*.ts, settle-binding.ts). Everything is
 * read at the `finalized` block: the row's own tx must have a canonical, successful receipt at or below it, and the
 * payout destination must be the account whose hash the chain binds to the payee (T1).
 *
 * Destination rule (every kind): the account fields the rail will pay (`payees.xendit_account_ref`, the canonical JCS
 * of {channel, accountNumber, holderName}) hash to the on-chain hash (the line binding's payoutAccountHash, which the
 * founder signed in the SupplierApproval or ADD_PAYEE, or the static platform registry's hash fixed at deployment), the
 * DB mirror `payees.payout_account_hash` agrees, and a line binding is past its cooling window (a re-bind replaces the
 * account and restarts cooling: a settlement never pays a freshly swapped account inside its veto window).
 */
import { decisionIdToBytes32, iTreasuryAbi, type HogeePublicClient } from '@hogee/chain';
import { payoutAccountHash } from '@hogee/core';
import { encodeAbiParameters, hexToString, keccak256, parseAbi, stringToHex, type Hex, type Log } from 'viem';
import { parsePayoutAccountRef, type PayoutDestination } from '../rail/rail';
import type { BindingVerdict } from './settle-decide';

/** The payment kinds settle-spend pays out (each has an on-chain settlement record, §9.1, M8). */
export type SettlementKind = 'SPEND' | 'OWNER_SPEND' | 'RELEASE_MILESTONE' | 'FUND_MILESTONE' | 'WITHDRAW_RESERVE';

/** The payment fields the binding reads (payments joined with the payee's account columns). */
export interface SettlementRow {
  readonly kind: SettlementKind;
  readonly intent_id: Hex;
  /** NULL exactly for WITHDRAW_RESERVE. */
  readonly line_id: Hex | null;
  readonly payee_id: string;
  readonly order_id: string | null;
  readonly milestone_idx: number | null;
  readonly amount_minor: string;
  readonly invoice_hash: Hex;
  readonly plan_version: number;
  /** NULL exactly for OWNER_SPEND / WITHDRAW_RESERVE. */
  readonly decision_id: string | null;
  readonly rationale_hash: Hex | null;
  readonly tx_hash: Hex;
  readonly xendit_account_ref: string | null;
  /** payees.payout_account_hash: the DB mirror of the bound hash (must agree with the chain). */
  readonly payout_account_hash: Hex;
}

/** What the chain says to pay: the idempotency key and amount come from here, never from DB columns. */
export interface VerifiedSettlement {
  /** The on-chain settlementId (confirmSettlement / failSettlement / the idempotency key). */
  readonly settlementId: Hex;
  /**
   * The key's second component (payoutIdempotencyKey's invoiceHash): the on-chain invoiceHash of a spend, else the
   * deployment scope (deploymentKeyScope) where the chain has no invoice. Never a DB column.
   */
  readonly invoiceHash: Hex;
  readonly amountMinor: bigint;
  readonly destination: PayoutDestination;
}

/** The chain-derived idempotency-key components of a settlement (VerifiedSettlement without what is paid). */
export type SettlementKeys = Pick<VerifiedSettlement, 'settlementId' | 'invoiceHash'>;

/**
 * OK, a mismatch (the caller halts), or NONE: the row is not a settlement (a funding that released nothing). A mismatch
 * of the destination alone (a cooling or re-bound payee) carries `keys`: the settlement itself was verified, so its
 * rail history can still be read (settle.ts: closing a row the worker already paid and confirmed, audit run-4).
 */
export type BindingResult =
  | { readonly verdict: 'OK'; readonly spend: VerifiedSettlement }
  | { readonly verdict: Exclude<BindingVerdict, 'OK'>; readonly detail: string; readonly keys?: SettlementKeys }
  | { readonly verdict: 'NONE'; readonly detail: string };

export type VerifyClient = Pick<HogeePublicClient, 'getBlock' | 'getTransactionReceipt' | 'readContract'>;

export const ZERO32 = `0x${'0'.repeat(64)}` as const;

export const same = (a: string | null | undefined, b: string | null | undefined): boolean => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
export const no = (verdict: Exclude<BindingVerdict, 'OK'>, detail: string, keys?: SettlementKeys): BindingResult => ({ verdict, detail, ...(keys ? { keys } : {}) });
export const ok = (spend: VerifiedSettlement): BindingResult => ({ verdict: 'OK', spend });

const SHORT_ID_RE = /^[a-z0-9_-]{1,32}$/;

/**
 * The idempotency-key component of a milestone or reserve settlement: keccak256(abi.encode(chainId, treasury)). Those
 * settlements have no on-chain invoice, and a milestone settlementId (keccak256(orderId, idx)) repeats across
 * deployments, since order ids are per-tenant ShortIds: without a deployment scope two deployments would share one rail
 * key, and the rail would hand the second the first one's payout (or refuse it). Spends keep their on-chain invoice.
 */
export function deploymentKeyScope(chainId: number, treasury: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }], [BigInt(chainId), treasury]));
}

/** stringToHex(id, 32) for a ShortId, else null (never throws on DB input). */
export function bytes32OfShortId(id: string | null): Hex | null {
  if (typeof id !== 'string' || !SHORT_ID_RE.test(id)) return null;
  return stringToHex(id, { size: 32 });
}

/** The ShortId a bytes32 tag encodes, or null unless it round-trips exactly. */
export function shortIdOfBytes32(value: Hex): string | null {
  try {
    const id = hexToString(value, { size: 32 }).replace(/\0+$/, '');
    return bytes32OfShortId(id) !== null && same(bytes32OfShortId(id), value) ? id : null;
  } catch {
    return null;
  }
}

/** The on-chain bytes32 decisionId is the row's UUID (never throws on DB input). */
export function decisionMatches(onchain: Hex, decisionId: string | null): boolean {
  if (decisionId === null) return false;
  try {
    return same(onchain, decisionIdToBytes32(decisionId));
  } catch {
    return false;
  }
}

export interface FinalizedHead {
  readonly number: bigint;
  readonly timestamp: bigint;
}

export async function finalizedHead(client: Pick<VerifyClient, 'getBlock'>): Promise<FinalizedHead> {
  const b = await client.getBlock({ blockTag: 'finalized' });
  return { number: b.number, timestamp: b.timestamp };
}

/**
 * The logs `address` emitted in `txHash`, if its receipt is successful, canonical and at or below `finalized`; else
 * null. RPC errors other than "no receipt" propagate.
 */
export async function finalizedLogsOf(client: VerifyClient, txHash: Hex, finalized: bigint, address: Hex): Promise<Log[] | null> {
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'TransactionReceiptNotFoundError') return null;
    throw error;
  }
  if (receipt.status !== 'success' || receipt.blockNumber > finalized) return null;
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (!same(block.hash, receipt.blockHash)) return null; // not canonical
  return receipt.logs.filter((l) => same(l.address, address));
}

/** Treasury.platformPayoutAccountHash (not part of the frozen ITreasury ABI). */
const platformAbi = parseAbi(['function platformPayoutAccountHash(bytes32 payeeId) view returns (bytes32)']);

/** Where the chain binds the payee's destination: a line binding, or the static platform registry (tax payee). */
export type DestinationSource = { readonly kind: 'line'; readonly lineId: Hex; readonly payee: Hex } | { readonly kind: 'platform'; readonly payee: Hex };

export type DestinationCheck =
  | { readonly ok: true; readonly destination: PayoutDestination }
  | { readonly ok: false; readonly detail: string; readonly cooling?: true };

/** The verdict of a failed destination check: a cooling binding holds the payout; anything else is a mismatch. */
export const destinationVerdict = (d: Extract<DestinationCheck, { ok: false }>) => (d.cooling ? ('PAYEE_COOLING' as const) : ('DESTINATION_MISMATCH' as const));

/** The destination rule in the module doc, read at the finalized head. */
export async function verifyDestination(
  client: Pick<VerifyClient, 'readContract'>,
  treasury: Hex,
  head: FinalizedHead,
  src: DestinationSource,
  row: Pick<SettlementRow, 'xendit_account_ref' | 'payout_account_hash'>,
): Promise<DestinationCheck> {
  const destination = parsePayoutAccountRef(row.xendit_account_ref);
  if (!destination) return { ok: false, detail: 'the payee has no canonical payout account' };
  let onchain: Hex;
  if (src.kind === 'line') {
    const b = await client.readContract({ address: treasury, abi: iTreasuryAbi, functionName: 'payeeBinding', args: [src.lineId, src.payee], blockNumber: head.number });
    if (!b.bound) return { ok: false, detail: 'the payee is not bound to the line on-chain' };
    // Pay the binding as it stands at payout time: hold while it cools (a re-bind restarts cooling, audit run-3).
    if (b.coolingUntil > head.timestamp) return { ok: false, cooling: true, detail: 'the payee binding is cooling; the payout is held' };
    onchain = b.payoutAccountHash;
  } else {
    onchain = await client.readContract({ address: treasury, abi: platformAbi, functionName: 'platformPayoutAccountHash', args: [src.payee], blockNumber: head.number });
    if (same(onchain, ZERO32)) return { ok: false, detail: 'the payee is not a static platform payee' };
  }
  if (!same(onchain, payoutAccountHash(destination))) return { ok: false, detail: 'the payout account does not hash to the on-chain binding' };
  if (!same(onchain, row.payout_account_hash)) return { ok: false, detail: "the payee row's payout_account_hash disagrees with the chain" };
  return { ok: true, destination };
}
