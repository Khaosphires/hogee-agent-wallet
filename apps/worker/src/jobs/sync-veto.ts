/**
 * Vetoed loosenings reconciled with the chain (audit run-4 v-4; re-check M2, M3, L2). A veto writes CANCELLED before
 * its cancelLoosen lands, and the exception's co-signed queueLoosen (or a matured executeLoosen anyone may send) can
 * still land after it. For every CANCELLED exception whose queueLoosen was signed, that no finalized cancel of ours
 * closed and that is not reconciled yet, Treasury.queuedLoosen decides (decideVeto):
 * - read at `finalized`, a final outcome ends the watch with one trace on the exception: CANCELLED, EXPIRED, or a
 *   request that can no longer be queued (VETO_RECONCILED, an EXCEPTION trace); EXECUTED is an ALERT
 *   (VETOED_LOOSEN_EXECUTED). Not a halt: the founder and the lender both signed that loosening, so its execution is
 *   within what they authorised, not a breach of the agent's limits, and an anonymous veto followed by a
 *   permissionless executeLoosen must not be able to stop the worker;
 * - read at `latest`, a loosening still QUEUED with no live cancel gets a fresh cancelLoosen, at most
 *   MAX_CANCEL_REQUEUES times, then one ALERT (VETO_CANCEL_RETRIES_EXHAUSTED) for a human.
 * The traces are the scan's markers, so a reconciled veto is never read again.
 */
import { HOGEE_KINDS, iTreasuryAbi } from '@hogee/chain';
import { BaseError, ContractFunctionZeroDataError, type Hex } from 'viem';
import { uuidv7 } from '../runtime/ids';
import { rows, type Pg } from '../store/pg';
import { appendTrace, hasTrace } from '../store/trace';
import type { JobDeps } from './deps';
import { finalizedHead } from './settle-chain';

/** Cancels the worker re-queues for one vetoed loosening (beyond the API's own) before it asks a human. */
export const MAX_CANCEL_REQUEUES = 3;

export interface VetoFacts {
  /** Treasury.queuedLoosen(loosenId).status at the finalized block. */
  readonly finalizedStatus: number;
  /** The same at latest. */
  readonly latestStatus: number;
  /** Every signed queueLoosen's LoosenRequest expiry is before the finalized block: it can never be queued now. */
  readonly requestExpired: boolean;
  /** A cancelLoosen of this exception that is neither refused nor reverted. */
  readonly liveCancel: boolean;
  /** cancelLoosen actions of this exception: the API's one plus the worker's re-queues. */
  readonly cancels: number;
}

export type VetoStep =
  | { readonly kind: 'reconciled'; readonly reason: 'CANCELLED' | 'EXPIRED' | 'NEVER_QUEUED' }
  | { readonly kind: 'executed' }
  | { readonly kind: 'requeue' }
  | { readonly kind: 'exhausted' }
  | { readonly kind: 'wait' };

const { LOOSEN_STATUS_NONE: NONE, LOOSEN_STATUS_QUEUED: QUEUED, LOOSEN_STATUS_EXECUTED: EXECUTED, LOOSEN_STATUS_CANCELLED: CANCELLED, LOOSEN_STATUS_EXPIRED: EXPIRED } = HOGEE_KINDS;

/** Pure (module doc). */
export function decideVeto(f: VetoFacts): VetoStep {
  if (f.finalizedStatus === EXECUTED) return { kind: 'executed' };
  if (f.finalizedStatus === CANCELLED) return { kind: 'reconciled', reason: 'CANCELLED' };
  if (f.finalizedStatus === EXPIRED) return { kind: 'reconciled', reason: 'EXPIRED' };
  if (f.finalizedStatus === NONE && f.requestExpired) return { kind: 'reconciled', reason: 'NEVER_QUEUED' };
  if (f.latestStatus !== QUEUED || f.liveCancel) return { kind: 'wait' };
  return Math.max(0, f.cancels - 1) < MAX_CANCEL_REQUEUES ? { kind: 'requeue' } : { kind: 'exhausted' };
}

const RECONCILED = 'VETO_RECONCILED';
const EXECUTED_ALERT = 'VETOED_LOOSEN_EXECUTED';
const REQUEUED = 'VETOED_LOOSEN_QUEUED';
const EXHAUSTED = 'VETO_CANCEL_RETRIES_EXHAUSTED';

interface VetoedRow {
  id: string;
  loosen_id: string;
  trace_id: string;
  live_cancel: boolean;
  cancels: number;
  expiries: (string | null)[];
}

const UINT64_RE = /^(0|[1-9][0-9]{0,19})$/;

async function vetoedRows(q: Pg, facilityId: string): Promise<VetoedRow[]> {
  return rows<VetoedRow>(
    q,
    `select e.id, e.loosen_id, coalesce(e.trace_id, 'trace:exc:' || e.id) as trace_id,
            exists (select 1 from chain_actions c where c.facility_id = e.facility_id and c.kind = 'Treasury.cancelLoosen' and c.ref_id = e.id
                     and c.state <> 'REVERTED' and c.revert_reason is null) as live_cancel,
            (select count(*)::int from chain_actions c where c.facility_id = e.facility_id and c.kind = 'Treasury.cancelLoosen' and c.ref_id = e.id) as cancels,
            array(select a.request_json->'req'->>'expiry' from chain_actions a
                   where a.facility_id = e.facility_id and a.kind = 'Treasury.queueLoosen' and a.ref_id = e.id and a.raw_signed_tx is not null) as expiries
       from exceptions e
      where e.facility_id = $1 and e.status = 'CANCELLED' and e.loosen_id is not null
        and exists (select 1 from chain_actions a where a.facility_id = e.facility_id and a.kind = 'Treasury.queueLoosen' and a.ref_id = e.id and a.raw_signed_tx is not null)
        and not exists (select 1 from chain_actions c where c.facility_id = e.facility_id and c.kind = 'Treasury.cancelLoosen' and c.ref_id = e.id and c.state = 'FINALIZED')
        and not exists (select 1 from traces t where t.facility_id = e.facility_id and t.trace_id = coalesce(e.trace_id, 'trace:exc:' || e.id)
                         and t.reason_code in ('${RECONCILED}', '${EXECUTED_ALERT}'))`,
    [facilityId],
  );
}

