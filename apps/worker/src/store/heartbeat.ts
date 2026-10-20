/** Heartbeats: one upserted row per (job, scope) with the latest status, a beat count and a short detail. */
import { jsonParam, rows, type Pg } from './pg';
import { WORKER_SCHEMA } from './schema';

export interface Heartbeat {
  readonly job: string;
  /** A facility id, or `global`. */
  readonly scope: string;
  readonly status: string;
  readonly detail: Record<string, unknown>;
}

export interface HeartbeatRow extends Heartbeat {
  readonly beatAt: Date;
  readonly beats: number;
}

const T = `${WORKER_SCHEMA}.heartbeats`;

export async function writeHeartbeat(q: Pg, b: Heartbeat): Promise<void> {
  await q.query(
    `insert into ${T} (job, scope, status, detail) values ($1, $2, $3, $4::jsonb)
     on conflict (job, scope) do update set beat_at = now(), beats = ${T}.beats + 1, status = excluded.status, detail = excluded.detail`,
    [b.job, b.scope, b.status, jsonParam(b.detail)],
  );
}

export async function readHeartbeats(q: Pg): Promise<HeartbeatRow[]> {
  const out = await rows<{ job: string; scope: string; status: string; detail: Record<string, unknown>; beat_at: Date; beats: string }>(
    q,
    `select job, scope, status, detail, beat_at, beats from ${T} order by job, scope`,
  );
  return out.map((x) => ({ job: x.job, scope: x.scope, status: x.status, detail: x.detail, beatAt: new Date(x.beat_at), beats: Number(x.beats) }));
}
