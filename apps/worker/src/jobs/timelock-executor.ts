/**
 * timelock-executor (§12.4, every minute): for each loosening the officer approved that the chain shows QUEUED and
 * past its executableAt (and not past its grace end), queue one unsigned Treasury.executeLoosen action (ref = the
 * loosenId). The relay re-checks the exception and the chain before the relayer signs; sync marks EXECUTED.
 * A WITHDRAW_RESERVE loosening moves value, so the sender's spend guard never sends its executeLoosen as a plain
 * chain action: it is left to its executor (anyone may call executeLoosen) and settled by adoption (settle-adopt.ts).
 */
import { iTreasuryAbi } from '@hogee/chain';
import { HOGEE_KINDS } from '@hogee/chain';
import type { Hex } from 'viem';
import { poolOf, rows } from '../store/pg';
import { appendTrace } from '../store/trace';
import { uuidv7 } from '../runtime/ids';
import type { JobDeps } from './deps';

export const TIMELOCK_EXECUTOR_JOB = 'timelock-executor';

export interface TimelockReport {
  readonly facilityId: string;
  readonly queued: readonly string[];
  readonly error?: string;
}

async function executeMatured(d: JobDeps, facilityId: string): Promise<string[]> {
  const pool = poolOf(d.db);
  const open = await rows<{ id: string; loosen_id: string }>(
    pool,
    `select e.id, e.loosen_id from exceptions e
      where e.facility_id = $1 and e.loosen_id is not null and e.status in ('QUEUED', 'EXECUTABLE') and e.kind <> 'WITHDRAW_RESERVE'
        and not exists (select 1 from chain_actions a where a.facility_id = e.facility_id and a.kind = 'Treasury.executeLoosen'
                          and a.ref_id = e.loosen_id and a.state <> 'REVERTED' and a.revert_reason is null)`,
    [facilityId],
  );
  if (open.length === 0) return [];
  const now = (await d.client.getBlock({ blockTag: 'latest' })).timestamp;
  const queued: string[] = [];
  for (const e of open) {
    const ql = await d.client.readContract({ address: d.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: 'queuedLoosen', args: [e.loosen_id as Hex] });
    if (Number(ql.status) !== HOGEE_KINDS.LOOSEN_STATUS_QUEUED || now < ql.executableAt || now > ql.expiresAt) continue;
    const id = `act-${uuidv7()}`;
    await pool.query(`insert into chain_actions (id, facility_id, kind, ref_id, state, request_json) values ($1, $2, 'Treasury.executeLoosen', $3, 'PENDING', $4::jsonb)`, [
      id,
      facilityId,
      e.loosen_id,
      JSON.stringify({ v: 1, exceptionId: e.id, loosenId: e.loosen_id }),
    ]);
    await appendTrace(pool, { facilityId, traceId: `trace:exc:${e.id}`, actor: 'worker', kind: 'EXCEPTION', summary: 'Timelock passed: executing the approved loosening', refs: {} });
    queued.push(id);
  }
  return queued;
}

/** One pass over this deployment's facilities. Never throws. */
export async function runTimelockExecutor(d: JobDeps, facilityIds: readonly string[]): Promise<TimelockReport[]> {
  const out: TimelockReport[] = [];
  for (const facilityId of facilityIds) {
    try {
      out.push({ facilityId, queued: await executeMatured(d, facilityId) });
    } catch (error: unknown) {
      d.log.error('timelock_executor_failed', { facilityId, error });
      out.push({ facilityId, queued: [], error: 'failed' });
    }
  }
  return out;
}
