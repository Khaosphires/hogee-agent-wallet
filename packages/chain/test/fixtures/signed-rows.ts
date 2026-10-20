/** Builders for signed `payments` / `chain_actions` rows used by the recovery and finality unit tests. */
import type { Address, Hex } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { buildSpend, decisionIdToBytes32, spendIntentId, toBytes32Tag, type PaymentIntentFields, type SignDeployment, type SignedRow } from '../../src/index';
import { signedTx } from './fake-chain';

export const TREASURY: Address = '0x00000000000000000000000000000000000071e5';
export const ESCROW: Address = '0x000000000000000000000000000000000000e5c0';
export const CHAIN = 31337;
export const FACILITY = 'fac-unit';
export const REGISTRY: Address = '0x00000000000000000000000000000000000000aa';
/** The deployment FACILITY names (MemoryRowStore's facilities say so). */
export const DEPLOYMENT: SignDeployment = {
  deploymentId: 'final-1',
  chainId: CHAIN,
  contracts: { PlanRegistry: { address: REGISTRY }, Treasury: { address: TREASURY }, MilestoneEscrow: { address: ESCROW } },
};
export const PLAN = toBytes32Tag('plan-unit-1');
export const ADS = toBytes32Tag('ADS');
const DECISION = '0199e7a2-5b1c-7d3e-8f4a-1b2c3d4e5f60';

/** Rina's ADS pacing slot (§26.5): 7,500 minor units per day to shopee-ads. */
export const PACING_MINOR = 7_500n;

export interface SpendTx {
  readonly payment: PaymentIntentFields;
  readonly data: Hex;
}

export function spendPayment(invoiceSeed: string, amountMinor = PACING_MINOR): SpendTx {
  const invoiceHash = toBytes32Tag(invoiceSeed);
  const payeeId = toBytes32Tag('shopee-ads');
  const rationaleHash = toBytes32Tag(`why-${invoiceSeed}`);
  const intentId = spendIntentId({ planId: PLAN, lineId: ADS, payeeId, invoiceHash, amountMinor });
  const data = buildSpend({ lineId: ADS, payeeId, amountMinor, invoiceHash, planVersion: 1, decisionId: decisionIdToBytes32(DECISION), rationaleHash }).data;
  return {
    data,
    payment: {
      kind: 'SPEND',
      intentId,
      lineId: ADS,
      payeeId: 'shopee-ads',
      orderId: null,
      milestoneIdx: null,
      amountMinor: amountMinor.toString(),
      invoiceHash,
      planVersion: 1,
      decisionId: DECISION,
      rationaleHash,
    },
  };
}

export function paymentRow(a: {
  id: string;
  state: string;
  account: PrivateKeyAccount;
  nonce: bigint;
  raw: Hex;
  txHash: Hex;
  payment: PaymentIntentFields;
  superseded?: readonly Hex[];
  block?: bigint | null;
}): SignedRow {
  return {
    target: { table: 'payments', facilityId: FACILITY, id: a.id },
    state: a.state,
    rawSignedTx: a.raw,
    nonce: a.nonce,
    signerAddress: a.account.address.toLowerCase() as Address,
    chainId: CHAIN,
    txHash: a.txHash,
    supersededTxHashes: a.superseded ?? [],
    nonceConsumedByTxHash: null,
    block: a.block ?? null,
    payment: a.payment,
    actionKind: null,
  };
}

export function actionRow(a: { id: string; state: string; account: PrivateKeyAccount; nonce: bigint; raw: Hex; txHash: Hex; block?: bigint | null }): SignedRow {
  return {
    target: { table: 'chain_actions', facilityId: FACILITY, id: a.id },
    state: a.state,
    rawSignedTx: a.raw,
    nonce: a.nonce,
    signerAddress: a.account.address.toLowerCase() as Address,
    chainId: CHAIN,
    txHash: a.txHash,
    supersededTxHashes: [],
    nonceConsumedByTxHash: null,
    block: a.block ?? null,
    payment: null,
    actionKind: 'Treasury.pause',
  };
}

/** The original signed spend and a ≥10 % fee bump of it (same nonce, to, data). */
export async function originalAndBump(account: PrivateKeyAccount, nonce: bigint, to: Address, data: Hex) {
  const original = await signedTx(account, { nonce, to, data, maxFeePerGas: 2_000_000_000n });
  const bump = await signedTx(account, { nonce, to, data, maxFeePerGas: 2_200_000_000n });
  return { original, bump };
}