/** One trace on the exception, once per reason code (the scan's markers and the alerts). */
async function traceOnce(d: JobDeps, q: Pg, facilityId: string, e: VetoedRow, t: { kind: 'ALERT' | 'EXCEPTION'; reasonCode: string; summary: string }): Promise<void> {
  if (await hasTrace(q, { facilityId, traceId: e.trace_id, reasonCode: t.reasonCode })) return;
  if (t.kind === 'ALERT') d.log.warn('vetoed_loosen_alert', { facilityId, exceptionId: e.id, reasonCode: t.reasonCode });
  await appendTrace(q, { facilityId, traceId: e.trace_id, actor: 'worker', kind: t.kind, reasonCode: t.reasonCode, summary: t.summary, refs: {} });
}

async function requeueCancel(d: JobDeps, q: Pg, facilityId: string, e: VetoedRow): Promise<void> {
  await q.query(`insert into chain_actions (id, facility_id, kind, ref_id, state, request_json) values ($1, $2, 'Treasury.cancelLoosen', $3, 'PENDING', $4::jsonb)`, [
    `act-${uuidv7()}`,
    facilityId,
    e.id,
    JSON.stringify({ v: 1, exceptionId: e.id, loosenId: e.loosen_id }),
  ]);
  await appendTrace(q, {
    facilityId,
    traceId: e.trace_id,
    actor: 'worker',
    kind: 'ALERT',
    reasonCode: REQUEUED,
    summary: `A vetoed loosening is queued on-chain and its cancel was refused: cancelling it again (re-queue ${Math.max(0, e.cancels - 1) + 1} of ${MAX_CANCEL_REQUEUES})`,
    refs: {},
  }).catch((error: unknown) => d.log.warn('trace_append_failed', { exceptionId: e.id, error }));
}

const requestExpiredAt = (expiries: readonly (string | null)[], finalizedAt: bigint): boolean =>
  expiries.length > 0 && expiries.every((x) => x !== null && UINT64_RE.test(x) && BigInt(x) < finalizedAt);

/** Reconciles the facility's vetoed loosenings (module doc). Throws on RPC errors (the next pass retries). */
export async function syncVetoedLoosens(d: JobDeps, q: Pg, facilityId: string): Promise<void> {
  const vetoed = await vetoedRows(q, facilityId);
  if (vetoed.length === 0) return;
  const treasury = d.deployment.contracts.Treasury.address;
  const head = await finalizedHead(d.client);
  const statusAt = async (loosenId: Hex, at: { blockNumber: bigint } | { blockTag: 'latest' }): Promise<number> => {
    try {
      return Number((await d.client.readContract({ address: treasury, abi: iTreasuryAbi, functionName: 'queuedLoosen', args: [loosenId], ...at })).status);
    } catch (error: unknown) {
      // A deployment younger than the finality depth has no Treasury code at `finalized` yet: nothing is final there.
      if (error instanceof BaseError && error.walk((x) => x instanceof ContractFunctionZeroDataError)) return NONE;
      throw error;
    }
  };
  for (const e of vetoed) {
    const loosenId = e.loosen_id as Hex;
    const finalizedStatus = await statusAt(loosenId, { blockNumber: head.number });
    const final = decideVeto({ finalizedStatus, latestStatus: finalizedStatus, requestExpired: requestExpiredAt(e.expiries, head.timestamp), liveCancel: true, cancels: e.cancels });
    const step = final.kind === 'wait' ? decideVeto({ finalizedStatus, latestStatus: await statusAt(loosenId, { blockTag: 'latest' }), requestExpired: false, liveCancel: e.live_cancel, cancels: e.cancels }) : final;
    switch (step.kind) {
      case 'executed':
        await traceOnce(d, q, facilityId, e, {
          kind: 'ALERT',
          reasonCode: EXECUTED_ALERT,
          summary: 'A vetoed loosening was executed on-chain (final): the console shows it cancelled, but the change the founder and lender signed applied. Review it; nothing was halted',
        });
        break;
      case 'reconciled':
        await traceOnce(d, q, facilityId, e, { kind: 'EXCEPTION', reasonCode: RECONCILED, summary: `The veto is final on-chain: the loosening is ${step.reason.toLowerCase().replace('_', ' ')}` });
        break;
      case 'requeue':
        await requeueCancel(d, q, facilityId, e);
        break;
      case 'exhausted':
        await traceOnce(d, q, facilityId, e, {
          kind: 'ALERT',
          reasonCode: EXHAUSTED,
          summary: `A vetoed loosening is still queued on-chain after ${MAX_CANCEL_REQUEUES} re-queued cancels: cancel it by hand (owner EOA, lender or observer) or pause`,
        });
        break;
      case 'wait':
        break;
    }
  }
}
