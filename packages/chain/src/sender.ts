/**
 * Crash-safe signing (§12.3, T19). Only the worker signs (D19).
 *
 * 1. `signAndStore`: in ONE db transaction lock the row, allocate the nonce from Postgres, sign, and store
 *    raw bytes + nonce + signer + chainId + txHash, moving the row to its signed state. COMMIT.
 * 2. Only then `broadcast` the stored bytes, and `markBroadcast`.
 * 3. A crash anywhere leaves either nothing (rolled back, nonce returned) or a stored signed tx that
 *    `recoverOpenIntents` re-sends as the SAME bytes. `rebroadcastStored` never signs; `feeBump` re-signs the
 *    SAME nonce only (one tx per nonce can ever be mined), in place on the same row, and keeps the replaced
 *    hash in `superseded_tx_hashes` (G0-AUDIT v-4). It re-signs only bytes the bumping key itself signed for
 *    the row, on the expected chain, bound to the row's deployment (`storedTxRefusal`), so a DB writer who
 *    swaps the stored bytes cannot get another call signed by a worker key.
 *
 * Before anything is signed the request is bound to the row's deployment (sign-binding.ts): the facility
 * names the deployment, `to` is its contract for the row's kind, `value` is 0, and the calldata is the call
 * the row describes. A chain action that moves value is signed only if its simulated call reverts with a
 * Hogee error (spend-guard.ts): value moves through `payments` rows only.
 */
import type { Db } from '@hogee/db';
import { getAddress, keccak256, parseTransaction, recoverTransactionAddress, type Address, type Hex, type TransactionSerializableEIP1559 } from 'viem';
import { broadcast, type BroadcastResult } from './broadcast';
import { redactError } from './errors';
import { assertGasLimit, bumpFees, capFees, type Eip1559Fees, type TxSigner } from './fees';
import { allocateNonce, type NonceCountReader } from './nonces';
import { assertFacilityDeployment, signBindingMismatch, type SignDeployment } from './sign-binding';
import { guardValueMovingAction, type SpendGuardClient } from './spend-guard';
import {
  OPEN_STATES,
  readFacilityDeployment,
  readTarget,
  replaceSigned,
  SIGNABLE_STATE,
  SIGNED_STATE,
  SignTargetError,
  transition,
  writeSigned,
  type SignedRow,
  type SignTarget,
} from './targets';
import type { TxRequest } from './tx-builder';

/** The chain calls the sender makes; a viem PublicClient satisfies it. */
export interface SenderClient extends NonceCountReader, SpendGuardClient {
  estimateFeesPerGas(): Promise<Eip1559Fees>;
  estimateGas(args: { account: Address; to: Address; data: Hex; value?: bigint }): Promise<bigint>;
  sendRawTransaction(args: { serializedTransaction: Hex }): Promise<Hex>;
}

export interface SignAndStoreParams {
  readonly target: SignTarget;
  readonly request: TxRequest;
  readonly account: TxSigner;
  readonly client: SenderClient;
  readonly chainId: number;
  /** MAX_FEE_GWEI in wei (see `gweiToWei`). */
  readonly capWei: bigint;
  /**
   * The deployment of the row's facility (its manifest). The facility row must name it (`deployment_id`,
   * `chain_id` = `chainId`), and `request.to` must be its contract for the row's kind.
   */
  readonly deployment: SignDeployment;
  /**
   * On-chain bytes32 planId of the facility's committed plan (PlanApproval.planId). Required to sign
   * SPEND / OWNER_SPEND payments: their `intent_id` is recomputed from it and the calldata, and a mismatch
   * (or a missing planId) is refused.
   *
   * It MUST come from the committed plan: the PlanApproval the founder signed and `commitPlan` recorded
   * (the plan row for the facility's current on-chain version). Never take it from the proposal, the
   * payment row or the request being signed, or the intent_id check proves nothing.
   */
  readonly planId?: Hex;
  /** Headroom over `eth_estimateGas` (default 20 %). Ignored when `request.gas` is set. */
  readonly gasBufferPercent?: bigint;
}

export interface StoredTx {
  readonly target: SignTarget;
  readonly rawTx: Hex;
  readonly txHash: Hex;
  readonly nonce: bigint;
  readonly signer: Address;
  readonly chainId: number;
  /** true when the row was already signed and nothing new was signed (idempotent retry). */
  readonly reused: boolean;
}

const DEFAULT_GAS_BUFFER_PERCENT = 20n;

