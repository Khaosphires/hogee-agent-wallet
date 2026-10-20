/**
 * Agent-key use outside the allocator (security re-check M4; T29). The agent key is the one presumed leaked, so its use
 * outside the worker halts at once and queues a safety pause (jobs/safety-pause.ts), without waiting for the orphan
 * watch to read a money-moving event at `finalized`. The pause only tightens: a false positive costs one founder +
 * lender unpause. The oracle, lender and relayer keys stay alert-only (EXTERNAL_KEY_USE, halt-rules.ts).
 *
 * Why the worker itself never trips it: the allocator commits a signer's next_nonce in the same transaction that
 * stores the signed bytes, before anything is broadcast (@hogee/chain sender.signAndStore); a crash leaves either
 * nothing or the stored tx with its nonce already counted. inspectNonces reads the chain before the DB, so a send
 * that races the check is counted too. Hole-fill cancels only use nonces below next_nonce, and the safety pause
 * raises next_nonce to the pending count (checking the agent key first) before it signs. So a pending count above
 * next_nonce is a tx the worker never signed.
 *
 * The halt reason, its safety-pause request (`agent-key:<signer>:<first unallocated nonce>`), the raised next_nonce
 * and an ALERT trace on every facility are written in ONE transaction: a crash can neither lose the finding nor
 * report it twice, and once next_nonce is raised the same use is not found again (a resume does not re-halt it).
 */
import { inspectNonces, type NonceInspection } from '@hogee/chain';
import type { Pool } from 'pg';
import type { Address } from 'viem';
import type { Logger } from '../runtime/log';
import { raiseHalt } from '../store/halt';
import { inTransaction, poolOf } from '../store/pg';
import { queueSafetyPause } from '../store/safety-pause';
import { appendTrace } from '../store/trace';
import type { JobDeps } from './deps';
import { agentKeyPauseId, judgeAgentKeyUse, type Finding } from './halt-rules';

export interface AgentKeyUse {
  readonly signer: Address;
  readonly chainId: number;
  /** nonces.next_nonce when the use was found: the first nonce the allocator never handed out. */
  readonly dbNext: bigint;
  /** The chain's pending count: next_nonce is raised to it. */
  readonly chainPending: bigint;
}

/** Halt reason + safety-pause request + raised next_nonce + an ALERT trace per facility, in one transaction. */
export async function recordAgentKeyUse(pool: Pool, log: Logger, use: AgentKeyUse, facilityIds: readonly string[]): Promise<Finding> {
  const finding = judgeAgentKeyUse({ signer: use.signer, dbNext: use.dbNext, chainPending: use.chainPending, externalUse: use.chainPending > use.dbNext });
  if (!finding) throw new RangeError('not an agent key use: the pending count is not above next_nonce');
  const signer = use.signer.toLowerCase();
  const id = agentKeyPauseId(signer, use.dbNext);
  await inTransaction(pool, async (c) => {
    const { halt } = await raiseHalt(c, log, finding.reason, finding.detail);
    await queueSafetyPause(c, { id, haltId: halt.id, reason: finding.reason, detail: finding.detail });
    await c.query('update nonces set next_nonce = greatest(next_nonce, $3) where signer_address = $1 and chain_id = $2', [signer, use.chainId, use.chainPending.toString()]);
    for (const facilityId of facilityIds) {
      await appendTrace(c, {
        facilityId,
        traceId: `alert:${id}`,
        actor: 'reconciler',
        kind: 'ALERT',
        reasonCode: finding.reason,
        summary: `agent key nonces ${use.dbNext}..${use.chainPending - 1n} used outside the worker's allocator; worker halted, treasury pause queued`,
        refs: {},
      });
    }
  });
  return finding;
}

/** Reads the agent key's nonces; a use outside the allocator is recorded at once (recordAgentKeyUse). */
export async function checkAgentKey(d: JobDeps, facilityIds: readonly string[]): Promise<{ inspection: NonceInspection; finding: Finding | null }> {
  const inspection = await inspectNonces(d.db, { signer: d.signers.agent.address, chainId: d.deployment.chainId, client: d.client });
  if (!judgeAgentKeyUse(inspection) || inspection.dbNext === null) return { inspection, finding: null };
  const use = { signer: inspection.signer, chainId: d.deployment.chainId, dbNext: inspection.dbNext, chainPending: inspection.chainPending };
  return { inspection, finding: await recordAgentKeyUse(poolOf(d.db), d.log, use, facilityIds) };
}
