/**
 * The orphan safety pause (§9.3, T29): an agent-key use outside the backend must end with Treasury.paused() true.
 * The orphan watch (jobs/orphans.ts) queues one request per orphan log, in the same transaction as the halt reason it
 * raises; this driver runs in every reconcile pass, on its own (whatever else in the pass failed), and is driven by
 * chain state, never by "a tx was signed":
 *
 * - a request is live while the halt it raised or joined is active; resuming that halt closes it (`HALT_CLEARED`),
 *   so a founder + lender unpause is never undone for an orphan an operator has acknowledged;
 * - while Treasury.paused() reads false at the latest block, each pass makes progress on the latest attempt or
 *   starts a fresh one; once it reads true at the latest block nothing more is sent, but the live requests close
 *   (`PAUSED`) only once it reads true at the `safe` block (re-check L2): a pause a reorg drops is sent again;
 * - signer order: the LENDER key first, the AGENT key only as a fallback (the agent key is the one presumed leaked, and
 *   its nonces can be front-run). The worker holds no owner key. Before signing, the signer's `nonces.next_nonce` is
 *   raised to the chain's pending count (DB only, allowed while halted); for the agent key, a use outside the allocator
 *   found there is first recorded as EXTERNAL_AGENT_KEY_USE (jobs/agent-key.ts), never silently absorbed;
 * - failure is never success: a reverted attempt, one mined while the treasury is still unpaused, one whose nonce was
 *   consumed by another tx (replaced, front-run: `nonce_consumed`, recovery's `unresolved`) or one the node does not
 *   hold as executable (a nonce gap) leads to a fresh attempt with a fresh nonce, lender then agent, in the same pass;
 * - fee policy (bounded, never a silent skip): attempts are capped by MAX_SAFETY_FEE_GWEI (default 10 × MAX_FEE_GWEI).
 *   A fresh attempt signs at the current estimate. An attempt still pending on the next pass is re-signed at the same
 *   nonce with both fees raised ≥ 10 % (or to the current estimate if higher), up to the cap, and re-sent; at the cap it
 *   is re-sent as is. An estimate above the cap signs nothing for that signer: an `error` log and a retry next pass;
 * - the stored attempt is DB data (security re-check H1): before it is bumped or re-sent, its bytes must be exactly
 *   this Treasury's pause() (to, calldata, value 0, the deployment chainId, the row's nonce) signed by the row's signer;
 *   anything else is a failed attempt, never re-signed or re-sent, and a fresh attempt follows. feeBump checks the
 *   same binding again (@hogee/chain sender.ts `storedTxRefusal`);
 * - a node that refuses the re-send (insufficient funds, replacement underpriced, txpool full, fee below base fee) or a
 *   refused bump fails that attempt only (H2): a fresh attempt follows in the same pass (lender, then agent), and a
 *   refused bump's bytes are swapped back for the ones the node had accepted, so recovery re-sends those.
 *
 * Attempts are chain_actions rows `safety-pause:<requestId>:<n>` (kind Treasury.pause, ref_id = the request id), on
 * the deployment's first facility (one Treasury per deployment: the pause covers every facility of it). Only this driver
 * signs them: the relay never takes them, and the job-lock waiters do not give way to them (re-check A-1).
 */
import {
  advanceNonce,
  AlreadyMinedError,
  buildPause,
  feeBump,
  FeeCapExceededError,
  iTreasuryAbi,
  readTarget,
  rebroadcastStored,
  replaceSigned,
  shortErrorReason,
  toTxRequest,
  type BroadcastResult,
  type BroadcastStatus,
  type SignedRow,
  type TxRequest,
} from '@hogee/chain';
import { getAddress, keccak256, parseTransaction, recoverTransactionAddress, type Address, type Hex } from 'viem';
import { actionTarget, sendAction, type ActionContext } from '../chain/actions';
import { checkAgentKey } from './agent-key';
import { SAFETY_FEE_MULTIPLIER } from '../config/env';
import { activeHalt } from '../store/halt';
import { poolOf, rows } from '../store/pg';
import { closeSafetyPauses, noteSafetyPause, openSafetyPauses, SAFETY_PAUSE_ID_PREFIX, type SafetyPauseClose, type SafetyPauseRequest } from '../store/safety-pause';
import type { JobDeps } from './deps';

