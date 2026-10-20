/**
 * Crash recovery for signed rows (§12.3, T19). Takes no signer, so it can NEVER sign a new tx for an open
 * intent: it only reads the chain (at `latest`), re-sends the SAME stored bytes, and moves states forward.
 * Final outcomes (FINALIZED, REVERTED, CANCELLED) are left to the finality watcher (finality.ts), which
 * reads at `finalized`.
 *
 * Per open row (payments SIGNED / BROADCAST / DROPPED, chain actions PENDING-with-raw-tx / BROADCAST), in
 * nonce order:
 * 1. a receipt for ANY hash of the row (`tx_hash`, the stored bytes, `superseded_tx_hashes`) → INCLUDED
 *    with that hash, success or revert (a non-final revert keeps the intent; G0-AUDIT v-4);
 * 2. payments: is the intent already executed on-chain? (`isIntentUsed` / the intent's event / views). By
 *    one of the row's hashes → INCLUDED; by some other tx → nothing is re-sent;
 * 3. a hash of the row is still in the node's mempool → BROADCAST (from SIGNED), nothing sent;
 * 4. the nonce is consumed by another tx → payments: DROPPED (keeps the intent; the finality watcher proves
 *    landing or CANCELLED at `finalized`); chain actions: INCLUDED if the consumer is the same call
 *    (an earlier version of a fee-bumped row), else `unresolved`;
 * 5. otherwise re-send the stored bytes. SIGNED / PENDING → BROADCAST; a BROADCAST payment the node forgot
 *    → DROPPED first (§12.3); a DROPPED payment stays DROPPED until it is mined.
 *
 * One pass covers ONE facility and is bound to its deployment: the facility row must name `deployment`
 * (else DeploymentMismatchError before any row or chain read), and every intent read uses its contracts.
 * Rows are processed per signer in nonce order. A row whose
 * reads or writes throw is reported as `error` (with a short reason) and the pass goes on, so one poisoned
 * row cannot starve the others.
 */
import type { Db } from '@hogee/db';
import { getAddress, keccak256, parseTransaction, type Address, type Hex } from 'viem';
import { minedSignedBytes } from './mined-bytes';
import type { HogeePublicClient } from './clients';
import { shortErrorReason } from './errors';
import { hogeeContractsOf, probeIntent, type Probe, type ProbeOptions } from './intents';
import { findNonceConsumer, type NonceConsumer } from './nonces';
import { broadcast } from './broadcast';
import { ownTxHashes } from './sender';
import { assertFacilityDeployment, type SignDeployment } from './sign-binding';
import { assertFacilityScope, groupBySigner, OPEN_STATES, pgSignedRowStore, SIGNED_STATE, type SignedRow, type SignedRowStore, type SignTarget } from './targets';

export type RecoveryClient = Pick<
  HogeePublicClient,
  'getTransactionReceipt' | 'getTransaction' | 'getTransactionCount' | 'sendRawTransaction' | 'readContract' | 'getLogs' | 'getBlockNumber' | 'getBlock'
>;

export interface RecoveryOptions {
  readonly chainId: number;
  /** The facility's deployment (its manifest); the facility row must name it. One pass = one facility. */
  readonly deployment: SignDeployment;
  readonly facilityId: string;
  /** Blocks searched back from the head for the intent's event (default 64). */
  readonly logLookbackBlocks?: bigint;
  /** getLogs range per request (default 10). */
  readonly logChunkSize?: bigint;
}

/**
 * `error`: a read or write for the row threw and the row was not recovered this pass (`detail` says why).
 * `toState` is then the state it was listed in; the next pass starts over from the row's stored state.
 */
export type RecoveryAction = 'included' | 'pending' | 'rebroadcast' | 'dropped' | 'unresolved' | 'error';

export interface RecoveryOutcome {
  readonly target: SignTarget;
  readonly nonce: bigint;
  /** keccak256 of the stored raw tx. */
  readonly storedTxHash: Hex;
  readonly action: RecoveryAction;
  readonly fromState: string;
  readonly toState: string;
  /** The hash that was mined at the row's nonce (may be an earlier, superseded hash of the row). */
  readonly onchainTxHash?: Hex;
  readonly block?: bigint;
  /** Receipt status when known. A `reverted` receipt leaves the row INCLUDED until it is final. */
  readonly receiptStatus?: 'success' | 'reverted';
  readonly detail?: string;
}

