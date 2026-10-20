/**
 * Row access for the two tables the worker signs for: `payments` (§12.3 state machine) and `chain_actions`
 * (G0 outbox for every non-payment tx). Writes are conditional on the expected state, so a stale worker can
 * never move a row backwards, and they respect the DB's signed-row CHECKs (raw tx, nonce, signer and chainId
 * are written together; every state past the unsigned ones keeps the raw tx).
 *
 * G0-AUDIT (v-4): a payment row records every hash ever signed for it. `tx_hash` is the current (or landed)
 * one and `superseded_tx_hashes` holds all the others, so a fee bump appends the replaced hash in the SAME
 * UPDATE that stores the new bytes, and a landing of an earlier hash swaps the two. `chain_actions` has no
 * `superseded_tx_hashes` column (frozen G0 schema): a replaced chain-action hash is not kept, and recovery
 * recognises a landed earlier version by its identical call at the same signer nonce instead.
 */
import { chainActions, facilities, payments, type Db, type DbTx } from '@hogee/db';
import { and, eq, inArray, isNotNull, isNull, ne, sql, type SQL } from 'drizzle-orm';
import type { Address, Hex } from 'viem';

export type SignTable = 'payments' | 'chain_actions';

/** The row to sign for. `id` is the paymentId or the chain actionId; keys are tenant-scoped. */
export interface SignTarget {
  readonly table: SignTable;
  readonly facilityId: string;
  readonly id: string;
}

/** Payment fields the sender and recovery compare with calldata and the chain. */
export interface PaymentIntentFields {
  readonly kind: string;
  readonly intentId: Hex;
  readonly lineId: Hex | null;
  readonly payeeId: string;
  readonly orderId: string | null;
  readonly milestoneIdx: number | null;
  readonly amountMinor: string;
  readonly invoiceHash: Hex;
  readonly planVersion: number;
  readonly decisionId: string | null;
  readonly rationaleHash: Hex | null;
}

export interface SignedRow {
  readonly target: SignTarget;
  readonly state: string;
  readonly rawSignedTx: Hex | null;
  readonly nonce: bigint | null;
  readonly signerAddress: Address | null;
  readonly chainId: number | null;
  readonly txHash: Hex | null;
  /** payments: every other hash ever signed for the row (lowercase). Always empty for chain actions. */
  readonly supersededTxHashes: readonly Hex[];
  /** payments: the foreign tx that consumed the nonce (set exactly when CANCELLED). */
  readonly nonceConsumedByTxHash: Hex | null;
  /** Receipt block once included. */
  readonly block: bigint | null;
  /** Set for `payments` rows only. */
  readonly payment: PaymentIntentFields | null;
  /** `chain_actions.kind` (`<Contract>.<function>`); null for payments. */
  readonly actionKind: string | null;
}

/** The state a row must be in to be signed. */
export const SIGNABLE_STATE: { readonly [T in SignTable]: string } = { payments: 'POLICY_OK', chain_actions: 'PENDING' };
/** The state a row moves to when its raw tx is stored. Chain actions have no SIGNED state: PENDING + raw tx. */
export const SIGNED_STATE: { readonly [T in SignTable]: string } = { payments: 'SIGNED', chain_actions: 'PENDING' };
/**
 * Signed but not yet seen in a block: recovery's input, and the rows a fee bump may replace in place.
 * G0-AUDIT (v-4): a DROPPED payment is still open; its bytes (or a bump of them) can still be mined.
 */
export const OPEN_STATES: { readonly [T in SignTable]: readonly string[] } = {
  payments: ['SIGNED', 'BROADCAST', 'DROPPED'],
  chain_actions: ['PENDING', 'BROADCAST'],
};

export class SignTargetError extends Error {
  override readonly name: string = 'SignTargetError';
}

type Q = Db | DbTx;

