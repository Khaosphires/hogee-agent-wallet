/**
 * Finalized watcher for signed rows (§12.3, G0-AUDIT v-4). Everything here is read at the `finalized` head,
 * so the terminal states it writes cannot be undone by a reorg. Only the worker runs it.
 *
 * INCLUDED rows (both tables), by the receipt of `tx_hash`:
 * - mined at or below `finalized`: success → FINALIZED; revert → REVERTED with the receipt's block, hash and
 *   decoded custom error (the intent is released only now; a non-final revert keeps the row INCLUDED). Only
 *   when the receipt's `blockHash` is the canonical block at that height: a node can still serve a receipt
 *   from a block that was reorged out, and such a receipt writes nothing (`pending`, retried next pass);
 * - mined above `finalized` → left INCLUDED;
 * - no receipt any more (reorged out) → payments DROPPED (keeps the intent), chain actions BROADCAST, so
 *   recovery re-sends the SAME bytes.
 *
 * DROPPED payments, the nonce watcher. Once the row's nonce is consumed at `finalized`:
 * 1. one of the row's own hashes (`tx_hash`, `superseded_tx_hashes`) has a final receipt, or is the tx that
 *    consumed the nonce → recorded as landed with THAT hash (INCLUDED, then FINALIZED / REVERTED);
 * 2. else the consumer is foreign; the intent's on-chain effect is read at `finalized` (intents.ts):
 *    - absent → CANCELLED, naming the consumer in `nonce_consumed_by_tx_hash` (the intent is released);
 *    - present and the consumer's own logs show it → landed with the consumer hash;
 *    - present otherwise, or unknown → `unresolved` for a human, still DROPPED (holding the intent).
 *
 * One pass covers ONE facility and is bound to its deployment: the facility row must name `deployment`
 * (else DeploymentMismatchError before any row or chain read), and every intent read uses its contracts.
 * Rows are processed per signer in nonce order. A row whose
 * reads or writes throw is reported as `error` (with a short reason) and the pass goes on, so one poisoned
 * row cannot starve the others.
 */
import type { Db } from '@hogee/db';
import { getAddress, keccak256, type Hex } from 'viem';
import type { HogeePublicClient } from './clients';
import { shortErrorReason } from './errors';
import { effectTxHashes, hogeeContractsOf, intentEffect, type HogeeContracts } from './intents';
import { findNonceConsumer } from './nonces';
import { minedSignedBytes } from './mined-bytes';
import { lookupRevert } from './revert';
import { ownTxHashes } from './sender';
import { assertFacilityDeployment, type SignDeployment } from './sign-binding';
import { assertFacilityScope, groupBySigner, pgSignedRowStore, type SignedRow, type SignedRowStore, type SignTarget, type SignTable } from './targets';
import { headAt } from './watcher';

export type FinalityClient = Pick<
  HogeePublicClient,
  'getBlock' | 'getTransactionReceipt' | 'getTransactionCount' | 'getTransaction' | 'readContract' | 'getLogs' | 'call' | 'request'
>;

export interface FinalityOptions {
  readonly chainId: number;
  /** The facility's deployment (its manifest); the facility row must name it. One pass = one facility. */
  readonly deployment: SignDeployment;
  readonly facilityId: string;
  /** A block where the dropped nonces were still unused (narrows the consumer search; default 0). */
  readonly nonceSearchFromBlock?: bigint;
}

/**
 * `error`: a read or write for the row threw and the row was not settled this pass (`detail` says why).
 * `toState` is then the state it was listed in; a non-terminal write (DROPPED → INCLUDED) may already have
 * happened, and the next pass continues from there.
 */
export type FinalityAction = 'finalized' | 'reverted' | 'pending' | 'reorged' | 'landed' | 'cancelled' | 'unresolved' | 'error';

export interface FinalityOutcome {
  readonly target: SignTarget;
  readonly nonce: bigint;
  readonly action: FinalityAction;
  readonly fromState: string;
  readonly toState: string;
  /** The hash recorded on the row (the one that landed). */
  readonly txHash?: Hex;
  readonly block?: bigint;
  /** CANCELLED: the foreign tx that consumed the nonce. */
  readonly consumedBy?: Hex;
  readonly revertReason?: string;
  readonly detail?: string;
}

