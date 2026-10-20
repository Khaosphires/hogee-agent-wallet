/**
 * Orphan watch (§9.3, T29): every agent-key effect read at `finalized` must match one of this deployment's payment
 * rows the worker signed, with the same intent id, the same rationaleHash, and the row's own signed bytes: its
 * `raw_signed_tx` must hash to the event's tx and recover to the worker's agent key (security re-check M3: tx hash,
 * intent id and rationale hash of an orphan are public, so a row a DB writer fabricated from them whitelists nothing
 * without the bytes behind them). A superseded hash alone no longer whitelists (its bytes are not stored); the worker
 * never fee-bumps a payment today. Matching rows:
 * - Treasury `Spent` against a SPEND row (intent_id = spendId);
 * - MilestoneEscrow `MilestoneFunded` against a FUND_MILESTONE row (intent_id = fundMilestoneIntentId(orderId, idx,
 *   amountMinor, fundedTotalMinor)), which the agent-actions job inserts before it signs; a funding without its row is
 *   an orphan. `MilestoneReleased` is not judged on its own: releaseMilestone needs the founder's signature and reverts
 *   MilestoneLocked for the agent, and an autoRelease happens inside a funding tx that is judged already.
 * Anything else means the agent key moved money outside the backend: halt (or add the reason to the active halt),
 * and queue a safety-pause request keyed by the orphan log (`orphan:<txHash>:<logIndex>`) that reconcile drives until
 * Treasury.paused() reads true (jobs/safety-pause.ts; tighten-only, so allowed while halted). `OwnerSpent` without an
 * OWNER_SPEND row is the founder's own fallback relayed elsewhere: alert only (G0-REVIEW H4). Any OWNER_SPEND row of
 * the intent explains it (the founder signed it, not the agent), including the `adopt-owner:` row settle-adopt.ts
 * records when a third party landed a copy of the relayer's call first (audit run-4). Rows of every facility
 * of the deployment count, and the alert trace goes to every facility (one Treasury per deployment).
 *
 * Each watched contract (Treasury; MilestoneEscrow when the manifest has one) has its own `log_checkpoints` cursor
 * (contract, chainId) at `finalized`, advanced in the SAME transaction that records the halt reason and the pause
 * request, so a crash can neither lose an orphan nor double-handle a chunk. A contract whose poll fails is reported
 * and retried next pass; it does not stop the other contract's poll.
 */
import { fundMilestoneIntentId, pollLogs, shortErrorReason, type ContractName, type DecodedHogeeLog, type DeploymentContracts, type LogCursor, type LogReader, type PollResult } from '@hogee/chain';
import { getAddress, keccak256, recoverTransactionAddress, type Address, type Hex } from 'viem';
import type { Logger } from '../runtime/log';
import { raiseHalt } from '../store/halt';
import { inTransaction, rows, type Pg } from '../store/pg';
import { queueSafetyPause } from '../store/safety-pause';
import { appendTrace } from '../store/trace';
import type { Pool, PoolClient } from 'pg';

export type OrphanEvent = 'Spent' | 'OwnerSpent' | 'MilestoneFunded';

export interface Orphan {
  readonly event: OrphanEvent;
  readonly reason: 'NO_ROW' | 'RATIONALE_MISMATCH' | 'FOREIGN_TX';
  /** The payments.intent_id the event should match (spendId; or the FUND_MILESTONE key for a funding). */
  readonly intentId: Hex;
  readonly txHash: Hex;
  readonly blockNumber: bigint;
  readonly logIndex: number;
  readonly amountMinor: bigint;
  /** MilestoneFunded only. */
  readonly orderId?: Hex;
  readonly idx?: number;
}

/** The safety-pause request id of an orphan: one per orphan log, so every orphan gets its own pause. */
export const orphanPauseId = (o: Pick<Orphan, 'txHash' | 'logIndex'>): string => `orphan:${o.txHash.toLowerCase()}:${o.logIndex}`;

