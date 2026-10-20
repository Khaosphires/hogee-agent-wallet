/**
 * Escrow funding (§8.4, §26.1 step 7; agent key). For each escrow order whose supplier is bound on-chain and past its
 * cooling window, the milestones are funded in index order with MilestoneEscrow.fundMilestone: milestone i only once
 * every earlier one is fully funded (in flight counted), and only when core evaluateProposal(FUND_MILESTONE) says AUTO
 * on the chain-backed context with every in-flight payment projected, the Reader flags of a bound milestone invoice
 * passed through. Funding only escrows: an autoRelease milestone (sample, deposit) pays out in the same call, any other
 * (the balance) waits for the founder's MilestoneRelease. With stage 1 only, the Rina balance is DENY CapExceeded: a
 * normal skip, traced once, never recordDenied, retried next pass.
 *
 * An automatic milestone is held back (deferred, traced once as an ALERT, retried next pass; never denied, recorded or
 * sent) while it pays out more than the line's CURRENT per-payment cap, or while the line's automatic payments of the
 * last windowSeconds plus this one would exceed its window cap (re-check 9 item 1: funding never moves the on-chain
 * windowSpent, so nothing else bounds automatic payments across orders). Held milestones are never bounded by it.
 *
 * Row first: `fund:<orderId>:<idx>` (POLICY_OK, decision + rationale, PROPOSAL trace) is inserted BEFORE signing, so the
 * orphan watch matches the MilestoneFunded (intent fundMilestoneIntentId(orderId, idx, amount, cumulativeAfter), same
 * rationaleHash, own tx hash). A crash between insert and sign resumes that row; a signed one is left to recovery.
 */
import { buildFundMilestone, decisionIdToBytes32, fundMilestoneIntentId, milestoneSettlementId } from '@hogee/chain';
import { evaluateProposal, type PolicyContext } from '@hogee/core';
import type { Hex } from 'viem';
import { poolOf, rows as dbRows } from '../store/pg';
import type { JobDeps } from './deps';
import { agentTraceIdOf, fundPaymentId, REASON, type AgentActionOutcome } from './agent-actions-ids';
import { autoFundingDeferral, fundMilestoneProposal, milestoneInvoiceFlags, nextMilestoneToFund, type AutoFundingDeferral, type EscrowOrderState, type NextFunding } from './agent-actions-pure';
import { decide, failureOf, insertDecided, invoiceForMilestone, sendPayment, traceOnChange, type Decision } from './agent-actions-sign';
import { contextOf, RELEASED_PAYMENT_STATES, type ActionPaymentRow, type ActionWorld } from './agent-actions-world';
import { MINED_STATES, minedAt } from './inflight';

const outcome = (o: EscrowOrderState, idx: number | null, rest: Omit<AgentActionOutcome, 'action' | 'ref'>): AgentActionOutcome => ({
  action: 'FUND_MILESTONE',
  ref: idx === null ? o.orderId : `${o.orderId}:${idx}`,
  ...rest,
});

interface FundStep {
  readonly w: ActionWorld;
  readonly order: EscrowOrderState;
  readonly next: NextFunding;
  readonly ctx: PolicyContext;
  readonly rows: readonly ActionPaymentRow[];
  /** Chain time of a block (memoised for the pass). */
  readonly blockTime: (block: bigint) => Promise<bigint>;
}

/** The row this funding signs: the unsigned one a crash left behind (if it is this funding), or a new one. */
async function rowFor(d: JobDeps, s: FundStep, decision: { invoiceId: string | null; invoiceHash: Hex | null; flags: readonly string[] | undefined }): Promise<{ id: string; decision: Decision } | { stale: string }> {
  const { order, next, w } = s;
  const intentId = fundMilestoneIntentId({ orderId: order.orderIdHex, idx: next.idx, amountMinor: BigInt(next.amountMinor), cumulativeAfterMinor: BigInt(next.cumulativeAfterMinor) });
  const mine = s.rows.filter((r) => r.kind === 'FUND_MILESTONE' && r.orderId === order.orderId && r.milestoneIdx === next.idx);
  const unsigned = mine.find((r) => !RELEASED_PAYMENT_STATES.includes(r.state));
  if (unsigned) {
    if (unsigned.amountMinor !== next.amountMinor || unsigned.intentId.toLowerCase() !== intentId.toLowerCase() || !unsigned.decisionId || !unsigned.rationaleHash) return { stale: unsigned.id };
    return { id: unsigned.id, decision: { decisionId: unsigned.decisionId, rationaleHash: unsigned.rationaleHash } };
  }
  const id = fundPaymentId(order.orderId, next.idx, mine.length + 1);
  const rationale = {
    kind: 'MILESTONE_FUNDING',
    orderId: order.orderId,
    idx: next.idx,
    amountMinor: next.amountMinor,
    cumulativeAfterMinor: next.cumulativeAfterMinor,
    autoRelease: order.milestones[next.idx]?.autoRelease === true,
    payeeId: order.payeeId,
    lineKey: order.lineKey,
    planVersion: s.ctx.planVersion,
    invoiceId: decision.invoiceId,
    invoiceFlags: decision.flags ?? [],
    verdict: 'AUTO',
    reasonCode: REASON.WITHIN_PLAN,
  };
  const x = decide(d, rationale);
  await insertDecided(
    d,
    {
      ...x,
      facilityId: w.facilityId,
      id,
      kind: 'FUND_MILESTONE',
      intentId,
      lineKey: order.lineKey,
      payeeId: order.payeeId,
      amountMinor: next.amountMinor,
      // Unique per milestone (payout idempotency keys hash it): the bound invoice's, else the settlementId.
      invoiceHash: decision.invoiceHash ?? milestoneSettlementId(order.orderIdHex, next.idx),
      planVersion: s.ctx.planVersion,
      orderId: order.orderId,
      milestoneIdx: next.idx,
      traceId: agentTraceIdOf(id),
    },
    {
      actor: 'policy',
      kind: 'PROPOSAL',
      verdict: 'AUTO',
      reasonCode: REASON.WITHIN_PLAN,
      summary: `Fund ${order.orderId} milestone ${next.idx}: ${next.amountMinor} minor into escrow for ${order.payeeId} (signed schedule, plan v${s.ctx.planVersion})`,
      refs: { paymentId: id, planVersion: s.ctx.planVersion, decisionId: x.decisionId },
    },
  );
  await d.onStep?.('inserted', id);
  return { id, decision: x };
}