interface Ctx {
  readonly store: SignedRowStore;
  readonly client: RecoveryClient;
  readonly row: SignedRow;
  readonly raw: Hex;
  readonly hash: Hex;
  readonly nonce: bigint;
  readonly own: readonly Hex[];
}

async function tryReceipt(client: RecoveryClient, hash: Hex) {
  try {
    return await client.getTransactionReceipt({ hash });
  } catch {
    return null;
  }
}

async function knownToNode(client: RecoveryClient, hash: Hex): Promise<boolean> {
  try {
    await client.getTransaction({ hash });
    return true;
  } catch {
    return false;
  }
}

function outcome(c: Ctx, action: RecoveryAction, toState: string, extra: Partial<RecoveryOutcome> = {}): RecoveryOutcome {
  return { target: c.row.target, nonce: c.nonce, storedTxHash: c.hash, action, fromState: c.row.state, toState, ...extra };
}

async function move(c: Ctx, from: readonly string[], to: string): Promise<string> {
  return (await c.store.transition(c.row.target, { from, to })) ? to : c.row.state;
}

async function landed(c: Ctx, txHash: Hex, block: bigint, receiptStatus?: 'success' | 'reverted', detail?: string): Promise<RecoveryOutcome> {
  // An earlier version of a fee-bumped row landed: store its own bytes with its hash (null = keep the stored ones).
  const raw = txHash.toLowerCase() === c.hash.toLowerCase() ? null : await minedSignedBytes(c.client, txHash);
  const ok = await c.store.recordLanding(c.row.target, { from: OPEN_STATES[c.row.target.table], txHash, block, ...(raw ? { rawSignedTx: raw } : {}) });
  return outcome(c, 'included', ok ? 'INCLUDED' : c.row.state, {
    onchainTxHash: txHash.toLowerCase() as Hex,
    block,
    ...(receiptStatus ? { receiptStatus } : {}),
    ...(detail ? { detail } : {}),
  });
}

/** The first hash of the row that has a receipt. */
async function findOwnReceipt(c: Ctx) {
  for (const hash of c.own) {
    const receipt = await tryReceipt(c.client, hash);
    if (receipt) return receipt;
  }
  return null;
}

/** Same signer and nonce (given) and the same to / data / value as the stored bytes: an earlier version of this tx. */
function isSameCall(raw: Hex, consumer: NonceConsumer): boolean {
  const tx = parseTransaction(raw);
  const to = tx.to ? tx.to.toLowerCase() : null;
  return to === (consumer.to?.toLowerCase() ?? null) && (tx.data ?? '0x').toLowerCase() === consumer.input.toLowerCase() && (tx.value ?? 0n) === consumer.value;
}

async function nonceConsumed(c: Ctx, signer: Address): Promise<RecoveryOutcome> {
  const late = await findOwnReceipt(c); // mined between the first check and now
  if (late) return landed(c, late.transactionHash, late.blockNumber, late.status);
  if (c.row.target.table === 'payments') {
    const toState = c.row.state === 'DROPPED' ? 'DROPPED' : await move(c, ['SIGNED', 'BROADCAST'], 'DROPPED');
    return outcome(c, 'dropped', toState, { detail: 'nonce consumed by another tx; the finality watcher settles it at finalized' });
  }
  const head = await c.client.getBlockNumber({ cacheTime: 0 });
  const consumer = await findNonceConsumer(c.client, { signer, nonce: c.nonce, toBlock: head });
  if (consumer && isSameCall(c.raw, consumer)) return landed(c, consumer.hash, consumer.blockNumber, undefined, 'same call at the same nonce');
  return outcome(c, 'unresolved', c.row.state, { detail: 'nonce consumed by a different tx (chain actions have no CANCELLED state)' });
}

async function resend(c: Ctx): Promise<RecoveryOutcome> {
  const { table } = c.row.target;
  const forgotten = table === 'payments' && c.row.state === 'BROADCAST';
  const before = forgotten ? await move(c, ['BROADCAST'], 'DROPPED') : c.row.state;
  const sent = await broadcast(c.client, c.raw);
  if (sent.status === 'nonce_consumed') return outcome(c, 'unresolved', before, { detail: 'nonce consumed while re-sending; retry recovery' });
  const toState = before === SIGNED_STATE[table] ? await move(c, [SIGNED_STATE[table]], 'BROADCAST') : before;
  return outcome(c, 'rebroadcast', toState);
}