/** `log_checkpoints` cursor on plain pg; `client()` is the open chunk transaction (for the handler's writes). */
export function pgLogCursorTx(pool: Pool, key: { contract: Address; chainId: number; startBlock: bigint }): LogCursor & { client(): PoolClient } {
  const contract = getAddress(key.contract).toLowerCase();
  const seed = (key.startBlock > 0n ? key.startBlock : 1n) - 1n;
  let current: PoolClient | null = null;
  return {
    finalizedOnly: true,
    client() {
      if (!current) throw new Error('no open log chunk');
      return current;
    },
    async step(fn) {
      return inTransaction(pool, async (c) => {
        current = c;
        try {
          await c.query('insert into log_checkpoints (contract, chain_id, last_block) values ($1, $2, $3) on conflict do nothing', [contract, key.chainId, seed.toString()]);
          const [row] = await rows<{ last_block: string }>(c, 'select last_block::text as last_block from log_checkpoints where contract = $1 and chain_id = $2 for update', [contract, key.chainId]);
          if (!row) throw new Error('log checkpoint row missing after insert');
          const last = BigInt(row.last_block);
          const out = await fn(last, null);
          if (!out) return null;
          if (out.to < last) throw new Error('log checkpoint must not move backwards');
          await c.query('update log_checkpoints set last_block = $3, updated_at = now() where contract = $1 and chain_id = $2', [contract, key.chainId, out.to.toString()]);
          return out.value;
        } finally {
          current = null;
        }
      });
    },
  };
}

interface Candidate {
  facility_id: string;
  id: string;
  kind: string;
  rationale_hash: string | null;
  tx_hash: string | null;
  superseded_tx_hashes: string[] | null;
  raw_signed_tx: string | null;
}

/** Whose payment rows may explain an event: this deployment's facilities, and the worker's own agent key. */
export interface OrphanScope {
  readonly facilityIds: readonly string[];
  readonly agent: Address;
}

/** The payment kind each judged event must match. */
const KIND_OF: Readonly<Record<OrphanEvent, string>> = { Spent: 'SPEND', OwnerSpent: 'OWNER_SPEND', MilestoneFunded: 'FUND_MILESTONE' };

interface EventFacts {
  readonly event: OrphanEvent;
  readonly intentId: Hex;
  readonly rationaleHash: Hex | undefined;
  readonly amountMinor: bigint;
  readonly extra: Pick<Orphan, 'orderId' | 'idx'>;
}

function factsOf(log: DecodedHogeeLog): EventFacts | null {
  if (log.eventName === 'MilestoneFunded') {
    const a = log.args as { orderId: Hex; idx: number; amountMinor: bigint; fundedTotalMinor: bigint; rationaleHash: Hex };
    const intentId = fundMilestoneIntentId({ orderId: a.orderId, idx: Number(a.idx), amountMinor: a.amountMinor, cumulativeAfterMinor: a.fundedTotalMinor });
    return { event: 'MilestoneFunded', intentId, rationaleHash: a.rationaleHash, amountMinor: a.amountMinor, extra: { orderId: a.orderId, idx: Number(a.idx) } };
  }
  if (log.eventName !== 'Spent' && log.eventName !== 'OwnerSpent') return null;
  const a = log.args as { spendId: Hex; amountMinor: bigint; rationaleHash?: Hex };
  return { event: log.eventName, intentId: a.spendId, rationaleHash: a.rationaleHash, amountMinor: a.amountMinor, extra: {} };
}

const RAW_TX_RE = /^0x[0-9a-fA-F]+$/;

/** True when `raw` is the signed tx `txHash` (keccak256 of the bytes) and its signature recovers to `agent`. */
async function isAgentTx(raw: string | null, txHash: Hex, agent: Address): Promise<boolean> {
  if (!raw || !RAW_TX_RE.test(raw) || keccak256(raw as Hex).toLowerCase() !== txHash) return false;
  try {
    return getAddress(await recoverTransactionAddress({ serializedTransaction: raw as never })) === getAddress(agent);
  } catch {
    return false;
  }
}

/** Orphan, or null when a payment row of `scope.facilityIds` explains the event (or it is not an agent effect). */
export async function classifyOrphan(q: Pg, scope: OrphanScope, log: DecodedHogeeLog): Promise<Orphan | null> {
  const f = factsOf(log);
  if (!f) return null;
  const txHash = (log.transactionHash ?? '0x').toLowerCase() as Hex;
  const kind = KIND_OF[f.event];
  const found = await rows<Candidate>(
    q,
    'select facility_id, id, kind, rationale_hash, tx_hash, superseded_tx_hashes, raw_signed_tx from payments where facility_id = any($1) and kind = $2 and intent_id = $3',
    [scope.facilityIds, kind, f.intentId.toLowerCase()],
  );
  const base = { event: f.event, intentId: f.intentId, txHash, blockNumber: log.blockNumber ?? 0n, logIndex: log.logIndex ?? 0, amountMinor: f.amountMinor, ...f.extra };
  if (found.length === 0) return { ...base, reason: 'NO_ROW' };
  if (kind === 'OWNER_SPEND') return null;
  const sameRationale = found.filter((r) => (r.rationale_hash ?? '').toLowerCase() === (f.rationaleHash ?? '').toLowerCase());
  if (sameRationale.length === 0) return { ...base, reason: 'RATIONALE_MISMATCH' };
  for (const r of sameRationale) if (await isAgentTx(r.raw_signed_tx, txHash, scope.agent)) return null;
  return { ...base, reason: 'FOREIGN_TX' };
}