/** The rows this watcher reads. */
export const FINALITY_STATES: { readonly [T in SignTable]: readonly string[] } = {
  payments: ['INCLUDED', 'DROPPED'],
  chain_actions: ['INCLUDED'],
};

/** Where a reorged-out INCLUDED row goes: back to an open state recovery re-sends from. */
const REORGED_STATE: { readonly [T in SignTable]: string } = { payments: 'DROPPED', chain_actions: 'BROADCAST' };

interface Ctx {
  readonly store: SignedRowStore;
  readonly client: FinalityClient;
  readonly opts: FinalityOptions;
  readonly contracts: HogeeContracts;
  readonly finalized: bigint;
}

type Out = Omit<FinalityOutcome, 'target' | 'nonce' | 'fromState'>;

/** The receipt, or null when the node says there is none. Any other RPC error propagates (no false reorg). */
async function receiptOrNull(client: FinalityClient, hash: Hex) {
  try {
    return await client.getTransactionReceipt({ hash });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'TransactionReceiptNotFoundError') return null;
    throw error;
  }
}

/** The receipt's block is the canonical block at its height (no terminal state from a reorged-out receipt). */
async function isCanonical(c: Ctx, receipt: { blockNumber: bigint; blockHash: Hex }): Promise<boolean> {
  const block = await c.client.getBlock({ blockNumber: receipt.blockNumber });
  return typeof block.hash === 'string' && typeof receipt.blockHash === 'string' && block.hash.toLowerCase() === receipt.blockHash.toLowerCase();
}

const NOT_CANONICAL = 'receipt block is not the canonical block at its height; retried next pass';

async function settleIncluded(c: Ctx, row: SignedRow): Promise<Out> {
  if (!row.txHash) return { action: 'unresolved', toState: row.state, detail: 'INCLUDED row has no tx hash' };
  const receipt = await receiptOrNull(c.client, row.txHash);
  if (!receipt) {
    const to = REORGED_STATE[row.target.table];
    const ok = await c.store.transition(row.target, { from: ['INCLUDED'], to });
    return { action: 'reorged', toState: ok ? to : row.state, txHash: row.txHash, detail: 'receipt no longer found' };
  }
  const txHash = receipt.transactionHash.toLowerCase() as Hex;
  const block = receipt.blockNumber;
  if (block > c.finalized) return { action: 'pending', toState: row.state, txHash, block };
  if (!(await isCanonical(c, receipt))) return { action: 'pending', toState: row.state, txHash, block, detail: NOT_CANONICAL };
  if (receipt.status === 'success') {
    const ok = await c.store.transition(row.target, { from: ['INCLUDED'], to: 'FINALIZED', txHash, block });
    return { action: 'finalized', toState: ok ? 'FINALIZED' : row.state, txHash, block };
  }
  const revertReason = (await lookupRevert(c.client, txHash)).decoded?.name ?? 'reverted';
  const ok = await c.store.transition(row.target, { from: ['INCLUDED'], to: 'REVERTED', txHash, block, revertReason });
  return { action: 'reverted', toState: ok ? 'REVERTED' : row.state, txHash, block, revertReason };
}

/** DROPPED → INCLUDED with the landed hash, then the INCLUDED finality step on the same row. */
async function land(c: Ctx, row: SignedRow, txHash: Hex, block: bigint, detail?: string): Promise<Out> {
  // An earlier version of a fee-bumped row landed: store its own bytes with its hash (null = keep the stored ones).
  const stored = row.rawSignedTx ? keccak256(row.rawSignedTx).toLowerCase() : null;
  const raw = stored === txHash.toLowerCase() ? null : await minedSignedBytes(c.client, txHash);
  const ok = await c.store.recordLanding(row.target, { from: ['DROPPED'], txHash, block, ...(raw ? { rawSignedTx: raw } : {}) });
  if (!ok) return { action: 'unresolved', toState: row.state, detail: 'row changed concurrently' };
  const next = await settleIncluded(c, { ...row, state: 'INCLUDED', txHash: txHash.toLowerCase() as Hex, block });
  return { ...next, action: 'landed', txHash: txHash.toLowerCase() as Hex, block: next.block ?? block, ...(detail ? { detail } : {}) };
}

