/**
 * The halt flag (task 1.6 alert-and-halt; the skill's kill switch). While a halt is active the worker signs nothing
 * new and pays nothing out: no pacing spend, no settlement, no nonce-hole cancel. Recovery still re-sends stored
 * bytes and finality still reads the chain (neither signs), and an orphan spend still drives the safety pause
 * (jobs/safety-pause.ts; tighten-only). A halt is visible in two places, the DB rows (the halt and its reasons) and
 * an `error` log line, and only an operator clears it (`pnpm --filter @hogee/worker ops resume --note … --ack-through …`).
 *
 * Raising and clearing are serialised on the halt row (security re-check M1): a reason joins the active halt under
 * FOR SHARE, in the same statement that records it, and a clear locks the halt FOR UPDATE, checks what it may
 * acknowledge and whether a safety pause of the halt is still open, then clears and acknowledges in one transaction.
 * So a reason (and the safety-pause request queued with it) can never land on a halt that is being cleared: it waits,
 * then starts a new halt.
 */
import type { Pool } from 'pg';
import type { Logger } from '../runtime/log';
import { inTransaction, jsonParam, rows, type Pg } from './pg';
import { closeSafetyPauses, openSafetyPausesOf, type SafetyPauseRequest } from './safety-pause';
import { WORKER_SCHEMA } from './schema';

export interface Halt {
  readonly id: string;
  readonly reason: string;
  readonly detail: Record<string, unknown>;
  readonly haltedAt: Date;
}

export class WorkerHaltedError extends Error {
  override readonly name = 'WorkerHaltedError';
  constructor(readonly halt: Halt) {
    super(`worker is halted (${halt.reason}); an operator must resume it`);
  }
}

interface HaltRow {
  id: string;
  reason: string;
  detail: Record<string, unknown> | null;
  halted_at: Date;
}

const T = `${WORKER_SCHEMA}.halts`;
const COLS = 'id, reason, detail, halted_at';
const toHalt = (r: HaltRow): Halt => ({ id: String(r.id), reason: r.reason, detail: r.detail ?? {}, haltedAt: new Date(r.halted_at) });

export async function activeHalt(q: Pg): Promise<Halt | null> {
  const [row] = await rows<HaltRow>(q, `select ${COLS} from ${T} where scope = 'global' and cleared_at is null`);
  return row ? toHalt(row) : null;
}

/** Throws WorkerHaltedError when a halt is active. Call before anything is signed or paid out. */
export async function assertNotHalted(q: Pg): Promise<void> {
  const halt = await activeHalt(q);
  if (halt) throw new WorkerHaltedError(halt);
}

export interface HaltReason {
  readonly id: string;
  readonly haltId: string;
  readonly reason: string;
  readonly detail: Record<string, unknown>;
  readonly raisedAt: Date;
  /** Set by the `ops resume` that cleared the halt. */
  readonly acknowledgedAt: Date | null;
  readonly acknowledgedBy: string | null;
}

interface HaltEventRow {
  id: string;
  halt_id: string;
  reason: string;
  detail: Record<string, unknown> | null;
  raised_at: Date;
  acknowledged_at: Date | null;
  acknowledged_by: string | null;
}

const E = `${WORKER_SCHEMA}.halt_events`;
const toReason = (r: HaltEventRow): HaltReason => ({
  id: String(r.id),
  haltId: String(r.halt_id),
  reason: r.reason,
  detail: r.detail ?? {},
  raisedAt: new Date(r.raised_at),
  acknowledgedAt: r.acknowledged_at ? new Date(r.acknowledged_at) : null,
  acknowledgedBy: r.acknowledged_by,
});

/** A new halt with `reason` as its first event, in ONE statement (a clear can never see the halt without it). */
async function insertHalt(q: Pg, reason: string, detail: string): Promise<Halt | null> {
  const [row] = await rows<HaltRow>(
    q,
    `with h as (
       insert into ${T} (reason, detail) values ($1, $2::jsonb) on conflict (scope) where cleared_at is null do nothing returning ${COLS}
     ), e as (
       insert into ${E} (halt_id, reason, detail) select h.id, h.reason, h.detail from h returning id
     )
     select h.*, (select count(*) from e) as events from h`,
    [reason, detail],
  );
  return row ? toHalt(row) : null;
}

/**
 * Records `reason` on the active halt unless the same reason with the same detail is already there, in ONE statement
 * that holds the halt row FOR SHARE (until the caller's transaction ends): a clear in progress makes it wait, and a halt
 * cleared meanwhile is not joined (null: start a new halt).
 */
async function joinActive(q: Pg, reason: string, detail: string): Promise<{ halt: Halt; recorded: boolean } | null> {
  const [row] = await rows<HaltRow & { recorded: string }>(
    q,
    `with h as (
       select ${COLS} from ${T} where scope = 'global' and cleared_at is null for share
     ), e as (
       insert into ${E} (halt_id, reason, detail)
       select h.id, $1, $2::jsonb from h
        where not exists (select 1 from ${E} x where x.halt_id = h.id and x.reason = $1 and x.detail = $2::jsonb)
       returning id
     )
     select h.*, (select count(*) from e) as recorded from h`,
    [reason, detail],
  );
  return row ? { halt: toHalt(row), recorded: Number(row.recorded) > 0 } : null;
}

/** Whether `reason` was ever recorded (on any halt, cleared or not) with a detail containing `detail`. */
export async function haltEverRecorded(q: Pg, reason: string, detail: Record<string, unknown>): Promise<boolean> {
  const [row] = await rows<{ found: boolean }>(q, `select exists (select 1 from ${E} where reason = $1 and detail @> $2::jsonb) as found`, [reason, jsonParam(detail)]);
  return row?.found === true;
}

