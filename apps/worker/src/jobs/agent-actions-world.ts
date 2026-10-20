/**
 * The chain-backed world one agent-actions pass decides on (§7.2 step 3), read at ONE block B like the tick:
 * ChainSnapshot + the committed plan → core's PolicyContext (fail closed on any plan or role mismatch), plus the
 * facility's escrow orders as MilestoneEscrow and Treasury hold them at B (order, milestones, the supplier's binding,
 * each release's settlement), plus every payment signed but not mined at B, projected as the contracts would apply it
 * (agent-actions-pure.ts projectPending). The context is rebuilt from the payments table before EVERY decision, so a
 * row this pass has just signed is in flight for the next one.
 */
import { iMilestoneEscrowAbi, iTreasuryAbi, LINE_KEYS, milestoneSettlementId, shortIdToBytes32, type HogeePublicClient } from '@hogee/chain';
import type { LineKey, PolicyContext } from '@hogee/core';
import type { Hex } from 'viem';
import { buildPolicyContext, ContextMismatchError, type CommittedPlan } from '../chain/context';
import { readChainSnapshot } from '../chain/mirror';
import { shortIdFromBytes32, type ChainSnapshot } from '../chain/snapshot';
import { raiseHalt } from '../store/halt';
import { poolOf, rows, type Pg } from '../store/pg';
import type { JobDeps } from './deps';
import { loadCommittedPlan } from './facility';
import { MINED_STATES, minedAt, OPEN_SIGNED_STATES, otherSlotOnDay, type PaymentRow, type ReceiptBlock } from './inflight';
import { projectPending, withEscrow, type EscrowOrderState } from './agent-actions-pure';
import { chainDay } from './decide';
import { alertCancelledOnChain } from './sync-binds';
import { receiptBlockOf } from './tick';

/** A payments row with the columns the founder and milestone kinds need. */
export interface ActionPaymentRow extends PaymentRow {
  readonly lineId: Hex | null;
  readonly orderId: string | null;
  readonly milestoneIdx: number | null;
  readonly traceId: string;
}

/** States that released the intent (payments_facility_intent_id_unique): the row can never execute. */
export const RELEASED_PAYMENT_STATES: readonly string[] = ['POLICY_DENIED', 'REVERTED', 'CANCELLED'];

interface ActionDbRow {
  id: string;
  kind: string;
  state: string;
  line_key: LineKey | null;
  line_id: string | null;
  payee_id: string;
  order_id: string | null;
  milestone_idx: number | null;
  amount_minor: string;
  intent_id: string;
  invoice_hash: string;
  plan_version: number;
  decision_id: string | null;
  rationale_hash: string | null;
  trace_id: string;
  signed: boolean;
  tx_hash: string | null;
  superseded_tx_hashes: string[] | null;
  block: string | null;
}

export async function loadActionPayments(q: Pg, facilityId: string): Promise<ActionPaymentRow[]> {
  const out = await rows<ActionDbRow>(
    q,
    `select id, kind, state, line_key, line_id, payee_id, order_id, milestone_idx, amount_minor::text as amount_minor, intent_id, invoice_hash,
            plan_version, decision_id, rationale_hash, trace_id, raw_signed_tx is not null as signed, tx_hash, superseded_tx_hashes, block::text as block
       from payments where facility_id = $1 order by created_at, id`,
    [facilityId],
  );
  return out.map((r) => ({
    id: r.id,
    kind: r.kind,
    state: r.state,
    lineKey: r.line_key,
    lineId: r.line_id as Hex | null,
    payeeId: r.payee_id,
    orderId: r.order_id,
    milestoneIdx: r.milestone_idx === null ? null : Number(r.milestone_idx),
    amountMinor: r.amount_minor,
    intentId: r.intent_id as Hex,
    invoiceHash: r.invoice_hash as Hex,
    planVersion: Number(r.plan_version),
    decisionId: r.decision_id,
    rationaleHash: r.rationale_hash as Hex | null,
    traceId: r.trace_id,
    signed: r.signed,
    txHash: r.tx_hash as Hex | null,
    supersededTxHashes: (r.superseded_tx_hashes ?? []) as Hex[],
    block: r.block === null ? null : BigInt(r.block),
  }));
}

export interface ActionWorld {
  readonly facilityId: string;
  readonly block: bigint;
  readonly snapshot: ChainSnapshot;
  readonly committed: CommittedPlan;
  readonly orders: readonly EscrowOrderState[];
  readonly pacingLines: ReadonlySet<LineKey>;
  readonly receiptBlock: ReceiptBlock;
}