const paymentCols = {
  state: payments.state,
  rawSignedTx: payments.rawSignedTx,
  nonce: payments.nonce,
  signerAddress: payments.signerAddress,
  chainId: payments.chainId,
  txHash: payments.txHash,
  supersededTxHashes: payments.supersededTxHashes,
  nonceConsumedByTxHash: payments.nonceConsumedByTxHash,
  block: payments.block,
  facilityId: payments.facilityId,
  id: payments.id,
  kind: payments.kind,
  intentId: payments.intentId,
  lineId: payments.lineId,
  payeeId: payments.payeeId,
  orderId: payments.orderId,
  milestoneIdx: payments.milestoneIdx,
  amountMinor: payments.amountMinor,
  invoiceHash: payments.invoiceHash,
  planVersion: payments.planVersion,
  decisionId: payments.decisionId,
  rationaleHash: payments.rationaleHash,
};

const actionCols = {
  state: chainActions.state,
  rawSignedTx: chainActions.rawSignedTx,
  nonce: chainActions.nonce,
  signerAddress: chainActions.signerAddress,
  chainId: chainActions.chainId,
  txHash: chainActions.txHash,
  block: chainActions.block,
  facilityId: chainActions.facilityId,
  id: chainActions.id,
  kind: chainActions.kind,
};

type PaymentRow = { [K in keyof typeof paymentCols]: (typeof paymentCols)[K]['_']['data'] | null };
type ActionRow = { [K in keyof typeof actionCols]: (typeof actionCols)[K]['_']['data'] | null };

function fromPayment(r: PaymentRow): SignedRow {
  return {
    target: { table: 'payments', facilityId: String(r.facilityId), id: String(r.id) },
    state: String(r.state),
    rawSignedTx: (r.rawSignedTx as Hex | null) ?? null,
    nonce: r.nonce ?? null,
    signerAddress: (r.signerAddress as Address | null) ?? null,
    chainId: r.chainId ?? null,
    txHash: (r.txHash as Hex | null) ?? null,
    supersededTxHashes: Object.freeze([...((r.supersededTxHashes as Hex[] | null) ?? [])]),
    nonceConsumedByTxHash: (r.nonceConsumedByTxHash as Hex | null) ?? null,
    block: r.block ?? null,
    actionKind: null,
    payment: {
      kind: String(r.kind),
      intentId: r.intentId as Hex,
      lineId: (r.lineId as Hex | null) ?? null,
      payeeId: String(r.payeeId),
      orderId: r.orderId ?? null,
      milestoneIdx: r.milestoneIdx ?? null,
      amountMinor: String(r.amountMinor),
      invoiceHash: r.invoiceHash as Hex,
      planVersion: Number(r.planVersion),
      decisionId: r.decisionId ?? null,
      rationaleHash: (r.rationaleHash as Hex | null) ?? null,
    },
  };
}

function fromAction(r: ActionRow): SignedRow {
  return {
    target: { table: 'chain_actions', facilityId: String(r.facilityId), id: String(r.id) },
    state: String(r.state),
    rawSignedTx: (r.rawSignedTx as Hex | null) ?? null,
    nonce: r.nonce ?? null,
    signerAddress: (r.signerAddress as Address | null) ?? null,
    chainId: r.chainId ?? null,
    txHash: (r.txHash as Hex | null) ?? null,
    supersededTxHashes: [],
    nonceConsumedByTxHash: null,
    block: r.block ?? null,
    actionKind: r.kind ?? null,
    payment: null,
  };
}

const paymentKey = (t: SignTarget) => and(eq(payments.facilityId, t.facilityId), eq(payments.id, t.id));
const actionKey = (t: SignTarget) => and(eq(chainActions.facilityId, t.facilityId), eq(chainActions.id, t.id));

/** Reads one row; with `lock` it is `SELECT … FOR UPDATE` (use inside a transaction). */
export async function readTarget(q: Q, target: SignTarget, opts: { lock?: boolean } = {}): Promise<SignedRow | null> {
  if (target.table === 'payments') {
    const base = q.select(paymentCols).from(payments).where(paymentKey(target));
    const rows = opts.lock ? await base.for('update') : await base;
    return rows[0] ? fromPayment(rows[0]) : null;
  }
  const base = q.select(actionCols).from(chainActions).where(actionKey(target));
  const rows = opts.lock ? await base.for('update') : await base;
  return rows[0] ? fromAction(rows[0]) : null;
}

