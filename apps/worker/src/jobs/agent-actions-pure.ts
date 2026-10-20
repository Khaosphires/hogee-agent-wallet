/**
 * Pure parts of the agent-actions job: which milestone to fund next, the Reader flags a milestone invoice carries, the
 * chain-backed escrow orders added to core's PolicyContext, and the in-flight projection every decision runs on.
 *
 * In flight = signed but not mined at the snapshot block (jobs/inflight.ts). Treasury and MilestoneEscrow counters move
 * only when a tx is mined, so each one is applied here as the contracts would apply it: a spend moves its line's spent
 * and window, the payee's paidMinor, the pacing sequence and the intent; an ownerSpend the same without the window; a
 * milestone funding the line's and the treasury's escrowed and the milestone's funded amount, and when an autoRelease
 * milestone becomes fully funded it is released in the same call (paidMinor, settlement); a founder release releases.
 */
import {
  TRUSTED_PUBLIC,
  trusted,
  untrusted,
  type FundMilestoneProposalIn,
  type LineKey,
  type PolicyContext,
  type PolicyDecision,
  type PolicyEscrowOrder,
  type PolicyLineState,
  type PolicyMilestone,
  type PolicyPayeeState,
  type SpendProposalIn,
} from '@hogee/core';
import type { Hex } from 'viem';

export interface MilestoneState {
  readonly amountMinor: string;
  readonly fundedMinor: string;
}

export interface NextFunding {
  readonly idx: number;
  /** What is left of the milestone: schedule − funded. */
  readonly amountMinor: string;
  /** The schedule amount: fundedMinor once this funding lands (the FUND_MILESTONE intent key's last field). */
  readonly cumulativeAfterMinor: string;
}

/**
 * Milestones are funded in index order (sample → deposit → balance → …): the first one not fully funded, and only
 * that one, since every earlier milestone must be fully funded first. Funding only escrows: an autoRelease milestone
 * pays out when fully funded, any other waits for the founder's MilestoneRelease.
 */
export function nextMilestoneToFund(milestones: readonly MilestoneState[]): NextFunding | null {
  for (const [idx, m] of milestones.entries()) {
    const amount = BigInt(m.amountMinor);
    const funded = BigInt(m.fundedMinor);
    if (funded >= amount) continue;
    return { idx, amountMinor: (amount - funded).toString(), cumulativeAfterMinor: amount.toString() };
  }
  return null;
}

/** Why an automatic milestone's funding waits for a later pass (re-check 9 item 1). */
export type AutoFundingDeferral = 'AUTO_OVER_PER_TX' | 'AUTO_WINDOW_FULL';

export interface AutoFundingCheck {
  /** The milestone's scheduled amount: what it pays out once fully funded. */
  readonly milestoneMinor: bigint;
  /** This funding: what is left of the milestone. */
  readonly amountMinor: bigint;
  /** The line's CURRENT caps and window (chain-backed, in flight projected). */
  readonly perTxCapMinor: bigint;
  readonly windowCapMinor: bigint;
  readonly windowSpentMinor: bigint;
  readonly windowSeconds: bigint;
  /** Chain time of the snapshot block. */
  readonly now: bigint;
  /** The line's other automatic-milestone fundings: `minedAt` is the chain time of their block, null while in flight. */
  readonly others: readonly { readonly amountMinor: bigint; readonly minedAt: bigint | null }[];
}

/**
 * Whether an automatic (autoRelease) milestone is held back this pass, or null to fund it. Escrow funding never moves
 * the on-chain windowSpent and core FUND_MILESTONE checks neither cap (the schedule was signed), so without this N
 * orders could each pay a deposit inside the window in the same window. Held when the payout is above the line's
 * current per-payment cap (tightened after signing), or when the line's automatic payments of the last windowSeconds
 * (in flight = now), its windowSpent and this funding exceed the window cap. Held milestones never come here. Pure.
 */
export function autoFundingDeferral(c: AutoFundingCheck): AutoFundingDeferral | null {
  if (c.milestoneMinor > c.perTxCapMinor) return 'AUTO_OVER_PER_TX';
  const recent = c.others.filter((o) => o.minedAt === null || o.minedAt + c.windowSeconds > c.now).reduce((sum, o) => sum + o.amountMinor, 0n);
  return c.windowSpentMinor + recent + c.amountMinor > c.windowCapMinor ? 'AUTO_WINDOW_FULL' : null;
}

export interface MilestoneInvoice {
  readonly id: string;
  readonly amountMinor: string;
  readonly flags: readonly string[];
  readonly invoiceHash: Hex;
}

/**
 * The flags @hogee/agent bindMilestoneInvoice attaches (the stored invoice row carries the Reader's flags): they only
 * accumulate, plus AMOUNT_MISMATCH when the invoice states another amount than the signed schedule. The amount funded
 * is always the schedule's. Absent = no invoice bound to the milestone.
 */