export interface AgentActionContext {
  readonly ctx: PolicyContext;
  readonly rows: readonly ActionPaymentRow[];
}

/** Receipt lookups for one pass (a hash mined at or below B stays mined). */
function cachedReceipts(fn: ReceiptBlock): ReceiptBlock {
  const seen = new Map<string, bigint>();
  return async (hash) => {
    const key = hash.toLowerCase();
    const hit = seen.get(key);
    if (hit !== undefined) return hit;
    const at = await fn(hash);
    if (at !== null) seen.set(key, at);
    return at;
  };
}

async function minedBy(row: PaymentRow, block: bigint, receiptBlock: ReceiptBlock): Promise<boolean> {
  return (await minedAt(row, block, receiptBlock)) !== null;
}

/**
 * Whether pacing line `lineKey` already has its slot of B's chain day (audit run-4: at most one pacing slot per line
 * per day, the tick's rule, also for API proposals): another SPEND row on the line, signed or mined and not released,
 * that is still pending at B (it lands that day or later) or was mined in a block of that day.
 */
export async function lineSlotToday(d: JobDeps, w: ActionWorld, all: readonly ActionPaymentRow[], lineKey: LineKey, except: string): Promise<boolean> {
  return otherSlotOnDay(all, {
    lineKey,
    except,
    block: w.block,
    receiptBlock: w.receiptBlock,
    day: chainDay(w.snapshot.timestamp),
    dayOfBlock: async (blockNumber) => chainDay((await d.client.getBlock({ blockNumber })).timestamp),
  });
}

/** Mined at B (usedIntents / paidInvoices, as jobs/inflight.ts) vs signed and still pending at B. */
async function splitAt(all: readonly ActionPaymentRow[], w: ActionWorld): Promise<{ usedIntents: Set<string>; paidInvoices: Set<string>; pending: ActionPaymentRow[] }> {
  const usedIntents = new Set<string>();
  const paidInvoices = new Set<string>();
  const pending: ActionPaymentRow[] = [];
  for (const row of all) {
    if (!OPEN_SIGNED_STATES.includes(row.state) && !MINED_STATES.includes(row.state)) continue;
    if (!(await minedBy(row, w.block, w.receiptBlock))) {
      pending.push(row);
      continue;
    }
    usedIntents.add(row.intentId.toLowerCase());
    const invoiceKind = row.kind === 'SPEND' || row.kind === 'OWNER_SPEND';
    if (invoiceKind && row.lineKey !== null && !w.pacingLines.has(row.lineKey)) paidInvoices.add(row.invoiceHash.toLowerCase());
  }
  return { usedIntents, paidInvoices, pending };
}

/** The projected PolicyContext now (fresh payments rows; B's chain state). Throws ContextMismatchError. */
export async function contextOf(d: JobDeps, w: ActionWorld): Promise<AgentActionContext> {
  const all = await loadActionPayments(poolOf(d.db), w.facilityId);
  const split = await splitAt(all, w);
  const roles = { agent: d.signers.agent.address, lender: d.signers.lender.address, oracle: d.signers.oracle.address };
  const base = buildPolicyContext({ snapshot: w.snapshot, committed: w.committed, roles, mined: split });
  return { ctx: projectPending(withEscrow(base, w.orders), split.pending, w.pacingLines), rows: all };
}

type EscrowClient = Pick<HogeePublicClient, 'readContract'>;