/**
 * The line's other automatic-milestone fundings that are signed or mined (an unsigned row passes this check before it
 * is ever signed), each with the chain time of the block it was mined in at B, or null while in flight.
 */
async function autoFundingsOf(d: JobDeps, s: FundStep): Promise<{ amountMinor: bigint; minedAt: bigint | null }[]> {
  const { w, order } = s;
  // Automatic as the DB order rows say, or as the chain holds the orders read at B (either one is enough).
  const auto = await dbRows<{ order_id: string; idx: number }>(poolOf(d.db), 'select order_id, idx from escrow_milestones where facility_id = $1 and auto_release', [w.facilityId]);
  const onChain = w.orders.flatMap((o) => o.milestones.flatMap((m, i) => (m.autoRelease ? [`${o.orderId}:${i}`] : [])));
  const isAuto = new Set([...auto.map((r) => `${r.order_id}:${Number(r.idx)}`), ...onChain]);
  const counted = s.rows.filter(
    (r) =>
      r.kind === 'FUND_MILESTONE' &&
      r.lineKey === order.lineKey &&
      (r.signed || MINED_STATES.includes(r.state)) &&
      !RELEASED_PAYMENT_STATES.includes(r.state) &&
      isAuto.has(`${r.orderId}:${r.milestoneIdx}`),
  );
  return Promise.all(
    counted.map(async (r) => {
      const block = await minedAt(r, w.block, w.receiptBlock);
      return { amountMinor: BigInt(r.amountMinor), minedAt: block === null ? null : await s.blockTime(block) };
    }),
  );
}

/** Whether this automatic milestone is held back this pass (see the module doc). Throws when its line is not on-chain. */
async function autoDeferral(d: JobDeps, s: FundStep): Promise<AutoFundingDeferral | null> {
  const { w, order, next, ctx } = s;
  const milestone = order.milestones[next.idx];
  if (milestone?.autoRelease !== true) return null;
  const lineId = w.committed.manifest.lines.find((l) => l.lineKey === order.lineKey)?.lineId.toLowerCase();
  const view = w.snapshot.lines.find((l) => l.lineId.toLowerCase() === lineId);
  const line = ctx.lines[order.lineKey];
  if (!view || !line) throw new Error(`no on-chain ${order.lineKey} line bounds this automatic payment`);
  return autoFundingDeferral({
    milestoneMinor: BigInt(milestone.amountMinor),
    amountMinor: BigInt(next.amountMinor),
    perTxCapMinor: BigInt(line.perTxCapMinor),
    windowCapMinor: BigInt(line.windowCapMinor),
    windowSpentMinor: BigInt(line.windowSpentMinor),
    windowSeconds: BigInt(view.pocket.windowSeconds),
    now: w.snapshot.timestamp,
    others: await autoFundingsOf(d, s),
  });
}

const HELD_BECAUSE: Readonly<Record<AutoFundingDeferral, string>> = {
  AUTO_OVER_PER_TX: "it pays out more than the line's per-payment cap allows now",
  AUTO_WINDOW_FULL: "the line's automatic payments of this window would pass its window cap",
};

