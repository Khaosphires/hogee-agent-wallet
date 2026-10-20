/**
 * The per-server model-usage budget (G0 §9 "still open"; decisions in docs/decisions/api-guard.md). Every model call,
 * chat or eval, each tool-loop step and each SDK retry, reserves from it BEFORE the provider is called and settles
 * after (runtime/budgeted-models.ts). Two measures, calls and characters (the redacted request plus the answer), are
 * capped over a rolling window and in total since the process started.
 *
 * - Reserve = 1 call + the request's characters + `outputReserveChars` (the answer is not known yet). A call that does
 *   not fit is refused before it is sent. Reserve and settle are synchronous, so concurrent calls cannot all pass one
 *   check and then overshoot together.
 * - Settle replaces the estimate with the measured size, once. A call that fails or is aborted never settles and keeps
 *   its whole reservation (the provider may have charged it), so errors never refund the budget: fail closed. So does a
 *   measured size that is not a whole number.
 * - The window is BUDGET_BUCKETS fixed buckets; a bucket counts until all of it has left the window, so the window is
 *   never under-counted and memory stays fixed however many calls arrive.
 * - `assertOpen` (the up-front gate, before any model or call log row exists) asks for room for one empty request, or
 *   for the last refused reservation until a reservation succeeds again. So once a real call no longer fits, later
 *   requests are refused up front instead of each logging one refused call.
 * - Per process: a restart starts a fresh budget (like the officer-attempt limiter).
 */
import { OncePer } from "../http/rate-limit";

export const BUDGET_BUCKETS = 24;
/** A budget refusal leaves at most one trace event per hour per server; every refusal is logged. */
export const BUDGET_TRACE_INTERVAL_MS = 60 * 60 * 1000;

export interface ModelBudgetLimits {
  /** MODEL_BUDGET_WINDOW_HOURS (as ms). */
  readonly windowMs: number;
  /** MODEL_BUDGET_WINDOW_CALLS: model calls per window. */
  readonly windowCalls: number;
  /** MODEL_BUDGET_WINDOW_CHARS: request + answer characters per window. */
  readonly windowChars: number;
  /** MODEL_BUDGET_TOTAL_CALLS: model calls in the life of the process. */
  readonly totalCalls: number;
  /** MODEL_BUDGET_TOTAL_CHARS: characters in the life of the process. */
  readonly totalChars: number;
  /** MODEL_BUDGET_OUTPUT_RESERVE_CHARS: what a call reserves for its answer before it is sent. */
  readonly outputReserveChars: number;
}

/**
 * About 1,500 calls a day: a chat turn is up to 6 planner calls, so ~250 turns. A full E1/E2 eval run needs more; its
 * operator raises the MODEL_BUDGET_* variables for that run. 16,384 characters cover the planner's 4,096-unit answer cap.
 */
export const DEFAULT_MODEL_BUDGET: ModelBudgetLimits = {
  windowMs: 24 * 60 * 60 * 1000,
  windowCalls: 1_500,
  windowChars: 30_000_000,
  totalCalls: 5_000,
  totalChars: 100_000_000,
  outputReserveChars: 16_384,
};

export type BudgetScope = "window" | "total";

export class ModelBudgetExhaustedError extends Error {
  override readonly name = "ModelBudgetExhaustedError";
  /** `retryAfterMs`: when the oldest window bucket frees some room; null when only a restart would (total). */
  constructor(
    readonly scope: BudgetScope,
    readonly retryAfterMs: number | null,
  ) {
    super(`model call refused before it was sent: the server's model budget (${scope}) is used up`);
  }
}

export interface Usage {
  readonly calls: number;
  readonly chars: number;
}

export interface Reservation {
  /** Characters reserved for this call. */
  readonly chars: number;
  /** Replaces the reservation with the measured size (whole characters); only the first settle counts. */
  settle(measuredChars: number): void;
}

export interface BudgetStatus {
  readonly open: boolean;
  readonly window: Usage;
  readonly total: Usage;
}

interface Bucket extends Usage {
  readonly start: number;
}

const isCount = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;

function checkLimits(l: ModelBudgetLimits): ModelBudgetLimits {
  for (const [name, n] of Object.entries(l)) {
    if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`model budget ${name} must be a positive whole number`);
  }
  if (l.windowMs < BUDGET_BUCKETS) throw new RangeError(`model budget windowMs must be at least ${BUDGET_BUCKETS}`);
  if (l.outputReserveChars > l.windowChars || l.outputReserveChars > l.totalChars) {
    throw new RangeError("model budget outputReserveChars must fit in windowChars and totalChars");
  }
  return l;
}

const add = (u: Usage, calls: number, chars: number): Usage => ({ calls: u.calls + calls, chars: u.chars + chars });

