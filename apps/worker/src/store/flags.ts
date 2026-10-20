/**
 * Operator / demo flags (hogee_worker.flags, written by the API's DEMO_MODE routes, read here): `autonomy`
 * ({running}) gates the autonomous tick, `crash_next_broadcast` ({armed}) makes the process exit right after its next
 * broadcast (the crash-recovery demo: the signed bytes are stored before they are sent, so recovery resumes them).
 * Flags never grant anything: they can only stop work or stop the process.
 */
import { rows, type Pg } from './pg';
import { WORKER_SCHEMA } from './schema';

export const AUTONOMY_FLAG = 'autonomy';
export const CRASH_FLAG = 'crash_next_broadcast';

export async function readFlag<T>(q: Pg, name: string): Promise<T | undefined> {
  const [r] = await rows<{ value: T }>(q, `select value from ${WORKER_SCHEMA}.flags where name = $1`, [name]);
  return r?.value;
}

export async function writeFlag(q: Pg, name: string, value: unknown): Promise<void> {
  await q.query(`insert into ${WORKER_SCHEMA}.flags (name, value) values ($1, $2::jsonb) on conflict (name) do update set value = excluded.value, updated_at = now()`, [
    name,
    JSON.stringify(value),
  ]);
}

/** Absent = running (the always-on loop); only an explicit {running: false} stops the tick. */
export async function autonomyRunning(q: Pg): Promise<boolean> {
  const v = await readFlag<{ running?: unknown }>(q, AUTONOMY_FLAG);
  return v?.running !== false;
}

/** Atomically disarms the crash flag; true when it was armed (exactly one broadcast triggers it). */
export async function consumeCrashFlag(q: Pg): Promise<boolean> {
  const [r] = await rows<{ name: string }>(q, `delete from ${WORKER_SCHEMA}.flags where name = $1 and value->>'armed' = 'true' returning name`, [CRASH_FLAG]);
  return r !== undefined;
}
