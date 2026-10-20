/**
 * A wall-clock budget for one job pass (cfo-guard, audit run-9 lead 3): every job shares one advisory lock, so a pass
 * that runs long starves reconcile, settle and relay (including the officer's Treasury.pause). Past the deadline a pass
 * starts no further read and sends nothing. `race` lets the pass give up on a read in flight: the read itself runs on
 * to completion in the background (reads only, so nothing is left half written) and its result is ignored.
 */
export class DeadlineError extends Error {
  override readonly name = 'DeadlineError';
  constructor(readonly budgetMs: number) {
    super(`the pass ran past its ${budgetMs} ms deadline`);
  }
}

export class Deadline {
  private constructor(
    private readonly at: number,
    readonly budgetMs: number,
    private readonly now: () => number,
  ) {}

  /** A deadline `budgetMs` from now (`now` in milliseconds; injectable for tests). */
  static after(budgetMs: number, now: () => number = Date.now): Deadline {
    if (!Number.isSafeInteger(budgetMs) || budgetMs < 1) throw new RangeError('budgetMs must be a positive whole number');
    return new Deadline(now() + budgetMs, budgetMs, now);
  }

  remainingMs(): number {
    return Math.max(0, this.at - this.now());
  }

  expired(): boolean {
    return this.remainingMs() === 0;
  }

  /** Throws DeadlineError once the deadline has passed. */
  check(): void {
    if (this.expired()) throw new DeadlineError(this.budgetMs);
  }

  /** `p`, or DeadlineError when the deadline passes first. The loser's late rejection is swallowed. */
  race<T>(p: Promise<T>): Promise<T> {
    if (this.expired()) {
      p.catch(() => undefined);
      return Promise.reject(new DeadlineError(this.budgetMs));
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new DeadlineError(this.budgetMs)), this.remainingMs());
      timer.unref?.();
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}

/** True when `error` is, or was caused by, a DeadlineError (the chain sender may wrap what it rethrows). */
export function isDeadlineError(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e instanceof Error && depth < 5; e = (e as { cause?: unknown }).cause, depth += 1) {
    if (e instanceof DeadlineError) return true;
  }
  return false;
}

/**
 * `client` with every method call counted against `deadline` (fixr-cfo, re-check LOW 5: a send's RPC calls used to
 * run outside the pass's budget while it held the shared job lock): checked before a call starts, raced while it runs.
 * A send through it stops at its next RPC call once the deadline has passed; what the outbox already stored stays (an
 * unsigned row is never signed later, a signed one is broadcast by recovery). Non-function properties pass through.
 */
export function withinDeadline<T extends object>(client: T, deadline: Deadline): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        deadline.check();
        const out: unknown = (value as (...a: unknown[]) => unknown).apply(target, args);
        return out instanceof Promise ? deadline.race(out) : out;
      };
    },
  });
}