function storedFrom(row: SignedRow): StoredTx {
  if (!row.rawSignedTx || row.nonce === null || !row.signerAddress || row.chainId === null) {
    throw new SignTargetError(`${row.target.table}/${row.target.id} has no stored signed tx`);
  }
  return {
    target: row.target,
    rawTx: row.rawSignedTx,
    txHash: keccak256(row.rawSignedTx),
    nonce: row.nonce,
    signer: getAddress(row.signerAddress),
    chainId: row.chainId,
    reused: true,
  };
}

function assertSignable(row: SignedRow, p: SignAndStoreParams): void {
  const want = SIGNABLE_STATE[row.target.table];
  if (row.state !== want) throw new SignTargetError(`${row.target.table}/${row.target.id} is ${row.state}, expected ${want}`);
  const mismatch = signBindingMismatch(row, p.request, { contracts: p.deployment.contracts, planId: p.planId ?? null });
  if (mismatch) throw new SignTargetError(`${row.target.table}/${row.target.id}: ${mismatch}`);
}

/**
 * Signs `request` for `target` and stores it (state → SIGNED for payments; PENDING + raw tx for chain
 * actions) in one db transaction. Does NOT broadcast. If the row is already signed, returns the stored tx
 * and signs nothing. A request not bound to the row's deployment (sign-binding.ts), a value-moving chain
 * action whose call would not revert (SpendActionRefusedError), and fee or gas estimation failures
 * (including FeeCapExceededError and a reverting estimate) throw before any nonce is allocated. Errors that
 * carry a URL (RPC failures) are rethrown as RedactedError with the original as `cause` (errors.ts).
 */
export async function signAndStore(db: Db, p: SignAndStoreParams): Promise<StoredTx> {
  try {
    return await signAndStoreUnredacted(db, p);
  } catch (error: unknown) {
    throw redactError(error);
  }
}

async function signAndStoreUnredacted(db: Db, p: SignAndStoreParams): Promise<StoredTx> {
  if (!Number.isSafeInteger(p.chainId) || p.chainId <= 0) throw new SignTargetError('chainId must be a positive integer');
  if (!p.deployment?.contracts) throw new SignTargetError('deployment is required');
  const signer = getAddress(p.account.address);
  const existing = await readTarget(db, p.target);
  if (!existing) throw new SignTargetError(`${p.target.table}/${p.target.id} not found`);
  if (existing.rawSignedTx) return storedFrom(existing);
  assertFacilityDeployment(p.target.facilityId, await readFacilityDeployment(db, p.target.facilityId), p.deployment, p.chainId);
  assertSignable(existing, p);
  if (existing.actionKind !== null) await guardValueMovingAction(p.client, { actionKind: existing.actionKind, signer, request: p.request });

  const fees = capFees(await p.client.estimateFeesPerGas(), p.capWei);
  const value = p.request.value ?? 0n;
  const gas =
    p.request.gas !== undefined
      ? assertGasLimit(p.request.gas)
      : assertGasLimit(
          withBuffer(
            await p.client.estimateGas({ account: signer, to: p.request.to, data: p.request.data, value }),
            p.gasBufferPercent ?? DEFAULT_GAS_BUFFER_PERCENT,
          ),
        );

  return db.transaction(async (tx) => {
    const row = await readTarget(tx, p.target, { lock: true });
    if (!row) throw new SignTargetError(`${p.target.table}/${p.target.id} not found`);
    if (row.rawSignedTx) return storedFrom(row);
    assertSignable(row, p);
    const nonce = await allocateNonce(tx, { signer, chainId: p.chainId, client: p.client });
    const unsigned: TransactionSerializableEIP1559 = {
      type: 'eip1559',
      chainId: p.chainId,
      nonce: Number(nonce),
      to: p.request.to,
      data: p.request.data,
      value,
      gas,
      ...fees,
    };
    const rawTx = await p.account.signTransaction(unsigned);
    const txHash = keccak256(rawTx);
    await writeSigned(tx, p.target, { rawSignedTx: rawTx, txHash, nonce, signerAddress: signer, chainId: p.chainId });
    return { target: p.target, rawTx, txHash, nonce, signer, chainId: p.chainId, reused: false };
  });
}

/** estimate * (100 + percent) / 100, rounded up. */
export function withBuffer(estimate: bigint, percent: bigint): bigint {
  if (estimate <= 0n || percent < 0n) throw new RangeError('gas estimate must be positive and buffer non-negative');
  return (estimate * (100n + percent) + 99n) / 100n;
}

// ---- broadcast (classification in broadcast.ts) ----------------------------------------------------------

/**
 * SIGNED → BROADCAST (payments) or PENDING → BROADCAST (chain actions); false if the row already moved on.
 * A DROPPED payment stays DROPPED when re-sent (§12.3: it leaves DROPPED only by being mined or CANCELLED).
 */
