/**
 * Log watcher (§6.1, §9.1): `getLogs` in chunks of ≤ 10 blocks (Alchemy free tier) up to a block tag —
 * `finalized` for settlement and evidence, `safe` for the UI — decoded with the generated ABIs.
 *
 * Restart safety: each chunk runs in ONE db transaction that locks the `log_checkpoints` row (contract,
 * chainId), reads the logs, runs the handler with that transaction, and advances `last_block`. A crash
 * before COMMIT rolls back both the handler's writes and the checkpoint, so the chunk is read again; handler
 * effects outside the db (payouts) must be idempotent themselves (§9.1 idempotency keys).
 *
 * `log_checkpoints` has one row per (contract, chainId), so only ONE consumer per contract can own the db
 * checkpoint (the `finalized` settlement watcher). Other consumers (the `safe` UI feed) use
 * {@link memoryLogCursor} or {@link readLogs}. The checkpoint stores no block hash, so a reorg below it
 * would go unnoticed: {@link pollLogs} refuses any tag but `finalized` on a db cursor.
 *
 * Provider output is checked before it is decoded or committed: every log must come from the requested
 * address and lie in the requested block range, else the chunk fails (and is read again next round). With a
 * `source` (the contract at that address), every decoded event must also be one that contract emits
 * (events.ts HOGEE_EVENT_SOURCES): SaleRecorded only from SalesOracle, the milestone events only from
 * MilestoneEscrow, everything else but PlanCommitted / FounderKeyRegistered only from Treasury. A full feed
 * polls every address of hogeeWatchTargets(deployment), or reads them all at once with readDeploymentLogs.
 */
import { logCheckpoints, type Db, type DbTx } from '@hogee/db';
import { and, eq } from 'drizzle-orm';
import { getAddress, parseEventLogs, type Address, type Log, type ParseEventLogsReturnType } from 'viem';
import type { ContractName, DeploymentContracts } from './deployments';
import { redactError } from './errors';
import { emitsEvent, hogeeWatchTargets } from './events';
import { iTreasuryAbi } from './generated';

export type WatchTag = 'safe' | 'finalized' | 'latest';

/** Alchemy free tier allows 10-block `eth_getLogs` ranges. */
export const DEFAULT_LOG_CHUNK = 10n;

/** Every Hogee event (all four ABIs inherit IHogeeEvents, so the Treasury ABI has them all). */
export const hogeeEventAbi = iTreasuryAbi;
export type DecodedHogeeLog = ParseEventLogsReturnType<typeof hogeeEventAbi>[number];

export interface BlockRange {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
}

function checkChunk(size: bigint): void {
  if (typeof size !== 'bigint' || size < 1n) throw new RangeError('chunk size must be a positive bigint');
}

/** The next inclusive range after `lastProcessed`, at most `size` blocks, not past `head`; null when caught up. */
export function nextChunk(lastProcessed: bigint, head: bigint, size: bigint = DEFAULT_LOG_CHUNK): BlockRange | null {
  checkChunk(size);
  const fromBlock = lastProcessed + 1n;
  if (fromBlock > head) return null;
  const end = fromBlock + size - 1n;
  return { fromBlock, toBlock: end < head ? end : head };
}

/** Splits [from, to] (inclusive) into consecutive ranges of at most `size` blocks. */
export function planChunks(from: bigint, to: bigint, size: bigint = DEFAULT_LOG_CHUNK): BlockRange[] {
  checkChunk(size);
  const ranges: BlockRange[] = [];
  let last = from - 1n;
  for (let r = nextChunk(last, to, size); r; r = nextChunk(last, to, size)) {
    ranges.push(r);
    last = r.toBlock;
  }
  return ranges;
}

/** Like {@link planChunks} but newest first (recovery searches backwards from the head). */
export function planChunksBackward(from: bigint, to: bigint, size: bigint = DEFAULT_LOG_CHUNK): BlockRange[] {
  return planChunks(from, to, size).reverse();
}

// ---- cursors ---------------------------------------------------------------------------------------

export class LogWatchError extends Error {
  override readonly name = 'LogWatchError';
}

export interface LogCursor {
  /**
   * true for a durable cursor that stores no block hash ({@link pgLogCursor}): it may only follow
   * `finalized`, since a reorgable tag would commit logs it never revisits.
   */
  readonly finalizedOnly?: boolean;
  /**
   * Runs one chunk with the cursor locked. `fn` gets the last processed block and the db transaction
   * (null for memory cursors) and returns the new last block, or null for "nothing to do".
   */
  step<T>(fn: (lastProcessed: bigint, tx: DbTx | null) => Promise<{ to: bigint; value: T } | null>): Promise<T | null>;
}

