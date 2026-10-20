import { evaluateProposal, type PolicyContext } from '@hogee/core';
import { fundMilestoneIntentId, sequenceInvoiceHash, toBytes32Tag } from '@hogee/chain';
import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { buildPolicyContext } from '../../src/chain/context';
import {
  fundPaymentId,
  isApiSpendProposalId,
  escalationPaymentId,
  ownerPaymentId,
  releasePaymentId,
} from '../../src/jobs/agent-actions-ids';
import {
  autoFundingDeferral,
  fundMilestoneProposal,
  isOverridable,
  milestoneInvoiceFlags,
  nextMilestoneToFund,
  projectPending,
  withEscrow,
  type EscrowOrderState,
  type PendingPayment,
} from '../../src/jobs/agent-actions-pure';
import { committed, NOW, rinaSnapshot, roles } from '../support/fixtures';

const mined = { usedIntents: new Set<string>(), paidInvoices: new Set<string>() };
const ORDER = 'order-a-001';
const ORDER_HEX = toBytes32Tag(ORDER);

function order(over: Partial<EscrowOrderState> = {}, funded: readonly string[] = ['0', '0', '0']): EscrowOrderState {
  const amounts = ['30000', '120000', '280000'];
  const auto = [true, true, false];
  return {
    orderId: ORDER,
    orderIdHex: ORDER_HEX,
    payeeId: 'supplier-a',
    lineKey: 'SUPPLIER',
    inspectionRequired: true,
    milestones: amounts.map((amountMinor, i) => ({ amountMinor, fundedMinor: funded[i] ?? '0', autoRelease: auto[i] ?? false, released: false })),
    evidenceHashes: amounts.map(() => `0x${'0'.repeat(64)}` as Hex),
    binding: { bound: true, coolingUntil: NOW - 1n, lifetimeCapMinor: 430_000n, paidMinor: 0n },
    ...over,
  };
}

const base = (): PolicyContext => buildPolicyContext({ snapshot: rinaSnapshot(), committed, roles, mined });
const fund = (ctx: PolicyContext, idx: number, amountMinor: string) => evaluateProposal(fundMilestoneProposal({ orderId: ORDER, idx, amountMinor, planVersion: ctx.planVersion }), ctx);

describe('agent-actions ids', () => {
  it('derives deterministic payment ids', () => {
    expect(fundPaymentId(ORDER, 0)).toBe('fund:order-a-001:0');
    expect(fundPaymentId(ORDER, 1, 2)).toBe('fund:order-a-001:1:2');
    expect(escalationPaymentId('exc-1')).toBe('escalation:exc-1');
    expect(releasePaymentId('exc-2')).toBe('release:exc-2');
    expect(ownerPaymentId('sig-3')).toBe('owner:sig-3');
    expect(() => fundPaymentId(ORDER, 256)).toThrow(RangeError);
    expect(() => fundPaymentId(ORDER, 0, 0)).toThrow(RangeError);
  });

  it('treats only unreserved ids as API spend proposals', () => {
    expect(isApiSpendProposalId('proposal:0192')).toBe(true);
    for (const id of ['pacing:ADS:1', 'fund:o:0', 'escalation:e', 'release:r', 'owner:s']) expect(isApiSpendProposalId(id)).toBe(false);
  });
});

describe('nextMilestoneToFund', () => {
  it('funds in index order: the first milestone not fully funded, with what is left of it', () => {
    expect(nextMilestoneToFund(order().milestones)).toEqual({ idx: 0, amountMinor: '30000', cumulativeAfterMinor: '30000' });
    expect(nextMilestoneToFund(order({}, ['30000', '0', '0']).milestones)).toEqual({ idx: 1, amountMinor: '120000', cumulativeAfterMinor: '120000' });
    expect(nextMilestoneToFund(order({}, ['30000', '20000', '0']).milestones)).toEqual({ idx: 1, amountMinor: '100000', cumulativeAfterMinor: '120000' });
    // The balance is funded too (funding only escrows; its release needs the founder's signature).
    expect(nextMilestoneToFund(order({}, ['30000', '120000', '0']).milestones)).toEqual({ idx: 2, amountMinor: '280000', cumulativeAfterMinor: '280000' });
    expect(nextMilestoneToFund(order({}, ['30000', '120000', '280000']).milestones)).toBeNull();
  });
});

describe('milestoneInvoiceFlags', () => {
  const inv = { id: 'inv-1', amountMinor: '30000', flags: ['IMPERATIVE_TEXT'], invoiceHash: `0x${'1'.repeat(64)}` as Hex };
  it('is absent without an invoice, passes the Reader flags through and adds AMOUNT_MISMATCH like bindMilestoneInvoice', () => {
    expect(milestoneInvoiceFlags(null, '30000')).toBeUndefined();
    expect(milestoneInvoiceFlags({ ...inv, flags: [] }, '30000')).toEqual([]);
    expect(milestoneInvoiceFlags(inv, '30000')).toEqual(['IMPERATIVE_TEXT']);
    expect(milestoneInvoiceFlags({ ...inv, amountMinor: '99999' }, '30000')).toEqual(['AMOUNT_MISMATCH', 'IMPERATIVE_TEXT']);
  });
});

