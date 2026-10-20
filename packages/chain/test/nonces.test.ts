import fc from 'fast-check';
import { keccak256, parseTransaction, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  allocateFromStore,
  FeeCapExceededError,
  fillNonceHoles,
  findHoles,
  normaliseNonceKey,
  seedFromStore,
  type NonceCountReader,
  type NonceKey,
  type NonceStore,
} from '../src/index';

const SIGNER: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const CHAIN = 31337;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/**
 * In-memory stand-in for the `nonces` table under READ COMMITTED:
 * - `lockNext` on a committed row takes the row lock (waits for the holder); on a missing row it returns
 *   null without locking, like `SELECT … FOR UPDATE` on no rows;
 * - `insertIfAbsent` waits for a concurrent inserter (unique-index wait), then does nothing if it committed;
 * - writes become visible on commit; a throw rolls them back; locks are released at the end.
 */
class FakeNonceDb {
  readonly rows = new Map<string, bigint>();
  private readonly queues = new Map<string, Promise<void>>();

  private async acquire(id: string): Promise<() => void> {
    const prev = this.queues.get(id) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queues.set(id, prev.then(() => mine));
    await prev;
    return release;
  }

  async transaction<T>(fn: (store: NonceStore) => Promise<T>): Promise<T> {
    const writes = new Map<string, bigint>();
    const held = new Map<string, () => void>();
    const id = (k: NonceKey) => `${k.signer}:${k.chainId}`;
    const lock = async (key: string) => {
      if (!held.has(key)) held.set(key, await this.acquire(key));
    };
    const store: NonceStore = {
      lockNext: async (k) => {
        await tick();
        const key = id(k);
        if (!held.has(key) && !this.rows.has(key)) return null;
        await lock(key);
        return writes.get(key) ?? this.rows.get(key) ?? null;
      },
      insertIfAbsent: async (k, next) => {
        const key = id(k);
        await lock(key);
        if (!this.rows.has(key) && !writes.has(key)) writes.set(key, next);
      },
      setNext: async (k, next) => {
        const key = id(k);
        if (!held.has(key)) throw new Error('setNext without the row lock');
        writes.set(key, next);
      },
    };
    try {
      const result = await fn(store);
      for (const [k, v] of writes) this.rows.set(k, v);
      return result;
    } finally {
      for (const release of held.values()) release();
    }
  }
}

function fakeChain(pending: number): NonceCountReader & { calls: number } {
  const chain = {
    calls: 0,
    async getTransactionCount() {
      chain.calls += 1;
      await tick(1);
      return pending;
    },
  };
  return chain;
}

const key = { signer: SIGNER, chainId: CHAIN };

describe('allocateFromStore (Postgres nonce allocator logic)', () => {
  it('initialises from the pending count on first use, then counts up without asking the chain', async () => {
    const db = new FakeNonceDb();
    const chain = fakeChain(7);
    const got: bigint[] = [];
    for (let i = 0; i < 3; i += 1) got.push(await db.transaction((s) => allocateFromStore(s, key, chain)));
    expect(got).toEqual([7n, 8n, 9n]);
    expect(chain.calls).toBe(1);
  });

  it('never hands out one nonce twice under 50 concurrent allocations (including a racing first use)', async () => {
    const db = new FakeNonceDb();
    const chain = fakeChain(3);
    const got = await Promise.all(Array.from({ length: 50 }, () => db.transaction((s) => allocateFromStore(s, key, chain))));
    const sorted = [...got].sort((a, b) => (a < b ? -1 : 1));
    expect(new Set(got.map(String)).size).toBe(50);
    expect(sorted).toEqual(Array.from({ length: 50 }, (_, i) => 3n + BigInt(i)));
  });

  it('gives the nonce back when the signing transaction rolls back', async () => {
    const db = new FakeNonceDb();
    const chain = fakeChain(0);
    await db.transaction((s) => allocateFromStore(s, key, chain));
    await expect(
      db.transaction(async (s) => {
        await allocateFromStore(s, key, chain);
        throw new Error('signer crashed before COMMIT');
      }),
    ).rejects.toThrow(/before COMMIT/);
    expect(await db.transaction((s) => allocateFromStore(s, key, chain))).toBe(1n);
  });

  it('keeps one row per key whatever the address casing', async () => {
    const db = new FakeNonceDb();
    const chain = fakeChain(0);
    await db.transaction((s) => allocateFromStore(s, { signer: SIGNER.toLowerCase() as Address, chainId: CHAIN }, chain));
    expect(await db.transaction((s) => allocateFromStore(s, key, chain))).toBe(1n);
    expect([...db.rows.keys()]).toEqual([`${SIGNER.toLowerCase()}:${CHAIN}`]);
    expect(() => normaliseNonceKey({ signer: SIGNER, chainId: 0 })).toThrow(/chainId/);
  });

  it('committed nonces stay unique and contiguous under random commit/rollback interleavings (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 25 }), fc.nat({ max: 1_000 }), async (commits, start) => {
        const db = new FakeNonceDb();
        const chain = fakeChain(start);
        const results = await Promise.allSettled(
          commits.map((commit) =>
            db.transaction(async (s) => {
              const n = await allocateFromStore(s, key, chain);
              await tick();
              if (!commit) throw new Error('rollback');
              return n;
            }),
          ),
        );
        const committed = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])).sort((a, b) => (a < b ? -1 : 1));
        expect(committed).toEqual(committed.map((_, i) => BigInt(start) + BigInt(i)));
        const next = await db.transaction((s) => allocateFromStore(s, key, chain));
        expect(next).toBe(BigInt(start) + BigInt(committed.length));
      }),
      { numRuns: 60 },
    );
  });
});

