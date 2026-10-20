/**
 * Rina demo numbers (project.md §26.2) as on-chain fixtures.
 * Mirror of contracts/test/utils/RinaFixture.sol: change both together, then both golden tests.
 * G0-REVIEW (M15): lines/stages are derived from a PlanManifest-shaped object with the numbers and ShortIds of
 * packages/core/src/demo/rina.ts (RINA_LINES, RINA_STAGES, RINA_IDS), via manifestToLines/manifestToStages.
 */
import type { Address, Hex } from 'viem';
import {
  HOGEE_KINDS,
  hashLines,
  hashStages,
  manifestToLines,
  manifestToStages,
  scheduleHash,
  toBytes32Tag,
  utf8Keccak,
  type ManifestInput,
  type LoosenRequestMessage,
  type MilestoneReleaseMessage,
  type OnchainLine,
  type OnchainStage,
  type OwnerSpendMessage,
  type PlanApprovalMessage,
  type StageReleaseMessage,
  type SupplierApprovalMessage,
} from '../../src/index';

export const DAY = 86_400n;
export const T0 = 1_792_108_800n; // 2026-10-16T00:00:00Z
export const WINDOW = 604_800;

export const CHAIN_TAG = toBytes32Tag('sepolia');
export const DEPLOYMENT_ID = toBytes32Tag('final-1');

export const PLAN_REGISTRY: Address = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
export const TREASURY: Address = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
export const ESCROW: Address = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0';
export const AGENT: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

export const PLAN_ID: Hex = '0x000000000000000000000000000000000199e7a25b1c7d3e8f4a1b2c3d4e5f60';
export const ORDER_A = toBytes32Tag('order-a-001'); // RINA_IDS.supplierAOrderId
export const SUPPLIER_A = toBytes32Tag('supplier-a'); // RINA_IDS.supplierAId and supplierAPayeeId

/** JCS (RFC 8785) of supplier A's test payout account {channel, accountNumber, holderName}, keys sorted. */
export const SUPPLIER_A_ACCOUNT_JCS = '{"accountNumber":"1234567890","channel":"MY_DUITNOW","holderName":"Supplier A Co Ltd"}';

const tag = toBytes32Tag;
const at = (days: bigint): string => String(T0 + days * DAY);

function manifestLine(
  lineKey: string,
  amount: number,
  pacing: number,
  escrowOnly: boolean,
  payeeIds: string[],
): ManifestInput['lines'][number] {
  return {
    lineKey,
    lineId: tag(lineKey),
    amountMinor: String(amount),
    perTxCapMinor: String(amount / 4), // constitution maxima: perTx 25%, window 50%
    windowCapMinor: String(amount / 2),
    windowSeconds: String(WINDOW),
    validUntil: at(60n),
    payeeIds,
    escrowOnly,
    ...(pacing > 0 ? { pacing: { period: 'day' as const, amountMinor: String(pacing) } } : {}),
  };
}

/** The lines/stages slice of Rina's PlanManifest v1 (core RINA_LINES / RINA_STAGES). */
export const rinaManifest: ManifestInput = {
  lines: [
    manifestLine('SUPPLIER', 500_000, 0, true, []),
    manifestLine('PACKAGING', 150_000, 0, false, []),
    manifestLine('LOGISTICS', 80_000, 0, false, ['spx-logistics']),
    manifestLine('ADS', 120_000, 7_500, false, ['shopee-ads']),
    manifestLine('PLATFORM_FEES', 50_000, 0, false, ['shopee-fees']),
    manifestLine('CONTINGENCY', 100_000, 0, false, []),
  ],
  stages: [
    { stageId: 'stage-1', releaseMinor: '400000', gate: null },
    { stageId: 'stage-2', releaseMinor: '600000', gate: { metric: 'salesMinor', target: '200000', deadline: at(30n) } },
  ],
};

export const lines: readonly OnchainLine[] = manifestToLines(rinaManifest);
export const stages: readonly OnchainStage[] = manifestToStages(rinaManifest);

export const planApproval: PlanApprovalMessage = {
  planId: PLAN_ID,
  version: 1,
  prevPlanHash: `0x${'0'.repeat(64)}`,
  planHash: utf8Keccak('hogee/golden/plan-v1'),
  countryPackHash: utf8Keccak('hogee/golden/country-pack-MY'),
  linesHash: hashLines(lines),
  stagesHash: hashStages(stages),
  totalMinor: 1_000_000n,
  reserveBps: 500,
  agent: AGENT,
  agentExpiry: T0 + 60n * DAY,
  deploymentId: DEPLOYMENT_ID,
  nonce: 1n,
  expiry: T0 + DAY,
};

export const schedule: readonly bigint[] = [30_000n, 120_000n, 280_000n];
export const autoRelease: readonly boolean[] = [true, true, false];

export const supplierApproval: SupplierApprovalMessage = {
  orderId: ORDER_A,
  supplierId: SUPPLIER_A,
  payee: SUPPLIER_A,
  payoutAccountHash: utf8Keccak(SUPPLIER_A_ACCOUNT_JCS),
  lineId: tag('SUPPLIER'),
  scheduleHash: scheduleHash(schedule, autoRelease),
  totalMinor: 430_000n,
  quoteHash: utf8Keccak('hogee/golden/quote-A'),
  shortlistHash: utf8Keccak('hogee/golden/shortlist'),
  chosenIndex: 0,
  inspectionRequired: true,
  deploymentId: DEPLOYMENT_ID,
  nonce: 2n,
  expiry: T0 + DAY,
};

export const milestoneRelease: MilestoneReleaseMessage = {
  orderId: ORDER_A,
  idx: 2,
  amountMinor: 280_000n,
  evidenceHash: utf8Keccak('hogee/golden/inspection-A'),
  deploymentId: DEPLOYMENT_ID,
  nonce: 3n,
  expiry: T0 + DAY,
};

export const loosenRequest: LoosenRequestMessage = {
  kind: HOGEE_KINDS.LOOSEN_MOVE_POCKETS,
  target: tag('CONTINGENCY'),
  aux: tag('ADS'),
  newValue: 20_000n,
  deploymentId: DEPLOYMENT_ID,
  nonce: 4n,
  expiry: T0 + DAY,
};

export const stageRelease: StageReleaseMessage = {
  stageId: tag('stage-2'),
  amountMinor: 600_000n,
  deploymentId: DEPLOYMENT_ID,
  nonce: 5n,
  expiry: T0 + DAY,
};

export const ownerSpend: OwnerSpendMessage = {
  lineId: tag('PACKAGING'),
  payeeId: tag('payee-packaging-1'),
  amountMinor: 30_000n,
  invoiceHash: utf8Keccak('hogee/golden/invoice-pk-1'),
  deploymentId: DEPLOYMENT_ID,
  nonce: 6n,
  expiry: T0 + DAY,
};