describe('withEscrow + core FUND_MILESTONE', () => {
  it('adds the chain-backed order and its supplier binding, so the sample is AUTO', () => {
    const ctx = withEscrow(base(), [order()]);
    expect(ctx.escrowOrders).toHaveLength(1);
    expect(ctx.payees).toContainEqual(expect.objectContaining({ payeeId: 'supplier-a', source: 'bound', lineKeys: ['SUPPLIER'], lifetimeCapMinor: '430000' }));
    expect(fund(ctx, 0, '30000')).toMatchObject({ verdict: 'AUTO', reasonCode: 'WITHIN_PLAN' });
  });

  it('a cooling or unbound supplier is refused by the policy', () => {
    expect(fund(withEscrow(base(), [order({ binding: { bound: true, coolingUntil: NOW + 60n, lifetimeCapMinor: 430_000n, paidMinor: 0n } })]), 0, '30000')).toMatchObject({ verdict: 'DENY', reasonCode: 'PayeeCooling' });
    expect(fund(withEscrow(base(), [order({ binding: { bound: false, coolingUntil: 0n, lifetimeCapMinor: 0n, paidMinor: 0n } })]), 0, '30000')).toMatchObject({ verdict: 'DENY', reasonCode: 'PayeeNotBound' });
  });

  it('a flagged milestone invoice goes to the loan officer', () => {
    const ctx = withEscrow(base(), [order()]);
    const p = fundMilestoneProposal({ orderId: ORDER, idx: 0, amountMinor: '30000', planVersion: 1, invoiceFlags: ['IMPERATIVE_TEXT'] });
    expect(evaluateProposal(p, ctx)).toMatchObject({ verdict: 'NEEDS_OFFICER', reasonCode: 'FLAGGED_INVOICE' });
  });
});

const pending = (p: Partial<PendingPayment> & Pick<PendingPayment, 'kind' | 'amountMinor'>): PendingPayment => ({
  lineKey: null,
  payeeId: 'supplier-a',
  intentId: `0x${'a'.repeat(64)}` as Hex,
  invoiceHash: `0x${'b'.repeat(64)}` as Hex,
  orderId: null,
  milestoneIdx: null,
  ...p,
});

describe('projectPending', () => {
  it('in-flight sample + deposit fundings leave stage 1 too small for the balance (CapExceeded, a normal skip)', () => {
    const ctx = withEscrow(base(), [order()]);
    const fundRow = (idx: number, amountMinor: string): PendingPayment =>
      pending({
        kind: 'FUND_MILESTONE',
        lineKey: 'SUPPLIER',
        amountMinor,
        orderId: ORDER,
        milestoneIdx: idx,
        intentId: fundMilestoneIntentId({ orderId: ORDER_HEX, idx, amountMinor: BigInt(amountMinor), cumulativeAfterMinor: BigInt(amountMinor) }),
      });
    const projected = projectPending(ctx, [fundRow(0, '30000'), fundRow(1, '120000')], new Set(['ADS']));
    expect(projected.totalEscrowedMinor).toBe('150000');
    expect(projected.lines.SUPPLIER?.escrowedMinor).toBe('150000');
    expect(projected.escrowOrders[0]?.milestones.map((m) => [m.fundedMinor, m.released])).toEqual([
      ['30000', true],
      ['120000', true],
      ['0', false],
    ]);
    // autoRelease paid the supplier out of its lifetime cap.
    expect(projected.payees.find((p) => p.payeeId === 'supplier-a')?.paidMinor).toBe('150000');
    expect(nextMilestoneToFund(projected.escrowOrders[0]?.milestones ?? [])).toMatchObject({ idx: 2 });
    expect(fund(projected, 2, '280000')).toMatchObject({ verdict: 'DENY', reasonCode: 'CapExceeded' });
    // The raw context (nothing in flight) would fund the same milestone again: in-flight rows must count.
    expect(fund(ctx, 0, '30000').verdict).toBe('AUTO');
    expect(fund(projected, 0, '30000')).toMatchObject({ verdict: 'DENY', reasonCode: 'AmountExceedsSchedule' });
  });

  it('an in-flight spend moves the window, the payee, the pacing slot and the intent', () => {
    const ctx = base();
    const intentId = `0x${'c'.repeat(64)}` as Hex;
    const projected = projectPending(
      ctx,
      [
        pending({ kind: 'SPEND', lineKey: 'ADS', payeeId: 'shopee-ads', amountMinor: '7500', intentId, invoiceHash: sequenceInvoiceHash(1n) }),
        pending({ kind: 'OWNER_SPEND', lineKey: 'LOGISTICS', payeeId: 'spx-logistics', amountMinor: '4000', invoiceHash: `0x${'d'.repeat(64)}` as Hex }),
      ],
      new Set(['ADS']),
    );
    expect(projected.lines.ADS).toMatchObject({ windowSpentMinor: '7500', spentMinor: '7500', nextSequence: 2 });
    expect(projected.lines.LOGISTICS).toMatchObject({ windowSpentMinor: '0', spentMinor: '4000' });
    expect(projected.totalSpentMinor).toBe('11500');
    expect(projected.usedIntents.has(intentId)).toBe(true);
    // A pacing slot's hash is not an invoice; an owner spend's invoice is.
    expect(projected.paidInvoices.has(sequenceInvoiceHash(1n))).toBe(false);
    expect(projected.paidInvoices.has(`0x${'d'.repeat(64)}`)).toBe(true);
    expect(projected.payees.find((p) => p.payeeId === 'shopee-ads')?.paidMinor).toBe('7500');
    // The input context is not mutated.
    expect(ctx.lines.ADS?.windowSpentMinor).toBe('0');
    expect(ctx.totalSpentMinor).toBe('0');
  });
});

