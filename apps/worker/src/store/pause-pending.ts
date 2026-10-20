/**
 * A pause on its way holds back agent spends (re-check A-2). The officer's (or founder's) Treasury.pause is a
 * chain_actions row the relay signs; the agent-actions handler signs its spends before its own relay step, and the tick
 * can win the next minute's lock first. A spend signed meanwhile takes an earlier agent nonce and is mined before the
 * pause. So before the AGENT key signs a payment (agent-actions-sign.ts sendPayment, pacing.ts signAndSend), the worker
 * refuses while any Treasury.pause of this deployment (one Treasury covers all its facilities) is PENDING, BROADCAST or
 * INCLUDED without a revert: nothing is signed and the row waits for the next pass, as while halted. Lender, oracle and
 * relayer signing is not held back (the pause itself must stay signable).
 *
 * Counted: an unsigned or signed row not yet final whose revert_reason is empty (a row the relay refused, or one
 * finality marked REVERTED, is not). A safety-pause attempt counts while its request is open; a closed request's
 * attempts do not (its halt was resumed, and a front-run attempt stays BROADCAST for good: chain actions have no
 * CANCELLED state). A mined pause leaves INCLUDED once finalized; until then the treasury reads paused anyway, or, for
 * a reverted one, spends wait for finality to say so (fail closed).
 */
import { rows, type Pg } from './pg';
import { SAFETY_PAUSE_ID_PREFIX } from './safety-pause';
import { WORKER_SCHEMA } from './schema';

export class PausePendingError extends Error {
  override readonly name = 'PausePendingError';
  constructor(readonly actionId: string) {
    super(`a Treasury.pause is pending (${actionId}); agent spends wait until it is mined or refused`);
  }
}

/** The oldest pending Treasury.pause of this deployment (see the module doc), or null. */
export async function pendingPause(q: Pg, deployment: { readonly deploymentId: string; readonly chainId: number }): Promise<string | null> {
  const [row] = await rows<{ id: string }>(
    q,
    `select a.id from chain_actions a
       join facilities f on f.facility_id = a.facility_id
      where f.deployment_id = $1 and f.chain_id = $2
        and a.kind = 'Treasury.pause' and a.state in ('PENDING', 'BROADCAST', 'INCLUDED') and a.revert_reason is null
        and (a.id not like '${SAFETY_PAUSE_ID_PREFIX}%' or a.ref_id in (select s.id from ${WORKER_SCHEMA}.safety_pauses s where s.closed_at is null))
      order by a.created_at, a.id
      limit 1`,
    [deployment.deploymentId, deployment.chainId],
  );
  return row?.id ?? null;
}

/** Throws PausePendingError while a Treasury.pause of this deployment is pending. Call before the agent key signs a payment. */
export async function assertNoPendingPause(q: Pg, deployment: { readonly deploymentId: string; readonly chainId: number }): Promise<void> {
  const id = await pendingPause(q, deployment);
  if (id) throw new PausePendingError(id);
}