async function recoverRow(c: Ctx, probeOpts: ProbeOptions): Promise<RecoveryOutcome> {
  const receipt = await findOwnReceipt(c);
  if (receipt) return landed(c, receipt.transactionHash, receipt.blockNumber, receipt.status);

  const probe: Probe = c.row.payment ? await probeIntent(c.client, c.row.payment, probeOpts) : { status: 'unknown' };
  if (probe.status === 'executed' && probe.txHash && probe.block !== undefined && c.own.includes(probe.txHash)) {
    return landed(c, probe.txHash, probe.block, undefined, 'found by the intent event');
  }

  for (const hash of c.own) {
    if (await knownToNode(c.client, hash)) {
      const toState = c.row.state === SIGNED_STATE[c.row.target.table] ? await move(c, [c.row.state], 'BROADCAST') : c.row.state;
      return outcome(c, 'pending', toState);
    }
  }

  if (!c.row.signerAddress) return outcome(c, 'unresolved', c.row.state, { detail: 'signed row has no signer address' });
  const signer = getAddress(c.row.signerAddress);
  const mined = BigInt(await c.client.getTransactionCount({ address: signer, blockTag: 'latest' }));
  if (mined > c.nonce) return nonceConsumed(c, signer);

  if (probe.status === 'executed') {
    return outcome(c, 'unresolved', c.row.state, { detail: 'intent executed on-chain by a tx that is not this row’s; nothing re-sent' });
  }
  return resend(c);
}

async function recoverRowSafely(
  store: SignedRowStore,
  client: RecoveryClient,
  row: SignedRow & { rawSignedTx: Hex; nonce: bigint },
  probeOpts: ProbeOptions,
): Promise<RecoveryOutcome> {
  try {
    const ctx: Ctx = { store, client, row, raw: row.rawSignedTx, hash: keccak256(row.rawSignedTx), nonce: row.nonce, own: ownTxHashes(row) };
    return await recoverRow(ctx, probeOpts);
  } catch (error: unknown) {
    let storedTxHash: Hex;
    try {
      storedTxHash = keccak256(row.rawSignedTx);
    } catch {
      storedTxHash = row.txHash ?? '0x';
    }
    return { target: row.target, nonce: row.nonce, storedTxHash, action: 'error', fromState: row.state, toState: row.state, detail: shortErrorReason(error) };
  }
}

/**
 * Recovers the facility's open signed rows on `opts.chainId` (both tables), per signer, lowest nonce first.
 * Never signs. Throws DeploymentMismatchError before anything else unless the facility names
 * `opts.deployment`. A row that throws becomes an `error` outcome; the pass continues.
 */
export async function recoverWithStore(store: SignedRowStore, client: RecoveryClient, opts: RecoveryOptions): Promise<RecoveryOutcome[]> {
  assertFacilityScope(opts);
  assertFacilityDeployment(opts.facilityId, await store.readFacilityDeployment(opts.facilityId), opts.deployment, opts.chainId);
  const probeOpts: ProbeOptions = {
    contracts: hogeeContractsOf(opts.deployment.contracts),
    ...(opts.logLookbackBlocks !== undefined ? { logLookbackBlocks: opts.logLookbackBlocks } : {}),
    ...(opts.logChunkSize !== undefined ? { logChunkSize: opts.logChunkSize } : {}),
  };
  const rows = await store.listRows({ chainId: opts.chainId, facilityId: opts.facilityId, states: OPEN_STATES });
  const outcomes: RecoveryOutcome[] = [];
  for (const group of groupBySigner(rows)) {
    for (const row of group) {
      if (!row.rawSignedTx || row.nonce === null) continue;
      outcomes.push(await recoverRowSafely(store, client, { ...row, rawSignedTx: row.rawSignedTx, nonce: row.nonce }, probeOpts));
    }
  }
  return outcomes;
}

/** {@link recoverWithStore} on the Postgres `payments` / `chain_actions` tables. */
export async function recoverOpenIntents(db: Db, client: RecoveryClient, opts: RecoveryOptions): Promise<RecoveryOutcome[]> {
  return recoverWithStore(pgSignedRowStore(db), client, opts);
}