export interface CheckpointKey {
  readonly contract: Address;
  readonly chainId: number;
}

/**
 * Checkpoint in `log_checkpoints`. `startBlock` (the deployment block) seeds a missing row with
 * last_block = startBlock − 1; block 0 (genesis) has no logs, so a startBlock of 0 is treated as 1.
 */
export function pgLogCursor(db: Db, key: CheckpointKey & { startBlock: bigint }): LogCursor {
  const contract = getAddress(key.contract).toLowerCase();
  const where = and(eq(logCheckpoints.contract, contract), eq(logCheckpoints.chainId, key.chainId));
  const seed = (key.startBlock > 0n ? key.startBlock : 1n) - 1n;
  return {
    finalizedOnly: true,
    async step(fn) {
      return db.transaction(async (tx) => {
        await tx.insert(logCheckpoints).values({ contract, chainId: key.chainId, lastBlock: seed }).onConflictDoNothing();
        const rows = await tx.select({ last: logCheckpoints.lastBlock }).from(logCheckpoints).where(where).for('update');
        const last = rows[0]?.last;
        if (last === undefined) throw new Error('log checkpoint row missing after insert');
        const out = await fn(last, tx);
        if (!out) return null;
        if (out.to < last) throw new Error('log checkpoint must not move backwards');
        await tx.update(logCheckpoints).set({ lastBlock: out.to }).where(where);
        return out.value;
      });
    },
  };
}