export function milestoneInvoiceFlags(invoice: MilestoneInvoice | null, scheduleMinor: string): string[] | undefined {
  if (!invoice) return undefined;
  const mismatch = invoice.amountMinor !== scheduleMinor ? ['AMOUNT_MISMATCH'] : [];
  return [...new Set([...invoice.flags, ...mismatch])].sort();
}

/** Treasury.payeeBinding(lineId, payeeId) of an order's supplier. */
export interface SupplierBinding {
  readonly bound: boolean;
  readonly coolingUntil: bigint;
  readonly lifetimeCapMinor: bigint;
  readonly paidMinor: bigint;
}

/** One escrow order as MilestoneEscrow and Treasury hold it at the snapshot block. */
export interface EscrowOrderState extends PolicyEscrowOrder {
  readonly orderIdHex: Hex;
  /** MilestoneEscrow milestones(orderId)[i].evidenceHash. */
  readonly evidenceHashes: readonly Hex[];
  readonly binding: SupplierBinding;
}

/**
 * The context with the facility's escrow orders and their suppliers' bindings. A supplier is bound by its signed
 * approval and is not listed on the plan's (escrow-only) line, so the plan mirror does not carry it; spend still
 * refuses it (escrow-only line, listing rule) while fundMilestone checks only the binding and its cooling.
 */
export function withEscrow(ctx: PolicyContext, orders: readonly EscrowOrderState[]): PolicyContext {
  const payees = [...ctx.payees];
  for (const o of orders) {
    if (!o.binding.bound || payees.some((p) => p.payeeId === o.payeeId && p.lineKeys.includes(o.lineKey))) continue;
    payees.push({
      payeeId: o.payeeId,
      source: 'bound',
      lineKeys: [o.lineKey],
      lifetimeCapMinor: o.binding.lifetimeCapMinor.toString(),
      ...(o.binding.coolingUntil > 0n ? { coolingUntil: o.binding.coolingUntil.toString() } : {}),
      paidMinor: o.binding.paidMinor.toString(),
    });
  }
  const escrowOrders: PolicyEscrowOrder[] = orders.map((o) => ({
    orderId: o.orderId,
    payeeId: o.payeeId,
    lineKey: o.lineKey,
    inspectionRequired: o.inspectionRequired,
    milestones: o.milestones.map((m) => ({ ...m })),
  }));
  return { ...ctx, payees, escrowOrders };
}

/** The payment columns the projection reads. */
export interface PendingPayment {
  readonly kind: string;
  readonly lineKey: LineKey | null;
  readonly payeeId: string;
  readonly amountMinor: string;
  readonly intentId: Hex;
  readonly invoiceHash: Hex;
  readonly orderId: string | null;
  readonly milestoneIdx: number | null;
}

const plus = (a: string, b: bigint): string => (BigInt(a) + b).toString();

interface Draft {
  lines: Partial<Record<LineKey, PolicyLineState>>;
  payees: PolicyPayeeState[];
  orders: PolicyEscrowOrder[];
  spent: bigint;
  escrowed: bigint;
  usedIntents: Set<string>;
  paidInvoices: Set<string>;
}

function pay(x: Draft, payeeId: string, lineKey: LineKey, amount: bigint): void {
  const i = x.payees.findIndex((p) => p.payeeId === payeeId && p.lineKeys.includes(lineKey));
  const p = x.payees[i];
  if (p) x.payees[i] = { ...p, paidMinor: plus(p.paidMinor, amount) };
}

function spend(x: Draft, row: PendingPayment, pacing: boolean, agent: boolean): void {
  const amount = BigInt(row.amountMinor);
  x.spent += amount;
  x.usedIntents.add(row.intentId.toLowerCase());
  if (row.lineKey === null) return;
  if (!pacing) x.paidInvoices.add(row.invoiceHash.toLowerCase());
  const s = x.lines[row.lineKey];
  if (s) {
    x.lines[row.lineKey] = {
      ...s,
      spentMinor: plus(s.spentMinor, amount),
      windowSpentMinor: agent ? plus(s.windowSpentMinor, amount) : s.windowSpentMinor,
      nextSequence: s.nextSequence + (pacing ? 1 : 0),
      ...(agent && s.windowLiveSpends !== undefined ? { windowLiveSpends: s.windowLiveSpends + 1 } : {}),
    };
  }
  pay(x, row.payeeId, row.lineKey, amount);
}

function milestone(x: Draft, row: PendingPayment, change: (m: PolicyMilestone) => PolicyMilestone): { order: PolicyEscrowOrder; before: PolicyMilestone; after: PolicyMilestone } | null {
  const oi = x.orders.findIndex((o) => o.orderId === row.orderId);
  const order = x.orders[oi];
  const before = row.milestoneIdx === null ? undefined : order?.milestones[row.milestoneIdx];
  if (!order || !before || row.milestoneIdx === null) return null;
  const after = change(before);
  const milestones = order.milestones.map((m, i) => (i === row.milestoneIdx ? after : m));
  x.orders[oi] = { ...order, milestones };
  return { order, before, after };
}