export async function markBroadcast(db: Db, target: SignTarget): Promise<boolean> {
  return transition(db, target, { from: [SIGNED_STATE[target.table]], to: 'BROADCAST' });
}

/** Re-sends the row's stored bytes (never signs) and marks it BROADCAST unless the nonce was consumed. */
export async function rebroadcastStored(db: Db, client: Pick<SenderClient, 'sendRawTransaction'>, target: SignTarget): Promise<BroadcastResult> {
  const row = await readTarget(db, target);
  if (!row) throw new SignTargetError(`${target.table}/${target.id} not found`);
  const stored = storedFrom(row);
  const result = await broadcast(client, stored.rawTx);
  if (result.status !== 'nonce_consumed') await markBroadcast(db, target);
  return result;
}

/** broadcast + markBroadcast for a row signAndStore just stored. */
export async function sendStored(db: Db, client: Pick<SenderClient, 'sendRawTransaction'>, stored: StoredTx): Promise<BroadcastResult> {
  const result = await broadcast(client, stored.rawTx);
  if (result.status !== 'nonce_consumed') await markBroadcast(db, stored.target);
  return result;
}

// ---- fee bump ------------------------------------------------------------------------------------------

/** What a stored tx must be bound to before a worker key re-signs it (feeBump). */
export interface StoredTxBinding {
  /** The key that would re-sign: it must be the row's signer and the key that signed the stored bytes. */
  readonly account: Pick<TxSigner, 'address'>;
  /** The chain the row signs for: the row's chain_id, the stored tx's chainId and the deployment's must all be it. */
  readonly chainId: number;
  /** The row's deployment (its manifest): `to` / calldata / value are checked as signAndStore checks a request. */
  readonly deployment: SignDeployment;
  /** SPEND / OWNER_SPEND payments: the committed planId (see SignAndStoreParams.planId). */
  readonly planId?: Hex;
}

/**
 * Null when the row's stored bytes are a tx `p.account` may re-sign at a higher fee, else the first reason it may
 * not (security re-check H1): the row's signer is the account; the bytes parse as a signed EIP-1559 tx, for
 * `p.chainId` (as are the row and the deployment), at the row's nonce, whose signature recovers to the account; and
 * its to / data / value pass the same sign binding signAndStore applies to a request (sign-binding.ts). The facility
 * row naming the deployment is checked by feeBump (a db read). Reasons never quote values.
 */
export async function storedTxRefusal(row: SignedRow, p: StoredTxBinding): Promise<string | null> {
  if (!row.rawSignedTx || row.nonce === null || !row.signerAddress || row.chainId === null) return 'row has no stored signed tx';
  const account = getAddress(p.account.address);
  if (getAddress(row.signerAddress) !== account) return 'account does not match the stored signer';
  if (p.deployment.chainId !== p.chainId || row.chainId !== p.chainId) return 'row chainId is not the deployment chainId';
  let tx: ReturnType<typeof parseTransaction>;
  let signer: Address;
  try {
    tx = parseTransaction(row.rawSignedTx);
    signer = await recoverTransactionAddress({ serializedTransaction: row.rawSignedTx as never });
  } catch {
    return 'stored bytes are not a signed EIP-1559 tx';
  }
  if (tx.type !== 'eip1559' || tx.maxFeePerGas === undefined || tx.maxPriorityFeePerGas === undefined) return 'stored bytes are not a signed EIP-1559 tx';
  if (tx.chainId !== p.chainId) return 'stored tx chainId is not the deployment chainId';
  if (tx.nonce === undefined || BigInt(tx.nonce) !== row.nonce) return 'stored tx nonce is not the row nonce';
  if (getAddress(signer) !== account) return 'stored tx is not signed by the account';
  if (!tx.to) return 'stored tx has no recipient';
  return signBindingMismatch(row, { to: tx.to, data: tx.data ?? '0x', value: tx.value ?? 0n }, { contracts: p.deployment.contracts, planId: p.planId ?? null });
}

export interface FeeBumpClient extends Pick<SenderClient, 'estimateFeesPerGas' | 'getTransactionCount'> {
  getTransactionReceipt(args: { hash: Hex }): Promise<unknown>;
}

export interface FeeBumpResult {
  readonly target: SignTarget;
  readonly rawTx: Hex;
  readonly txHash: Hex;
  /** The replaced tx: it can still be mined instead of the new one (same nonce), so watch both. */
  readonly previousTxHash: Hex;
  /**
   * payments: every earlier hash of the row now in `superseded_tx_hashes` (previousTxHash last). Always
   * empty for chain actions, whose table has no such column (the replaced hash is not kept).
   */
  readonly supersededTxHashes: readonly Hex[];
  readonly nonce: bigint;
  readonly fees: Eip1559Fees;
}

