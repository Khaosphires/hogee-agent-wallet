/**
 * Postgres nonce allocator (§6.1 viem row, §12.3, D19). viem's in-memory nonce manager is never used:
 * the `nonces` row of (signer, chainId) is locked with `SELECT … FOR UPDATE` inside the SAME db
 * transaction that stores the raw signed tx (see sender.ts), so two workers or a restart can never hand
 * out one nonce twice, and an aborted signing transaction gives its nonce back.
 */
import { chainActions, nonces, payments, type Db, type DbTx } from '@hogee/db';
import { and, eq, gte } from 'drizzle-orm';
import { getAddress, keccak256, type Address, type BlockTag, type Hex } from 'viem';
import { broadcast, isReplacementUnderpriced, type BroadcastStatus } from './broadcast';
import { redactError } from './errors';
import { assertGasLimit, capFees, type Eip1559Fees, type TxSigner } from './fees';

export interface NonceKey {
  readonly signer: Address;
  readonly chainId: number;
}

/** `eth_getTransactionCount`; a viem PublicClient satisfies it. */
export interface NonceCountReader {
  getTransactionCount(args: { address: Address; blockTag?: BlockTag }): Promise<number>;
}

/** Storage operations the allocator needs; {@link pgNonceStore} runs them on a db transaction. */
export interface NonceStore {
  /** `SELECT next_nonce … FOR UPDATE`; null when the signer has no row on this chain yet. */
  lockNext(key: NonceKey): Promise<bigint | null>;
  /** `INSERT … ON CONFLICT DO NOTHING` (a concurrent first use may win the insert). */
  insertIfAbsent(key: NonceKey, next: bigint): Promise<void>;
  setNext(key: NonceKey, next: bigint): Promise<void>;
}

export class NonceError extends Error {
  override readonly name = 'NonceError';
}

/** Lowercase signer (the DB CHECK requires it, and it makes one row per key regardless of casing). */
export function normaliseNonceKey(key: NonceKey): NonceKey {
  if (!Number.isSafeInteger(key.chainId) || key.chainId <= 0) throw new NonceError('chainId must be a positive integer');
  return { signer: getAddress(key.signer).toLowerCase() as Address, chainId: key.chainId };
}

export function pgNonceStore(tx: DbTx): NonceStore {
  const where = (key: NonceKey) => and(eq(nonces.signerAddress, key.signer), eq(nonces.chainId, key.chainId));
  return {
    async lockNext(key) {
      const rows = await tx.select({ next: nonces.nextNonce }).from(nonces).where(where(key)).for('update');
      return rows[0]?.next ?? null;
    },
    async insertIfAbsent(key, next) {
      await tx.insert(nonces).values({ signerAddress: key.signer, chainId: key.chainId, nextNonce: next }).onConflictDoNothing();
    },
    async setNext(key, next) {
      await tx.update(nonces).set({ nextNonce: next }).where(where(key));
    },
  };
}

/**
 * Allocation logic over any {@link NonceStore}: lock the row; on first use initialise it from the chain's
 * PENDING count; hand out `next` and store `next + 1`. Must run inside the caller's transaction.
 */
export async function allocateFromStore(store: NonceStore, key: NonceKey, client: NonceCountReader): Promise<bigint> {
  const k = normaliseNonceKey(key);
  let next = await store.lockNext(k);
  if (next === null) {
    const pending = BigInt(await client.getTransactionCount({ address: getAddress(k.signer), blockTag: 'pending' }));
    await store.insertIfAbsent(k, pending);
    next = await store.lockNext(k);
    if (next === null) throw new NonceError('nonce row missing after insert');
  }
  await store.setNext(k, next + 1n);
  return next;
}

/**
 * Allocates the next nonce for (signer, chainId) inside `tx`. Call it in the SAME transaction that stores
 * the raw signed tx (sender.signAndStore does). The row stays locked until `tx` commits or rolls back.
 */
export async function allocateNonce(tx: DbTx, opts: NonceKey & { client: NonceCountReader }): Promise<bigint> {
  return allocateFromStore(pgNonceStore(tx), opts, opts.client);
}

