/**
 * The CFO report cache (fixr-cfo, re-check LOW 4): one computation per key at a time (concurrent requests share it:
 * single flight) and a finished report kept for CFO_REPORT_TTL_MS. The key names the snapshot block (by hash), so a
 * new block always computes a new report; within one block the report can lag the worker's DB mirror by at most the
 * TTL (the same lag the service already logs as cfo_sales_mirror_lag). A failure is never cached. In-process and
 * bounded: past `maxEntries` the oldest report goes first.
 */
export const CFO_REPORT_TTL_MS = 15_000;
const MAX_REPORTS = 64;

export class ReportCache<T> {
  private readonly done = new Map<string, { readonly at: number; readonly value: T }>();
  private readonly running = new Map<string, Promise<T>>();

  constructor(
    readonly ttlMs: number = CFO_REPORT_TTL_MS,
    readonly maxEntries: number = MAX_REPORTS,
  ) {}

  get size(): number {
    return this.done.size;
  }

  /** The report for `key`: a fresh finished one, the one being computed, or `load()` (counted from `nowMs`). */
  get(key: string, nowMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.done.get(key);
    if (hit && nowMs - hit.at < this.ttlMs) return Promise.resolve(hit.value);
    const inFlight = this.running.get(key);
    if (inFlight) return inFlight;
    const p = load()
      .then((value) => {
        this.keep(key, nowMs, value);
        return value;
      })
      .finally(() => this.running.delete(key));
    this.running.set(key, p);
    return p;
  }

  private keep(key: string, at: number, value: T): void {
    this.done.delete(key);
    this.done.set(key, { at, value });
    while (this.done.size > this.maxEntries) {
      const oldest = this.done.keys().next();
      if (oldest.done) break;
      this.done.delete(oldest.value);
    }
  }
}
