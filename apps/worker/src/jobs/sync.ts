/**
 * DB mirrors of on-chain outcomes (task 1.12). The chain is the source of truth; after each relay pass the worker
 * re-reads it and moves the product rows the API serves: the founder key to REGISTERED, plan rows to COMMITTED /
 * SUPERSEDED / REVERTED, supplier payees to COOLING / BOUND, loosening exceptions to QUEUED / EXECUTABLE / EXECUTED /
 * CANCELLED / EXPIRED, released stages and escalations to EXECUTED, recorded sales and denials to their tx, and escrow
 * milestones to their funded / released amounts. Every write is idempotent and conditional on the current state.
 * Vetoed (CANCELLED) loosenings are reconciled with the chain too (audit run-4, sync-veto.ts). A supplier payee whose
 * bindPayee failed for good is CANCELLED (audit run-9 critic gap 1, sync-binds.ts), and re-opened with an ALERT if the
 * chain shows it bound after all (re-check 9 item 2). Payee bindings are read at the block `now` comes from.
 */
import { HOGEE_KINDS, iMilestoneEscrowAbi, iPlanRegistryAbi, iSalesOracleAbi, iTreasuryAbi, toBytes32Tag } from '@hogee/chain';
import type { Address, Hex } from 'viem';
import { poolOf, rows, type Pg } from '../store/pg';
import type { JobDeps } from './deps';
import { alertReopened, syncFailedBinds, type ChainAt } from './sync-binds';
import { syncVetoedLoosens } from './sync-veto';

const LANDED = `('INCLUDED', 'FINALIZED')`;

/** tx hash of the facility's landed action of `kind` for `refId` (null when none landed yet). */
async function landedTx(q: Pg, facilityId: string, kind: string, refId: string): Promise<string | null> {
  const [r] = await rows<{ tx_hash: string }>(
    q,
    `select tx_hash from chain_actions where facility_id = $1 and kind = $2 and ref_id = $3 and state in ${LANDED} and tx_hash is not null order by created_at desc limit 1`,
    [facilityId, kind, refId],
  );
  return r?.tx_hash ?? null;
}

async function syncFounder(d: JobDeps, q: Pg, facilityId: string): Promise<void> {
  const pending = await rows<{ id: string; qx: string; qy: string }>(q, `select id, qx, qy from founders where facility_id = $1 and key_status = 'PENDING_LENDER' and qx is not null`, [facilityId]);
  if (pending.length === 0) return;
  const [qx, qy] = await d.client.readContract({ address: d.deployment.contracts.PlanRegistry.address, abi: iPlanRegistryAbi, functionName: 'founderKey' });
  for (const f of pending) {
    if (f.qx === qx.toLowerCase() && f.qy === qy.toLowerCase()) {
      await q.query(`update founders set key_status = 'REGISTERED' where facility_id = $1 and id = $2 and key_status = 'PENDING_LENDER'`, [facilityId, f.id]);
    }
  }
}

async function syncOpened(d: JobDeps, q: Pg, facilityId: string): Promise<void> {
  const [f] = await rows<{ opened_tx: string | null }>(q, 'select opened_tx from facilities where facility_id = $1', [facilityId]);
  if (!f || f.opened_tx) return;
  const tx = await landedTx(q, facilityId, 'Treasury.openFacility', facilityId);
  if (tx) await q.query('update facilities set opened_tx = $2 where facility_id = $1 and opened_tx is null', [facilityId, tx]);
}