/**
 * Creates the (signer, chainId) row from the chain's PENDING count when it has none, exactly as a first allocation
 * would; never moves an existing row. Returns the row's next_nonce. The worker seeds every key at start-up (audit
 * run-4): inspectNonces can only report externalUse once the key has a row, and a first allocation would otherwise
 * absorb an outside use made before it.
 */
export async function seedFromStore(store: NonceStore, key: NonceKey, client: NonceCountReader): Promise<bigint> {
  const k = normaliseNonceKey(key);
  const current = await store.lockNext(k);
  if (current !== null) return current;
  await store.insertIfAbsent(k, BigInt(await client.getTransactionCount({ address: getAddress(k.signer), blockTag: 'pending' })));
  const seeded = await store.lockNext(k);
  if (seeded === null) throw new NonceError('nonce row missing after insert');
  return seeded;
}

/** {@link seedFromStore} in its own db transaction. */
export async function seedNonce(db: Db, opts: NonceKey & { client: NonceCountReader }): Promise<bigint> {
  return db.transaction((tx) => seedFromStore(pgNonceStore(tx), opts, opts.client));
}

/** Raises next_nonce to at least `atLeast` (never lowers it). Used when the key was used outside the allocator. */
export async function advanceNonce(tx: DbTx, key: NonceKey, atLeast: bigint): Promise<bigint> {
  const k = normaliseNonceKey(key);
  const store = pgNonceStore(tx);
  const current = await store.lockNext(k);
  if (current === null) {
    await store.insertIfAbsent(k, atLeast);
    return (await store.lockNext(k)) ?? atLeast;
  }
  if (current < atLeast) await store.setNext(k, atLeast);
  return current < atLeast ? atLeast : current;
}

// ---- gap detection (§12.3) ------------------------------------------------------------------------

/** A stored signed row holding a nonce that is not mined yet. */
export interface NonceSlot {
  readonly table: 'payments' | 'chain_actions';
  readonly facilityId: string;
  readonly id: string;
  readonly nonce: bigint;
  readonly txHash: Hex | null;
  readonly state: string;
}

export interface NonceInspection {
  readonly signer: Address;
  readonly chainId: number;
  /** Mined tx count at `latest` = the lowest nonce not yet mined. */
  readonly chainLatest: bigint;
  readonly chainPending: bigint;
  /** nonces.next_nonce, or null before first use. */
  readonly dbNext: bigint | null;
  /** Stored signed rows with nonce >= chainLatest (waiting to be mined). */
  readonly open: readonly NonceSlot[];
  /** Nonces in [chainLatest, dbNext) that no stored row holds: they block every later nonce. */
  readonly holes: readonly bigint[];
  /** chainPending > dbNext: the key was used outside the allocator (manual send or leaked key, T29). */
  readonly externalUse: boolean;
}

/** Reads the chain and both signing tables; changes nothing. */
export async function inspectNonces(db: Db | DbTx, opts: NonceKey & { client: NonceCountReader }): Promise<NonceInspection> {
  const k = normaliseNonceKey(opts);
  const address = getAddress(k.signer);
  const [latest, pending] = await Promise.all([
    opts.client.getTransactionCount({ address, blockTag: 'latest' }),
    opts.client.getTransactionCount({ address, blockTag: 'pending' }),
  ]);
  const chainLatest = BigInt(latest);
  const chainPending = BigInt(pending);
  const nonceRows = await db
    .select({ next: nonces.nextNonce })
    .from(nonces)
    .where(and(eq(nonces.signerAddress, k.signer), eq(nonces.chainId, k.chainId)));
  const dbNext = nonceRows[0]?.next ?? null;

  const paymentRows = await db
    .select({ facilityId: payments.facilityId, id: payments.id, nonce: payments.nonce, txHash: payments.txHash, state: payments.state })
    .from(payments)
    .where(and(eq(payments.signerAddress, k.signer), eq(payments.chainId, k.chainId), gte(payments.nonce, chainLatest)));
  const actionRows = await db
    .select({
      facilityId: chainActions.facilityId,
      id: chainActions.id,
      nonce: chainActions.nonce,
      txHash: chainActions.txHash,
      state: chainActions.state,
    })
    .from(chainActions)
    .where(and(eq(chainActions.signerAddress, k.signer), eq(chainActions.chainId, k.chainId), gte(chainActions.nonce, chainLatest)));

  const open: NonceSlot[] = [
    ...paymentRows.map((r) => ({ table: 'payments' as const, ...r, nonce: r.nonce ?? -1n, txHash: (r.txHash as Hex | null) ?? null })),
    ...actionRows.map((r) => ({ table: 'chain_actions' as const, ...r, nonce: r.nonce ?? -1n, txHash: (r.txHash as Hex | null) ?? null })),
  ].sort((a, b) => (a.nonce < b.nonce ? -1 : a.nonce > b.nonce ? 1 : 0));

  return Object.freeze({
    signer: address,
    chainId: k.chainId,
    chainLatest,
    chainPending,
    dbNext,
    open,
    holes: findHoles(chainLatest, dbNext, open.map((s) => s.nonce)),
    externalUse: dbNext !== null && chainPending > dbNext,
  });
}

