/**
 * relay / record-sale (task 1.12): the worker's half of the API outbox. For each facility of this deployment, every
 * UNSIGNED `PENDING` chain action the API created is checked against the product tables (relay-calls.ts), signed with
 * its role key through @hogee/chain signAndStore (Postgres nonce, raw tx stored before broadcast) and broadcast.
 * Recovery and finality (reconcile) move it on from there. A refused row is never signed: it keeps `PENDING` with a
 * `revert_reason` and an ALERT trace. A call whose simulation reverts is refused with the decoded Hogee error.
 * While halted only tighten-only kinds (pause, a vetoed loosening's cancel) are signed. The safety pause's own attempt
 * rows (`safety-pause:<request>:<n>`) are never taken (re-check A-1): reconcile's driver alone signs them (lender key
 * first, at MAX_SAFETY_FEE_GWEI, with its own bump and fresh-attempt rules; jobs/safety-pause.ts), never the relay at
 * the routine fee cap.
 * After each pass the facility's DB mirrors are synced from the chain (sync.ts).
 *
 * The record-sale pass takes at most RECORD_SALE_PER_PASS oracle rows per facility, least recently tried first (audit
 * run-9 lead 4; re-check review LOW 4): every sale queues one recordSale, signed by the oracle key on the nonce
 * sequence settlement confirmations share, so a burst of sales is drained a few per pass and the rest stay PENDING for
 * the next one (each sale wakes the queue, and its cron runs every minute). A row the pass tried but could not send
 * (an error, or a deferral) gets `updated_at = now()` (its last attempt), so it goes behind the rows not tried since:
 * rows that keep failing never hold the batch's head, and every row is tried at least once per ceil(PENDING / 10) passes.
 */
import { decodeRevertData, FeeCapExceededError, revertDataFromError, shortErrorReason, toTxRequest, type TxSigner } from '@hogee/chain';
import { sendAction } from '../chain/actions';
import { activeHalt } from '../store/halt';
import { poolOf, rows, type Pg } from '../store/pg';
import { SAFETY_PAUSE_ID_PREFIX } from '../store/safety-pause';
import { appendTrace } from '../store/trace';
import type { JobDeps } from './deps';
import { ORACLE_KINDS, RELAY_BUILDERS, RelayDeferral, RelayRefusal, TIGHTEN_KINDS, type RelayPlan, type RelayRow, type Role } from './relay-calls';
import { syncFacility } from './sync';

export const RELAY_JOB = 'relay';
/** Oracle rows (SalesOracle.recordSale) one record-sale pass takes per facility. */
export const RECORD_SALE_PER_PASS = 10;

export interface RelayOutcome {
  readonly actionId: string;
  readonly kind: string;
  readonly result: 'sent' | 'refused' | 'halted' | 'deferred' | 'error';
  readonly detail?: string;
}

export interface RelayReport {
  readonly facilityId: string;
  readonly actions: readonly RelayOutcome[];
}

interface ActionDbRow {
  id: string;
  kind: string;
  ref_id: string | null;
  request_json: unknown;
}

const signerOf = (d: JobDeps, role: Role): TxSigner => d.signers[role];
const traceIdOf = (row: RelayRow): string => {
  const t = (row.request as { traceId?: unknown } | null)?.traceId;
  return typeof t === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(t) ? t : `trace:act:${row.id}`;
};

async function refuse(d: JobDeps, facilityId: string, row: RelayRow, reason: string): Promise<RelayOutcome> {
  await poolOf(d.db).query(`update chain_actions set revert_reason = $3 where facility_id = $1 and id = $2 and raw_signed_tx is null`, [facilityId, row.id, `REFUSED: ${reason}`.slice(0, 200)]);
  await appendTrace(poolOf(d.db), { facilityId, traceId: traceIdOf(row), actor: 'worker', kind: 'ALERT', reasonCode: 'RELAY_REFUSED', summary: `${row.kind} not signed: ${reason}`, refs: {} }).catch(
    (error: unknown) => d.log.warn('trace_append_failed', { actionId: row.id, error }),
  );
  d.log.warn('relay_refused', { facilityId, actionId: row.id, kind: row.kind, reason });
  return { actionId: row.id, kind: row.kind, result: 'refused', detail: reason };
}

async function send(d: JobDeps, facilityId: string, row: RelayRow, plan: RelayPlan): Promise<RelayOutcome> {
  const ctx = { db: d.db, client: d.client, deployment: d.deployment, chainId: d.deployment.chainId, capWei: d.config.maxFeeWei };
  const spec = { facilityId, id: row.id, kind: row.kind, ...(row.refId ? { refId: row.refId } : {}), request: toTxRequest(plan.call, d.deployment.contracts) };
  const roles = plan.fallback ? [plan.role, plan.fallback] : [plan.role];
  let lastError: unknown;
  for (const role of roles) {
    try {
      const { stored, sent } = await sendAction(ctx, spec, signerOf(d, role));
      await appendTrace(poolOf(d.db), {
        facilityId,
        traceId: traceIdOf(row),
        actor: 'executor',
        kind: 'TX',
        summary: `${row.kind} signed by the ${role} key at nonce ${stored.nonce} and broadcast (${sent.status})`,
        refs: { txHash: stored.txHash },
      }).catch((error: unknown) => d.log.warn('trace_append_failed', { actionId: row.id, error }));
      return { actionId: row.id, kind: row.kind, result: 'sent', detail: stored.txHash };
    } catch (error: unknown) {
      lastError = error;
      const data = revertDataFromError(error);
      const decoded = data ? decodeRevertData(data) : null;
      if (decoded && !plan.fallback) {
        const args = decoded.args.length > 0 ? `(${decoded.args.map(String).join(',')})` : '';
        return refuse(d, facilityId, row, `simulation reverts ${decoded.name}${args}`);
      }
    }
  }
  throw lastError;
}

