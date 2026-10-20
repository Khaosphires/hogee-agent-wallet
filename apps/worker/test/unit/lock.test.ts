/** The job lock's session semantics with a fake pool: a connection whose unlock failed is destroyed, never reused. */
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { withJobLock } from '../../src/runtime/lock';
import { silentLogger } from '../../src/runtime/log';

function fakePool(o: { unlockFails: boolean; busyTries?: number }) {
  const released: unknown[] = [];
  let tries = 0;
  const client = {
    async query(text: string) {
      if (text.includes('pg_try_advisory_lock')) return { rows: [{ ok: (tries += 1) > (o.busyTries ?? 0) }] };
      if (text.includes('pg_advisory_unlock') && o.unlockFails) throw new Error('connection terminated');
      return { rows: [{ pg_advisory_unlock: true }] };
    },
    release(err?: unknown) {
      released.push(err);
    },
  };
  return { pool: { connect: async () => client } as unknown as Pool, released };
}

describe('withJobLock', () => {
  it('returns a healthy connection to the pool after unlocking', async () => {
    const { pool, released } = fakePool({ unlockFails: false });
    expect(await withJobLock(pool, silentLogger, 'reconcile', async () => 1)).toEqual({ ran: true, value: 1 });
    expect(released).toEqual([undefined]);
  });

  it('destroys the connection when the unlock fails, so the session (and its advisory lock) ends', async () => {
    const { pool, released } = fakePool({ unlockFails: true });
    expect(await withJobLock(pool, silentLogger, 'reconcile', async () => 1)).toEqual({ ran: true, value: 1 });
    expect(released).toHaveLength(1);
    expect(released[0]).toBeTruthy();
  });

  it('still destroys the connection when both the job and the unlock fail, and rethrows the job error', async () => {
    const { pool, released } = fakePool({ unlockFails: true });
    await expect(
      withJobLock(pool, silentLogger, 'reconcile', async () => {
        throw new Error('job failed');
      }),
    ).rejects.toThrow('job failed');
    expect(released[0]).toBeTruthy();
  });
});

describe('withJobLock with a wait (fixr-cfo, re-check LOW 5: a tighten-only relay must not be skipped)', () => {
  it('without a wait, a busy lock skips at once (one try)', async () => {
    const { pool } = fakePool({ unlockFails: false, busyTries: 1 });
    expect(await withJobLock(pool, silentLogger, 'relay', async () => 1)).toEqual({ ran: false });
  });

  it('with a wait, retries until the lock frees, then runs', async () => {
    const { pool, released } = fakePool({ unlockFails: false, busyTries: 3 });
    expect(await withJobLock(pool, silentLogger, 'relay', async () => 'sent', { waitMs: 2_000, pollMs: 5 })).toEqual({ ran: true, value: 'sent' });
    expect(released).toEqual([undefined]);
  });

  it('gives up (skips) once the wait is over', async () => {
    const { pool, released } = fakePool({ unlockFails: false, busyTries: 1_000_000 });
    const started = Date.now();
    expect(await withJobLock(pool, silentLogger, 'relay', async () => 1, { waitMs: 60, pollMs: 10 })).toEqual({ ran: false });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(released).toEqual([undefined]);
  });
});