/** Nonces in [from, to) not in `held`. Pure. */
export function findHoles(from: bigint, to: bigint | null, held: readonly bigint[]): bigint[] {
  if (to === null || to <= from) return [];
  const taken = new Set(held.map(String));
  const holes: bigint[] = [];
  for (let n = from; n < to; n += 1n) if (!taken.has(String(n))) holes.push(n);
  return holes;
}

export interface CancelSender {
  estimateFeesPerGas(): Promise<Eip1559Fees>;
  sendRawTransaction(args: { serializedTransaction: Hex }): Promise<Hex>;
}

/**
 * How the node took a hole-fill cancel: a `BroadcastStatus`, or `occupied` when a pending tx with similar
 * fees already holds that nonce ("replacement transaction underpriced"; typically the cancel an earlier,
 * crashed run sent). None of them is an error: the hole is being filled, or already is.
 */
export type HoleFillStatus = BroadcastStatus | 'occupied';

export interface HoleFill {
  readonly nonce: bigint;
  /** keccak256 of the cancel signed by THIS run (computed locally). */
  readonly txHash: Hex;
  readonly status: HoleFillStatus;
}

export interface NonceReconcileResult extends NonceInspection {
  /** The new next_nonce when external use was detected. */
  readonly advancedTo: bigint | null;
  /** No-op self-send cancels broadcast to fill holes. */
  readonly cancels: readonly HoleFill[];
}

const CANCEL_GAS = 21_000n;

export interface FillHolesParams {
  readonly client: CancelSender;
  readonly account: TxSigner;
  readonly chainId: number;
  readonly holes: readonly bigint[];
  /** MAX_FEE_GWEI in wei. */
  readonly capWei: bigint;
}

/**
 * Signs a no-op cancel (0-value self-send, 21,000 gas) per hole and sends it through `broadcast`, so a
 * re-run after a crash (the node already has the cancel, the nonce is already used, or the earlier cancel
 * is still pending) reports a status instead of failing. Any other error is rethrown, redacted when it
 * carries a URL (errors.ts).
 */
export async function fillNonceHoles(p: FillHolesParams): Promise<HoleFill[]> {
  try {
    return await fillHoles(p);
  } catch (error: unknown) {
    throw redactError(error);
  }
}

async function fillHoles(p: FillHolesParams): Promise<HoleFill[]> {
  if (p.holes.length === 0) return [];
  const signer = getAddress(p.account.address);
  const fees = capFees(await p.client.estimateFeesPerGas(), p.capWei);
  const fills: HoleFill[] = [];
  for (const nonce of p.holes) {
    const raw = await p.account.signTransaction({
      type: 'eip1559',
      chainId: p.chainId,
      nonce: Number(nonce),
      to: signer,
      value: 0n,
      gas: assertGasLimit(CANCEL_GAS),
      ...fees,
    });
    try {
      fills.push({ nonce, ...(await broadcast(p.client, raw)) });
    } catch (error: unknown) {
      if (!isReplacementUnderpriced(error)) throw error;
      fills.push({ nonce, txHash: keccak256(raw), status: 'occupied' });
    }
  }
  return fills;
}

/**
 * §12.3 gap repair for one signer. Rows that hold a nonce are recovered by `recoverOpenIntents`, which
 * re-sends the SAME bytes after its on-chain intent checks (run it first). This function handles what no
 * row owns:
 * - external use (chainPending > next_nonce): next_nonce is raised so the allocator never reuses a nonce;
 * - holes: each is filled with a no-op cancel ({@link fillNonceHoles}). Cancels have no business effect and
 *   are not stored: if this crashes, the next run signs a cancel for the same nonce again (only one tx per
 *   nonce can ever be mined), and the node's "already known" / "nonce too low" / "replacement underpriced"
 *   replies to it are statuses, not failures.
 */