async function readOrder(client: EscrowClient, d: JobDeps, escrow: Hex, row: { order_id: string; payee_id: string; inspection_required: boolean }, block: bigint): Promise<EscrowOrderState | null> {
  const orderIdHex = shortIdToBytes32(row.order_id, 'orderId');
  const at = { blockNumber: block } as const;
  const [o, ms] = await Promise.all([
    client.readContract({ address: escrow, abi: iMilestoneEscrowAbi, functionName: 'order', args: [orderIdHex], ...at }),
    client.readContract({ address: escrow, abi: iMilestoneEscrowAbi, functionName: 'milestones', args: [orderIdHex], ...at }),
  ]);
  if (!o.exists) return null; // bindPayee has not landed (yet)
  const payeeId = shortIdFromBytes32(o.payeeId);
  const lineKey = shortIdFromBytes32(o.lineId);
  // The chain is the truth; a DB order that names another payee or no plan line is not funded (fail closed).
  if (payeeId !== row.payee_id || !(LINE_KEYS as readonly string[]).includes(lineKey)) {
    d.log.warn('escrow_order_mismatch', { orderId: row.order_id, note: 'the DB order is not the on-chain order; not funded' });
    return null;
  }
  const treasury = d.deployment.contracts.Treasury.address;
  const [binding, used] = await Promise.all([
    client.readContract({ address: treasury, abi: iTreasuryAbi, functionName: 'payeeBinding', args: [o.lineId, o.payeeId], ...at }),
    Promise.all(ms.map((_, i) => client.readContract({ address: treasury, abi: iTreasuryAbi, functionName: 'isIntentUsed', args: [milestoneSettlementId(orderIdHex, i)], ...at }))),
  ]);
  return {
    orderId: row.order_id,
    orderIdHex,
    payeeId,
    lineKey: lineKey as LineKey,
    inspectionRequired: o.inspectionRequired,
    milestones: ms.map((m, i) => ({ amountMinor: m.amountMinor.toString(), fundedMinor: m.fundedMinor.toString(), autoRelease: m.autoRelease, released: m.released, settlementUsed: used[i] === true })),
    evidenceHashes: ms.map((m) => m.evidenceHash),
    binding: { bound: binding.bound, coolingUntil: binding.coolingUntil, lifetimeCapMinor: binding.lifetimeCapMinor, paidMinor: binding.paidMinor },
  };
}

/**
 * The facility's escrow orders (DB ids) as the chain holds them at `block`; none on a deployment without MilestoneEscrow.
 * An order whose payee the DB holds CANCELLED is never funded (re-check 9 item 2): when the chain shows it anyway (a
 * replayed approval bound it), it is skipped with one ALERT until the sync re-opens the payee.
 */
export async function readEscrowOrders(d: JobDeps, facilityId: string, block: bigint): Promise<EscrowOrderState[]> {
  const escrow = d.deployment.contracts.MilestoneEscrow?.address as Hex | undefined;
  if (!escrow) return [];
  const q = poolOf(d.db);
  const listed = await rows<{ order_id: string; payee_id: string; inspection_required: boolean; cancelled: boolean; bind_id: string | null }>(
    q,
    `select o.order_id, o.payee_id, o.inspection_required, p.status = 'CANCELLED' as cancelled,
            (select a.id from chain_actions a where a.facility_id = o.facility_id and a.kind = 'Treasury.bindPayee' and a.ref_id = o.order_id
              order by a.created_at desc, a.id desc limit 1) as bind_id
       from escrow_orders o join payees p on p.facility_id = o.facility_id and p.id = o.payee_id
      where o.facility_id = $1 order by o.created_at, o.order_id`,
    [facilityId],
  );
  const out: EscrowOrderState[] = [];
  for (const row of listed) {
    const order = await readOrder(d.client, d, escrow, row, block);
    if (order && row.cancelled) await alertCancelledOnChain(d, q, facilityId, row.order_id, row.bind_id);
    else if (order) out.push(order);
  }
  return out;
}

export type WorldOutcome = { readonly world: ActionWorld } | { readonly status: 'no_plan' | 'mismatch'; readonly detail: string };

/** One block, its snapshot, the committed plan and the escrow orders. A DB/chain plan or role mismatch halts (as the tick). */
export async function loadActionWorld(d: JobDeps, facilityId: string): Promise<WorldOutcome> {
  const pool = poolOf(d.db);
  const block = await d.client.getBlockNumber({ cacheTime: 0 });
  const [snapshot, committed, orders] = await Promise.all([readChainSnapshot(d.client, d.deployment, block), loadCommittedPlan(pool, facilityId), readEscrowOrders(d, facilityId, block)]);
  if (!committed) return { status: 'no_plan', detail: 'no committed plan' };
  const pacingLines = new Set(committed.manifest.lines.filter((l) => l.pacing).map((l) => l.lineKey));
  const world: ActionWorld = { facilityId, block, snapshot, committed, orders, pacingLines, receiptBlock: cachedReceipts(receiptBlockOf(d.client)) };
  try {
    await contextOf(d, world);
  } catch (error: unknown) {
    if (!(error instanceof ContextMismatchError)) throw error;
    if (error.code === 'NO_COMMITTED_PLAN') return { status: 'no_plan', detail: error.code };
    await raiseHalt(pool, d.log, 'CONTEXT_MISMATCH', { facilityId, code: error.code, block, job: 'agent-actions' });
    return { status: 'mismatch', detail: error.code };
  }
  return { world };
}
