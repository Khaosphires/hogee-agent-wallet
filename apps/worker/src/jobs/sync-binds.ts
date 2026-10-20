/**
 * Supplier orders whose bindPayee never lands (audit run-9, critic gap 1). Before this, such a payee stayed PENDING for
 * ever: its order's unfunded milestones kept holding SUPPLIER budget (the API's free pocket counts PENDING / COOLING /
 * BOUND payees), and the chat stayed at ORDER_PENDING. Now a PENDING payee is CANCELLED (an existing payee status) when
 * every bindPayee action of its orders has failed for good: it REVERTED, was refused before signing (no signed bytes, a
 * revert_reason), or never landed, AND in every case the signed SupplierApproval's expiry is more than
 * BIND_EXPIRY_MARGIN_S in the past (chain time). Re-check 9 item 2: until then the approval's calldata is public and
 * still valid, so anyone could replay it and bind the payee while the DB said CANCELLED and its budget was freed;
 * after it Treasury refuses it (SignatureExpired). An unsigned bind is also marked refused, so the relay never signs it.
 * Never while the chain shows the payee bound (payeeBinding is read at the same block as `now`). Each cancellation is
 * traced (ALERT) on the bind action's own trace. If the chain shows a CANCELLED payee bound after all, sync.ts
 * syncPayees re-opens it (alertReopened), and the agent never funds an order whose payee the DB holds CANCELLED
 * (alertCancelledOnChain). Contracts unchanged; the supplier still cannot get a second order (one order per web
 * supplier): picking another supplier is the way on.
 */
import { iTreasuryAbi, toBytes32Tag } from '@hogee/chain';
import type { Hex } from 'viem';
import { rows, type Pg } from '../store/pg';
import { appendTrace, hasTrace } from '../store/trace';
import type { JobDeps } from './deps';

/** Chain seconds after the approval's expiry before an unlanded bind counts as failed (a tx mined in time is final). */
export const BIND_EXPIRY_MARGIN_S = 120n;

/** One chain read point: block `block` and its timestamp `now`, so a binding and the clock come from the same block. */
export interface ChainAt {
  readonly block: bigint;
  readonly now: bigint;
}

/** The trace of a bindPayee action (the relay's own, so the timeline shows its refusal, cancellation and re-open). */
export const bindTraceId = (actionId: string): string => `trace:act:${actionId}`;

interface BindRow {
  payee_id: string;
  line_id: string | null;
  order_id: string;
  action_id: string;
  state: string;
  signed: boolean;
  revert_reason: string | null;
  expiry: string | null;
}

export interface BindAction {
  readonly state: string;
  readonly signed: boolean;
  readonly revertReason: string | null;
  /** The signed SupplierApproval's expiry (unix seconds, chain time); null when the request does not carry one. */
  readonly expiry: bigint | null;
}

const short = (s: string): string => s.replace(/^REFUSED:\s*/, '').slice(0, 120);

/**
 * Why this bind can never bind its payee, or null while it, or a replay of its signed approval, could still land (or it
 * has landed). Only once the approval expired more than the margin ago (chain time), whatever happened to the bind;
 * an approval without an expiry is never given up on. Pure.
 */
export function bindFailure(a: BindAction, now: bigint): string | null {
  if (a.state === 'INCLUDED' || a.state === 'FINALIZED') return null;
  if (a.expiry === null || now <= a.expiry + BIND_EXPIRY_MARGIN_S) return null;
  if (a.state === 'REVERTED') return a.revertReason ? `it reverted: ${short(a.revertReason)}` : 'it reverted';
  if (!a.signed && a.revertReason) return `it was not sent: ${short(a.revertReason)}`;
  return 'the signed approval expired before it landed';
}

const expiryOf = (raw: string | null): bigint | null => (raw !== null && /^[0-9]{1,20}$/.test(raw) ? BigInt(raw) : null);

interface Candidate {
  readonly payeeId: string;
  readonly lineId: string | null;
  readonly orderIds: readonly string[];
  readonly actions: readonly { readonly id: string; readonly signed: boolean; readonly revertReason: string | null; readonly why: string | null }[];
}

async function candidates(q: Pg, facilityId: string, now: bigint): Promise<Candidate[]> {
  const found = await rows<BindRow>(
    q,
    `select p.id as payee_id, p.bound_line_ids[1] as line_id, o.order_id, a.id as action_id, a.state::text as state,
            a.raw_signed_tx is not null as signed, a.revert_reason, a.request_json->'approval'->>'expiry' as expiry
       from payees p
       join escrow_orders o on o.facility_id = p.facility_id and o.payee_id = p.id
       join chain_actions a on a.facility_id = o.facility_id and a.kind = 'Treasury.bindPayee' and a.ref_id = o.order_id
      where p.facility_id = $1 and p.status = 'PENDING'
      order by p.id, a.created_at, a.id`,
    [facilityId],
  );
  const byPayee = new Map<string, BindRow[]>();
  for (const r of found) byPayee.set(r.payee_id, [...(byPayee.get(r.payee_id) ?? []), r]);
  return [...byPayee.values()].flatMap((rs) => {
    const actions = rs.map((r) => ({
      id: r.action_id,
      signed: r.signed,
      revertReason: r.revert_reason,
      why: bindFailure({ state: r.state, signed: r.signed, revertReason: r.revert_reason, expiry: expiryOf(r.expiry) }, now),
    }));
    const first = rs[0] as BindRow;
    return actions.every((a) => a.why !== null) ? [{ payeeId: first.payee_id, lineId: first.line_id, orderIds: [...new Set(rs.map((r) => r.order_id))], actions }] : [];
  });
}

