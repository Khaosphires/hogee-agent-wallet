/**
 * Parameterised SQL on the @hogee/db pool ($1, $2, …; never string-built from request values). Drizzle's typed
 * builders are used where they read better; these helpers cover locking, upserts and multi-statement transactions.
 */
import type { Db } from "@hogee/db";
import type { PoolClient, QueryResultRow } from "pg";

export type Q = Pick<PoolClient, "query">;

export async function rows<T extends QueryResultRow>(q: Q, text: string, values: readonly unknown[] = []): Promise<T[]> {
  const result = await q.query<T>(text, values as unknown[]);
  return result.rows;
}

export async function one<T extends QueryResultRow>(q: Q, text: string, values: readonly unknown[] = []): Promise<T | undefined> {
  return (await rows<T>(q, text, values))[0];
}

/** BEGIN … COMMIT on one pooled client; ROLLBACK and rethrow on any error. */
export async function inTx<T>(db: Db, fn: (q: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.$client.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** JSON with bigints as decimal strings, for jsonb parameters. */
export function jsonb(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

export const pool = (db: Db): Q => db.$client;
