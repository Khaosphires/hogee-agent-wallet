/**
 * POST /api/chat rate limits (G0 §9 "still open"; decisions in docs/decisions/api-guard.md). Three sliding 60 s windows,
 * all per process (the API serves localhost):
 *   - per persona chat session (persona + the body's sessionId);
 *   - per client address: the socket address only when the runtime hands one over. No trusted-proxy rule exists, so
 *     X-Forwarded-For / X-Real-IP are never read. Mounted in Next (hono/vercel) there is no socket, so every caller is
 *     one LOCAL_CLIENT and this scope acts as a second server-wide limit;
 *   - per server.
 * A turn is admitted only when all three have room, and only an admitted turn is counted (check and count are one
 * synchronous step, so a burst cannot slip past). Each map holds at most MAX_TRACKED_KEYS keys: expired keys are swept
 * first, then the least recently used is evicted. Evicting a live key forgets its count; the server scope still bounds
 * a caller who cycles keys.
 */
import type { Context } from "hono";

export const RATE_WINDOW_MS = 60_000;
export const MAX_TRACKED_KEYS = 1_000;
/** The client key when the runtime exposes no socket address (the Next mount): one bucket for the localhost demo. */
export const LOCAL_CLIENT = "local";

export interface ChatRateLimits {
  /** Turns per persona chat session per minute (CHAT_RATE_SESSION_PER_MIN). */
  readonly perSession: number;
  /** Turns per client address per minute (CHAT_RATE_CLIENT_PER_MIN). */
  readonly perClient: number;
  /** Turns per server per minute (CHAT_RATE_SERVER_PER_MIN). */
  readonly perServer: number;
}

/** A founder types a few messages a minute; a turn makes up to PLANNER_MAX_STEPS (6) model calls. */
export const DEFAULT_CHAT_RATE: ChatRateLimits = { perSession: 10, perClient: 20, perServer: 30 };

/**
 * VISION-DECISIONS §9: chat ACTIONS (button presses: no free text, no model call, no redaction) count in their own
 * bucket, 30 a minute per persona chat session, so clicking through cards never eats the text turns above. The client
 * and server scopes bound a caller who cycles session ids (same rules as the text limiter; fixed, no env).
 */
export const DEFAULT_ACTION_RATE: ChatRateLimits = { perSession: 30, perClient: 60, perServer: 120 };

const positiveInt = (n: number, what: string): number => {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`${what} must be a positive whole number`);
  return n;
};

/** True at most once per `intervalMs` (the first refusal of a window is traced, the rest are only logged). */
export class OncePer {
  private last: number | null = null;

  constructor(private readonly intervalMs: number) {}

  due(nowMs: number): boolean {
    if (this.last !== null && nowMs - this.last < this.intervalMs) return false;
    this.last = nowMs;
    return true;
  }
}

/** Sliding-window hit counter per key, bounded to `maxKeys` keys. */
export class WindowCounter {
  /** Insertion order is recency order: a key is re-inserted on every hit. */
  private readonly hits = new Map<string, readonly number[]>();

  constructor(
    readonly limit: number,
    readonly windowMs: number = RATE_WINDOW_MS,
    readonly maxKeys: number = MAX_TRACKED_KEYS,
  ) {
    positiveInt(limit, "limit");
    positiveInt(windowMs, "windowMs");
    positiveInt(maxKeys, "maxKeys");
  }

  get size(): number {
    return this.hits.size;
  }

  keys(): string[] {
    return [...this.hits.keys()];
  }

  /** Milliseconds until `key` may be hit again; 0 when it may be hit now. Records nothing. */
  waitMs(key: string, nowMs: number): number {
    const live = this.live(key, nowMs);
    if (live.length < this.limit) return 0;
    const oldest = live[live.length - this.limit] ?? nowMs;
    return Math.max(1, oldest + this.windowMs - nowMs);
  }

  hit(key: string, nowMs: number): void {
    const live = this.live(key, nowMs);
    this.hits.delete(key);
    this.makeRoom(nowMs);
    this.hits.set(key, [...live, nowMs]);
  }

  private live(key: string, nowMs: number): readonly number[] {
    return (this.hits.get(key) ?? []).filter((t) => nowMs - t < this.windowMs);
  }

  private makeRoom(nowMs: number): void {
    if (this.hits.size < this.maxKeys) return;
    for (const [key, times] of this.hits) if (times.every((t) => nowMs - t >= this.windowMs)) this.hits.delete(key);
    for (const key of this.hits.keys()) {
      if (this.hits.size < this.maxKeys) break;
      this.hits.delete(key);
    }
  }
}

export type RateScope = "session" | "client" | "server";

export interface RateRefusal {
  readonly scope: RateScope;
  readonly retryAfterMs: number;
}

const SERVER_KEY = "server";

export class ChatRateLimiter {
  private readonly counters: readonly (readonly [RateScope, WindowCounter])[];
  private readonly traced = new OncePer(RATE_WINDOW_MS);

  constructor(
    readonly limits: ChatRateLimits = DEFAULT_CHAT_RATE,
    maxKeys: number = MAX_TRACKED_KEYS,
  ) {
    this.counters = [
      ["session", new WindowCounter(limits.perSession, RATE_WINDOW_MS, maxKeys)],
      ["client", new WindowCounter(limits.perClient, RATE_WINDOW_MS, maxKeys)],
      ["server", new WindowCounter(limits.perServer, RATE_WINDOW_MS, 1)],
    ];
  }

  /** Admits and counts one chat turn, or returns the narrowest scope that refuses it (then nothing is counted). */
  take(keys: { readonly session: string; readonly client: string }, nowMs: number): RateRefusal | null {
    const keyOf = (scope: RateScope): string => (scope === "server" ? SERVER_KEY : keys[scope]);
    for (const [scope, counter] of this.counters) {
      const wait = counter.waitMs(keyOf(scope), nowMs);
      if (wait > 0) return { scope, retryAfterMs: wait };
    }
    for (const [scope, counter] of this.counters) counter.hit(keyOf(scope), nowMs);
    return null;
  }

  /** True for the first refusal of a window (trace it), false for the rest (log only). */
  traceRefusal(nowMs: number): boolean {
    return this.traced.due(nowMs);
  }
}

interface NodeIncoming {
  readonly incoming?: { readonly socket?: { readonly remoteAddress?: unknown } };
}

/** The caller's socket address when the runtime exposes it (Hono node adapter: `c.env.incoming`), else LOCAL_CLIENT. */
export function clientAddress(c: Context): string {
  const address = (c.env as NodeIncoming | undefined)?.incoming?.socket?.remoteAddress;
  return typeof address === "string" && address.length > 0 && address.length <= 64 ? address : LOCAL_CLIENT;
}

/** Whole seconds, at least 1, for a wait in milliseconds. */
export const retryAfterSeconds = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));

/** Sets Retry-After on the response the route is about to send (headers set on `c` reach the error response too). */
export function setRetryAfter(c: Context, ms: number): void {
  c.header("Retry-After", String(retryAfterSeconds(ms)));
}