async function fundOne(d: JobDeps, s: FundStep): Promise<AgentActionOutcome> {
  const { order, next, ctx, w } = s;
  const live = s.rows.filter((r) => r.kind === 'FUND_MILESTONE' && r.orderId === order.orderId && r.milestoneIdx === next.idx && !RELEASED_PAYMENT_STATES.includes(r.state));
  // Signed and not reflected on-chain at B nor pending (e.g. a non-final revert): never a second funding for it.
  if (live.some((r) => r.signed || r.state !== 'POLICY_OK')) return outcome(order, next.idx, { result: 'skipped', reason: 'FUNDING_IN_FLIGHT' });
  const scheduled = order.milestones[next.idx]?.amountMinor ?? next.cumulativeAfterMinor;
  const invoice = await invoiceForMilestone(poolOf(d.db), w.facilityId, order.orderId, next.idx);
  const flags = milestoneInvoiceFlags(invoice, scheduled);
  const proposal = fundMilestoneProposal({ orderId: order.orderId, idx: next.idx, amountMinor: next.amountMinor, planVersion: ctx.planVersion, ...(flags ? { invoiceFlags: flags } : {}) });
  const verdict = evaluateProposal(proposal, ctx);
  if (verdict.verdict !== 'AUTO') {
    await traceOnChange(d, {
      facilityId: w.facilityId,
      traceId: agentTraceIdOf(fundPaymentId(order.orderId, next.idx)),
      actor: 'policy',
      kind: 'POLICY_VERDICT',
      verdict: verdict.verdict,
      reasonCode: verdict.reasonCode,
      summary: `${order.orderId} milestone ${next.idx} (${next.amountMinor} minor) not funded: ${verdict.reasonCode}; ${verdict.verdict === 'NEEDS_OFFICER' ? 'the invoice is flagged for the loan officer' : 'retried next pass, not recorded as a denial'}`,
      refs: { planVersion: ctx.planVersion },
    });
    return outcome(order, next.idx, { result: verdict.verdict === 'NEEDS_OFFICER' ? 'needs_officer' : 'denied', reason: verdict.reasonCode, amountMinor: next.amountMinor });
  }
  const held = await autoDeferral(d, s);
  if (held) {
    await traceOnChange(d, {
      facilityId: w.facilityId,
      traceId: agentTraceIdOf(fundPaymentId(order.orderId, next.idx)),
      actor: 'policy',
      kind: 'ALERT',
      reasonCode: held,
      summary: `${order.orderId} milestone ${next.idx} (${next.amountMinor} minor) held back: ${HELD_BECAUSE[held]}; retried next pass, nothing denied or sent`,
      refs: { planVersion: ctx.planVersion },
    });
    return outcome(order, next.idx, { result: 'deferred', reason: held, amountMinor: next.amountMinor });
  }
  const row = await rowFor(d, s, { invoiceId: invoice?.id ?? null, invoiceHash: invoice?.invoiceHash ?? null, flags });
  if ('stale' in row) {
    d.log.warn('fund_row_stale', { facilityId: w.facilityId, paymentId: row.stale, note: 'an unsigned funding row that is not this funding; left for the operator' });
    return outcome(order, next.idx, { result: 'skipped', reason: 'STALE_FUNDING_ROW', paymentId: row.stale });
  }
  const call = buildFundMilestone({
    orderId: order.orderIdHex,
    idx: next.idx,
    amountMinor: BigInt(next.amountMinor),
    decisionId: decisionIdToBytes32(row.decision.decisionId),
    rationaleHash: row.decision.rationaleHash,
  });
  const sent = await sendPayment(d, { facilityId: w.facilityId, paymentId: row.id, call, signer: d.signers.agent, role: 'agent', planId: w.committed.planId, traceId: agentTraceIdOf(row.id) });
  return outcome(order, next.idx, { result: 'sent', paymentId: row.id, amountMinor: next.amountMinor, txHash: sent.txHash });
}

/** Funds what each bound, cooled order may receive now (see the module doc). Per-milestone failures are outcomes. */
export async function fundEscrow(d: JobDeps, w: ActionWorld): Promise<AgentActionOutcome[]> {
  const out: AgentActionOutcome[] = [];
  const times = new Map<bigint, bigint>();
  const blockTime = async (blockNumber: bigint): Promise<bigint> => {
    const hit = times.get(blockNumber);
    if (hit !== undefined) return hit;
    const t = (await d.client.getBlock({ blockNumber })).timestamp;
    times.set(blockNumber, t);
    return t;
  };
  for (const order of w.orders) {
    if (!order.binding.bound) {
      out.push(outcome(order, null, { result: 'skipped', reason: 'PAYEE_NOT_BOUND' }));
      continue;
    }
    if (w.snapshot.timestamp < order.binding.coolingUntil) {
      out.push(outcome(order, null, { result: 'skipped', reason: 'PAYEE_COOLING' }));
      continue;
    }
    // At most one funding per milestone per pass; stop at the first milestone that is not funded now.
    for (let step = 0; step < order.milestones.length; step += 1) {
      const { ctx, rows } = await contextOf(d, w);
      const projected = ctx.escrowOrders.find((o) => o.orderId === order.orderId);
      const next = projected ? nextMilestoneToFund(projected.milestones) : null;
      if (!next) break;
      let result: AgentActionOutcome;
      try {
        result = await fundOne(d, { w, order, next, ctx, rows, blockTime });
      } catch (error: unknown) {
        const f = failureOf(error);
        if (f.result === 'error') d.log.error('fund_milestone_failed', { facilityId: w.facilityId, orderId: order.orderId, idx: next.idx, error });
        result = outcome(order, next.idx, { ...f, amountMinor: next.amountMinor });
      }
      out.push(result);
      if (result.result !== 'sent') break;
    }
  }
  return out;
}