export type AttemptVerdict = 'unsigned' | 'in_flight' | 'stalled' | 'failed';

export interface AttemptFacts {
  readonly signed: boolean;
  readonly nonce: bigint | null;
  /** Receipt of the attempt's current hash, null when the node has none. */
  readonly receipt: 'success' | 'reverted' | null;
  /** The signer's transaction count at `latest` (mined) and at `pending` (mined + executable in the node's pool). */
  readonly minedCount: bigint;
  readonly pendingCount: bigint;
}

/**
 * The latest attempt, judged while Treasury.paused() still reads false (pure):
 * - `unsigned`: it failed before a nonce was used; the next try reuses the row;
 * - `failed`: mined (a revert, or a success the unpaused treasury contradicts) or its nonce was consumed by another tx;
 * - `in_flight`: the node holds it in the signer's executable sequence; it is bumped and re-sent;
 * - `stalled`: not mined, nonce unused, yet not executable at the node (dropped, or behind a nonce gap): re-sent, and a
 *   fresh attempt follows unless that makes it executable.
 */
export function judgeAttempt(f: AttemptFacts): AttemptVerdict {
  if (!f.signed || f.nonce === null) return 'unsigned';
  if (f.receipt !== null || f.minedCount > f.nonce) return 'failed';
  return f.pendingCount > f.nonce ? 'in_flight' : 'stalled';
}

/** The safety-pause fee cap of these deps (MAX_SAFETY_FEE_GWEI; default 10 × MAX_FEE_GWEI). */
export function safetyFeeCapWei(config: JobDeps['config']): bigint {
  return config.maxSafetyFeeWei ?? config.maxFeeWei * SAFETY_FEE_MULTIPLIER;
}

export type PauseRole = 'lender' | 'agent';

export interface PauseAttempt {
  readonly id: string;
  readonly role: PauseRole;
  /** `sent` / `bumped` / `rebroadcast`: executable at the node after this pass; `failed`: not. */
  readonly action: 'sent' | 'bumped' | 'rebroadcast' | 'failed';
  readonly status?: BroadcastStatus;
  readonly txHash?: Hex;
  readonly nonce?: string;
  readonly detail?: string;
}

export interface SafetyPauseReport {
  /** Live requests (their halt is active) at the start of the pass. */
  readonly live: number;
  /** Treasury.paused() at latest after the pass; null when no live request needed the read. */
  readonly paused: boolean | null;
  /** Treasury.paused() at the safe block, read once `paused` is true (requests close only then); else null. */
  readonly pausedSafe?: boolean | null;
  readonly attempts: readonly PauseAttempt[];
  readonly closed: readonly { readonly id: string; readonly reason: SafetyPauseClose }[];
  readonly error?: string;
}

const PAUSE_ROLES: readonly PauseRole[] = ['lender', 'agent'];

async function readPaused(d: JobDeps, blockTag: 'latest' | 'safe'): Promise<boolean> {
  return d.client.readContract({ address: d.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: 'paused', blockTag });
}

async function txCount(d: JobDeps, address: Address, blockTag: 'latest' | 'pending'): Promise<bigint> {
  return BigInt(await d.client.getTransactionCount({ address, blockTag }));
}

async function receiptStatus(d: JobDeps, hash: Hex): Promise<'success' | 'reverted' | null> {
  try {
    return (await d.client.getTransactionReceipt({ hash })).status;
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'TransactionReceiptNotFoundError') return null;
    throw error;
  }
}

function roleOf(d: JobDeps, signer: string | null): PauseRole | null {
  if (!signer) return null;
  const a = getAddress(signer);
  return PAUSE_ROLES.find((role) => getAddress(d.signers[role].address) === a) ?? null;
}

/** Raises the signer's next_nonce to the chain's pending count (DB only; never lowers it). */
async function raiseNonce(d: JobDeps, address: Address): Promise<void> {
  const pending = await txCount(d, address, 'pending');
  await d.db.transaction((tx) => advanceNonce(tx, { signer: address, chainId: d.deployment.chainId }, pending));
}

async function executable(d: JobDeps, signer: Address, nonce: bigint): Promise<boolean> {
  return (await txCount(d, signer, 'pending')) > nonce;
}