/** Every reason recorded on a halt, oldest first. */
export async function haltReasons(q: Pg, haltId: string): Promise<HaltReason[]> {
  const out = await rows<HaltEventRow>(
    q,
    `select id, halt_id, reason, detail, raised_at, acknowledged_at, acknowledged_by from ${E} where halt_id = $1 order by id`,
    [haltId],
  );
  return out.map(toReason);
}

/**
 * Records a halt, or adds `reason` to the active one (`raised: false`). Every distinct reason is kept in
 * `halt_events` (`recorded`: this call added it; the same reason with the same detail is recorded once), so a second
 * fault raised during a halt is never dropped: `ops status` lists it until `ops resume` acknowledges it. A new halt is
 * logged at `error` level as `halt_raised`, a reason added to an active halt as `halt_reason_added`, so a log watcher
 * sees both even if nobody reads the tables.
 */
export async function raiseHalt(q: Pg, log: Logger, reason: string, detail: Record<string, unknown>): Promise<{ halt: Halt; raised: boolean; recorded: boolean }> {
  const json = jsonParam(detail);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const inserted = await insertHalt(q, reason, json);
    if (inserted) {
      log.error('halt_raised', { reason, detail, haltId: inserted.id, action: 'new signing and payouts stopped until `ops resume`' });
      return { halt: inserted, raised: true, recorded: true };
    }
    const joined = await joinActive(q, reason, json);
    if (joined) {
      const { halt, recorded } = joined;
      if (recorded) log.error('halt_reason_added', { reason, detail, haltId: halt.id, activeReason: halt.reason, action: 'listed by `ops status` until `ops resume`' });
      return { halt, raised: false, recorded };
    }
    // The active halt was cleared between the two statements: try again.
  }
  throw new Error('could not record the halt');
}

export interface ClearHaltOptions {
  readonly by: string;
  readonly note: string;
  /**
   * The last halt_events id the operator reviewed (what `ops status` showed). Reasons up to it are acknowledged; an
   * unacknowledged reason above it refuses the clear (`newer_events`). 'all' acknowledges whatever is there (tests and
   * harness teardown only: an operator always names the id).
   */
  readonly ackThrough: string | 'all';
  /** Close the halt's open safety-pause requests (`ABANDONED`) instead of refusing (`open_pauses`). */
  readonly abandonPause?: boolean;
}

export type ClearHaltResult =
  | { readonly status: 'none' }
  | { readonly status: 'newer_events'; readonly halt: Halt; readonly newer: readonly HaltReason[] }
  | { readonly status: 'open_pauses'; readonly halt: Halt; readonly open: readonly SafetyPauseRequest[] }
  | {
      readonly status: 'cleared';
      readonly halt: Halt;
      /** The reasons this call acknowledged. */
      readonly acknowledged: readonly HaltReason[];
      /** Safety-pause request ids closed as ABANDONED. */
      readonly abandoned: readonly string[];
    };

const EVENT_ID_RE = /^[0-9]{1,18}$/;

/**
 * Operator command: clears the active halt in ONE transaction that holds its row FOR UPDATE (so no reason can join it
 * meanwhile): refuses while an unacknowledged reason newer than `ackThrough` exists, or while a safety-pause request of
 * the halt is still open (unless `abandonPause`); else closes abandoned requests, clears the halt and acknowledges its
 * reasons up to `ackThrough` (two statements).
 */
export async function clearHalt(pool: Pool, log: Logger, o: ClearHaltOptions): Promise<ClearHaltResult> {
  if (o.ackThrough !== 'all' && !EVENT_ID_RE.test(o.ackThrough)) throw new RangeError('ackThrough must be a halt event id or "all"');
  const through = o.ackThrough === 'all' ? null : o.ackThrough;
  const result = await inTransaction(pool, async (c): Promise<ClearHaltResult> => {
    const [row] = await rows<HaltRow>(c, `select ${COLS} from ${T} where scope = 'global' and cleared_at is null for update`);
    if (!row) return { status: 'none' };
    const halt = toHalt(row);
    const pending = (await haltReasons(c, halt.id)).filter((r) => r.acknowledgedAt === null);
    const newer = through === null ? [] : pending.filter((r) => BigInt(r.id) > BigInt(through));
    if (newer.length > 0) return { status: 'newer_events', halt, newer };
    const open = await openSafetyPausesOf(c, halt.id);
    if (open.length > 0 && !o.abandonPause) return { status: 'open_pauses', halt, open };
    await closeSafetyPauses(c, open.map((r) => r.id), 'ABANDONED');
    await c.query(`update ${T} set cleared_at = now(), cleared_by = $2, clear_note = $3 where id = $1`, [halt.id, o.by, o.note]);
    await c.query(`update ${E} set acknowledged_at = now(), acknowledged_by = $2 where halt_id = $1 and acknowledged_at is null and ($3::bigint is null or id <= $3::bigint)`, [
      halt.id,
      o.by,
      through,
    ]);
    return { status: 'cleared', halt, acknowledged: pending, abandoned: open.map((r) => r.id) };
  });
  if (result.status === 'cleared') {
    const { halt, acknowledged, abandoned } = result;
    log.warn('halt_cleared', { haltId: halt.id, reason: halt.reason, reasons: acknowledged.map((r) => r.reason), abandonedPauses: abandoned, by: o.by, note: o.note });
  }
  return result;
}
