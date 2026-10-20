/**
 * Binding of what the worker signs to the row's deployment (security-audit run-2 hardening): `to` is the
 * deployment's contract for the row's kind, `value` is 0, and a chain action's calldata is its kind.
 */
import { encodeFunctionData, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  buildFundMilestone,
  buildPause,
  buildRecordDenied,
  buildRecordSale,
  decisionIdToBytes32,
  facilityDeploymentMismatch,
  iTreasuryAbi,
  parseActionKind,
  signBindingMismatch,
  toBytes32Tag,
  type DeploymentContracts,
  type SignedRow,
} from '../src/index';
import { ESCROW, FACILITY, PLAN, spendPayment, TREASURY } from './fixtures/signed-rows';

const REGISTRY: Address = '0x00000000000000000000000000000000000000aa';
const ORACLE: Address = '0x00000000000000000000000000000000000000bb';
/** Another facility's Treasury on the same chain: what a mis-resolved deployment would point at. */
const OTHER_TREASURY: Address = '0x00000000000000000000000000000000000071e6';
const FINAL: DeploymentContracts = {
  PlanRegistry: { address: REGISTRY },
  Treasury: { address: TREASURY },
  MilestoneEscrow: { address: ESCROW },
  SalesOracle: { address: ORACLE },
};
const LOOP: DeploymentContracts = { PlanRegistry: { address: REGISTRY }, Treasury: { address: TREASURY } };
const DECISION = '0199e7a2-5b1c-7d3e-8f4a-1b2c3d4e5f60';
const h = (c: string): Hex => `0x${c.repeat(64)}`;

function unsigned(table: 'payments' | 'chain_actions', extra: Partial<SignedRow>): SignedRow {
  return {
    target: { table, facilityId: FACILITY, id: `${table}-1` },
    state: table === 'payments' ? 'POLICY_OK' : 'PENDING',
    rawSignedTx: null,
    nonce: null,
    signerAddress: null,
    chainId: null,
    txHash: null,
    supersededTxHashes: [],
    nonceConsumedByTxHash: null,
    block: null,
    payment: null,
    actionKind: null,
    ...extra,
  };
}

const spend = spendPayment('inv-bind');
const spendRow = unsigned('payments', { payment: spend.payment });
const action = (kind: string) => unsigned('chain_actions', { actionKind: kind });
const ctx = (contracts: DeploymentContracts = FINAL) => ({ contracts, planId: PLAN });