/** The attempt row by id (its facility is whichever this deployment's first facility was when it was created). */
async function readAttempt(d: JobDeps, id: string): Promise<SignedRow | null> {
  const [row] = await rows<{ facility_id: string }>(poolOf(d.db), `select facility_id from chain_actions where id = $1 and kind = 'Treasury.pause' limit 1`, [id]);
  return row ? readTarget(d.db, actionTarget(row.facility_id, id)) : null;
}

async function factsOf(d: JobDeps, row: SignedRow): Promise<AttemptFacts> {
  if (!row.rawSignedTx || row.nonce === null || !row.signerAddress) return { signed: false, nonce: null, receipt: null, minedCount: 0n, pendingCount: 0n };
  const signer = getAddress(row.signerAddress);
  const [receipt, minedCount, pendingCount] = await Promise.all([
    receiptStatus(d, (row.txHash ?? keccak256(row.rawSignedTx)) as Hex),
    txCount(d, signer, 'latest'),
    txCount(d, signer, 'pending'),
  ]);
  return { signed: true, nonce: row.nonce, receipt, minedCount, pendingCount };
}

/**
 * Null when the attempt row holds exactly `expected` (this Treasury's pause(), value 0) for `chainId` at the row's nonce,
 * signed by the row's signer; else why not (H1: the row is DB data, and a DB writer can swap its bytes). Pure but async
 * (signature recovery). Reasons never quote values.
 */
export async function pauseTxMismatch(row: SignedRow, expected: TxRequest, chainId: number): Promise<string | null> {
  if (!row.rawSignedTx || row.nonce === null || !row.signerAddress) return 'no stored signed tx';
  if (row.chainId !== chainId) return 'the row is for another chain';
  let tx: ReturnType<typeof parseTransaction>;
  let from: Address;
  try {
    tx = parseTransaction(row.rawSignedTx);
    from = await recoverTransactionAddress({ serializedTransaction: row.rawSignedTx as never });
  } catch {
    return 'not a signed transaction';
  }
  if (tx.type !== 'eip1559') return 'not an EIP-1559 tx';
  if (tx.chainId !== chainId) return 'signed for another chain';
  if (!tx.to || getAddress(tx.to) !== getAddress(expected.to)) return 'to is not the Treasury';
  if ((tx.data ?? '0x').toLowerCase() !== expected.data.toLowerCase()) return 'calldata is not pause()';
  if ((tx.value ?? 0n) !== 0n) return 'it moves value';
  if (tx.nonce === undefined || BigInt(tx.nonce) !== row.nonce) return 'its nonce is not the row nonce';
  if (getAddress(from) !== getAddress(row.signerAddress)) return 'not signed by the row signer';
  return null;
}

/** After a bump the node refused: the bytes it had accepted go back on the row (no new signature), so recovery re-sends those. */
async function restoreAccepted(d: JobDeps, row: SignedRow, accepted: Hex, bumpedHash: Hex): Promise<boolean> {
  if (row.nonce === null) return false;
  const nonce = row.nonce;
  try {
    await d.db.transaction((tx) => replaceSigned(tx, row.target, { rawSignedTx: accepted, txHash: keccak256(accepted), nonce, previousTxHash: bumpedHash }));
    return true;
  } catch (error: unknown) {
    d.log.error('treasury_pause_restore_failed', { id: row.target.id, error });
    return false;
  }
}

/**
 * Bumps (in flight) and re-sends the latest attempt. True when it is executable at the node afterwards. Never throws for
 * a refusal (H1 binding, fee bump, node): the attempt is reported `failed` and the caller makes a fresh one.
 */