async function syncPlans(d: JobDeps, q: Pg, facilityId: string): Promise<void> {
  // The chain can show a plan committed before its commit action is recorded as landed: such a row was marked
  // COMMITTED with no tx_hash. Fill it in once the action lands, so the plan row always names its tx (evidence).
  await q.query(
    `update plans p set tx_hash = c.tx_hash
       from (select distinct on (ref_id) ref_id, tx_hash from chain_actions
              where facility_id = $1 and kind = 'PlanRegistry.commitPlan' and state in ${LANDED} and tx_hash is not null
              order by ref_id, created_at desc) c
      where p.facility_id = $1 and p.id = c.ref_id and p.status in ('COMMITTED', 'SUPERSEDED') and p.tx_hash is null`,
    [facilityId],
  );
  const submitted = await rows<{ id: string; version: number; plan_hash: string; draft_id: string | null }>(
    q,
    `select id, version, plan_hash, draft_id from plans where facility_id = $1 and status = 'SUBMITTED' order by version`,
    [facilityId],
  );
  if (submitted.length === 0) return;
  const registry = d.deployment.contracts.PlanRegistry.address;
  const [version, current] = await Promise.all([
    d.client.readContract({ address: registry, abi: iPlanRegistryAbi, functionName: 'planVersion' }),
    d.client.readContract({ address: registry, abi: iPlanRegistryAbi, functionName: 'currentPlan' }),
  ]);
  for (const p of submitted) {
    const committed = Number(version) === Number(p.version) && current.planHash.toLowerCase() === p.plan_hash;
    if (committed) {
      const tx = await landedTx(q, facilityId, 'PlanRegistry.commitPlan', p.id);
      await q.query(`update plans set status = 'SUPERSEDED' where facility_id = $1 and status = 'COMMITTED' and version < $2`, [facilityId, p.version]);
      await q.query(`update plans set status = 'COMMITTED', signed_at = coalesce(signed_at, now()), tx_hash = $3 where facility_id = $1 and id = $2 and status = 'SUBMITTED'`, [facilityId, p.id, tx]);
      if (p.draft_id) {
        await q.query(`update exceptions set status = 'EXECUTED', executed_tx = $3 where facility_id = $1 and kind = 'REPLAN' and payload->>'draftId' = $2 and status in ('OPEN', 'FOUNDER_SIGNED', 'APPROVED')`, [
          facilityId,
          p.draft_id,
          tx,
        ]);
      }
      continue;
    }
    const [failed] = await rows<{ reason: string | null }>(
      q,
      `select revert_reason as reason from chain_actions where facility_id = $1 and kind = 'PlanRegistry.commitPlan' and ref_id = $2
          and (state = 'REVERTED' or (raw_signed_tx is null and revert_reason is not null)) order by created_at desc limit 1`,
      [facilityId, p.id],
    );
    if (failed) await q.query(`update plans set status = 'REVERTED', revert_reason = $3 where facility_id = $1 and id = $2 and status = 'SUBMITTED'`, [facilityId, p.id, failed.reason ?? 'reverted']);
  }
}

/**
 * Supplier payees the chain shows bound move to COOLING / BOUND. CANCELLED ones are re-checked too: a bind whose signed
 * approval was replayed before it expired can bind a payee the DB already cancelled; it is re-opened, with an ALERT.
 */
export async function syncPayees(d: Pick<JobDeps, 'client' | 'deployment' | 'log'>, q: Pg, facilityId: string, at: ChainAt): Promise<void> {
  const open = await rows<{ id: string; status: string; bound_line_ids: string[] }>(
    q,
    `select id, status::text as status, bound_line_ids from payees where facility_id = $1 and status in ('PENDING', 'COOLING', 'CANCELLED') and cardinality(bound_line_ids) > 0`,
    [facilityId],
  );
  for (const p of open) {
    const lineId = p.bound_line_ids[0] as Hex;
    const b = await d.client.readContract({
      address: d.deployment.contracts.Treasury.address,
      abi: iTreasuryAbi,
      functionName: 'payeeBinding',
      args: [lineId, toBytes32Tag(p.id)],
      blockNumber: at.block,
    });
    if (!b.bound) continue;
    const status = at.now >= b.coolingUntil ? 'BOUND' : 'COOLING';
    const moved = await q.query(`update payees set status = $3, cooling_until = $4 where facility_id = $1 and id = $2 and status = $5`, [facilityId, p.id, status, b.coolingUntil.toString(), p.status]);
    if (p.status === 'CANCELLED' && moved.rowCount === 1) await alertReopened(d, q, facilityId, p.id);
  }
}