async function settleDropped(c: Ctx, row: SignedRow): Promise<Out> {
  if (!row.payment || !row.signerAddress || row.nonce === null) {
    return { action: 'unresolved', toState: row.state, detail: 'DROPPED row without payment fields or signer' };
  }
  const signer = getAddress(row.signerAddress);
  const nonce = row.nonce;
  const count = BigInt(await c.client.getTransactionCount({ address: signer, blockNumber: c.finalized }));
  if (count <= nonce) return { action: 'pending', toState: row.state, detail: 'nonce not consumed at finalized' };

  const own = ownTxHashes(row);
  for (const hash of own) {
    const receipt = await receiptOrNull(c.client, hash);
    if (receipt && receipt.blockNumber <= c.finalized && (await isCanonical(c, receipt))) return land(c, row, hash, receipt.blockNumber);
  }
  const consumer = await findNonceConsumer(c.client, {
    signer,
    nonce,
    toBlock: c.finalized,
    ...(c.opts.nonceSearchFromBlock !== undefined ? { fromBlock: c.opts.nonceSearchFromBlock } : {}),
  });
  if (!consumer) return { action: 'unresolved', toState: row.state, detail: 'nonce consumed at finalized but its tx was not found' };
  if (own.includes(consumer.hash)) return land(c, row, consumer.hash, consumer.blockNumber);

  const effect = await intentEffect(c.client, row.payment, { contracts: c.contracts, blockNumber: c.finalized });
  if (effect === 'absent') {
    const ok = await c.store.recordCancelled(row.target, { consumedBy: consumer.hash });
    return { action: 'cancelled', toState: ok ? 'CANCELLED' : row.state, consumedBy: consumer.hash, block: consumer.blockNumber };
  }
  if (effect === 'present') {
    const applied = await effectTxHashes(c.client, row.payment, { contracts: c.contracts, fromBlock: consumer.blockNumber, toBlock: consumer.blockNumber });
    if (applied.includes(consumer.hash)) return land(c, row, consumer.hash, consumer.blockNumber, 'landed via a tx not recorded for this row');
    return { action: 'unresolved', toState: row.state, consumedBy: consumer.hash, detail: 'intent applied on-chain, but not by the tx that consumed the nonce' };
  }
  return { action: 'unresolved', toState: row.state, consumedBy: consumer.hash, detail: 'intent effect could not be established at finalized' };
}

async function settleRow(c: Ctx, row: SignedRow): Promise<Out> {
  try {
    return row.state === 'DROPPED' ? await settleDropped(c, row) : await settleIncluded(c, row);
  } catch (error: unknown) {
    return { action: 'error', toState: row.state, detail: shortErrorReason(error) };
  }
}

/**
 * One pass over the facility's INCLUDED and DROPPED rows on `opts.chainId`, per signer, lowest nonce first.
 * Never signs or sends. Throws DeploymentMismatchError before anything else unless the facility names
 * `opts.deployment`. A row that throws becomes an `error` outcome; the pass continues.
 */
export async function advanceFinalityWithStore(store: SignedRowStore, client: FinalityClient, opts: FinalityOptions): Promise<FinalityOutcome[]> {
  assertFacilityScope(opts);
  assertFacilityDeployment(opts.facilityId, await store.readFacilityDeployment(opts.facilityId), opts.deployment, opts.chainId);
  const finalized = await headAt(client, 'finalized');
  const rows = await store.listRows({ chainId: opts.chainId, facilityId: opts.facilityId, states: FINALITY_STATES });
  const c: Ctx = { store, client, opts, contracts: hogeeContractsOf(opts.deployment.contracts), finalized };
  const outcomes: FinalityOutcome[] = [];
  for (const group of groupBySigner(rows)) {
    for (const row of group) {
      if (row.nonce === null) continue;
      outcomes.push({ target: row.target, nonce: row.nonce, fromState: row.state, ...(await settleRow(c, row)) });
    }
  }
  return outcomes;
}

/** {@link advanceFinalityWithStore} on the Postgres `payments` / `chain_actions` tables. */
export async function advanceFinality(db: Db, client: FinalityClient, opts: FinalityOptions): Promise<FinalityOutcome[]> {
  return advanceFinalityWithStore(pgSignedRowStore(db), client, opts);
}
