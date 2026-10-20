import { describe, expect, it } from 'vitest';
import type { Abi } from 'viem';
import { iMilestoneEscrowAbi, iPlanRegistryAbi, iSalesOracleAbi, iTreasuryAbi } from '../src/index';

const ERRORS = [
  'PlanInvariantViolated', 'StalePlan', 'PayeeNotBound', 'PayeeCooling', 'CapExceeded', 'LineExpired',
  'DuplicateIntent', 'DuplicateInvoice', 'DuplicateSale', 'NotOwner', 'NotLender', 'NotAgent', 'NotOracle',
  'AgentExpired', 'ReserveLocked', 'TimelockActive', 'Paused', 'MilestoneLocked', 'EvidenceMissing',
  'AmountExceedsSchedule', 'SignatureExpired', 'InvalidSignature', 'CircuitOpen',
  // G0-REVIEW additions
  'FounderKeyAlreadySet', 'MissingDecision', 'SettlementClosed', 'EscrowOnly',
];

// §8.6, with `Paused` renamed `TreasuryPaused` (G0-DECISION: name clash with the error), plus G0-REVIEW events.
const EVENTS = [
  'FacilityOpened', 'FounderKeyRegistered', 'PlanCommitted', 'Funded', 'PayeeBound', 'Spent', 'RevenueRecorded',
  'MilestoneFunded', 'MilestoneReleased', 'SaleRecorded', 'ReserveSkimmed', 'Tightened', 'LoosenQueued',
  'LoosenExecuted', 'LoosenCancelled', 'StageReleased', 'Denied', 'TreasuryPaused', 'Unpaused', 'CircuitTripped',
  'SettlementConfirmed', 'SettlementFailed',
  // G0-REVIEW additions
  'OwnerSpent', 'ReserveWithdrawn',
];

const FUNCTIONS: Record<string, readonly string[]> = {
  IPlanRegistry: ['registerFounderKey', 'commitPlan', 'planVersion', 'currentPlan', 'line', 'stage'],
  ITreasury: [
    'openFacility', 'fund', 'bindPayee', 'spend', 'ownerSpend', 'tighten', 'pause', 'queueLoosen', 'executeLoosen',
    'cancelLoosen', 'releaseStage', 'recordDenied', 'confirmSettlement', 'failSettlement', 'pocket', 'isIntentUsed',
    'rollingSpent', 'reserve', 'revenue', 'releasedMinor', 'agentExpiry',
  ],
  IMilestoneEscrow: ['fundMilestone', 'releaseMilestone', 'order', 'milestones'],
  ISalesOracle: ['recordSale', 'isSaleRecorded'],
};

const ABIS: Record<string, Abi> = {
  IPlanRegistry: iPlanRegistryAbi,
  ITreasury: iTreasuryAbi,
  IMilestoneEscrow: iMilestoneEscrowAbi,
  ISalesOracle: iSalesOracleAbi,
};

const names = (abi: Abi, type: string) =>
  abi.filter((item) => item.type === type).map((item) => ('name' in item ? item.name : ''));

describe.each(Object.keys(ABIS))('%s generated ABI', (name) => {
  const abi = ABIS[name] as Abi;

  it('decodes every §8.5 error and §8.6 event', () => {
    expect(names(abi, 'error').sort()).toEqual([...ERRORS].sort());
    expect(names(abi, 'event').sort()).toEqual([...EVENTS].sort());
  });

  it('exposes the §26.9 functions', () => {
    expect(names(abi, 'function')).toEqual(expect.arrayContaining([...(FUNCTIONS[name] ?? [])]));
  });
});

it('spend keeps the §8.4 parameter order', () => {
  const spend = iTreasuryAbi.find((i) => i.type === 'function' && i.name === 'spend');
  expect(spend && 'inputs' in spend ? spend.inputs.map((i) => i.name) : []).toEqual([
    'lineId', 'payeeId', 'amountMinor', 'invoiceHash', 'planVersion', 'decisionId', 'rationaleHash',
  ]);
});

it('Spent and OwnerSpent carry planVersion; PayeeBound carries the payout destination (G0-REVIEW)', () => {
  const event = (name: string) => iTreasuryAbi.find((i) => i.type === 'event' && i.name === name);
  const inputs = (name: string) => {
    const e = event(name);
    return e && 'inputs' in e ? e.inputs.map((i) => i.name) : [];
  };
  expect(inputs('Spent').at(-1)).toBe('planVersion');
  expect(inputs('OwnerSpent')).toEqual(['spendId', 'lineId', 'payeeId', 'amountMinor', 'invoiceHash', 'planVersion']);
  expect(inputs('PayeeBound').slice(-3)).toEqual(['supplierId', 'scheduleHash', 'payoutAccountHash']);
  expect(inputs('PlanCommitted').slice(-3)).toEqual(['linesHash', 'stagesHash', 'reserveBps']);
});