const LOOSEN_STATUS: Readonly<Record<number, string>> = {
  [HOGEE_KINDS.LOOSEN_STATUS_EXECUTED]: 'EXECUTED',
  [HOGEE_KINDS.LOOSEN_STATUS_CANCELLED]: 'CANCELLED',
  [HOGEE_KINDS.LOOSEN_STATUS_EXPIRED]: 'EXPIRED',
};

async function syncLoosens(d: JobDeps, q: Pg, facilityId: string, now: bigint): Promise<void> {
  const open = await rows<{ id: string; status: string; loosen_id: string; kind: string }>(
    q,
    `select id, status, loosen_id, kind from exceptions where facility_id = $1 and loosen_id is not null and status in ('APPROVED', 'QUEUED', 'EXECUTABLE')`,
    [facilityId],
  );
  for (const e of open) {
    const ql = await d.client.readContract({ address: d.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: 'queuedLoosen', args: [e.loosen_id as Hex] });
    if (Number(ql.status) === HOGEE_KINDS.LOOSEN_STATUS_NONE) continue;
    const terminal = LOOSEN_STATUS[Number(ql.status)];
    if (terminal) {
      const executed = terminal === 'EXECUTED' ? ((await landedTx(q, facilityId, 'Treasury.executeLoosen', e.loosen_id)) ?? (await withdrawTx(q, facilityId, e.loosen_id))) : null;
      await q.query(`update exceptions set status = $3, executed_tx = coalesce($4, executed_tx) where facility_id = $1 and id = $2 and status in ('APPROVED', 'QUEUED', 'EXECUTABLE')`, [
        facilityId,
        e.id,
        terminal,
        executed,
      ]);
      continue;
    }
    const status = now >= ql.executableAt ? 'EXECUTABLE' : 'QUEUED';
    const queuedTx = await landedTx(q, facilityId, 'Treasury.queueLoosen', e.id);
    await q.query(
      `update exceptions set status = $3, executable_at = $4, queued_at = coalesce(queued_at, now()), queued_tx = coalesce(queued_tx, $5)
        where facility_id = $1 and id = $2 and status in ('APPROVED', 'QUEUED', 'EXECUTABLE')`,
      [facilityId, e.id, status, ql.executableAt.toString(), queuedTx],
    );
  }
}

async function withdrawTx(q: Pg, facilityId: string, loosenId: string): Promise<string | null> {
  const [p] = await rows<{ tx_hash: string }>(q, `select tx_hash from payments where facility_id = $1 and kind = 'WITHDRAW_RESERVE' and intent_id = $2 and tx_hash is not null`, [facilityId, loosenId]);
  return p?.tx_hash ?? null;
}

async function syncStagesAndEscalations(d: JobDeps, q: Pg, facilityId: string): Promise<void> {
  const approved = await rows<{ id: string; kind: string; payload: { stageId?: string } }>(
    q,
    `select id, kind, payload from exceptions where facility_id = $1 and status = 'APPROVED' and kind in ('RELEASE_STAGE', 'POLICY_ESCALATION', 'RELEASE_ESCROW_BALANCE')`,
    [facilityId],
  );
  for (const e of approved) {
    let tx: string | null = null;
    if (e.kind === 'RELEASE_STAGE' && e.payload.stageId) {
      const [, released] = await d.client.readContract({ address: d.deployment.contracts.PlanRegistry.address, abi: iPlanRegistryAbi, functionName: 'stage', args: [toBytes32Tag(e.payload.stageId)] });
      if (!released) continue;
      tx = await landedTx(q, facilityId, 'Treasury.releaseStage', e.id);
    } else {
      const [p] = await rows<{ tx_hash: string }>(
        q,
        `select tx_hash from payments where facility_id = $1 and id = $2 and state in ('INCLUDED', 'FINALIZED', 'SETTLEMENT_REQUESTED', 'SETTLED', 'SETTLEMENT_FAILED')`,
        [facilityId, `${e.kind === 'POLICY_ESCALATION' ? 'escalation' : 'release'}:${e.id}`],
      );
      if (!p) continue;
      tx = p.tx_hash;
    }
    await q.query(`update exceptions set status = 'EXECUTED', executed_tx = $3 where facility_id = $1 and id = $2 and status = 'APPROVED'`, [facilityId, e.id, tx]);
  }
}