async function resend(d: JobDeps, ctx: ActionContext, row: SignedRow, verdict: 'in_flight' | 'stalled', out: PauseAttempt[]): Promise<boolean> {
  const role = roleOf(d, row.signerAddress);
  if (!role || row.nonce === null || !row.signerAddress || !row.rawSignedTx) return false;
  const signer = getAddress(row.signerAddress);
  const accepted = row.rawSignedTx;
  const base = { id: row.target.id, role, nonce: row.nonce.toString() };
  const fail = (detail: string): false => {
    const attempt: PauseAttempt = { ...base, action: 'failed', detail };
    out.push(attempt);
    d.log.error('treasury_pause_failed', { ...attempt });
    return false;
  };
  const mismatch = await pauseTxMismatch(row, toTxRequest(buildPause(), d.deployment.contracts), d.deployment.chainId);
  if (mismatch) return fail(`stored tx is not this Treasury's pause() (${mismatch}); not re-signed or re-sent`);
  let action: 'bumped' | 'rebroadcast' = 'rebroadcast';
  let detail: string | undefined;
  let bumpedHash: Hex | null = null;
  if (verdict === 'in_flight') {
    try {
      const bumped = await feeBump(d.db, { target: row.target, account: d.signers[role], client: d.client, capWei: ctx.capWei, chainId: d.deployment.chainId, deployment: d.deployment });
      bumpedHash = bumped.txHash;
      action = 'bumped';
    } catch (error: unknown) {
      if (error instanceof AlreadyMinedError) {
        out.push({ ...base, action: 'rebroadcast', detail: 'already mined; judged next pass' });
        return true;
      }
      if (!(error instanceof FeeCapExceededError)) return fail(`fee bump refused: ${shortErrorReason(error)}`);
      detail = 'at MAX_SAFETY_FEE_GWEI: re-sent without a bump';
    }
  }
  let sent: BroadcastResult;
  try {
    sent = await rebroadcastStored(d.db, d.client, row.target);
  } catch (error: unknown) {
    const restored = bumpedHash === null ? null : await restoreAccepted(d, row, accepted, bumpedHash);
    const kept = restored === null ? '' : restored ? '; the row keeps the bytes the node had accepted' : '; the refused bump is still stored';
    return fail(`the node refused the re-send: ${shortErrorReason(error)}${kept}`);
  }
  const ok = sent.status !== 'nonce_consumed' && (await executable(d, signer, row.nonce));
  const attempt: PauseAttempt = { ...base, action: ok ? action : 'failed', status: sent.status, txHash: sent.txHash, ...(detail ? { detail } : {}) };
  out.push(attempt);
  d.log.error(ok ? 'treasury_pause_resent' : 'treasury_pause_failed', { ...attempt });
  return ok;
}

/** A fresh attempt: lender first, the agent if the lender's cannot be made executable. */
async function freshAttempt(
  d: JobDeps,
  ctx: ActionContext,
  req: SafetyPauseRequest,
  facilityIds: readonly string[],
  reuse: string | null,
  out: PauseAttempt[],
): Promise<void> {
  const facilityId = facilityIds[0] as string;
  const pool = poolOf(d.db);
  let n = req.attempts;
  let id = reuse;
  for (const role of PAUSE_ROLES) {
    if (id === null) n += 1;
    const attemptId = id ?? `${SAFETY_PAUSE_ID_PREFIX}${req.id}:${n}`;
    id = attemptId;
    const account = d.signers[role];
    try {
      if (role === 'agent') await checkAgentKey(d, facilityIds); // never absorb an unrecorded agent-key use
      await raiseNonce(d, account.address);
      const call = buildPause();
      const request = toTxRequest(call, d.deployment.contracts);
      const { stored, sent } = await sendAction(ctx, { facilityId, id: attemptId, kind: call.kind, refId: req.id, request, requestJson: { reason: req.reason, request: req.id } }, account);
      await noteSafetyPause(pool, req.id, { attempts: n, lastAttemptId: attemptId, lastError: null });
      const ok = sent.status !== 'nonce_consumed' && (await executable(d, stored.signer, stored.nonce));
      const detail = ok ? undefined : sent.status === 'nonce_consumed' ? 'nonce consumed by another tx' : 'not executable at the node (nonce gap)';
      const attempt: PauseAttempt = { id: attemptId, role, action: ok ? 'sent' : 'failed', status: sent.status, txHash: stored.txHash, nonce: stored.nonce.toString(), ...(detail ? { detail } : {}) };
      out.push(attempt);
      d.log.error(ok ? 'treasury_pause_sent' : 'treasury_pause_failed', { requestId: req.id, reason: req.reason, ...attempt });
      if (ok) return;
      id = null; // signed: never re-sign that row
    } catch (error: unknown) {
      const detail = error instanceof FeeCapExceededError ? `fee estimate ${error.neededWei} wei is above MAX_SAFETY_FEE_GWEI (${error.capWei} wei)` : shortErrorReason(error);
      out.push({ id: attemptId, role, action: 'failed', detail });
      d.log.error('treasury_pause_failed', { requestId: req.id, reason: req.reason, id: attemptId, role, detail });
      await noteSafetyPause(pool, req.id, { attempts: n, lastAttemptId: attemptId, lastError: detail });
      const row = await readTarget(d.db, actionTarget(facilityId, attemptId)).catch(() => null);
      if (row?.rawSignedTx) id = null; // signed before it failed (the broadcast was refused): a new row next
    }
  }
}