/** In-process cursor (the `safe` UI feed, tests). Not restart-safe by design. */
export function memoryLogCursor(startBlock: bigint): LogCursor {
  let last = (startBlock > 0n ? startBlock : 1n) - 1n;
  let busy = Promise.resolve();
  return {
    async step(fn) {
      const run = busy.then(async () => {
        const out = await fn(last, null);
        if (!out) return null;
        last = out.to;
        return out.value;
      });
      busy = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

/** Reads the db checkpoint without locking (null before the first chunk). */
export async function readCheckpoint(db: Db | DbTx, key: CheckpointKey): Promise<bigint | null> {
  const rows = await db
    .select({ last: logCheckpoints.lastBlock })
    .from(logCheckpoints)
    .where(and(eq(logCheckpoints.contract, getAddress(key.contract).toLowerCase()), eq(logCheckpoints.chainId, key.chainId)));
  return rows[0]?.last ?? null;
}

// ---- reading ---------------------------------------------------------------------------------------

export interface LogReader {
  getBlock(args: { blockTag: WatchTag }): Promise<{ number: bigint | null }>;
  getLogs(args: { address: Address; fromBlock: bigint; toBlock: bigint }): Promise<Log[]>;
}

/** Throws unless every log is from `address` and inside `range` (a broken or hostile provider). */
export function assertLogsFrom(logs: readonly Log[], address: Address, range: BlockRange): void {
  const want = getAddress(address);
  for (const log of logs) {
    if (typeof log.address !== 'string' || getAddress(log.address) !== want) throw new LogWatchError('getLogs returned a log from another address');
    const block = log.blockNumber;
    if (block === null || block < range.fromBlock || block > range.toBlock) throw new LogWatchError('getLogs returned a log outside the requested range');
  }
}

/**
 * Decodes raw logs with the Hogee event ABI; logs that match no Hogee event are dropped. With `source`, throws
 * LogWatchError unless every decoded event is one that contract emits.
 */
export function decodeHogeeLogs(logs: readonly Log[], source?: ContractName): DecodedHogeeLog[] {
  const decoded = parseEventLogs({ abi: hogeeEventAbi, logs: logs as Log[] });
  if (source === undefined) return decoded;
  for (const log of decoded) {
    if (!emitsEvent(source, log.eventName)) throw new LogWatchError(`${log.eventName} is not emitted by ${source}`);
  }
  return decoded;
}

/** Block number at `tag` (`safe` / `finalized` / `latest`). RPC errors are rethrown redacted (errors.ts). */
export async function headAt(client: Pick<LogReader, 'getBlock'>, tag: WatchTag): Promise<bigint> {
  let block: { number: bigint | null };
  try {
    block = await client.getBlock({ blockTag: tag });
  } catch (error: unknown) {
    throw redactError(error);
  }
  if (block.number === null) throw new Error(`no block number at tag ${tag}`);
  return block.number;
}

/** Stateless chunked read of [fromBlock, toBlock] for one contract, decoded (and checked against `source`, if given). */
export async function readLogs(
  client: Pick<LogReader, 'getLogs'>,
  opts: { address: Address; fromBlock: bigint; toBlock: bigint; chunkSize?: bigint; source?: ContractName },
): Promise<DecodedHogeeLog[]> {
  const out: DecodedHogeeLog[] = [];
  for (const r of planChunks(opts.fromBlock, opts.toBlock, opts.chunkSize ?? DEFAULT_LOG_CHUNK)) {
    const raw = await client.getLogs({ address: opts.address, fromBlock: r.fromBlock, toBlock: r.toBlock });
    assertLogsFrom(raw, opts.address, r);
    out.push(...decodeHogeeLogs(raw, opts.source));
  }
  return out;
}

/** A decoded log with the contract that emitted it. */
export type SourcedHogeeLog = DecodedHogeeLog & { readonly source: ContractName };

const chainOrder = (a: DecodedHogeeLog, b: DecodedHogeeLog): number => {
  const block = (a.blockNumber ?? -1n) - (b.blockNumber ?? -1n);
  return block !== 0n ? (block < 0n ? -1 : 1) : (a.logIndex ?? -1) - (b.logIndex ?? -1);
};

/**
 * Stateless read of [fromBlock, toBlock] across every contract of a deployment (hogeeWatchTargets): each contract's
 * logs come from its own address, are checked against what it emits, and are tagged with it; the result is in chain
 * order (block, then log index). For a feed that is not checkpointed per contract (the `safe` UI feed, tests).
 */
export async function readDeploymentLogs(
  client: Pick<LogReader, 'getLogs'>,
  opts: { contracts: DeploymentContracts; fromBlock: bigint; toBlock: bigint; chunkSize?: bigint },
): Promise<SourcedHogeeLog[]> {
  const out: SourcedHogeeLog[] = [];
  for (const { source, address } of hogeeWatchTargets(opts.contracts)) {
    const logs = await readLogs(client, { address, source, fromBlock: opts.fromBlock, toBlock: opts.toBlock, ...(opts.chunkSize ? { chunkSize: opts.chunkSize } : {}) });
    out.push(...logs.map((log) => ({ ...log, source })));
  }
  return out.toSorted(chainOrder);
}

export interface LogBatchContext {
  /** The chunk's db transaction (pg cursor) or null (memory cursor). Write handler effects with it. */
  readonly tx: DbTx | null;
  readonly range: BlockRange;
  readonly tag: WatchTag;
}

export type LogHandler = (logs: readonly DecodedHogeeLog[], ctx: LogBatchContext) => Promise<void>;

export interface PollLogsOptions {
  readonly address: Address;
  /** The contract at `address`: every decoded event must be one it emits, else the chunk fails (not committed). */
  readonly source?: ContractName;
  readonly tag: WatchTag;
  readonly cursor: LogCursor;
  readonly chunkSize?: bigint;
  /** Chunks per call (default 50), so one poll stays bounded on a long backlog. */
  readonly maxChunks?: number;
}

export interface PollResult {
  readonly head: bigint;
  readonly ranges: readonly BlockRange[];
  readonly logCount: number;
  /** true when the cursor reached `head`. */
  readonly caughtUp: boolean;
}

/**
 * One polling round: reads chunks after the cursor up to the block at `tag` and hands each decoded batch
 * (possibly empty) to `handler`, advancing the cursor chunk by chunk. A db cursor follows `finalized` only.
 */
export async function pollLogs(client: LogReader, opts: PollLogsOptions, handler: LogHandler): Promise<PollResult> {
  if (opts.cursor.finalizedOnly && opts.tag !== 'finalized') {
    throw new LogWatchError('a db log cursor stores no block hash: it may only follow `finalized`');
  }
  const size = opts.chunkSize ?? DEFAULT_LOG_CHUNK;
  checkChunk(size);
  const maxChunks = opts.maxChunks ?? 50;
  if (!Number.isSafeInteger(maxChunks) || maxChunks < 1) throw new RangeError('maxChunks must be a positive integer');
  const head = await headAt(client, opts.tag);
  const ranges: BlockRange[] = [];
  let logCount = 0;
  for (let i = 0; i < maxChunks; i += 1) {
    const done = await opts.cursor.step(async (last, tx) => {
      const range = nextChunk(last, head, size);
      if (!range) return null;
      const raw = await client.getLogs({ address: opts.address, ...range });
      assertLogsFrom(raw, opts.address, range);
      const logs = decodeHogeeLogs(raw, opts.source);
      await handler(logs, { tx, range, tag: opts.tag });
      return { to: range.toBlock, value: { range, count: logs.length } };
    });
    if (!done) return { head, ranges, logCount, caughtUp: true };
    ranges.push(done.range);
    logCount += done.count;
  }
  const last = ranges.at(-1);
  return { head, ranges, logCount, caughtUp: last !== undefined && last.toBlock >= head };
}