/** The rows the relay delivers: never a safety-pause attempt (reconcile's alone; see the module doc). */
const RELAYED_ROW = `id not like '${SAFETY_PAUSE_ID_PREFIX}%'`;

/** The relay queue keeps creation order (its kinds can depend on each other); record-sale goes by last attempt. */
const RELAY_ORDER = 'created_at, id';
const RECORD_SALE_ORDER = 'updated_at, created_at, id';

/** An unsent row the pass tried and could not send: its last attempt is now, so the next pass takes it last. */
async function markTried(d: JobDeps, facilityId: string, actionId: string): Promise<void> {
  await poolOf(d.db)
    .query(`update chain_actions set updated_at = now() where facility_id = $1 and id = $2 and state = 'PENDING' and raw_signed_tx is null`, [facilityId, actionId])
    .catch((error: unknown) => d.log.warn('relay_mark_tried_failed', { facilityId, actionId, error }));
}

async function relayFacility(d: JobDeps, facilityId: string, oracle: boolean): Promise<RelayReport> {
  const pool = poolOf(d.db);
  // Each queue reads only its own kinds; the record-sale queue at most RECORD_SALE_PER_PASS of them.
  const pending = await rows<ActionDbRow>(
    pool,
    `select id, kind, ref_id, request_json from chain_actions
      where facility_id = $1 and state = 'PENDING' and raw_signed_tx is null and revert_reason is null
        and (kind = any($2::text[])) = $3 and ${RELAYED_ROW}
      order by ${oracle ? RECORD_SALE_ORDER : RELAY_ORDER}
      limit $4`,
    [facilityId, [...ORACLE_KINDS], oracle, oracle ? RECORD_SALE_PER_PASS : null],
  );
  const halted = (await activeHalt(pool)) !== null;
  const out: RelayOutcome[] = [];
  for (const r of pending.filter((x) => ORACLE_KINDS.has(x.kind) === oracle)) {
    const row: RelayRow = { id: r.id, kind: r.kind, refId: r.ref_id, request: r.request_json };
    if (halted && !TIGHTEN_KINDS.has(row.kind)) {
      out.push({ actionId: row.id, kind: row.kind, result: 'halted' });
      continue;
    }
    try {
      const builder = RELAY_BUILDERS[row.kind];
      if (!builder) throw new RelayRefusal(`unknown action kind ${row.kind}`);
      out.push(await send(d, facilityId, row, await builder({ d, q: pool, facilityId, row })));
    } catch (error: unknown) {
      if (error instanceof RelayRefusal) out.push(await refuse(d, facilityId, row, error.reason));
      else if (error instanceof RelayDeferral) out.push({ actionId: row.id, kind: row.kind, result: 'deferred', detail: error.reason });
      else if (error instanceof FeeCapExceededError) out.push({ actionId: row.id, kind: row.kind, result: 'deferred', detail: 'FEE_CAP' });
      else {
        d.log.error('relay_failed', { facilityId, actionId: row.id, kind: row.kind, error });
        out.push({ actionId: row.id, kind: row.kind, result: 'error', detail: shortErrorReason(error) });
      }
    }
    const last = out.at(-1);
    if (oracle && (last?.result === 'error' || last?.result === 'deferred')) await markTried(d, facilityId, row.id);
  }
  return { facilityId, actions: out };
}

/** One pass of the relay (or, with `oracle`, the record-sale queue) over this deployment's facilities. Never throws. */
export async function runRelay(d0: JobDeps, facilityIds: readonly string[], opts: { oracle?: boolean } = {}): Promise<RelayReport[]> {
  const d: JobDeps = { ...d0, log: d0.log.child({ job: opts.oracle ? 'record-sale' : RELAY_JOB }) };
  const reports: RelayReport[] = [];
  for (const facilityId of facilityIds) {
    const report = await relayFacility(d, facilityId, opts.oracle === true).catch((error: unknown): RelayReport => {
      d.log.error('relay_facility_failed', { facilityId, error });
      return { facilityId, actions: [] };
    });
    await syncFacility(d, facilityId).catch((error: unknown) => d.log.error('sync_failed', { facilityId, error }));
    if (report.actions.length > 0) d.log.info('relay_done', { facilityId, actions: report.actions });
    reports.push(report);
  }
  return reports;
}

/**
 * True when one of `facilityIds` has a tighten-only row (pause, cancelLoosen) the relay delivers and has not signed or
 * refused yet: the relay wake then waits for the job lock instead of being skipped and runs another pass for it
 * (runtime/relay-wake.ts), and the job-lock waiters give way to it (runtime/job-locks.ts). A safety-pause attempt is
 * never one (re-check A-1): the relay does not sign it, and reconcile, which does, must not give way to it.
 */
export async function hasPendingTighten(q: Pg, facilityIds: readonly string[]): Promise<boolean> {
  if (facilityIds.length === 0) return false;
  const found = await rows<{ x: number }>(
    q,
    `select 1 as x from chain_actions
      where facility_id = any($1::text[]) and state = 'PENDING' and raw_signed_tx is null and revert_reason is null
        and kind = any($2::text[]) and ${RELAYED_ROW}
      limit 1`,
    [[...facilityIds], [...TIGHTEN_KINDS]],
  );
  return found.length > 0;
}
