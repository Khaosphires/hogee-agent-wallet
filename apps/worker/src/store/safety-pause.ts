/**
 * Orphan safety-pause requests (T29), in `hogee_worker.safety_pauses`. The orphan watch queues one per orphan log, in
 * the same transaction as the halt reason it raises; reconcile drives the open ones (jobs/safety-pause.ts) until
 * Treasury.paused() reads true, and closes them when their halt is resumed. Plain parameterised SQL.
 */
import { jsonParam, rows, type Pg } from './pg';
import { WORKER_SCHEMA } from './schema';

/**
 * Prefix of the driver's chain_actions attempt ids (`safety-pause:<request>:<n>`, jobs/safety-pause.ts). Those rows are
 * reconcile's alone: the relay never takes them, nor waits or gives way for them (jobs/relay.ts, re-check A-1). An API
 * action id (`act-…`) never starts with it.
 */
export const SAFETY_PAUSE_ID_PREFIX = 'safety-pause:';

export interface SafetyPauseRequest {
  /** `orphan:<txHash>:<logIndex>`: a second orphan (even after a resume) gets its own request. */
  readonly id: string;
  /** The halt the orphan raised or joined; the request is live only while that halt is active. */
  readonly haltId: string;
  readonly reason: string;
  readonly detail: Record<string, unknown>;
  readonly attempts: number;
  /** chain_actions id of the latest attempt (`safety-pause:<id>:<n>`), null before the first. */
  readonly lastAttemptId: string | null;
  readonly lastError: string | null;
  readonly createdAt: Date;
}

/** `ABANDONED`: an operator resumed the halt with `--abandon-pause` before Treasury.paused() was confirmed. */
export type SafetyPauseClose = 'PAUSED' | 'HALT_CLEARED' | 'ABANDONED';

interface Row {
  id: string;
  halt_id: string;
  reason: string;
  detail: Record<string, unknown> | null;
  attempts: number;
  last_attempt_id: string | null;
  last_error: string | null;
  created_at: Date;
}

const T = `${WORKER_SCHEMA}.safety_pauses`;
const toRequest = (r: Row): SafetyPauseRequest => ({
  id: r.id,
  haltId: String(r.halt_id),
  reason: r.reason,
  detail: r.detail ?? {},
  attempts: Number(r.attempts),
  lastAttemptId: r.last_attempt_id,
  lastError: r.last_error,
  createdAt: new Date(r.created_at),
});

/** Queues a request unless it exists (a re-read log chunk queues nothing twice). True when this call queued it. */
export async function queueSafetyPause(q: Pg, r: { id: string; haltId: string; reason: string; detail: Record<string, unknown> }): Promise<boolean> {
  const out = await rows<{ id: string }>(
    q,
    `insert into ${T} (id, halt_id, reason, detail) values ($1, $2, $3, $4::jsonb) on conflict (id) do nothing returning id`,
    [r.id, r.haltId, r.reason, jsonParam(r.detail)],
  );
  return out.length === 1;
}

/** Open requests, oldest first. */
export async function openSafetyPauses(q: Pg): Promise<SafetyPauseRequest[]> {
  const out = await rows<Row>(
    q,
    `select id, halt_id::text as halt_id, reason, detail, attempts, last_attempt_id, last_error, created_at from ${T} where closed_at is null order by created_at, id`,
  );
  return out.map(toRequest);
}

/** Open requests of one halt, oldest first. */
export async function openSafetyPausesOf(q: Pg, haltId: string): Promise<SafetyPauseRequest[]> {
  const out = await rows<Row>(
    q,
    `select id, halt_id::text as halt_id, reason, detail, attempts, last_attempt_id, last_error, created_at from ${T} where closed_at is null and halt_id = $1 order by created_at, id`,
    [haltId],
  );
  return out.map(toRequest);
}

export async function closeSafetyPauses(q: Pg, ids: readonly string[], reason: SafetyPauseClose): Promise<void> {
  if (ids.length === 0) return;
  await q.query(`update ${T} set closed_at = now(), closed_reason = $2, updated_at = now() where id = any($1) and closed_at is null`, [ids, reason]);
}

/** Records the latest attempt id (and the attempt count) or the latest failure of a request. */
export async function noteSafetyPause(q: Pg, id: string, n: { attempts?: number; lastAttemptId?: string; lastError?: string | null }): Promise<void> {
  await q.query(
    `update ${T} set attempts = coalesce($2, attempts), last_attempt_id = coalesce($3, last_attempt_id),
       last_error = case when $5 then $4 else last_error end, updated_at = now() where id = $1`,
    [id, n.attempts ?? null, n.lastAttemptId ?? null, n.lastError ?? null, n.lastError !== undefined],
  );
}