export class ModelBudget {
  readonly limits: ModelBudgetLimits;
  private readonly bucketMs: number;
  private buckets: readonly Bucket[] = [];
  private total: Usage = { calls: 0, chars: 0 };
  private readonly traced = new OncePer(BUDGET_TRACE_INTERVAL_MS);
  /** Room `assertOpen` asks for: one output allowance, or the last refused reservation that could ever fit. */
  private gateChars: number;

  constructor(
    limits: ModelBudgetLimits = DEFAULT_MODEL_BUDGET,
    private readonly clock: () => number = Date.now,
  ) {
    this.limits = checkLimits(limits);
    this.bucketMs = Math.ceil(limits.windowMs / BUDGET_BUCKETS);
    this.gateChars = limits.outputReserveChars;
  }

  /** Reserves one call of `inputChars` request characters, or throws ModelBudgetExhaustedError (nothing counted). */
  reserve(inputChars: number): Reservation {
    if (!isCount(inputChars)) throw new ModelBudgetExhaustedError("total", null);
    const now = this.clock();
    const chars = inputChars + this.limits.outputReserveChars;
    const refusal = this.refusal(chars, now);
    if (refusal) {
      if (chars <= this.limits.windowChars && chars <= this.limits.totalChars) this.gateChars = Math.max(this.gateChars, chars);
      throw refusal;
    }
    this.gateChars = this.limits.outputReserveChars;
    const start = Math.floor(now / this.bucketMs) * this.bucketMs;
    const live = this.inWindow(now);
    const current = live.find((b) => b.start === start);
    this.buckets = current ? live.map((b) => (b === current ? { ...add(b, 1, chars), start } : b)) : [...live, { start, calls: 1, chars }];
    this.total = add(this.total, 1, chars);
    let settled = false;
    return {
      chars,
      settle: (measuredChars: number) => {
        if (settled || !isCount(measuredChars)) return;
        settled = true;
        this.adjust(start, measuredChars - chars);
      },
    };
  }

  /** Throws ModelBudgetExhaustedError unless a call would still fit (see the module note on the gate). */
  assertOpen(): void {
    const refusal = this.refusal(this.gateChars, this.clock());
    if (refusal) throw refusal;
  }

  isOpen(): boolean {
    return this.refusal(this.gateChars, this.clock()) === null;
  }

  status(): BudgetStatus {
    const now = this.clock();
    return { open: this.refusal(this.gateChars, now) === null, window: this.windowUsage(now), total: this.total };
  }

  /** True for the first refusal of an hour (trace it), false for the rest (log only). */
  traceRefusal(nowMs: number = this.clock()): boolean {
    return this.traced.due(nowMs);
  }

  /** Buckets held (tests: memory stays fixed). */
  bucketCount(): number {
    return this.buckets.length;
  }

  private adjust(start: number, deltaChars: number): void {
    this.total = add(this.total, 0, deltaChars);
    this.buckets = this.buckets.map((b) => (b.start === start ? { ...add(b, 0, deltaChars), start } : b));
  }

  /** A bucket counts while any part of it is inside (now - windowMs, now]. */
  private inWindow(now: number): readonly Bucket[] {
    return this.buckets.filter((b) => b.start + this.bucketMs > now - this.limits.windowMs);
  }

  private windowUsage(now: number): Usage {
    return this.inWindow(now).reduce<Usage>((u, b) => add(u, b.calls, b.chars), { calls: 0, chars: 0 });
  }

  private refusal(chars: number, now: number): ModelBudgetExhaustedError | null {
    const l = this.limits;
    if (this.total.calls + 1 > l.totalCalls || this.total.chars + chars > l.totalChars) return new ModelBudgetExhaustedError("total", null);
    const live = this.inWindow(now);
    const used = live.reduce<Usage>((u, b) => add(u, b.calls, b.chars), { calls: 0, chars: 0 });
    if (used.calls + 1 <= l.windowCalls && used.chars + chars <= l.windowChars) return null;
    const oldest = Math.min(...live.map((b) => b.start));
    return new ModelBudgetExhaustedError("window", live.length > 0 ? Math.max(1, oldest + this.bucketMs + l.windowMs - now) : null);
  }
}

const MAX_DEPTH = 6;

/** The budget refusal inside `e`, however the AI SDK wrapped it (cause chain, RetryError errors/lastError), or null. */
export function budgetRefusalIn(e: unknown, depth = 0, seen: Set<unknown> = new Set()): ModelBudgetExhaustedError | null {
  if (e instanceof ModelBudgetExhaustedError) return e;
  if (depth >= MAX_DEPTH || typeof e !== "object" || e === null || seen.has(e)) return null;
  seen.add(e);
  const o = e as { cause?: unknown; lastError?: unknown; errors?: unknown };
  const next = [o.cause, o.lastError, ...(Array.isArray(o.errors) ? o.errors : [])];
  for (const n of next) {
    const found = budgetRefusalIn(n, depth + 1, seen);
    if (found) return found;
  }
  return null;
}
