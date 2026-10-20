import fc from 'fast-check';
import { encodeAbiParameters, encodeEventTopics, getAbiItem, type Address, type Hex, type Log } from 'viem';
import { describe, expect, it } from 'vitest';
import type { Db } from '@hogee/db';
import {
  DEFAULT_LOG_CHUNK,
  iTreasuryAbi,
  memoryLogCursor,
  nextChunk,
  pgLogCursor,
  planChunks,
  planChunksBackward,
  pollLogs,
  readLogs,
  toBytes32Tag,
  type DecodedHogeeLog,
  type LogReader,
  type WatchTag,
} from '../src/index';

const TREASURY: Address = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const OTHER: Address = '0x0000000000000000000000000000000000000bad';
const h = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;

describe('chunk math', () => {
  it('nextChunk walks forward ≤ 10 blocks and stops at the head', () => {
    expect(nextChunk(99n, 200n)).toEqual({ fromBlock: 100n, toBlock: 109n });
    expect(nextChunk(195n, 200n)).toEqual({ fromBlock: 196n, toBlock: 200n });
    expect(nextChunk(200n, 200n)).toBeNull();
    expect(nextChunk(0n, 5n, 1n)).toEqual({ fromBlock: 1n, toBlock: 1n });
    expect(() => nextChunk(0n, 5n, 0n)).toThrow(RangeError);
  });

  it('planChunks covers [from, to] exactly, in order, each range ≤ size (property)', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 9n }), fc.nat({ max: 500 }), fc.bigInt({ min: 1n, max: 50n }), (from, len, size) => {
        const to = from + BigInt(len) - 1n;
        const ranges = planChunks(from, to, size);
        let expected = from;
        for (const r of ranges) {
          expect(r.fromBlock).toBe(expected);
          expect(r.toBlock - r.fromBlock + 1n).toBeLessThanOrEqual(size);
          expect(r.toBlock).toBeGreaterThanOrEqual(r.fromBlock);
          expected = r.toBlock + 1n;
        }
        expect(expected).toBe(len === 0 ? from : to + 1n);
        expect(ranges.length).toBe(Math.ceil(len / Number(size)));
      }),
    );
  });

  it('planChunksBackward is newest first', () => {
    expect(planChunksBackward(1n, 25n).map((r) => r.fromBlock)).toEqual([21n, 11n, 1n]);
    expect(DEFAULT_LOG_CHUNK).toBe(10n);
  });
});

// ---- a fake RPC that behaves like Alchemy free tier (≤ 10-block getLogs) ------------------------

const SPENT = getAbiItem({ abi: iTreasuryAbi, name: 'Spent' });
const PAUSED = getAbiItem({ abi: iTreasuryAbi, name: 'TreasuryPaused' });

function spentLog(block: bigint, n: number, address: Address = TREASURY): Log {
  const topics = encodeEventTopics({
    abi: [SPENT],
    eventName: 'Spent',
    args: { spendId: h(n), lineId: toBytes32Tag('ADS'), payeeId: toBytes32Tag('shopee-ads') },
  });
  const data = encodeAbiParameters(
    SPENT.inputs.filter((i) => !i.indexed),
    [BigInt(1000 + n), h(500 + n), h(600 + n), h(700 + n), 1],
  );
  return log(block, n, address, topics as Hex[], data);
}

function pausedLog(block: bigint, n: number): Log {
  const topics = encodeEventTopics({ abi: [PAUSED], eventName: 'TreasuryPaused', args: { lineId: toBytes32Tag('ADS'), by: OTHER } });
  return log(block, n, TREASURY, topics as Hex[], '0x');
}

function log(block: bigint, n: number, address: Address, topics: Hex[], data: Hex): Log {
  return {
    address,
    topics: topics as [Hex, ...Hex[]],
    data,
    blockNumber: block,
    blockHash: h(9000 + Number(block)),
    transactionHash: h(8000 + n),
    transactionIndex: 0,
    logIndex: n,
    removed: false,
  };
}

function fakeRpc(heads: Partial<Record<WatchTag, bigint>>, logs: Log[]) {
  const ranges: Array<[bigint, bigint]> = [];
  const client: LogReader = {
    async getBlock({ blockTag }) {
      return { number: heads[blockTag] ?? null };
    },
    async getLogs({ address, fromBlock, toBlock }) {
      if (toBlock - fromBlock + 1n > 10n) throw new Error('Log response size exceeded: 10 block range limit');
      ranges.push([fromBlock, toBlock]);
      return logs.filter((l) => l.address === address && (l.blockNumber ?? -1n) >= fromBlock && (l.blockNumber ?? -1n) <= toBlock);
    },
  };
  return { client, ranges };
}