export async function reconcileNonce(
  db: Db,
  opts: NonceKey & { client: NonceCountReader & CancelSender; account: TxSigner; capWei: bigint },
): Promise<NonceReconcileResult> {
  const k = normaliseNonceKey(opts);
  if (getAddress(opts.account.address).toLowerCase() !== k.signer) throw new NonceError('account does not match signer');
  const inspection = await inspectNonces(db, opts);
  let advancedTo: bigint | null = null;
  if (inspection.externalUse) {
    advancedTo = await db.transaction((tx) => advanceNonce(tx, k, inspection.chainPending));
  }
  const cancels = await fillNonceHoles({ client: opts.client, account: opts.account, chainId: k.chainId, holes: inspection.holes, capWei: opts.capWei });
  return Object.freeze({ ...inspection, advancedTo, cancels });
}

/** For tests and diagnostics: the stored next_nonce (no lock). */
export async function readNextNonce(db: Db | DbTx, key: NonceKey): Promise<bigint | null> {
  const k = normaliseNonceKey(key);
  const rows = await db
    .select({ next: nonces.nextNonce })
    .from(nonces)
    .where(and(eq(nonces.signerAddress, k.signer), eq(nonces.chainId, k.chainId)));
  return rows[0]?.next ?? null;
}

// ---- who consumed a nonce (§12.3 CANCELLED proof, G0-AUDIT v-4) ------------------------------------

/** The tx that used (signer, nonce): found in the block where the signer's nonce count first passes it. */
export interface NonceConsumer {
  /** Lowercase. */
  readonly hash: Hex;
  readonly blockNumber: bigint;
  readonly nonce: bigint;
  readonly to: Address | null;
  readonly input: Hex;
  readonly value: bigint;
}

/** `getTransactionCount` at a block number and `getBlock` with its txs; a viem PublicClient satisfies it. */
export interface NonceHistoryReader {
  getTransactionCount(args: { address: Address; blockNumber: bigint }): Promise<number>;
  getBlock(args: { blockNumber: bigint; includeTransactions: true }): Promise<{
    transactions: readonly (Hex | { hash: Hex; from: Address; nonce: number; to: Address | null; input: Hex; value: bigint })[];
  }>;
}

/**
 * Finds the tx that consumed `nonce` of `signer` at or below `toBlock`, or null when the nonce is not
 * consumed there. Binary search over the (monotonic) nonce count, so ~log2(toBlock) count reads plus one
 * block read; `fromBlock` (a block where the nonce was still unused, e.g. when the row was signed) narrows it.
 * Needs historical state (Anvil, archive RPCs).
 */
export async function findNonceConsumer(
  client: NonceHistoryReader,
  a: { signer: Address; nonce: bigint; toBlock: bigint; fromBlock?: bigint },
): Promise<NonceConsumer | null> {
  const address = getAddress(a.signer);
  const countAt = async (blockNumber: bigint) => BigInt(await client.getTransactionCount({ address, blockNumber }));
  if ((await countAt(a.toBlock)) <= a.nonce) return null;
  let lo = a.fromBlock !== undefined && a.fromBlock < a.toBlock ? a.fromBlock : 0n;
  if (lo > 0n && (await countAt(lo)) > a.nonce) lo = 0n;
  let hi = a.toBlock; // invariant: count(lo) <= nonce < count(hi); genesis has no txs, so count(0) = 0
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if ((await countAt(mid)) > a.nonce) hi = mid;
    else lo = mid;
  }
  const block = await client.getBlock({ blockNumber: hi, includeTransactions: true });
  for (const tx of block.transactions) {
    if (typeof tx === 'string') continue;
    if (getAddress(tx.from) === address && BigInt(tx.nonce) === a.nonce) {
      return { hash: tx.hash.toLowerCase() as Hex, blockNumber: hi, nonce: a.nonce, to: tx.to ?? null, input: tx.input, value: tx.value };
    }
  }
  return null;
}