describe('isOverridable', () => {
  it('an officer approval overrides only the flagged-invoice escalation, never a denial', () => {
    expect(isOverridable({ verdict: 'AUTO', reasonCode: 'WITHIN_PLAN', mirrorsRevert: false })).toBe(true);
    expect(isOverridable({ verdict: 'NEEDS_OFFICER', reasonCode: 'FLAGGED_INVOICE', mirrorsRevert: false, exceptionKind: 'POLICY_ESCALATION' })).toBe(true);
    expect(isOverridable({ verdict: 'NEEDS_OFFICER', reasonCode: 'LOOSEN_NEEDS_BOTH_SIGS', mirrorsRevert: false })).toBe(false);
    expect(isOverridable({ verdict: 'DENY', reasonCode: 'PayeeNotBound', mirrorsRevert: true })).toBe(false);
  });
});

/**
 * Re-check 9 item 1: escrow funding never moves the on-chain windowSpent and core FUND_MILESTONE checks neither cap,
 * so the worker itself holds an automatic milestone back (deferred: retried next pass, never denied or sent) when it
 * pays out more than the line's CURRENT per-payment cap, or when the line's automatic payments of the last
 * windowSeconds (chain time; in flight = now) plus this one would exceed its window cap.
 */
describe('autoFundingDeferral', () => {
  const WEEK = 604_800n;
  const base = { milestoneMinor: 120_000n, amountMinor: 120_000n, perTxCapMinor: 125_000n, windowCapMinor: 250_000n, windowSpentMinor: 0n, windowSeconds: WEEK, now: NOW, others: [] };

  it("funds Rina's and Mei's catalog sample and deposit, and Mei's web deposit, in one window", () => {
    expect(autoFundingDeferral({ ...base, milestoneMinor: 30_000n, amountMinor: 30_000n })).toBeNull();
    expect(autoFundingDeferral({ ...base, others: [{ amountMinor: 30_000n, minedAt: null }] })).toBeNull();
    expect(autoFundingDeferral({ ...base, milestoneMinor: 75_000n, amountMinor: 75_000n, others: [{ amountMinor: 30_000n, minedAt: NOW - 60n }, { amountMinor: 120_000n, minedAt: null }] })).toBeNull();
  });

  it('defers a milestone that pays out more than the current per-payment cap (a cap tightened after signing)', () => {
    expect(autoFundingDeferral({ ...base, perTxCapMinor: 100_000n })).toBe('AUTO_OVER_PER_TX');
    // The payout is the whole milestone, even when only its rest is funded now.
    expect(autoFundingDeferral({ ...base, amountMinor: 20_000n, perTxCapMinor: 100_000n })).toBe('AUTO_OVER_PER_TX');
    expect(autoFundingDeferral({ ...base, perTxCapMinor: 120_000n })).toBeNull();
  });

  it('defers when the automatic payments of the window plus this one exceed the window cap; in flight counts as now', () => {
    const paid = (minedAt: bigint | null) => [{ amountMinor: 125_000n, minedAt }, { amountMinor: 30_000n, minedAt }];
    expect(autoFundingDeferral({ ...base, others: paid(NOW - 60n) })).toBe('AUTO_WINDOW_FULL');
    expect(autoFundingDeferral({ ...base, others: paid(null) })).toBe('AUTO_WINDOW_FULL');
    expect(autoFundingDeferral({ ...base, others: paid(NOW - WEEK + 1n) })).toBe('AUTO_WINDOW_FULL');
    // Once the window has rolled past them, the same payments no longer count.
    expect(autoFundingDeferral({ ...base, others: paid(NOW - WEEK) })).toBeNull();
    expect(autoFundingDeferral({ ...base, others: [{ amountMinor: 130_000n, minedAt: NOW - 60n }] })).toBeNull(); // 250,000 exactly
    expect(autoFundingDeferral({ ...base, windowSpentMinor: 1n, others: [{ amountMinor: 130_000n, minedAt: NOW - 60n }] })).toBe('AUTO_WINDOW_FULL');
    expect(autoFundingDeferral({ ...base, windowCapMinor: 100_000n })).toBe('AUTO_WINDOW_FULL');
  });
});