function fund(x: Draft, row: PendingPayment): void {
  const amount = BigInt(row.amountMinor);
  x.escrowed += amount;
  if (row.lineKey !== null) {
    const s = x.lines[row.lineKey];
    if (s) x.lines[row.lineKey] = { ...s, escrowedMinor: plus(s.escrowedMinor, amount) };
  }
  const hit = milestone(x, row, (m) => {
    const funded = BigInt(m.fundedMinor) + amount;
    const releases = m.autoRelease && !m.released && funded === BigInt(m.amountMinor);
    return { ...m, fundedMinor: funded.toString(), ...(releases ? { released: true, settlementUsed: true } : {}) };
  });
  if (hit && hit.after.released && !hit.before.released) pay(x, hit.order.payeeId, hit.order.lineKey, BigInt(hit.after.amountMinor));
}

function release(x: Draft, row: PendingPayment): void {
  const hit = milestone(x, row, (m) => ({ ...m, released: true, settlementUsed: true }));
  if (hit && !hit.before.released) pay(x, hit.order.payeeId, hit.order.lineKey, BigInt(hit.after.amountMinor));
}

/** The context once every pending row is mined (see the module doc). Pure: `ctx` is not mutated. */
export function projectPending(ctx: PolicyContext, pending: readonly PendingPayment[], pacingLines: ReadonlySet<LineKey>): PolicyContext {
  const x: Draft = {
    lines: { ...ctx.lines },
    payees: [...ctx.payees],
    orders: [...ctx.escrowOrders],
    spent: 0n,
    escrowed: 0n,
    usedIntents: new Set(ctx.usedIntents),
    paidInvoices: new Set(ctx.paidInvoices),
  };
  for (const row of pending) {
    const pacing = row.lineKey !== null && pacingLines.has(row.lineKey);
    if (row.kind === 'SPEND') spend(x, row, pacing, true);
    else if (row.kind === 'OWNER_SPEND') spend(x, row, pacing, false);
    else if (row.kind === 'FUND_MILESTONE') fund(x, row);
    else if (row.kind === 'RELEASE_MILESTONE') release(x, row);
  }
  return {
    ...ctx,
    lines: x.lines,
    payees: x.payees,
    escrowOrders: x.orders,
    totalSpentMinor: plus(ctx.totalSpentMinor, x.spent),
    totalEscrowedMinor: plus(ctx.totalEscrowedMinor, x.escrowed),
    usedIntents: x.usedIntents,
    paidInvoices: x.paidInvoices,
  };
}

/** The FUND_MILESTONE proposal: order and amount from the signed schedule (trusted), the invoice can only add flags. */
export function fundMilestoneProposal(a: { orderId: string; idx: number; amountMinor: string; planVersion: number; invoiceFlags?: readonly string[] }): FundMilestoneProposalIn {
  return {
    kind: 'FUND_MILESTONE',
    origin: TRUSTED_PUBLIC,
    orderId: trusted(a.orderId, 'escrow:order'),
    idx: a.idx,
    amountMinor: trusted(a.amountMinor, 'escrow:schedule'),
    planVersion: a.planVersion,
    ...(a.invoiceFlags ? { invoiceFlags: a.invoiceFlags } : {}),
  };
}

export type SpendBasis = { readonly invoiceId: string; readonly flags: readonly string[] } | { readonly pacingSlot: number };

/**
 * A SPEND proposal rebuilt from server-derived values (an escalation payload or an API payment row): line and payee
 * come from DB bindings (trusted); an invoice amount is the Reader's grounded total (untrusted, bounded by the caps);
 * a pacing amount is the manifest's (trusted).
 */
export function spendProposal(a: { lineKey: LineKey; payeeId: string; amountMinor: string; invoiceHash: Hex; intentId: Hex; planVersion: number; basis: SpendBasis }): SpendProposalIn {
  const amountMinor = 'invoiceId' in a.basis ? untrusted(a.amountMinor, `invoice:${a.basis.invoiceId}`) : trusted(a.amountMinor, 'plan:pacing');
  return {
    kind: 'SPEND',
    origin: TRUSTED_PUBLIC,
    lineKey: trusted(a.lineKey, 'db:payment'),
    payeeId: trusted(a.payeeId, 'db:payee-binding'),
    amountMinor,
    invoiceHash: a.invoiceHash,
    intentId: a.intentId,
    planVersion: a.planVersion,
    basis: a.basis,
  };
}

/** What an officer approval may override: a payment the policy sent to the officer for a flagged invoice. Never a DENY. */
export function isOverridable(d: PolicyDecision): boolean {
  return d.verdict === 'AUTO' || (d.verdict === 'NEEDS_OFFICER' && d.reasonCode === 'FLAGGED_INVOICE');
}
