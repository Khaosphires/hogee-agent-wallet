/**
 * Worker-owned tables in their own schema, `hogee_worker` (like pg-boss keeps `pgboss`). They hold operational state
 * only: the halt flag and its reasons, orphan safety-pause requests, heartbeats, the non-canonical receipt watch and
 * the mock rail's payouts. The product data model stays in packages/db (frozen migration 0000 is never edited).
 * Idempotent DDL, run at worker start under an advisory lock so two workers starting together do not race.
 *
 * TODO(lead): if these tables should be visible to the API/UI through Drizzle, move them into an additive
 * packages/db migration; the column names here are the proposal.
 */
import type { Pool } from 'pg';
import { inTransaction } from './pg';

export const WORKER_SCHEMA = 'hogee_worker';
/** Advisory lock key of the startup migration (two workers starting together take turns). */
export const WORKER_MIGRATE_LOCK = 0x4e0_1e60;

const DDL: readonly string[] = [
  `CREATE SCHEMA IF NOT EXISTS ${WORKER_SCHEMA}`,
  // Alert-and-halt (task 1.6): at most one active halt per scope; operators clear it with `pnpm ops resume`.
  `CREATE TABLE IF NOT EXISTS ${WORKER_SCHEMA}.halts (
     id bigserial PRIMARY KEY,
     scope text NOT NULL DEFAULT 'global',
     reason text NOT NULL,
     detail jsonb NOT NULL DEFAULT '{}'::jsonb,
     halted_at timestamptz NOT NULL DEFAULT now(),
     cleared_at timestamptz,
     cleared_by text,
     clear_note text,
     CHECK ((cleared_at IS NULL) = (cleared_by IS NULL))
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS halts_one_active ON ${WORKER_SCHEMA}.halts (scope) WHERE cleared_at IS NULL`,
  // Every reason raised while a halt is active (the halt row keeps its first one): `ops status` lists the ones no
  // `ops resume` has acknowledged yet, so a second fault (say an orphan spend during a manual halt) is never hidden.
  `CREATE TABLE IF NOT EXISTS ${WORKER_SCHEMA}.halt_events (
     id bigserial PRIMARY KEY,
     halt_id bigint NOT NULL,
     reason text NOT NULL,
     detail jsonb NOT NULL DEFAULT '{}'::jsonb,
     raised_at timestamptz NOT NULL DEFAULT now(),
     acknowledged_at timestamptz,
     acknowledged_by text,
     CHECK ((acknowledged_at IS NULL) = (acknowledged_by IS NULL))
   )`,
  `CREATE INDEX IF NOT EXISTS halt_events_by_halt ON ${WORKER_SCHEMA}.halt_events (halt_id, id)`,
  // Halts raised before halt_events existed: their first reason becomes an event (acknowledged if already cleared).
  `INSERT INTO ${WORKER_SCHEMA}.halt_events (halt_id, reason, detail, raised_at, acknowledged_at, acknowledged_by)
     SELECT h.id, h.reason, h.detail, h.halted_at, h.cleared_at, h.cleared_by FROM ${WORKER_SCHEMA}.halts h
      WHERE NOT EXISTS (SELECT 1 FROM ${WORKER_SCHEMA}.halt_events e WHERE e.halt_id = h.id)`,
  // Orphan safety pauses (T29): one request per orphan log (`orphan:<txHash>:<logIndex>`), queued in the same
  // transaction as its halt reason, driven by reconcile until Treasury.paused() reads true (or its halt is resumed).
  `CREATE TABLE IF NOT EXISTS ${WORKER_SCHEMA}.safety_pauses (
     id text PRIMARY KEY,
     halt_id bigint NOT NULL,
     reason text NOT NULL,
     detail jsonb NOT NULL DEFAULT '{}'::jsonb,
     created_at timestamptz NOT NULL DEFAULT now(),
     attempts integer NOT NULL DEFAULT 0,
     last_attempt_id text,
     last_error text,
     updated_at timestamptz NOT NULL DEFAULT now(),
     closed_at timestamptz,
     closed_reason text,
     CHECK ((closed_at IS NULL) = (closed_reason IS NULL))
   )`,
  `CREATE INDEX IF NOT EXISTS safety_pauses_open ON ${WORKER_SCHEMA}.safety_pauses (halt_id) WHERE closed_at IS NULL`,
  // One row per (job, scope): the latest beat, a running count and a short detail (task 1.7 "heartbeat visible").
  `CREATE TABLE IF NOT EXISTS ${WORKER_SCHEMA}.heartbeats (
     job text NOT NULL,
     scope text NOT NULL,
     beat_at timestamptz NOT NULL DEFAULT now(),
     beats bigint NOT NULL DEFAULT 1,
     status text NOT NULL,
     detail jsonb NOT NULL DEFAULT '{}'::jsonb,
     PRIMARY KEY (job, scope)
   )`,
  // Rows whose finality pass keeps seeing a receipt from a non-canonical block: consecutive passes per row.
  `CREATE TABLE IF NOT EXISTS ${WORKER_SCHEMA}.noncanonical_watch (
     facility_id text NOT NULL,
     target_table text NOT NULL,
     row_id text NOT NULL,
     passes integer NOT NULL,
     first_seen timestamptz NOT NULL DEFAULT now(),
     last_seen timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (facility_id, target_table, row_id)
   )`,
  // Settlement attestations (settle-confirm / settle-fail) left `unresolved`: consecutive passes per row (audit run-3).
  `CREATE TABLE IF NOT EXISTS ${WORKER_SCHEMA}.unresolved_watch (
     facility_id text NOT NULL,
     target_table text NOT NULL,
     row_id text NOT NULL,
     passes integer NOT NULL,
     first_seen timestamptz NOT NULL DEFAULT now(),
     last_seen timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (facility_id, target_table, row_id)
   )`,
  // The worker's PUBLIC role addresses per deployment, written at start-up (never a key). The API reads the agent
  // (PlanApproval.agent of a new plan) and the relayer (the sender it simulates relayed calls from).
  `CREATE TABLE IF NOT EXISTS ${WORKER_SCHEMA}.roles (
     deployment_id text NOT NULL,
     chain_id integer NOT NULL,
     role text NOT NULL CHECK (role IN ('agent', 'oracle', 'lender', 'relayer')),
     address text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
     updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (deployment_id, chain_id, role)
   )`,
  // Operator / demo switches the API sets through a worker-control job (autonomy on/off, crash-next-broadcast).
  `CREATE TABLE IF NOT EXISTS ${WORKER_SCHEMA}.flags (
     name text PRIMARY KEY,
     value jsonb NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  // MockRail's payouts, keyed like Xendit by the idempotency key (§9.1): same key → the original payout.
  `CREATE TABLE IF NOT EXISTS ${WORKER_SCHEMA}.mock_payouts (
     idempotency_key text PRIMARY KEY,
     payout_id text NOT NULL UNIQUE,
     reference_id text NOT NULL,
     amount_minor numeric(39,0) NOT NULL CHECK (amount_minor > 0),
     currency text NOT NULL,
     destination text NOT NULL,
     status text NOT NULL,
     failure_code text,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
];

/**
 * lock_timeout / statement_timeout of the migration transaction (re-check L6): another worker starting at the same time
 * may hold the migration lock while it runs the DDL, longer than the pool's short session lock_timeout (5 s default).
 */
export const MIGRATE_TIMEOUT_MS = 120_000;

export async function migrateWorkerSchema(pool: Pool): Promise<void> {
  await inTransaction(pool, async (c) => {
    await c.query(`select set_config('lock_timeout', $1, true), set_config('statement_timeout', $1, true)`, [String(MIGRATE_TIMEOUT_MS)]);
    await c.query('select pg_advisory_xact_lock($1)', [WORKER_MIGRATE_LOCK]);
    for (const statement of DDL) await c.query(statement);
  });
}
