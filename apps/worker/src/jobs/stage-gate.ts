/**
 * stage-gate (§12.4, every 10 min): when an unreleased funding stage's gate is met as the CHAIN counts it (revenue for
 * METRIC_SALES_MINOR; Treasury.revenueLedger().salesCount for METRIC_ORDERS, or the mirrored recorded sales where a
 * deployment predates that view; before the deadline),
 * open ONE RELEASE_STAGE exception for the loan officer. It grants nothing: the officer decides, and the relay re-checks
 * the gate on-chain before the lender key signs releaseStage.
 */
import { HOGEE_KINDS, iPlanRegistryAbi, iTreasuryAbi } from '@hogee/chain';
import { hexToString, parseAbi, type Hex } from 'viem';
import { poolOf, rows } from '../store/pg';
import { appendTrace } from '../store/trace';
import { uuidv7 } from '../runtime/ids';
import type { JobDeps } from './deps';

export const STAGE_GATE_JOB = 'stage-gate';

export interface StageGateReport {
  readonly facilityId: string;
  readonly opened: readonly string[];
  readonly error?: string;
}

const shortId = (b: Hex): string => hexToString(b, { size: 32 }).replace(/\0+$/, '');

/** Not frozen surface (task 1.8 ledger detail), so a local ABI. */
const ledgerAbi = parseAbi(['function revenueLedger() view returns (uint128 reserveSkimmedMinor, uint128 reserveWithdrawnMinor, uint64 salesCount)']);

async function ordersRecorded(d: JobDeps, facilityId: string): Promise<bigint> {
  try {
    const [, , salesCount] = await d.client.readContract({ address: d.deployment.contracts.Treasury.address, abi: ledgerAbi, functionName: 'revenueLedger' });
    return BigInt(salesCount);
  } catch {
    // older deployment without the view: the DB mirror of recorded, non-zero sales
  }
  const [r] = await rows<{ n: string }>(poolOf(d.db), `select count(*)::text as n from sales where facility_id = $1 and tx_hash is not null and amount_bucket > 0`, [facilityId]);
  return BigInt(r?.n ?? '0');
}

async function openForMetGates(d: JobDeps, facilityId: string): Promise<string[]> {
  const pool = poolOf(d.db);
  const registry = d.deployment.contracts.PlanRegistry.address;
  const [stageIds, revenue, block] = await Promise.all([
    d.client.readContract({ address: registry, abi: iPlanRegistryAbi, functionName: 'stageIds' }),
    d.client.readContract({ address: d.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: 'revenue' }),
    d.client.getBlock({ blockTag: 'latest' }),
  ]);
  const opened: string[] = [];
  for (const stageId of stageIds) {
    const [stage, released] = await d.client.readContract({ address: registry, abi: iPlanRegistryAbi, functionName: 'stage', args: [stageId] });
    if (released || stage.metric === HOGEE_KINDS.METRIC_NONE) continue;
    if (stage.deadline !== 0n && block.timestamp > stage.deadline) continue;
    const fact = stage.metric === HOGEE_KINDS.METRIC_SALES_MINOR ? revenue : await ordersRecorded(d, facilityId);
    if (fact < stage.target) continue;
    const sid = shortId(stageId);
    const [existing] = await rows(pool, `select 1 from exceptions where facility_id = $1 and kind = 'RELEASE_STAGE' and payload->>'stageId' = $2 and status in ('OPEN', 'APPROVED')`, [facilityId, sid]);
    if (existing) continue;
    const id = `exc-${uuidv7()}`;
    const traceId = `trace:exc:${id}`;
    await pool.query(
      `insert into exceptions (id, facility_id, kind, title, payload, requested_by, requires_founder, requires_lender, status, blast_radius_minor, trace_id)
       values ($1, $2, 'RELEASE_STAGE', $3, $4::jsonb, 'worker', false, true, 'OPEN', $5, $6)`,
      [id, facilityId, `Release funding ${sid}: its gate is met on-chain`, JSON.stringify({ stageId: sid }), stage.releaseMinor.toString(), traceId],
    );
    await appendTrace(pool, { facilityId, traceId, actor: 'worker', kind: 'EXCEPTION', verdict: 'NEEDS_OFFICER', reasonCode: 'STAGE_GATE_MET', summary: `Stage ${sid} gate met; the loan officer decides the release`, refs: {} });
    opened.push(id);
  }
  return opened;
}

/** One pass over this deployment's facilities. Never throws. */
export async function runStageGate(d: JobDeps, facilityIds: readonly string[]): Promise<StageGateReport[]> {
  const out: StageGateReport[] = [];
  for (const facilityId of facilityIds) {
    try {
      out.push({ facilityId, opened: await openForMetGates(d, facilityId) });
    } catch (error: unknown) {
      d.log.error('stage_gate_failed', { facilityId, error });
      out.push({ facilityId, opened: [], error: 'failed' });
    }
  }
  return out;
}