async function progress(d: JobDeps, req: SafetyPauseRequest, facilityIds: readonly string[], out: PauseAttempt[]): Promise<void> {
  const ctx: ActionContext = { db: d.db, client: d.client, deployment: d.deployment, chainId: d.deployment.chainId, capWei: safetyFeeCapWei(d.config) };
  const latest = req.lastAttemptId ? await readAttempt(d, req.lastAttemptId) : null;
  let reuse: string | null = null;
  if (latest) {
    const verdict = judgeAttempt(await factsOf(d, latest));
    if (verdict === 'unsigned') reuse = latest.target.id;
    if ((verdict === 'in_flight' || verdict === 'stalled') && (await resend(d, ctx, latest, verdict, out))) return;
  }
  await freshAttempt(d, ctx, req, facilityIds, reuse, out);
}

/** One pass over the open safety-pause requests. Never throws: a failure is in `error` and retried next pass. */
export async function driveSafetyPause(d: JobDeps, facilityIds: readonly string[]): Promise<SafetyPauseReport> {
  const pool = poolOf(d.db);
  const attempts: PauseAttempt[] = [];
  const closed: { id: string; reason: SafetyPauseClose }[] = [];
  const close = async (reqs: readonly SafetyPauseRequest[], reason: SafetyPauseClose) => {
    await closeSafetyPauses(pool, reqs.map((r) => r.id), reason);
    closed.push(...reqs.map((r) => ({ id: r.id, reason })));
  };
  let live: SafetyPauseRequest[] = [];
  let paused: boolean | null = null;
  let pausedSafe: boolean | null = null;
  try {
    const open = await openSafetyPauses(pool);
    if (open.length === 0) return { live: 0, paused, attempts, closed };
    const halt = await activeHalt(pool);
    live = open.filter((r) => halt !== null && r.haltId === halt.id);
    await close(open.filter((r) => !live.includes(r)), 'HALT_CLEARED');
    const [first] = live;
    if (!first) return { live: 0, paused, attempts, closed };
    paused = await readPaused(d, 'latest');
    const facilityId = facilityIds[0];
    if (!paused && !facilityId) {
      d.log.error('treasury_pause_failed', { requestId: first.id, detail: 'this deployment has no facility row to sign through' });
      await noteSafetyPause(pool, first.id, { lastError: 'no facility row for this deployment' });
    } else if (!paused && facilityId) {
      await progress(d, first, facilityIds, attempts);
      paused = await readPaused(d, 'latest');
    }
    if (paused) pausedSafe = await readPaused(d, 'safe');
    if (paused && pausedSafe) {
      await close(live, 'PAUSED');
      d.log.warn('treasury_pause_confirmed', { requests: live.map((r) => r.id) });
    } else if (paused) {
      d.log.warn('treasury_pause_unconfirmed', { requests: live.map((r) => r.id), action: 'closed once Treasury.paused() reads true at the safe block' });
    } else {
      // A pause just sent is usually not mined yet: that is a warning. No executable attempt at all is an error.
      const pending = attempts.some((a) => a.action !== 'failed');
      const fields = { requests: live.map((r) => r.id), attempts: attempts.map((a) => `${a.role}:${a.action}`), action: 'checked again next reconcile pass' };
      if (pending) d.log.warn('treasury_pause_pending', fields);
      else d.log.error('treasury_still_unpaused', fields);
    }
    return { live: live.length, paused, pausedSafe, attempts, closed };
  } catch (error: unknown) {
    const detail = shortErrorReason(error);
    d.log.error('safety_pause_pass_failed', { error, requests: live.map((r) => r.id) });
    if (live[0]) await noteSafetyPause(pool, live[0].id, { lastError: detail }).catch(() => undefined);
    return { live: live.length, paused, pausedSafe, attempts, closed, error: detail };
  }
}
