/**
 * Consecutive-pass counter for rows whose finality outcome is a `pending` caused by a receipt from a non-canonical
 * block (packages/chain finality.ts). One such pass is normal around a reorg; a row that stays there for N passes is
 * stuck, and the reconcile job halts (task 1.6). Stored in the DB so a restart does not reset the count.
 */
import type { Pool } from 'pg';
import { inTransaction, rows } from './pg';
import { WORKER_SCHEMA } from './schema';

export interface WatchedRow {
  readonly table: string;
  readonly id: string;
}

export const watchKey = (r: WatchedRow): string => `${r.table}/${r.id}`;

/** The two consecutive-pass watches: non-canonical receipts, and unresolved settlement attestations (audit run-3). */
export type WatchName = 'noncanonical_watch' | 'unresolved_watch';

/**
 * Records one pass for `facilityId`: rows in `seen` get passes + 1 (1 when new); the facility's other rows are
 * forgotten (they recovered). Returns `<table>/<id>` → consecutive passes for the rows seen.
 */
export async function trackNonCanonical(pool: Pool, facilityId: string, seen: readonly WatchedRow[]): Promise<Map<string, number>> {
  return trackWatch(pool, 'noncanonical_watch', facilityId, seen);
}

/** Same counter for settlement attestations recovery or finality left `unresolved` (store: hogee_worker.unresolved_watch). */
export async function trackUnresolved(pool: Pool, facilityId: string, seen: readonly WatchedRow[]): Promise<Map<string, number>> {
  return trackWatch(pool, 'unresolved_watch', facilityId, seen);
}

async function trackWatch(pool: Pool, watch: WatchName, facilityId: string, seen: readonly WatchedRow[]): Promise<Map<string, number>> {
  const T = `${WORKER_SCHEMA}.${watch}`;
  return inTransaction(pool, async (c) => {
    const keys = new Set(seen.map(watchKey));
    const existing = await rows<{ target_table: string; row_id: string }>(c, `select target_table, row_id from ${T} where facility_id = $1 for update`, [facilityId]);
    for (const r of existing) {
      if (keys.has(watchKey({ table: r.target_table, id: r.row_id }))) continue;
      await c.query(`delete from ${T} where facility_id = $1 and target_table = $2 and row_id = $3`, [facilityId, r.target_table, r.row_id]);
    }
    const out = new Map<string, number>();
    for (const row of seen) {
      const [r] = await rows<{ passes: number }>(
        c,
        `insert into ${T} (facility_id, target_table, row_id, passes) values ($1, $2, $3, 1)
         on conflict (facility_id, target_table, row_id) do update set passes = ${T}.passes + 1, last_seen = now() returning passes`,
        [facilityId, row.table, row.id],
      );
      out.set(watchKey(row), Number(r?.passes ?? 1));
    }
    return out;
  });
}