async function cancel(d: Pick<JobDeps, 'log'>, q: Pg, facilityId: string, c: Candidate): Promise<void> {
  // An unsigned bind is refused first, so the relay never signs it after the payee is cancelled.
  const unsigned = c.actions.filter((a) => !a.signed && a.revertReason === null).map((a) => a.id);
  if (unsigned.length > 0) {
    await q.query(
      `update chain_actions set revert_reason = 'REFUSED: the signed approval expired before it was sent'
        where facility_id = $1 and kind = 'Treasury.bindPayee' and id = any($2::text[]) and raw_signed_tx is null and revert_reason is null`,
      [facilityId, unsigned],
    );
  }
  const moved = await q.query(`update payees set status = 'CANCELLED' where facility_id = $1 and id = $2 and status = 'PENDING'`, [facilityId, c.payeeId]);
  if (moved.rowCount !== 1) return;
  const last = c.actions[c.actions.length - 1] as Candidate['actions'][number];
  d.log.warn('payee_bind_failed', { facilityId, payeeId: c.payeeId, orders: c.orderIds, why: last.why });
  for (const orderId of c.orderIds) {
    await appendTrace(q, {
      facilityId,
      traceId: bindTraceId(last.id),
      actor: 'worker',
      kind: 'ALERT',
      summary: `Supplier order ${orderId} never landed on-chain (${last.why}), so its payee binding is cancelled: nothing was paid and its budget is free again`,
      refs: {},
    });
  }
}

/** Cancels the payees whose binds failed for good (module doc). Throws on RPC errors (the next pass retries). */
export async function syncFailedBinds(d: Pick<JobDeps, 'client' | 'deployment' | 'log'>, q: Pg, facilityId: string, at: ChainAt): Promise<void> {
  for (const c of await candidates(q, facilityId, at.now)) {
    if (c.lineId === null) continue; // no line to read the binding from: never cancel blind
    const b = await d.client.readContract({
      address: d.deployment.contracts.Treasury.address,
      abi: iTreasuryAbi,
      functionName: 'payeeBinding',
      args: [c.lineId as Hex, toBytes32Tag(c.payeeId)],
      blockNumber: at.block,
    });
    if (b.bound) continue; // bound on-chain: syncPayees moves it to COOLING / BOUND
    await cancel(d, q, facilityId, c);
  }
}

/** The latest bindPayee action of each of the payee's orders. */
async function bindsOf(q: Pg, facilityId: string, payeeId: string): Promise<{ order_id: string; action_id: string | null }[]> {
  return rows<{ order_id: string; action_id: string | null }>(
    q,
    `select o.order_id,
            (select a.id from chain_actions a where a.facility_id = o.facility_id and a.kind = 'Treasury.bindPayee' and a.ref_id = o.order_id
              order by a.created_at desc, a.id desc limit 1) as action_id
       from escrow_orders o where o.facility_id = $1 and o.payee_id = $2 order by o.created_at, o.order_id`,
    [facilityId, payeeId],
  );
}

/** One ALERT with `reasonCode` on the order's bind trace (its own trace when it has no bind action), never twice. */
async function alertOnce(q: Pg, facilityId: string, orderId: string, actionId: string | null, reasonCode: string, summary: string): Promise<boolean> {
  const traceId = actionId === null ? `trace:escrow:${orderId}` : bindTraceId(actionId);
  if (await hasTrace(q, { facilityId, traceId, reasonCode })) return false;
  await appendTrace(q, { facilityId, traceId, actor: 'worker', kind: 'ALERT', reasonCode, summary, refs: {} });
  return true;
}

/**
 * A CANCELLED payee the chain shows bound after all (its signed approval was replayed before it expired) was just
 * re-opened by syncPayees: an ALERT per order, since the order holds SUPPLIER budget again (its terms were USED, so no
 * other order took that budget through those terms, but a later order may have counted on it).
 */
export async function alertReopened(d: Pick<JobDeps, 'log'>, q: Pg, facilityId: string, payeeId: string): Promise<void> {
  d.log.warn('payee_reopened', { facilityId, payeeId, note: 'a cancelled payee is bound on-chain; re-opened' });
  for (const b of await bindsOf(q, facilityId, payeeId)) {
    await alertOnce(
      q,
      facilityId,
      b.order_id,
      b.action_id,
      'PAYEE_REOPENED',
      `Supplier order ${b.order_id} landed on-chain after its payee binding was cancelled (its signed approval was sent again before it expired), so the payee is open again and the order holds supplier budget again; check the supplier pocket`,
    );
  }
}

/** The agent met an on-chain order whose payee the DB holds CANCELLED: not funded; one ALERT per order. */
export async function alertCancelledOnChain(d: Pick<JobDeps, 'log'>, q: Pg, facilityId: string, orderId: string, actionId: string | null): Promise<void> {
  const first = await alertOnce(
    q,
    facilityId,
    orderId,
    actionId,
    'PAYEE_CANCELLED',
    `Supplier order ${orderId} is on-chain but its payee binding is cancelled here, so the agent does not fund it until the sync re-checks the payee on-chain`,
  );
  if (first) d.log.warn('escrow_order_payee_cancelled', { facilityId, orderId, note: 'on-chain order with a CANCELLED payee; not funded' });
}
