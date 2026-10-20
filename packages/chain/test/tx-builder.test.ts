import fc from 'fast-check';
import { encodeAbiParameters, keccak256, toFunctionSelector, type Abi, type AbiFunction, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  buildBindPayee,
  buildCancelLoosen,
  buildCommitPlan,
  buildConfirmSettlement,
  buildExecuteLoosen,
  buildFailSettlement,
  buildFund,
  buildFundMilestone,
  buildOpenFacility,
  buildOwnerSpend,
  buildPause,
  buildQueueLoosen,
  buildRecordDenied,
  buildRecordSale,
  buildRegisterFounderKey,
  buildReleaseMilestone,
  buildReleaseStage,
  buildSpend,
  buildTighten,
  decodeHogeeCall,
  fundMilestoneIntentId,
  HOGEE_ABIS,
  HOGEE_KINDS,
  intentId,
  loosenId,
  milestoneSettlementId,
  reasonCodeToBytes32,
  releaseMilestoneIntentId,
  spendIntentId,
  toBytes32Tag,
  toTxRequest,
  TxValueError,
  utf8Keccak,
  type ContractName,
  type HogeeCall,
} from '../src/index';
import {
  AGENT,
  autoRelease,
  ESCROW,
  lines,
  loosenRequest,
  milestoneRelease,
  ORDER_A,
  ownerSpend,
  PLAN_ID,
  PLAN_REGISTRY,
  planApproval,
  schedule,
  stageRelease,
  stages,
  supplierApproval,
  TREASURY,
} from './fixtures/rina';

const h = (c: string): Hex => `0x${c.repeat(64)}`;
const ECDSA = { kind: HOGEE_KINDS.SIG_ECDSA, data: `0x${'ab'.repeat(65)}` as Hex };
const WEBAUTHN = { kind: HOGEE_KINDS.SIG_WEBAUTHN, data: encodeAbiParameters([{ type: 'bytes' }], ['0x1234']) };

interface Case {
  readonly call: HogeeCall;
  readonly fn: string;
  readonly args: readonly unknown[];
}

/** One case per state-changing function; `args` is what decodeFunctionData must return. */
const cases: Record<string, Case> = {
  'Treasury.spend': {
    call: buildSpend({ lineId: toBytes32Tag('ADS'), payeeId: toBytes32Tag('shopee-ads'), amountMinor: 10_000n, invoiceHash: h('1'), planVersion: 1, decisionId: h('2'), rationaleHash: h('3') }),
    fn: 'spend',
    args: [toBytes32Tag('ADS'), toBytes32Tag('shopee-ads'), 10_000n, h('1'), 1, h('2'), h('3')],
  },
  'Treasury.tighten': {
    call: buildTighten({ kind: HOGEE_KINDS.TIGHTEN_LOWER_PER_TX_CAP, target: toBytes32Tag('ADS'), newValue: 5_000n, decisionId: h('4') }),
    fn: 'tighten',
    args: [HOGEE_KINDS.TIGHTEN_LOWER_PER_TX_CAP, toBytes32Tag('ADS'), 5_000n, h('4')],
  },
  'Treasury.pause': { call: buildPause(), fn: 'pause', args: [] },
  'Treasury.recordDenied': {
    call: buildRecordDenied({ lineId: toBytes32Tag('ADS'), decisionId: h('5'), reasonCode: reasonCodeToBytes32('PayeeNotBound'), proposalHash: h('6') }),
    fn: 'recordDenied',
    args: [toBytes32Tag('ADS'), h('5'), toBytes32Tag('PayeeNotBound'), h('6')],
  },
  'Treasury.confirmSettlement': {
    call: buildConfirmSettlement({ settlementId: h('7'), payoutRefHash: h('8') }),
    fn: 'confirmSettlement',
    args: [h('7'), h('8')],
  },
  'Treasury.failSettlement': {
    call: buildFailSettlement({ settlementId: h('7'), code: reasonCodeToBytes32('INVALID_DESTINATION', 'code') }),
    fn: 'failSettlement',
    args: [h('7'), toBytes32Tag('INVALID_DESTINATION')],
  },
  'Treasury.bindPayee': {
    call: buildBindPayee({ approval: supplierApproval, schedule, autoRelease, founder: WEBAUTHN }),
    fn: 'bindPayee',
    args: [supplierApproval, schedule, autoRelease, WEBAUTHN],
  },
  'Treasury.openFacility': {
    call: buildOpenFacility({ capMinor: 1_000_000n, reserveFloorBps: 300 }),
    fn: 'openFacility',
    args: [1_000_000n, 300],
  },
  'Treasury.fund': { call: buildFund({ amountMinor: 500_000n }), fn: 'fund', args: [500_000n] },
  'Treasury.ownerSpend': {
    call: buildOwnerSpend({ req: ownerSpend, founder: ECDSA }),
    fn: 'ownerSpend',
    args: [ownerSpend, ECDSA],
  },
  'Treasury.queueLoosen': {
    call: buildQueueLoosen({ req: loosenRequest, founder: WEBAUTHN, lender: ECDSA }),
    fn: 'queueLoosen',
    args: [loosenRequest, WEBAUTHN, ECDSA],
  },
  'Treasury.executeLoosen': {
    call: buildExecuteLoosen({ loosenId: loosenId(loosenRequest) }),
    fn: 'executeLoosen',
    args: [loosenId(loosenRequest)],
  },
  'Treasury.cancelLoosen': {
    call: buildCancelLoosen({ loosenId: loosenId(loosenRequest) }),
    fn: 'cancelLoosen',
    args: [loosenId(loosenRequest)],
  },
  'Treasury.releaseStage': {
    call: buildReleaseStage({ req: stageRelease, lender: ECDSA }),
    fn: 'releaseStage',
    args: [stageRelease, ECDSA],
  },
  'PlanRegistry.commitPlan': {
    call: buildCommitPlan({ approval: planApproval, lines, stages, founder: WEBAUTHN }),
    fn: 'commitPlan',
    args: [planApproval, lines, stages, WEBAUTHN],
  },
  'PlanRegistry.registerFounderKey': {
    call: buildRegisterFounderKey({ qx: h('a'), qy: h('b'), ownerEOA: AGENT }),
    fn: 'registerFounderKey',
    args: [h('a'), h('b'), AGENT],
  },
  'MilestoneEscrow.fundMilestone': {
    call: buildFundMilestone({ orderId: ORDER_A, idx: 1, amountMinor: 120_000n, decisionId: h('c'), rationaleHash: h('d') }),
    fn: 'fundMilestone',
    args: [ORDER_A, 1, 120_000n, h('c'), h('d')],
  },
  'MilestoneEscrow.releaseMilestone': {
    call: buildReleaseMilestone({ release: milestoneRelease, founder: WEBAUTHN }),
    fn: 'releaseMilestone',
    args: [milestoneRelease, WEBAUTHN],
  },
  'SalesOracle.recordSale': {
    call: buildRecordSale({ saleIdHash: utf8Keccak('evt_123'), amountBucket: 4_500n }),
    fn: 'recordSale',
    args: [utf8Keccak('evt_123'), 4_500n],
  },
};