async function syncSalesAndDenials(d: JobDeps, q: Pg, facilityId: string): Promise<void> {
  const sales = await rows<{ id: string; sale_id_hash: string }>(q, 'select id, sale_id_hash from sales where facility_id = $1 and tx_hash is null', [facilityId]);
  for (const s of sales) {
    const oracle = d.deployment.contracts.SalesOracle?.address as Address | undefined;
    if (!oracle) break;
    const recorded = await d.client.readContract({ address: oracle, abi: iSalesOracleAbi, functionName: 'isSaleRecorded', args: [s.sale_id_hash as Hex] });
    const tx = recorded ? await landedTx(q, facilityId, 'SalesOracle.recordSale', s.id) : null;
    if (tx) await q.query('update sales set tx_hash = $3 where facility_id = $1 and id = $2 and tx_hash is null', [facilityId, s.id, tx]);
  }
  await q.query(
    `update denials dn set recorded_tx = a.tx_hash from chain_actions a
      where dn.facility_id = $1 and dn.recorded_tx is null and a.facility_id = dn.facility_id and a.kind = 'Treasury.recordDenied'
        and a.ref_id = dn.id and a.state in ${LANDED} and a.tx_hash is not null`,
    [facilityId],
  );
}

async function syncEscrow(d: JobDeps, q: Pg, facilityId: string): Promise<void> {
  const escrow = d.deployment.contracts.MilestoneEscrow?.address as Address | undefined;
  if (!escrow) return;
  const orders = await rows<{ order_id: string }>(q, 'select order_id from escrow_orders where facility_id = $1', [facilityId]);
  for (const o of orders) {
    const ms = await d.client.readContract({ address: escrow, abi: iMilestoneEscrowAbi, functionName: 'milestones', args: [toBytes32Tag(o.order_id)] });
    for (const [idx, m] of ms.entries()) {
      await q.query(
        `update escrow_milestones set funded_minor = $4, released_minor = $5 where facility_id = $1 and order_id = $2 and idx = $3 and (funded_minor <> $4 or released_minor <> $5)`,
        [facilityId, o.order_id, idx, m.fundedMinor.toString(), m.released ? m.amountMinor.toString() : '0'],
      );
    }
  }
}

/** Chain → DB mirrors for one facility (see module doc). Throws on RPC errors (the next pass retries). */
export async function syncFacility(d: JobDeps, facilityId: string): Promise<void> {
  const q = poolOf(d.db);
  const head = await d.client.getBlock({ blockTag: 'latest' });
  const at: ChainAt = { block: head.number, now: head.timestamp };
  await syncFounder(d, q, facilityId);
  await syncOpened(d, q, facilityId);
  await syncPlans(d, q, facilityId);
  await syncPayees(d, q, facilityId, at);
  await syncFailedBinds(d, q, facilityId, at);
  await syncLoosens(d, q, facilityId, at.now);
  await syncVetoedLoosens(d, q, facilityId);
  await syncStagesAndEscalations(d, q, facilityId);
  await syncSalesAndDenials(d, q, facilityId);
  await syncEscrow(d, q, facilityId);
}