describe('signBindingMismatch: payments', () => {
  it('accepts the payment call to the deployment contract its kind targets, with no value or value 0', () => {
    expect(signBindingMismatch(spendRow, { to: TREASURY, data: spend.data }, ctx())).toBeNull();
    expect(signBindingMismatch(spendRow, { to: TREASURY.toUpperCase().replace('0X', '0x') as Address, data: spend.data, value: 0n }, ctx())).toBeNull();
  });

  it('refuses a `to` that is not the deployment contract for the kind (another facility’s Treasury, the escrow)', () => {
    expect(signBindingMismatch(spendRow, { to: OTHER_TREASURY, data: spend.data }, ctx())).toMatch(/to is not the deployment's Treasury/);
    expect(signBindingMismatch(spendRow, { to: ESCROW, data: spend.data }, ctx())).toMatch(/to is not the deployment's Treasury/);
  });

  it('refuses a non-zero value (every Hogee entry point is nonpayable)', () => {
    expect(signBindingMismatch(spendRow, { to: TREASURY, data: spend.data, value: 1n }, ctx())).toMatch(/value must be 0/);
  });

  it('refuses a milestone payment when the deployment has no MilestoneEscrow (loop-1)', () => {
    const fund = unsigned('payments', {
      payment: { ...spend.payment, kind: 'FUND_MILESTONE', orderId: 'order-a-001', milestoneIdx: 1, amountMinor: '120000' },
    });
    const data = buildFundMilestone({
      orderId: toBytes32Tag('order-a-001'), idx: 1, amountMinor: 120_000n, decisionId: decisionIdToBytes32(DECISION), rationaleHash: spend.payment.rationaleHash ?? h('3'),
    }).data;
    expect(signBindingMismatch(fund, { to: ESCROW, data }, ctx())).toBeNull();
    expect(signBindingMismatch(fund, { to: ESCROW, data }, ctx(LOOP))).toMatch(/deployment has no MilestoneEscrow/);
  });

  it('still refuses calldata that differs from the payment row', () => {
    expect(signBindingMismatch(spendRow, { to: TREASURY, data: buildPause().data }, ctx())).toMatch(/Treasury.spend/);
  });

  it('refuses a SPEND whose intent_id is not intentId(planId, calldata): another plan, or no plan id at all', () => {
    const request = { to: TREASURY, data: spend.data };
    expect(signBindingMismatch(spendRow, request, { contracts: FINAL, planId: toBytes32Tag('plan-other') })).toMatch(/intent_id/);
    expect(signBindingMismatch(spendRow, request, { contracts: FINAL, planId: null })).toMatch(/planId is required/);
  });
});

describe('signBindingMismatch: chain actions', () => {
  it('accepts calldata that is exactly the `<Contract>.<function>` of the kind, sent to that contract', () => {
    expect(signBindingMismatch(action('Treasury.pause'), { to: TREASURY, data: buildPause().data }, ctx())).toBeNull();
    const sale = buildRecordSale({ saleIdHash: h('5'), amountBucket: 1_000n });
    expect(signBindingMismatch(action('SalesOracle.recordSale'), { to: ORACLE, data: sale.data }, ctx())).toBeNull();
  });

  it('refuses another contract, another function, a view function, an unknown contract and malformed calldata', () => {
    const pause = buildPause().data;
    expect(signBindingMismatch(action('Treasury.pause'), { to: ESCROW, data: pause }, ctx())).toMatch(/to is not the deployment's Treasury/);
    const denied = buildRecordDenied({ lineId: h('0'), decisionId: h('1'), reasonCode: h('2'), proposalHash: h('3') }).data;
    expect(signBindingMismatch(action('Treasury.pause'), { to: TREASURY, data: denied }, ctx())).toMatch(/calldata is not Treasury.pause/);
    const view = encodeFunctionData({ abi: iTreasuryAbi, functionName: 'isIntentUsed', args: [h('9')] });
    expect(signBindingMismatch(action('Treasury.isIntentUsed'), { to: TREASURY, data: view }, ctx())).toMatch(/not a state-changing function/);
    expect(signBindingMismatch(action('Watcher.Spent'), { to: TREASURY, data: pause }, ctx())).toMatch(/names no Hogee contract/);
    expect(signBindingMismatch(action('Treasury.pause'), { to: TREASURY, data: '0xdeadbeef' }, ctx())).toMatch(/calldata is not Treasury.pause/);
    const sale = buildRecordSale({ saleIdHash: h('5'), amountBucket: 1_000n }).data;
    expect(signBindingMismatch(action('SalesOracle.recordSale'), { to: ORACLE, data: sale }, ctx(LOOP))).toMatch(/deployment has no SalesOracle/);
    expect(signBindingMismatch(action('Treasury.pause'), { to: TREASURY, data: pause, value: 5n }, ctx())).toMatch(/value must be 0/);
  });

  it('parseActionKind splits `<Contract>.<function>` and rejects anything else', () => {
    expect(parseActionKind('Treasury.openFacility')).toEqual({ contract: 'Treasury', functionName: 'openFacility' });
    expect(parseActionKind('MilestoneEscrow.releaseMilestone')).toEqual({ contract: 'MilestoneEscrow', functionName: 'releaseMilestone' });
    for (const bad of ['Treasury', 'Treasury.', '.pause', 'Treasury.pause.x', 'Oracle.recordSale', 'treasury.pause']) {
      expect(parseActionKind(bad)).toBeNull();
    }
  });
});

describe('facilityDeploymentMismatch (the facility row names the deployment)', () => {
  const deployment = { deploymentId: 'final-1', chainId: 31337, contracts: FINAL };

  it('accepts the facility’s own deployment on its chain', () => {
    expect(facilityDeploymentMismatch({ deploymentId: 'final-1', chainId: 31337 }, deployment, 31337)).toBeNull();
  });

  it('refuses a missing facility, another deployment, another chain, or a chainId that is not the deployment’s', () => {
    expect(facilityDeploymentMismatch(null, deployment, 31337)).toMatch(/facility not found/);
    expect(facilityDeploymentMismatch({ deploymentId: 'loop-1', chainId: 31337 }, deployment, 31337)).toMatch(/deployment_id/);
    expect(facilityDeploymentMismatch({ deploymentId: 'final-1', chainId: 11155111 }, deployment, 31337)).toMatch(/chain_id/);
    expect(facilityDeploymentMismatch({ deploymentId: 'final-1', chainId: 31337 }, { ...deployment, chainId: 11155111 }, 31337)).toMatch(/chainId/);
  });
});