const stateChanging = (Object.entries(HOGEE_ABIS) as [ContractName, Abi][]).flatMap(([contract, abi]) =>
  abi
    .filter((i): i is AbiFunction => i.type === 'function' && i.stateMutability !== 'view' && i.stateMutability !== 'pure')
    .map((f) => ({ kind: `${contract}.${f.name}`, contract, f })),
);

describe('tx builder covers the frozen ABIs', () => {
  it('has a builder case for every state-changing function of the four contracts', () => {
    expect(stateChanging.map((s) => s.kind).sort()).toEqual(Object.keys(cases).sort());
  });

  it.each(Object.entries(cases))('%s round-trips through decodeFunctionData', (kind, c) => {
    const entry = stateChanging.find((s) => s.kind === kind);
    expect(entry).toBeDefined();
    expect(c.call.kind).toBe(kind);
    expect(c.call.data.slice(0, 10)).toBe(toFunctionSelector(entry?.f as AbiFunction));
    const decoded = decodeHogeeCall(c.call.contract, c.call.data);
    expect(decoded.functionName).toBe(c.fn);
    expect(decoded.args).toEqual(c.args);
  });
});

describe('builder input validation', () => {
  const spend = { lineId: toBytes32Tag('ADS'), payeeId: toBytes32Tag('shopee-ads'), amountMinor: 1n, invoiceHash: h('1'), planVersion: 1, decisionId: h('2'), rationaleHash: h('3') };

  it.each([
    ['amount above uint128', { amountMinor: 2n ** 128n }],
    ['negative amount', { amountMinor: -1n }],
    ['planVersion above uint32', { planVersion: 2 ** 32 }],
    ['fractional planVersion', { planVersion: 1.5 }],
    ['short lineId', { lineId: '0x1234' as Hex }],
    ['free text payee', { payeeId: 'shopee-ads' as Hex }],
  ])('spend rejects %s', (_name, patch) => {
    expect(() => buildSpend({ ...spend, ...patch })).toThrow(TxValueError);
  });

  it('rejects a 64-byte ECDSA signature and an unknown signature kind', () => {
    expect(() => buildOwnerSpend({ req: ownerSpend, founder: { kind: 0, data: `0x${'ab'.repeat(64)}` } })).toThrow(/65 bytes/);
    expect(() => buildOwnerSpend({ req: ownerSpend, founder: { kind: 2, data: ECDSA.data } })).toThrow(/kind must be 0/);
  });

  it('rejects reserveFloorBps above 100% and mismatched schedule arrays', () => {
    expect(() => buildOpenFacility({ capMinor: 1n, reserveFloorBps: 10_001 })).toThrow(/at most 10000/);
    expect(() => buildBindPayee({ approval: supplierApproval, schedule, autoRelease: [true], founder: ECDSA })).toThrow(/lengths differ/);
  });

  /** Treasury.bindPayee row 6a refuses a zero milestone with PlanInvariantViolated(13): never build that call. */
  it.each([
    ['the first', [0n, 120_000n, 280_000n]],
    ['a middle', [30_000n, 0n, 280_000n]],
    ['the last', [30_000n, 120_000n, 0n]],
  ])('bindPayee rejects a zero milestone (%s entry)', (_name, zeroed) => {
    expect(() => buildBindPayee({ approval: supplierApproval, schedule: zeroed, autoRelease: [true, true, false], founder: ECDSA })).toThrow(TxValueError);
    expect(() => buildBindPayee({ approval: supplierApproval, schedule: zeroed, autoRelease: [true, true, false], founder: ECDSA })).toThrow(/schedule\[\d\] must be above 0/);
  });

  it('spend round-trips for arbitrary in-range values (property)', () => {
    const b32 = fc.uint8Array({ minLength: 32, maxLength: 32 }).map((u) => `0x${Buffer.from(u).toString('hex')}` as Hex);
    fc.assert(
      fc.property(b32, b32, fc.bigInt({ min: 0n, max: 2n ** 128n - 1n }), b32, fc.integer({ min: 0, max: 2 ** 32 - 1 }), b32, b32, (lineId, payeeId, amountMinor, invoiceHash, planVersion, decisionId, rationaleHash) => {
        const c = buildSpend({ lineId, payeeId, amountMinor, invoiceHash, planVersion, decisionId, rationaleHash });
        expect(decodeHogeeCall('Treasury', c.data).args).toEqual([lineId, payeeId, amountMinor, invoiceHash, planVersion, decisionId, rationaleHash]);
      }),
      { numRuns: 200 },
    );
  });
});