export interface OrphanPass {
  /** One finalized polling round per watched contract that polled without error. */
  readonly polls: Readonly<Partial<Record<ContractName, PollResult>>>;
  readonly orphans: readonly Orphan[];
  /** `<contract>: <reason>` per contract whose poll failed (retried next pass; its cursor stayed put). */
  readonly errors: readonly string[];
}

export interface OrphanDeps {
  readonly pool: Pool;
  readonly client: LogReader;
  /** The deployment's contracts: Treasury always, MilestoneEscrow when the manifest has one (final-1). */
  readonly contracts: Pick<DeploymentContracts, 'Treasury' | 'MilestoneEscrow'>;
  readonly chainId: number;
  readonly startBlock: bigint;
  readonly facilityIds: readonly string[];
  /** The worker's agent address: a payment row explains an event only with bytes this key signed. */
  readonly agent: Address;
  readonly log: Logger;
}

const describeOrphan = (o: Orphan): string =>
  o.event === 'MilestoneFunded'
    ? `MilestoneFunded order ${o.orderId} #${o.idx} (${o.amountMinor} minor, tx ${o.txHash})`
    : `${o.event} ${o.intentId} (${o.amountMinor} minor, tx ${o.txHash})`;

/** Halt reason + pause request + an alert trace on every facility, all in the chunk's transaction. */
async function recordOrphan(c: PoolClient, d: OrphanDeps, orphan: Orphan): Promise<void> {
  const detail = { ...orphan, blockNumber: orphan.blockNumber.toString(), amountMinor: orphan.amountMinor.toString() };
  const { halt } = await raiseHalt(c, d.log, 'ORPHAN_SPEND', detail);
  await queueSafetyPause(c, { id: orphanPauseId(orphan), haltId: halt.id, reason: 'ORPHAN_SPEND', detail });
  for (const facilityId of d.facilityIds) {
    await appendTrace(c, {
      facilityId,
      traceId: `alert:orphan:${orphan.txHash}:${orphan.logIndex}`,
      actor: 'reconciler',
      kind: 'ALERT',
      reasonCode: 'ORPHAN_SPEND',
      summary: `${describeOrphan(orphan)} matches no payment row (${orphan.reason}); worker halted, treasury pause queued`,
      refs: { txHash: orphan.txHash },
    });
  }
}

async function watchContract(d: OrphanDeps, source: ContractName, address: Address, orphans: Orphan[]): Promise<PollResult> {
  const cursor = pgLogCursorTx(d.pool, { contract: address, chainId: d.chainId, startBlock: d.startBlock });
  return pollLogs(d.client, { address, source, tag: 'finalized', cursor }, async (logs) => {
    const c = cursor.client();
    for (const log of logs) {
      const orphan = await classifyOrphan(c, { facilityIds: d.facilityIds, agent: d.agent }, log);
      if (!orphan) continue;
      orphans.push(orphan);
      if (orphan.event === 'OwnerSpent') {
        d.log.warn('orphan_owner_spend', { ...orphan, action: 'alert only: the founder may spend through the owner fallback' });
        continue;
      }
      await recordOrphan(c, d, orphan);
    }
  });
}

/** One finalized polling round per watched contract; orphans halt the worker and queue a pause, in the chunk's tx. */
export async function watchOrphans(d: OrphanDeps): Promise<OrphanPass> {
  const targets: [ContractName, Address][] = [['Treasury', d.contracts.Treasury.address]];
  if (d.contracts.MilestoneEscrow) targets.push(['MilestoneEscrow', d.contracts.MilestoneEscrow.address]);
  const orphans: Orphan[] = [];
  const polls: Partial<Record<ContractName, PollResult>> = {};
  const errors: string[] = [];
  for (const [source, address] of targets) {
    try {
      polls[source] = await watchContract(d, source, address, orphans);
    } catch (error: unknown) {
      d.log.error('orphan_watch_contract_failed', { contract: source, error });
      errors.push(`${source}: ${shortErrorReason(error)}`);
    }
  }
  return { polls, orphans, errors };
}