export class AlreadyMinedError extends Error {
  override readonly name = 'AlreadyMinedError';
}

async function hasReceipt(client: FeeBumpClient, hash: Hex): Promise<boolean> {
  try {
    await client.getTransactionReceipt({ hash });
    return true;
  } catch {
    return false;
  }
}

/** The current hash first, then the earlier ones, lowercase and deduplicated. */
export function ownTxHashes(row: Pick<SignedRow, 'txHash' | 'rawSignedTx' | 'supersededTxHashes'>): Hex[] {
  const all = [row.txHash, row.rawSignedTx ? keccak256(row.rawSignedTx) : null, ...row.supersededTxHashes];
  return [...new Set(all.filter((h): h is Hex => h !== null).map((h) => h.toLowerCase() as Hex))];
}

export interface FeeBumpParams extends StoredTxBinding {
  readonly target: SignTarget;
  readonly account: TxSigner;
  readonly client: FeeBumpClient;
  /** MAX_FEE_GWEI (or the caller's own cap) in wei. */
  readonly capWei: bigint;
}

/**
 * Re-signs an open row's tx (payments SIGNED / BROADCAST / DROPPED, chain actions PENDING / BROADCAST) with
 * the SAME nonce, to/data/value/gas and both fees raised ≥10 % (capped by `capWei`), and stores it in place
 * of the old bytes on the same row, appending the old hash to `superseded_tx_hashes` (payments). Refuses
 * (SignTargetError, before anything is signed) unless the facility row names `deployment` on `chainId` and the
 * stored bytes pass {@link storedTxRefusal}; refuses when any hash of the row is already mined or its nonce is
 * consumed. Does not broadcast: call `rebroadcastStored` next.
 */
export async function feeBump(db: Db, p: FeeBumpParams): Promise<FeeBumpResult> {
  if (!p.deployment?.contracts) throw new SignTargetError('deployment is required');
  return db.transaction(async (tx) => {
    const row = await readTarget(tx, p.target, { lock: true });
    if (!row) throw new SignTargetError(`${p.target.table}/${p.target.id} not found`);
    if (!OPEN_STATES[p.target.table].includes(row.state)) {
      throw new SignTargetError(`${p.target.table}/${p.target.id} is ${row.state}; only open rows can be fee-bumped`);
    }
    assertFacilityDeployment(p.target.facilityId, await readFacilityDeployment(tx, p.target.facilityId), p.deployment, p.chainId);
    const refusal = await storedTxRefusal(row, p);
    if (refusal) throw new SignTargetError(`${p.target.table}/${p.target.id}: ${refusal}; not re-signed`);
    const stored = storedFrom(row);
    const prev = parseTransaction(stored.rawTx);
    if (prev.type !== 'eip1559' || prev.maxFeePerGas === undefined || prev.maxPriorityFeePerGas === undefined) {
      throw new SignTargetError('stored tx is not an EIP-1559 tx');
    }
    const own = ownTxHashes(row);
    for (const hash of own) if (await hasReceipt(p.client, hash)) throw new AlreadyMinedError('a tx of this row is already mined');
    const mined = BigInt(await p.client.getTransactionCount({ address: stored.signer, blockTag: 'latest' }));
    if (mined > stored.nonce) throw new AlreadyMinedError('nonce already consumed; run recovery instead');

    let current: Eip1559Fees | undefined;
    try {
      current = await p.client.estimateFeesPerGas();
    } catch {
      current = undefined;
    }
    const fees = bumpFees({ maxFeePerGas: prev.maxFeePerGas, maxPriorityFeePerGas: prev.maxPriorityFeePerGas }, p.capWei, current);
    const rawTx = await p.account.signTransaction({
      type: 'eip1559',
      chainId: stored.chainId,
      nonce: Number(stored.nonce),
      ...(prev.to ? { to: prev.to } : {}),
      data: prev.data ?? '0x',
      value: prev.value ?? 0n,
      gas: assertGasLimit(prev.gas ?? 0n),
      ...fees,
    });
    const txHash = keccak256(rawTx);
    const previousTxHash = (row.txHash ?? stored.txHash).toLowerCase() as Hex;
    await replaceSigned(tx, p.target, { rawSignedTx: rawTx, txHash, nonce: stored.nonce, previousTxHash });
    const supersededTxHashes = p.target.table === 'payments' ? [...row.supersededTxHashes, previousTxHash] : [];
    return { target: p.target, rawTx, txHash, previousTxHash, supersededTxHashes, nonce: stored.nonce, fees };
  });
}