describe('toTxRequest', () => {
  const contracts = { PlanRegistry: { address: PLAN_REGISTRY }, Treasury: { address: TREASURY }, MilestoneEscrow: { address: ESCROW } };

  it('resolves the contract address from the deployment', () => {
    expect(toTxRequest(cases['Treasury.pause']?.call as HogeeCall, contracts)).toEqual({ to: TREASURY, data: buildPause().data });
    expect(toTxRequest(cases['MilestoneEscrow.fundMilestone']?.call as HogeeCall, contracts, { gas: 500_000n }).gas).toBe(500_000n);
  });

  it('fails for a contract the deployment does not have (loop-1 has no SalesOracle)', () => {
    expect(() => toTxRequest(cases['SalesOracle.recordSale']?.call as HogeeCall, contracts)).toThrow(/no SalesOracle/);
  });
});

describe('intent ids', () => {
  it('spendIntentId is the §8.4 intentId', () => {
    const p = { planId: PLAN_ID, lineId: toBytes32Tag('ADS'), payeeId: toBytes32Tag('shopee-ads'), invoiceHash: h('1'), amountMinor: 10_000n };
    expect(spendIntentId(p)).toBe(intentId(p));
  });

  it('fundMilestoneIntentId = keccak256(abi.encode(orderId, uint8 idx, uint128 amount, uint128 cumulativeAfter))', () => {
    const expected = keccak256(
      encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint8' }, { type: 'uint128' }, { type: 'uint128' }], [ORDER_A, 1, 120_000n, 150_000n]),
    );
    expect(fundMilestoneIntentId({ orderId: ORDER_A, idx: 1, amountMinor: 120_000n, cumulativeAfterMinor: 150_000n })).toBe(expected);
    expect(fundMilestoneIntentId({ orderId: ORDER_A, idx: 1, amountMinor: 120_000n, cumulativeAfterMinor: 120_000n })).not.toBe(expected);
  });

  it('releaseMilestoneIntentId is the milestone settlementId', () => {
    expect(releaseMilestoneIntentId({ orderId: ORDER_A, idx: 2 })).toBe(milestoneSettlementId(ORDER_A, 2));
    expect(() => releaseMilestoneIntentId({ orderId: ORDER_A, idx: 256 })).toThrow(TxValueError);
  });
});