export interface SignedFields {
  readonly rawSignedTx: Hex;
  readonly txHash: Hex;
  readonly nonce: bigint;
  /** Lowercase. */
  readonly signerAddress: Address;
  readonly chainId: number;
}

/** Stores the signed tx and moves the row to its signed state; only from the signable state with no raw tx. */
export async function writeSigned(tx: DbTx, target: SignTarget, f: SignedFields): Promise<void> {
  const values = {
    rawSignedTx: f.rawSignedTx.toLowerCase(),
    txHash: f.txHash.toLowerCase(),
    nonce: f.nonce,
    signerAddress: f.signerAddress.toLowerCase(),
    chainId: f.chainId,
  };
  const updated =
    target.table === 'payments'
      ? await tx
          .update(payments)
          .set({ ...values, state: 'SIGNED' })
          .where(and(paymentKey(target), eq(payments.state, 'POLICY_OK'), isNull(payments.rawSignedTx)))
          .returning({ id: payments.id })
      : await tx
          .update(chainActions)
          .set(values)
          .where(and(actionKey(target), eq(chainActions.state, 'PENDING'), isNull(chainActions.rawSignedTx)))
          .returning({ id: chainActions.id });
  if (updated.length !== 1) throw new SignTargetError(`${target.table}/${target.id} was not in a signable state`);
}

export interface Replacement {
  readonly rawSignedTx: Hex;
  readonly txHash: Hex;
  readonly nonce: bigint;
  /** The row's current tx_hash; the UPDATE only applies while it is still that. */
  readonly previousTxHash: Hex;
}

/**
 * Fee bump / same-intent replacement IN PLACE on the same row: swaps the raw tx of an open row, keeping its
 * nonce. For payments the same UPDATE appends the replaced `tx_hash` to `superseded_tx_hashes` (Postgres
 * evaluates SET expressions on the old row), because the earlier bytes can still be the ones mined.
 */
export async function replaceSigned(tx: DbTx, target: SignTarget, f: Replacement): Promise<void> {
  const raw = f.rawSignedTx.toLowerCase();
  const hash = f.txHash.toLowerCase();
  const prev = f.previousTxHash.toLowerCase();
  if (hash === prev) throw new SignTargetError(`${target.table}/${target.id}: replacement has the same hash`);
  const open = OPEN_STATES[target.table];
  const updated =
    target.table === 'payments'
      ? await tx
          .update(payments)
          .set({
            rawSignedTx: raw,
            txHash: hash,
            supersededTxHashes: sql`array_append(${payments.supersededTxHashes}, ${payments.txHash})`,
          })
          .where(and(paymentKey(target), eq(payments.nonce, f.nonce), eq(payments.txHash, prev), inArray(payments.state, open as never[])))
          .returning({ id: payments.id })
      : await tx
          .update(chainActions)
          .set({ rawSignedTx: raw, txHash: hash })
          .where(and(actionKey(target), eq(chainActions.nonce, f.nonce), eq(chainActions.txHash, prev), inArray(chainActions.state, open as never[])))
          .returning({ id: chainActions.id });
  if (updated.length !== 1) throw new SignTargetError(`${target.table}/${target.id} is not open with nonce ${f.nonce} and the expected tx hash`);
}

export interface Transition {
  readonly from: readonly string[];
  readonly to: string;
  readonly txHash?: Hex;
  readonly block?: bigint;
  readonly revertReason?: string;
}

/** Conditional state change (`WHERE state IN from`); returns false when another writer got there first. */
export async function transition(q: Q, target: SignTarget, t: Transition): Promise<boolean> {
  const extra = {
    ...(t.txHash !== undefined ? { txHash: t.txHash.toLowerCase() } : {}),
    ...(t.block !== undefined ? { block: t.block } : {}),
    ...(t.revertReason !== undefined ? { revertReason: t.revertReason.slice(0, 200) } : {}),
  };
  const updated =
    target.table === 'payments'
      ? await q
          .update(payments)
          .set({ ...extra, state: t.to as never })
          .where(and(paymentKey(target), inArray(payments.state, t.from as never[])))
          .returning({ id: payments.id })
      : await q
          .update(chainActions)
          .set({ ...extra, state: t.to as never })
          .where(and(actionKey(target), inArray(chainActions.state, t.from as never[])))
          .returning({ id: chainActions.id });
  return updated.length === 1;
}

