/**
 * Block timestamps (unix seconds) for chain-time dating (cfo-guard), through an in-process LRU keyed by block number.
 * The cache is scoped to one chain by its genesis hash, so a fresh Anvil with the same chain id never reuses a stale
 * entry. A block's timestamp never changes once it is canonical; a reorg near the head can move a record by seconds,
 * which the CFO's UTC-day buckets tolerate (and the guard only ever tightens). Bounded: past `maxEntries` the least
 * recently used entry is evicted, never the whole map (audit run-9 lead 3).
 */
import type { HogeePublicClient } from '@hogee/chain';

export type BlockClient = Pick<HogeePublicClient, 'getBlock'>;

export const BLOCK_TIME_CACHE_MAX = 50_000;
const FETCH_CONCURRENCY = 8;

export class BlockTimeCache {
  private genesis: string | null = null;
  /** Insertion order is recency order: a hit re-inserts its key. */
  private readonly times = new Map<bigint, bigint>();

  constructor(readonly maxEntries: number = BLOCK_TIME_CACHE_MAX) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new RangeError('maxEntries must be a positive whole number');
  }

  get size(): number {
    return this.times.size;
  }

  /** Scopes the cache to the chain whose genesis hash is `hash`: another chain empties it first. */
  scope(hash: string): void {
    const h = hash.toLowerCase();
    if (this.genesis === h) return;
    this.times.clear();
    this.genesis = h;
  }

  get(block: bigint): bigint | undefined {
    const t = this.times.get(block);
    if (t === undefined) return undefined;
    this.times.delete(block);
    this.times.set(block, t);
    return t;
  }

  set(block: bigint, timestamp: bigint): void {
    this.times.delete(block);
    this.times.set(block, timestamp);
    while (this.times.size > this.maxEntries) {
      const oldest = this.times.keys().next();
      if (oldest.done) break;
      this.times.delete(oldest.value);
    }
  }
}

/** One pass's view of the cache: reads through it, counting the RPC block reads it makes. */
export interface BlockTimes {
  /** Unix seconds of `block` (one getBlock on a miss). */
  of(block: bigint): Promise<bigint>;
  /** Unix seconds of every block in `blocks` (misses fetched a few at a time). */
  all(blocks: readonly bigint[]): Promise<Map<bigint, bigint>>;
  /** getBlock calls made through this view (logs and tests). */
  fetched(): number;
}

/**
 * Scopes `cache` to the client's chain (one getBlock of the genesis block) and returns a view over it. `check` runs
 * before every RPC read (the pass deadline throws there, so a pass never starts another round trip past it). Any RPC
 * error propagates (fail closed).
 */
export async function blockTimesFor(client: BlockClient, cache: BlockTimeCache, check: () => void = () => undefined): Promise<BlockTimes> {
  check();
  cache.scope((await client.getBlock({ blockNumber: 0n })).hash ?? '');
  let fetched = 1;
  const fetchOne = async (block: bigint): Promise<bigint> => {
    fetched += 1;
    const t = (await client.getBlock({ blockNumber: block })).timestamp;
    cache.set(block, t);
    return t;
  };
  const of = async (block: bigint): Promise<bigint> => {
    const hit = cache.get(block);
    if (hit !== undefined) return hit;
    check();
    return fetchOne(block);
  };
  const all = async (blocks: readonly bigint[]): Promise<Map<bigint, bigint>> => {
    const out = new Map<bigint, bigint>();
    const missing: bigint[] = [];
    for (const b of new Set(blocks)) {
      const hit = cache.get(b);
      if (hit === undefined) missing.push(b);
      else out.set(b, hit);
    }
    for (let i = 0; i < missing.length; i += FETCH_CONCURRENCY) {
      check();
      const batch = missing.slice(i, i + FETCH_CONCURRENCY);
      for (const [b, t] of await Promise.all(batch.map(async (b) => [b, await fetchOne(b)] as const))) out.set(b, t);
    }
    return out;
  };
  return { of, all, fetched: () => fetched };
}
