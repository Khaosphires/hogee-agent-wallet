import { encodeErrorResult, keccak256, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  broadcast,
  buildExecuteLoosen,
  buildFundMilestone,
  buildOwnerSpend,
  buildReleaseMilestone,
  buildSpend,
  bytes32ToDecisionId,
  decisionIdToBytes32,
  decodeRevertData,
  hogeeErrorAbi,
  iTreasuryAbi,
  lineKeyToLineId,
  paymentCallMismatch,
  reasonCodeToBytes32,
  releaseMilestoneIntentId,
  revertDataFromError,
  shortErrorReason,
  shortIdToBytes32,
  spendIntentId,
  toBytes32Tag,
  TxValueError,
  type PaymentIntentFields,
} from '../src/index';
import { ownerSpend, milestoneRelease } from './fixtures/rina';

const h = (c: string): Hex => `0x${c.repeat(64)}`;
const RAW: Hex = '0x02f86b827a69808477359400847735940082520894000000000000000000000000000000000000000180c0';
const DECISION = '0199e7a2-5b1c-7d3e-8f4a-1b2c3d4e5f60';

function nodeError(details: string): Error {
  const inner = Object.assign(new Error('RPC Request failed.'), { details, code: -32003 });
  return Object.assign(new Error('Transaction creation failed.'), { details, cause: inner });
}

describe('broadcast classification (stored bytes, never re-signed)', () => {
  it('returns the locally computed hash on success', async () => {
    const result = await broadcast({ sendRawTransaction: async () => keccak256(RAW) }, RAW);
    expect(result).toEqual({ status: 'sent', txHash: keccak256(RAW) });
  });

  it.each([
    ['transaction already imported', 'already_known'],
    ['already known', 'already_known'],
    ['nonce too low', 'nonce_consumed'],
  ])('maps "%s" to %s', async (details, status) => {
    const result = await broadcast({ sendRawTransaction: async () => Promise.reject(nodeError(details)) }, RAW);
    expect(result.status).toBe(status);
  });

  it('rethrows anything else (e.g. replacement underpriced, insufficient funds)', async () => {
    await expect(broadcast({ sendRawTransaction: async () => Promise.reject(nodeError('replacement transaction underpriced')) }, RAW)).rejects.toThrow(
      /Transaction creation failed/,
    );
  });
});

describe('shortErrorReason (what an `error` outcome may carry)', () => {
  it('keeps the name and first line, redacts URLs (they can embed provider keys) and caps the length', () => {
    const e = Object.assign(new Error('fetch to https://rpc.example/v2/key-in-path?x=1 failed\nURL: https://rpc.example/v2/key-in-path'), { name: 'HttpRequestError' });
    expect(shortErrorReason(e)).toBe('HttpRequestError: fetch to <url> failed');
    expect(shortErrorReason(Object.assign(new Error('long details'), { shortMessage: 'HTTP request failed.' }))).toBe('Error: HTTP request failed.');
    expect(shortErrorReason(new Error('x'.repeat(500))).length).toBeLessThanOrEqual(160);
    expect(shortErrorReason('plain')).toBe('string: plain');
  });
});

describe('on-chain id encodings (§26.3)', () => {
  it('decisionId UUID ↔ left-padded bytes32', () => {
    const b = decisionIdToBytes32(DECISION);
    expect(b).toBe(`0x${'0'.repeat(32)}0199e7a25b1c7d3e8f4a1b2c3d4e5f60`);
    expect(bytes32ToDecisionId(b)).toBe(DECISION);
    expect(bytes32ToDecisionId(h('1'))).toBeUndefined();
    expect(() => decisionIdToBytes32(DECISION.toUpperCase())).toThrow(TxValueError);
  });

  it('ShortIds, LineKeys and reason codes are right-padded bytes32 (stringToHex)', () => {
    expect(shortIdToBytes32('shopee-ads')).toBe(toBytes32Tag('shopee-ads'));
    expect(lineKeyToLineId('ADS')).toBe(toBytes32Tag('ADS'));
    expect(reasonCodeToBytes32('PayeeNotBound')).toBe(toBytes32Tag('PayeeNotBound'));
    expect(() => shortIdToBytes32('Shopee Ads')).toThrow(TxValueError);
    expect(() => lineKeyToLineId('RENT' as never)).toThrow(TxValueError);
    expect(() => reasonCodeToBytes32('x'.repeat(33))).toThrow(TxValueError);
  });
});

