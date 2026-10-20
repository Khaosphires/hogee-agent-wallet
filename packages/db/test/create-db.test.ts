import { describe, expect, it } from 'vitest';
import { createDb, payments } from '../src/index';

describe('createDb', () => {
  it('builds a drizzle client without connecting', async () => {
    // Port 1 on localhost: any connection attempt would fail. Creating the client must not try.
    const db = createDb('postgres://nobody:nobody@127.0.0.1:1/none');
    expect(db.$client.totalCount).toBe(0);
    expect(typeof db.select).toBe('function');
    await db.$client.end();
  });

  it('renders a query against the schema without a database', async () => {
    const db = createDb('postgres://nobody:nobody@127.0.0.1:1/none');
    const { sql } = db.select({ id: payments.id }).from(payments).toSQL();
    expect(sql).toBe('select "id" from "payments"');
    await db.$client.end();
  });

  it.each(['', '   '])('rejects an empty database URL (%j)', (url) => {
    expect(() => createDb(url)).toThrow(/databaseUrl is required/);
  });

  it('bounds the wait for a pooled connection when asked (the API sets it; no timeout by default)', async () => {
    const db = createDb('postgres://nobody:nobody@127.0.0.1:1/none', { connectionTimeoutMillis: 10_000 });
    expect(db.$client.options.connectionTimeoutMillis).toBe(10_000);
    await db.$client.end();
    const plain = createDb('postgres://nobody:nobody@127.0.0.1:1/none');
    expect(plain.$client.options.connectionTimeoutMillis ?? 0).toBe(0);
    await plain.$client.end();
    expect(() => createDb('postgres://x@localhost/x', { connectionTimeoutMillis: -1 })).toThrow(/connectionTimeoutMillis/);
  });

  it('rejects a non-positive pool size', () => {
    expect(() => createDb('postgres://x@localhost/x', { maxConnections: 0 })).toThrow(/maxConnections/);
  });
});