export interface ListRowsOptions {
  readonly chainId: number;
  readonly facilityId?: string;
  /** Row states to return, per table. */
  readonly states: { readonly [T in SignTable]: readonly string[] };
}

/** Every signed row on `chainId` in the given states (both tables), lowest nonce first. */
export async function listRows(q: Q, opts: ListRowsOptions): Promise<SignedRow[]> {
  const paymentWhere: SQL[] = [eq(payments.chainId, opts.chainId), isNotNull(payments.rawSignedTx)];
  const actionWhere: SQL[] = [eq(chainActions.chainId, opts.chainId), isNotNull(chainActions.rawSignedTx)];
  if (opts.facilityId !== undefined) {
    paymentWhere.push(eq(payments.facilityId, opts.facilityId));
    actionWhere.push(eq(chainActions.facilityId, opts.facilityId));
  }
  const p = opts.states.payments.length > 0
    ? await q.select(paymentCols).from(payments).where(and(...paymentWhere, inArray(payments.state, opts.states.payments as never[])))
    : [];
  const a = opts.states.chain_actions.length > 0
    ? await q.select(actionCols).from(chainActions).where(and(...actionWhere, inArray(chainActions.state, opts.states.chain_actions as never[])))
    : [];
  const rows = [...p.map(fromPayment), ...a.map(fromAction)];
  return rows.sort((x, y) => ((x.nonce ?? 0n) < (y.nonce ?? 0n) ? -1 : (x.nonce ?? 0n) > (y.nonce ?? 0n) ? 1 : 0));
}

/** Throws unless `opts` names one chain and one facility (recovery and finality passes are per facility). */
export function assertFacilityScope(opts: { readonly chainId: number; readonly facilityId: string }): void {
  if (!Number.isSafeInteger(opts.chainId) || opts.chainId <= 0) throw new RangeError('chainId must be a positive integer');
  if (typeof opts.facilityId !== 'string' || opts.facilityId === '') throw new RangeError('facilityId is required (contracts name one deployment)');
}

/**
 * Rows grouped per signer (lowercase address; rows without one last), each group lowest nonce first, groups
 * in address order. Recovery and finality process a signer's rows in nonce order, one group at a time.
 */
export function groupBySigner(rows: readonly SignedRow[]): SignedRow[][] {
  const groups = new Map<string, SignedRow[]>();
  for (const row of rows) {
    const key = row.signerAddress?.toLowerCase() ?? '~';
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const byNonce = (x: SignedRow, y: SignedRow) => ((x.nonce ?? 0n) < (y.nonce ?? 0n) ? -1 : (x.nonce ?? 0n) > (y.nonce ?? 0n) ? 1 : 0);
  return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, g]) => [...g].sort(byNonce));
}

/** Every signed, not-yet-included row on `chainId` (both tables), optionally for one facility. */
export async function listOpenRows(q: Q, opts: { chainId: number; facilityId?: string }): Promise<SignedRow[]> {
  return listRows(q, { ...opts, states: OPEN_STATES });
}

export interface Landing {
  readonly from: readonly string[];
  /** The hash that was mined at the row's nonce. */
  readonly txHash: Hex;
  readonly block: bigint;
  /**
   * The mined tx's own signed bytes, when it is not the row's stored version (an earlier version of a fee-bumped tx
   * landed): stored with the hash, so keccak256(raw_signed_tx) = tx_hash still holds for the evidence export.
   */
  readonly rawSignedTx?: Hex;
}