describe('paymentCallMismatch (what is stored is what is signed)', () => {
  const PLAN = toBytes32Tag('plan-unit-1');
  const ctx = { planId: PLAN };
  const spendArgs = {
    lineId: toBytes32Tag('ADS'),
    payeeId: toBytes32Tag('shopee-ads'),
    amountMinor: 7_500n,
    invoiceHash: h('1'),
    planVersion: 1,
    decisionId: decisionIdToBytes32(DECISION),
    rationaleHash: h('3'),
  };
  const spendRow: PaymentIntentFields = {
    kind: 'SPEND',
    intentId: spendIntentId({ planId: PLAN, ...spendArgs }),
    lineId: toBytes32Tag('ADS'),
    payeeId: 'shopee-ads',
    orderId: null,
    milestoneIdx: null,
    amountMinor: '7500',
    invoiceHash: h('1'),
    planVersion: 1,
    decisionId: DECISION,
    rationaleHash: h('3'),
  };
  const sig = { kind: 0, data: `0x${'ab'.repeat(65)}` as Hex };

  it('accepts the exact spend', () => {
    expect(paymentCallMismatch(spendRow, buildSpend(spendArgs).data, ctx)).toBeNull();
  });

  it.each([
    ['payee', { payeeId: toBytes32Tag('evil') }, /payeeId/],
    ['amount', { amountMinor: 7_501n }, /amountMinor/],
    ['plan version', { planVersion: 2 }, /planVersion/],
    ['decision', { decisionId: h('2') }, /decisionId/],
    ['rationale', { rationaleHash: h('4') }, /rationaleHash/],
  ])('refuses a spend with a different %s', (_n, patch, message) => {
    expect(paymentCallMismatch(spendRow, buildSpend({ ...spendArgs, ...patch }).data, ctx)).toMatch(message);
  });

  it('refuses the wrong function for the payment kind', () => {
    expect(paymentCallMismatch(spendRow, buildExecuteLoosen({ loosenId: h('9') }).data, ctx)).toMatch(/Treasury.spend/);
  });

  it('SPEND / OWNER_SPEND: intent_id must be intentId(planId, calldata line, payee, invoice, amount); no planId fails closed', () => {
    const data = buildSpend(spendArgs).data;
    expect(paymentCallMismatch({ ...spendRow, intentId: h('9') }, data, ctx)).toMatch(/intent_id/);
    expect(paymentCallMismatch(spendRow, data, { planId: toBytes32Tag('plan-other') })).toMatch(/intent_id/);
    expect(paymentCallMismatch(spendRow, data, { planId: null })).toMatch(/planId is required/);
    expect(paymentCallMismatch(spendRow, data, { planId: '0x1234' })).toMatch(/planId must be bytes32/);

    const req = { ...ownerSpend, payeeId: toBytes32Tag('shopee-ads') };
    const owner = {
      ...spendRow,
      kind: 'OWNER_SPEND',
      intentId: spendIntentId({ planId: PLAN, lineId: req.lineId, payeeId: req.payeeId, invoiceHash: req.invoiceHash, amountMinor: req.amountMinor }),
      lineId: ownerSpend.lineId,
      amountMinor: String(ownerSpend.amountMinor),
      invoiceHash: ownerSpend.invoiceHash,
      decisionId: null,
      rationaleHash: null,
    };
    const ownerCall = buildOwnerSpend({ req, founder: sig }).data;
    expect(paymentCallMismatch(owner, ownerCall, ctx)).toBeNull();
    expect(paymentCallMismatch({ ...owner, intentId: spendRow.intentId }, ownerCall, ctx)).toMatch(/intent_id/);
    expect(paymentCallMismatch(owner, ownerCall, { planId: null })).toMatch(/planId is required/);
  });

  it('RELEASE_MILESTONE: intent_id must be the milestone settlementId of the calldata (orderId, idx)', () => {
    const release = {
      ...spendRow,
      kind: 'RELEASE_MILESTONE',
      intentId: releaseMilestoneIntentId({ orderId: milestoneRelease.orderId, idx: milestoneRelease.idx }),
      orderId: 'order-a-001',
      milestoneIdx: milestoneRelease.idx,
      amountMinor: String(milestoneRelease.amountMinor),
      lineId: toBytes32Tag('SUPPLIER'),
    };
    const data = buildReleaseMilestone({ release: milestoneRelease, founder: sig }).data;
    expect(paymentCallMismatch(release, data, { planId: null })).toBeNull(); // no planId needed
    expect(paymentCallMismatch({ ...release, intentId: h('7') }, data, ctx)).toMatch(/intent_id/);
  });

  it('checks FUND_MILESTONE, OWNER_SPEND and WITHDRAW_RESERVE fields', () => {
    const order = { ...spendRow, kind: 'FUND_MILESTONE', orderId: 'order-a-001', milestoneIdx: 1, amountMinor: '120000', lineId: toBytes32Tag('SUPPLIER') };
    const fund = { orderId: toBytes32Tag('order-a-001'), idx: 1, amountMinor: 120_000n, decisionId: decisionIdToBytes32(DECISION), rationaleHash: h('3') };
    expect(paymentCallMismatch(order, buildFundMilestone(fund).data, ctx)).toBeNull();
    expect(paymentCallMismatch(order, buildFundMilestone({ ...fund, idx: 2 }).data, ctx)).toMatch(/idx/);

    const owner = { ...spendRow, kind: 'OWNER_SPEND', lineId: ownerSpend.lineId, amountMinor: '1', invoiceHash: ownerSpend.invoiceHash, decisionId: null, rationaleHash: null };
    expect(paymentCallMismatch(owner, buildOwnerSpend({ req: { ...ownerSpend, payeeId: toBytes32Tag('shopee-ads') }, founder: sig }).data, ctx)).toMatch(/amountMinor/);

    const reserve = { ...spendRow, kind: 'WITHDRAW_RESERVE', intentId: h('9'), lineId: null, decisionId: null, rationaleHash: null };
    expect(paymentCallMismatch(reserve, buildExecuteLoosen({ loosenId: h('9') }).data, ctx)).toBeNull();
    expect(paymentCallMismatch(reserve, buildExecuteLoosen({ loosenId: h('8') }).data, ctx)).toMatch(/loosenId/);
  });
});

describe('revert decoding (§8.5 custom errors)', () => {
  it('decodes every Hogee custom error, with args', () => {
    expect(hogeeErrorAbi.length).toBeGreaterThanOrEqual(27);
    const data = encodeErrorResult({ abi: iTreasuryAbi, errorName: 'PlanInvariantViolated', args: [7] });
    expect(decodeRevertData(data)).toMatchObject({ name: 'PlanInvariantViolated', args: [7] });
    expect(decodeRevertData(encodeErrorResult({ abi: iTreasuryAbi, errorName: 'PayeeNotBound' }))?.name).toBe('PayeeNotBound');
    expect(decodeRevertData('0xdeadbeef')).toBeNull();
    expect(decodeRevertData('0x')).toBeNull();
  });

  it('finds revert data in a nested viem error chain', () => {
    const data = encodeErrorResult({ abi: iTreasuryAbi, errorName: 'CapExceeded' });
    const err = { message: 'call reverted', cause: { cause: { data } } };
    expect(revertDataFromError(err)).toBe(data);
    expect(revertDataFromError({ cause: { data: { data } } })).toBe(data);
    expect(revertDataFromError(new Error('no data'))).toBeNull();
  });
});