describe('seedFromStore (start-up nonce row, audit run-4)', () => {
  it('creates a missing row from the pending count, so a later use outside the allocator is visible', async () => {
    const db = new FakeNonceDb();
    expect(await db.transaction((s) => seedFromStore(s, key, fakeChain(4)))).toBe(4n);
    expect(db.rows.get(`${SIGNER.toLowerCase()}:${CHAIN}`)).toBe(4n);
    // The allocator then counts from the seeded row without asking the chain again.
    const chain = fakeChain(9);
    expect(await db.transaction((s) => allocateFromStore(s, key, chain))).toBe(4n);
    expect(chain.calls).toBe(0);
  });

  it('never moves an existing row (an outside use stays detectable, never absorbed)', async () => {
    const db = new FakeNonceDb();
    await db.transaction((s) => allocateFromStore(s, key, fakeChain(2)));
    const chain = fakeChain(10);
    expect(await db.transaction((s) => seedFromStore(s, key, chain))).toBe(3n);
    expect(chain.calls).toBe(0);
    expect(await db.transaction((s) => allocateFromStore(s, key, chain))).toBe(3n);
  });

  it('a seed racing a first allocation keeps one row and unique nonces', async () => {
    const db = new FakeNonceDb();
    const chain = fakeChain(5);
    const [, a, b] = await Promise.all([
      db.transaction((s) => seedFromStore(s, key, chain)),
      db.transaction((s) => allocateFromStore(s, key, chain)),
      db.transaction((s) => allocateFromStore(s, key, chain)),
    ]);
    expect([a, b].sort()).toEqual([5n, 6n]);
    expect(db.rows.get(`${SIGNER.toLowerCase()}:${CHAIN}`)).toBe(7n);
  });
});

describe('findHoles (gap detection)', () => {
  it('lists unheld nonces in [chainLatest, dbNext)', () => {
    expect(findHoles(5n, 9n, [5n, 7n])).toEqual([6n, 8n]);
    expect(findHoles(5n, 5n, [])).toEqual([]);
    expect(findHoles(5n, null, [])).toEqual([]);
    expect(findHoles(5n, 3n, [])).toEqual([]);
  });

  it('holes and held nonces partition the range (property)', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 1_000n }), fc.nat({ max: 40 }), fc.array(fc.nat({ max: 60 })), (from, len, offsets) => {
        const to = from + BigInt(len);
        const held = offsets.map((o) => from + BigInt(o));
        const holes = findHoles(from, to, held);
        const inRange = new Set(held.filter((n) => n < to).map(String));
        expect(holes.length + inRange.size).toBe(len);
        for (const hole of holes) expect(inRange.has(String(hole))).toBe(false);
      }),
    );
  });
});

describe('fillNonceHoles (no-op cancels through broadcast)', () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const fees = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };

  function node(replies: readonly (string | null)[]) {
    const queue = [...replies];
    const sent: Hex[] = [];
    return {
      sent,
      estimateFeesPerGas: async () => fees,
      sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }): Promise<Hex> => {
        sent.push(serializedTransaction);
        const details = queue.shift() ?? null;
        if (details === null) return keccak256(serializedTransaction);
        throw Object.assign(new Error('Transaction creation failed.'), { details });
      },
    };
  }

  it('sends a 0-value self-send per hole and maps the node replies of a re-run to statuses', async () => {
    const client = node([null, 'already known', 'nonce too low', 'replacement transaction underpriced']);
    const fills = await fillNonceHoles({ client, account, chainId: 31337, holes: [4n, 5n, 6n, 7n], capWei: 10n ** 12n });
    expect(fills.map((f) => [f.nonce, f.status])).toEqual([
      [4n, 'sent'],
      [5n, 'already_known'],
      [6n, 'nonce_consumed'],
      [7n, 'occupied'],
    ]);
    expect(fills.map((f) => f.txHash)).toEqual(client.sent.map((raw) => keccak256(raw)));
    for (const [i, raw] of client.sent.entries()) {
      const tx = parseTransaction(raw);
      expect(tx).toMatchObject({ nonce: 4 + i, to: account.address.toLowerCase(), gas: 21_000n });
      expect(tx.value ?? 0n).toBe(0n); // parseTransaction omits a zero value
    }
  });

  it('rethrows any other node error, and refuses fees above the cap before signing anything', async () => {
    await expect(fillNonceHoles({ client: node(['insufficient funds for gas']), account, chainId: 31337, holes: [0n], capWei: 10n ** 12n })).rejects.toThrow(
      /Transaction creation failed/,
    );
    const capped = node([]);
    await expect(fillNonceHoles({ client: capped, account, chainId: 31337, holes: [0n], capWei: 1n })).rejects.toThrow(FeeCapExceededError);
    expect(capped.sent).toEqual([]);
    expect(await fillNonceHoles({ client: capped, account, chainId: 31337, holes: [], capWei: 1n })).toEqual([]);
  });
});