/**
 * Records that `txHash` landed: state INCLUDED, `tx_hash` = the landed hash, `block`. For payments, when the
 * landed hash is not the current `tx_hash` the two swap places: the landed one leaves
 * `superseded_tx_hashes` and the current one joins it, so the array keeps every other hash of the row.
 */
export async function recordLanding(q: Q, target: SignTarget, l: Landing): Promise<boolean> {
  const landed = l.txHash.toLowerCase();
  const updated =
    target.table === 'payments'
      ? await q
          .update(payments)
          .set({
            state: 'INCLUDED',
            block: l.block,
            txHash: landed,
            ...(l.rawSignedTx ? { rawSignedTx: l.rawSignedTx } : {}),
            supersededTxHashes: sql`CASE WHEN ${payments.txHash} = ${landed} THEN ${payments.supersededTxHashes} ELSE array_append(array_remove(${payments.supersededTxHashes}, ${landed}::text), ${payments.txHash}) END`,
          })
          .where(and(paymentKey(target), inArray(payments.state, l.from as never[])))
          .returning({ id: payments.id })
      : await q
          .update(chainActions)
          .set({ state: 'INCLUDED', block: l.block, txHash: landed, ...(l.rawSignedTx ? { rawSignedTx: l.rawSignedTx } : {}) })
          .where(and(actionKey(target), inArray(chainActions.state, l.from as never[])))
          .returning({ id: chainActions.id });
  return updated.length === 1;
}

/**
 * G0-AUDIT (v-4): DROPPED → CANCELLED, naming the foreign tx that consumed the nonce. The caller must have
 * proved at `finalized` that the intent's on-chain effect is absent; the WHERE (and the DB CHECKs) refuse a
 * consumer that is one of the row's own hashes. Payments only (chain actions have no CANCELLED state).
 */
export async function recordCancelled(q: Q, target: SignTarget, c: { consumedBy: Hex }): Promise<boolean> {
  if (target.table !== 'payments') throw new SignTargetError('only payments can be CANCELLED');
  const consumer = c.consumedBy.toLowerCase();
  const updated = await q
    .update(payments)
    .set({ state: 'CANCELLED', nonceConsumedByTxHash: consumer })
    .where(
      and(
        paymentKey(target),
        eq(payments.state, 'DROPPED'),
        isNotNull(payments.txHash),
        ne(payments.txHash, consumer),
        sql`array_position(${payments.supersededTxHashes}, ${consumer}::text) IS NULL`,
      ),
    )
    .returning({ id: payments.id });
  return updated.length === 1;
}

/** `facilities.deployment_id` / `chain_id` of a facility. */
export interface FacilityDeployment {
  readonly deploymentId: string;
  readonly chainId: number;
}

export async function readFacilityDeployment(q: Q, facilityId: string): Promise<FacilityDeployment | null> {
  const rows = await q
    .select({ deploymentId: facilities.deploymentId, chainId: facilities.chainId })
    .from(facilities)
    .where(eq(facilities.facilityId, facilityId));
  const row = rows[0];
  return row ? { deploymentId: row.deploymentId, chainId: Number(row.chainId) } : null;
}

/** The row writes recovery and the finality watcher need; {@link pgSignedRowStore} is the Postgres one. */
export interface SignedRowStore {
  /** The facility's deployment, checked before a pass touches any row. */
  readFacilityDeployment(facilityId: string): Promise<FacilityDeployment | null>;
  listRows(opts: ListRowsOptions): Promise<SignedRow[]>;
  transition(target: SignTarget, t: Transition): Promise<boolean>;
  recordLanding(target: SignTarget, l: Landing): Promise<boolean>;
  recordCancelled(target: SignTarget, c: { consumedBy: Hex }): Promise<boolean>;
}

export function pgSignedRowStore(q: Q): SignedRowStore {
  return {
    readFacilityDeployment: (facilityId) => readFacilityDeployment(q, facilityId),
    listRows: (opts) => listRows(q, opts),
    transition: (target, t) => transition(q, target, t),
    recordLanding: (target, l) => recordLanding(q, target, l),
    recordCancelled: (target, c) => recordCancelled(q, target, c),
  };
}