describe('pollLogs', () => {
  const logs = [spentLog(3n, 1), pausedLog(12n, 2), spentLog(12n, 3), spentLog(25n, 4), spentLog(26n, 5, OTHER), spentLog(31n, 6)];

  it('reads ≤ 10-block chunks up to the finalized head and decodes Hogee events', async () => {
    const { client, ranges } = fakeRpc({ finalized: 30n, safe: 40n }, logs);
    const seen: DecodedHogeeLog[] = [];
    const result = await pollLogs(client, { address: TREASURY, tag: 'finalized', cursor: memoryLogCursor(1n) }, async (batch) => {
      seen.push(...batch);
    });
    expect(ranges).toEqual([
      [1n, 10n],
      [11n, 20n],
      [21n, 30n],
    ]);
    expect(result).toMatchObject({ head: 30n, logCount: 4, caughtUp: true });
    expect(seen.map((l) => l.eventName)).toEqual(['Spent', 'TreasuryPaused', 'Spent', 'Spent']);
    const first = seen[0];
    expect(first?.eventName === 'Spent' && first.args).toMatchObject({ spendId: h(1), amountMinor: 1001n, planVersion: 1 });
  });

  it('the safe tag reads further than finalized', async () => {
    const { client } = fakeRpc({ finalized: 30n, safe: 40n }, logs);
    const result = await pollLogs(client, { address: TREASURY, tag: 'safe', cursor: memoryLogCursor(1n) }, async () => undefined);
    expect(result.head).toBe(40n);
    expect(result.logCount).toBe(5);
  });

  it('is idempotent across a crash: a failed batch does not advance the cursor and is read again', async () => {
    const { client } = fakeRpc({ finalized: 30n }, logs);
    const cursor = memoryLogCursor(1n);
    const processed: string[] = [];
    let crashOnce = true;
    const handler = async (batch: readonly DecodedHogeeLog[], ctx: { range: { fromBlock: bigint } }) => {
      if (crashOnce && ctx.range.fromBlock === 11n) {
        crashOnce = false;
        throw new Error('kill -9 while settling');
      }
      processed.push(...batch.map((l) => `${l.transactionHash}:${l.logIndex}`));
    };
    await expect(pollLogs(client, { address: TREASURY, tag: 'finalized', cursor }, handler)).rejects.toThrow(/kill -9/);
    const second = await pollLogs(client, { address: TREASURY, tag: 'finalized', cursor }, handler);
    expect(second.ranges[0]).toEqual({ fromBlock: 11n, toBlock: 20n });
    expect(processed).toEqual([`${h(8001)}:1`, `${h(8002)}:2`, `${h(8003)}:3`, `${h(8004)}:4`]);
    const third = await pollLogs(client, { address: TREASURY, tag: 'finalized', cursor }, handler);
    expect(third).toMatchObject({ ranges: [], logCount: 0, caughtUp: true });
  });

  it('bounds one round with maxChunks and reports caughtUp = false', async () => {
    const { client } = fakeRpc({ finalized: 30n }, logs);
    const cursor = memoryLogCursor(1n);
    const first = await pollLogs(client, { address: TREASURY, tag: 'finalized', cursor, maxChunks: 2 }, async () => undefined);
    expect(first).toMatchObject({ caughtUp: false, logCount: 3 });
    const rest = await pollLogs(client, { address: TREASURY, tag: 'finalized', cursor, maxChunks: 2 }, async () => undefined);
    expect(rest).toMatchObject({ caughtUp: true, logCount: 1 });
  });

  it('a chunk size above the provider limit fails loudly instead of skipping blocks', async () => {
    const { client } = fakeRpc({ finalized: 30n }, logs);
    await expect(
      pollLogs(client, { address: TREASURY, tag: 'finalized', cursor: memoryLogCursor(1n), chunkSize: 20n }, async () => undefined),
    ).rejects.toThrow(/10 block range/);
  });

  it('readLogs is a stateless chunked read', async () => {
    const { client, ranges } = fakeRpc({}, logs);
    const got = await readLogs(client, { address: TREASURY, fromBlock: 10n, toBlock: 26n });
    expect(got.map((l) => l.blockNumber)).toEqual([12n, 12n, 25n]);
    expect(ranges).toEqual([
      [10n, 19n],
      [20n, 26n],
    ]);
  });
});

describe('watcher guards (what the cursor commits must be what was asked for)', () => {
  const logs = [spentLog(3n, 1), spentLog(12n, 2)];

  it('a db checkpoint cursor (no block hash stored) only follows `finalized`; safe / latest are refused before any read', async () => {
    const { client, ranges } = fakeRpc({ finalized: 30n, safe: 40n, latest: 50n }, logs);
    const cursor = pgLogCursor({} as Db, { contract: TREASURY, chainId: 31337, startBlock: 1n });
    for (const tag of ['safe', 'latest'] as const) {
      await expect(pollLogs(client, { address: TREASURY, tag, cursor }, async () => undefined)).rejects.toThrow(/only follow `finalized`/);
    }
    expect(ranges).toEqual([]);
  });

  it('refuses a provider log from another address or outside the requested range; the chunk is not committed', async () => {
    for (const bad of [spentLog(5n, 7, OTHER), spentLog(15n, 8)]) {
      const client: LogReader = {
        getBlock: async () => ({ number: 30n }),
        getLogs: async ({ fromBlock, toBlock }) => (fromBlock === 1n ? [spentLog(3n, 1), bad] : []).filter(() => toBlock >= fromBlock),
      };
      const cursor = memoryLogCursor(1n);
      const seen: DecodedHogeeLog[] = [];
      const run = pollLogs(client, { address: TREASURY, tag: 'finalized', cursor }, async (batch) => {
        seen.push(...batch);
      });
      await expect(run).rejects.toThrow(/another address|outside the requested range/);
      expect(seen).toEqual([]);
      const retry = await pollLogs({ ...client, getLogs: async () => [] }, { address: TREASURY, tag: 'finalized', cursor, maxChunks: 1 }, async () => undefined);
      expect(retry.ranges[0]).toEqual({ fromBlock: 1n, toBlock: 10n }); // the bad chunk is read again
      await expect(readLogs(client, { address: TREASURY, fromBlock: 1n, toBlock: 10n })).rejects.toThrow(/another address|outside the requested range/);
    }
  });
});
