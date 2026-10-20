/**
 * Chain-time dates for the CFO report's records, bounded (fixr-cfo, re-check LOW 4). Before, every GET /api/cfo dated
 * the facility's ALL-time records, one getBlock per distinct block, through a 20,000-entry cache that emptied when
 * full, so a long history re-read every block on every request.
 *
 * Now only these blocks are dated exactly (through an LRU that evicts, never clears; scoped by the genesis hash):
 *   - every record of the last CFO_WINDOW_DAYS chain days (the report's 30-day series and its 7-day averages). The
 *     window's first record block is found by a binary search over the record blocks (chain time never decreases with
 *     the block number): about log2(records) block reads;
 *   - the earliest record of each class core tells apart (payment kind, state, a line or none, auto-released or not;
 *     and sales), so the first COUNTED record, the P&L's first day, is exact whatever core's rules count;
 *   - the sale that crossed the stage target (its day is the stage date), the RECENT_SALES_DATED newest sales (the
 *     report lists them) and the agent actions (listed);
 * Every other, older record gets the time of the nearest dated block at or below it. That is a lower bound, never
 * after the record's own time and still before the window, and it keeps block order, so core's totals, counts, first
 * day, series, averages, stage date and recent list are exactly those of the full dating (test/cfo-dating.test.ts).
 * Any read error propagates (the report fails closed).
 */
/** Chain days dated exactly: the report's 30-day series (core SERIES_DAYS). */
export const CFO_WINDOW_DAYS = 30;
/** The newest sales the report lists (core MAX_RECENT_SALES). */
export const RECENT_SALES_DATED = 20;
export const BLOCK_TIME_CACHE_MAX = 50_000;
const FETCH_CONCURRENCY = 8;
const SECONDS_PER_DAY = 86_400n;

/** The one chain read dating needs (the API's public client has it). */
export interface BlockClient {
  getBlock(args: { blockNumber: bigint }): Promise<{ readonly hash: string | null; readonly timestamp: bigint }>;
}

/** Block timestamps (unix seconds) of one chain, least recently used evicted past `maxEntries`. */
export class BlockTimeCache {
  private genesis: string | null = null;
  /** Insertion order is recency order: a hit re-inserts its key. */
  private readonly times = new Map<bigint, bigint>();

  constructor(readonly maxEntries: number = BLOCK_TIME_CACHE_MAX) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new RangeError("maxEntries must be a positive whole number");
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

export interface DatedPayment {
  readonly kind: string;
  readonly state: string;
  readonly lineKey: string | null;
  readonly autoReleased: boolean;
  readonly block: bigint;
}

export interface DatingIn {
  readonly payments: readonly DatedPayment[];
  /** In block order (then sale id), as the report reads them. */
  readonly sales: readonly { readonly block: bigint; readonly amountMinor: string }[];
  readonly actions: readonly { readonly block: bigint }[];
  /** The snapshot block's timestamp (the report's "now"). */
  readonly timestamp: bigint;
  /** The stage target the report projects (salesMinor), or null. */
  readonly stageTargetMinor: bigint | null;
}

/** The window's first second: the start of the UTC day CFO_WINDOW_DAYS − 1 days before the snapshot's. */
export function windowFrom(timestamp: bigint): bigint {
  const day = timestamp / SECONDS_PER_DAY - BigInt(CFO_WINDOW_DAYS - 1);
  return day > 0n ? day * SECONDS_PER_DAY : 0n;
}

/** The earliest block of each payment class and of the sales (the anchors of the first counted record). */
function classAnchors(i: DatingIn): bigint[] {
  const first = new Map<string, bigint>();
  const keep = (key: string, block: bigint) => {
    const was = first.get(key);
    if (was === undefined || block < was) first.set(key, block);
  };
  for (const p of i.payments) keep(`${p.kind}|${p.state}|${p.lineKey === null}|${p.autoReleased}`, p.block);
  for (const s of i.sales) keep("sale", s.block);
  return [...first.values()];
}

/** The block of the sale that brought the running total to the stage target (block order), or none. */
function crossingBlock(i: DatingIn): bigint[] {
  if (i.stageTargetMinor === null) return [];
  let total = 0n;
  for (const s of i.sales) {
    total += BigInt(s.amountMinor);
    if (total >= i.stageTargetMinor) return [s.block];
  }
  return [];
}

/** A view of the cache for one report: reads through it, a few blocks at a time. */
async function reader(client: BlockClient, cache: BlockTimeCache) {
  cache.scope((await client.getBlock({ blockNumber: 0n })).hash ?? "");
  const known = new Map<bigint, bigint>();
  const fetchAll = async (blocks: readonly bigint[]): Promise<void> => {
    const missing: bigint[] = [];
    for (const b of new Set(blocks)) {
      if (known.has(b)) continue;
      const hit = cache.get(b);
      if (hit === undefined) missing.push(b);
      else known.set(b, hit);
    }
    for (let k = 0; k < missing.length; k += FETCH_CONCURRENCY) {
      const batch = missing.slice(k, k + FETCH_CONCURRENCY);
      for (const [b, t] of await Promise.all(batch.map(async (b) => [b, (await client.getBlock({ blockNumber: b })).timestamp] as const))) {
        cache.set(b, t);
        known.set(b, t);
      }
    }
  };
  const timeOf = async (b: bigint): Promise<bigint> => {
    await fetchAll([b]);
    return known.get(b) as bigint;
  };
  return { known, fetchAll, timeOf };
}

/** Index of the first block in `sorted` dated at or after `fromTime` (sorted.length when none). */
async function windowIndex(sorted: readonly bigint[], fromTime: bigint, timeOf: (b: bigint) => Promise<bigint>): Promise<number> {
  if ((await timeOf(sorted[0] as bigint)) >= fromTime) return 0;
  // Invariant: sorted[lo] is dated before fromTime; every block at or above index hi is dated at or after it.
  let lo = 0;
  let hi = sorted.length;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if ((await timeOf(sorted[mid] as bigint)) < fromTime) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Block (decimal) → unix seconds for every record of `i` (module doc). Throws on any read error. */
export async function dateRecords(client: BlockClient, cache: BlockTimeCache, i: DatingIn): Promise<{ times: Map<string, bigint> }> {
  const records = [...new Set([...i.payments, ...i.sales].map((x) => x.block))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (records.length === 0 && i.actions.length === 0) return { times: new Map() };
  const r = await reader(client, cache);
  const w = records.length === 0 ? 0 : await windowIndex(records, windowFrom(i.timestamp), r.timeOf);
  await r.fetchAll([...records.slice(w), ...classAnchors(i), ...crossingBlock(i), ...i.sales.slice(-RECENT_SALES_DATED).map((s) => s.block), ...i.actions.map((a) => a.block)]);
  const dated = [...r.known.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const times = new Map<string, bigint>();
  let k = -1;
  for (const b of records) {
    while (k + 1 < dated.length && (dated[k + 1] as [bigint, bigint])[0] <= b) k += 1;
    // records[0] is always dated (the search's first read), so a dated block at or below b exists.
    times.set(b.toString(), r.known.get(b) ?? (dated[k] as [bigint, bigint])[1]);
  }
  for (const a of i.actions) times.set(a.block.toString(), r.known.get(a.block) as bigint);
  return { times };
}
