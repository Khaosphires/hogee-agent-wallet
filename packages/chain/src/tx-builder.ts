/**
 * Typed calldata builders for every state-changing Hogee call (§26.9). D6: the AI never writes calldata;
 * deterministic code calls these with typed values (bigint / number / boolean / Hex), never free text.
 * ABIs come from the generated (frozen) `generated.ts`.
 */
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256, type Address, type Hex } from 'viem';
import type { ContractName, DeploymentContracts } from './deployments';
import type {
  LoosenRequestMessage,
  MilestoneReleaseMessage,
  OwnerSpendMessage,
  PlanApprovalMessage,
  StageReleaseMessage,
  SupplierApprovalMessage,
} from './eip712';
import { iMilestoneEscrowAbi, iPlanRegistryAbi, iSalesOracleAbi, iTreasuryAbi } from './generated';
import { intentId, milestoneSettlementId, type IntentParams, type OnchainLine, type OnchainStage } from './hashes';
import { HOGEE_KINDS } from './kinds';
import { assertAddress, assertBytes, assertHex32, assertSmallUint, assertUint, TxValueError } from './values';

export const HOGEE_ABIS = {
  Treasury: iTreasuryAbi,
  PlanRegistry: iPlanRegistryAbi,
  MilestoneEscrow: iMilestoneEscrowAbi,
  SalesOracle: iSalesOracleAbi,
} as const satisfies Record<ContractName, unknown>;

/** Calldata for one contract call. `kind` is the `chain_actions.kind` value, `<Contract>.<function>`. */
export interface HogeeCall<C extends ContractName = ContractName> {
  readonly contract: C;
  readonly functionName: string;
  readonly kind: `${C}.${string}`;
  readonly data: Hex;
}

/** What the signer needs: destination + calldata (+ optional value and explicit gas). */
export interface TxRequest {
  readonly to: Address;
  readonly data: Hex;
  readonly value?: bigint;
  /** Explicit gas limit; when absent the sender estimates it. */
  readonly gas?: bigint;
}

/** §26.9 Sig { uint8 kind; bytes data }: 0 = ECDSA (65 bytes), 1 = abi.encode(WebAuthn.WebAuthnAuth). */
export interface OnchainSig {
  readonly kind: number;
  readonly data: Hex;
}

function call<C extends ContractName>(contract: C, functionName: string, data: Hex): HogeeCall<C> {
  return Object.freeze({ contract, functionName, kind: `${contract}.${functionName}` as const, data });
}

function sig(value: OnchainSig, field: string): { kind: number; data: Hex } {
  assertBytes(value.data, `${field}.data`);
  if (value.kind === HOGEE_KINDS.SIG_ECDSA) {
    if (value.data.length !== 2 + 65 * 2) throw new TxValueError(`${field}: an ECDSA signature is 65 bytes`);
  } else if (value.kind === HOGEE_KINDS.SIG_WEBAUTHN) {
    if (value.data.length <= 2) throw new TxValueError(`${field}: a WebAuthn signature must not be empty`);
  } else {
    throw new TxValueError(`${field}.kind must be 0 (ECDSA) or 1 (WebAuthn)`);
  }
  return { kind: value.kind, data: value.data };
}

// ---- Treasury ------------------------------------------------------------------------------------

export interface SpendArgs {
  lineId: Hex;
  payeeId: Hex;
  amountMinor: bigint;
  invoiceHash: Hex;
  planVersion: number;
  decisionId: Hex;
  rationaleHash: Hex;
}

/** Treasury.spend (onlyAgent). spendId = intentId(planId, lineId, payeeId, invoiceHash, amount). */
export function buildSpend(a: SpendArgs): HogeeCall<'Treasury'> {
  const args = [
    assertHex32(a.lineId, 'lineId'),
    assertHex32(a.payeeId, 'payeeId'),
    assertUint(a.amountMinor, 128, 'amountMinor'),
    assertHex32(a.invoiceHash, 'invoiceHash'),
    assertSmallUint(a.planVersion, 32, 'planVersion'),
    assertHex32(a.decisionId, 'decisionId'),
    assertHex32(a.rationaleHash, 'rationaleHash'),
  ] as const;
  return call('Treasury', 'spend', encodeFunctionData({ abi: iTreasuryAbi, functionName: 'spend', args }));
}

/** Treasury.tighten (agent may only tighten). kind: HOGEE_KINDS.TIGHTEN_*. */
export function buildTighten(a: { kind: number; target: Hex; newValue: bigint; decisionId: Hex }): HogeeCall<'Treasury'> {
  const args = [
    assertSmallUint(a.kind, 8, 'kind'),
    assertHex32(a.target, 'target'),
    assertUint(a.newValue, 256, 'newValue'),
    assertHex32(a.decisionId, 'decisionId'),
  ] as const;
  return call('Treasury', 'tighten', encodeFunctionData({ abi: iTreasuryAbi, functionName: 'tighten', args }));
}

export function buildPause(): HogeeCall<'Treasury'> {
  return call('Treasury', 'pause', encodeFunctionData({ abi: iTreasuryAbi, functionName: 'pause' }));
}

/** Treasury.recordDenied (onlyAgent). lineId 0 = no line; reasonCode = reasonCodeToBytes32(code). */
export function buildRecordDenied(a: { lineId: Hex; decisionId: Hex; reasonCode: Hex; proposalHash: Hex }): HogeeCall<'Treasury'> {
  const args = [
    assertHex32(a.lineId, 'lineId'),
    assertHex32(a.decisionId, 'decisionId'),
    assertHex32(a.reasonCode, 'reasonCode'),
    assertHex32(a.proposalHash, 'proposalHash'),
  ] as const;
  return call('Treasury', 'recordDenied', encodeFunctionData({ abi: iTreasuryAbi, functionName: 'recordDenied', args }));
}

/** Treasury.confirmSettlement (onlyOracle), §9.1 step 4. */
export function buildConfirmSettlement(a: { settlementId: Hex; payoutRefHash: Hex }): HogeeCall<'Treasury'> {
  const args = [assertHex32(a.settlementId, 'settlementId'), assertHex32(a.payoutRefHash, 'payoutRefHash')] as const;
  return call('Treasury', 'confirmSettlement', encodeFunctionData({ abi: iTreasuryAbi, functionName: 'confirmSettlement', args }));
}

/** Treasury.failSettlement (onlyOracle). code = reasonCodeToBytes32('INVALID_DESTINATION'), …. */
export function buildFailSettlement(a: { settlementId: Hex; code: Hex }): HogeeCall<'Treasury'> {
  const args = [assertHex32(a.settlementId, 'settlementId'), assertHex32(a.code, 'code')] as const;
  return call('Treasury', 'failSettlement', encodeFunctionData({ abi: iTreasuryAbi, functionName: 'failSettlement', args }));
}

/**
 * Treasury.bindPayee (relayer submits the founder-signed SupplierApproval). A zero milestone is refused here: the
 * contract reverts PlanInvariantViolated(13) on one (bindPayee row 6a, audit run-3).
 */
export function buildBindPayee(a: {
  approval: SupplierApprovalMessage;
  schedule: readonly bigint[];
  autoRelease: readonly boolean[];
  founder: OnchainSig;
}): HogeeCall<'Treasury'> {
  if (a.schedule.length !== a.autoRelease.length) throw new TxValueError('schedule and autoRelease lengths differ');
  a.schedule.forEach((amount, i) => {
    assertUint(amount, 128, `schedule[${i}]`);
    if (amount === 0n) throw new TxValueError(`schedule[${i}] must be above 0 (a zero milestone reverts bindPayee)`);
  });
  const args = [a.approval, a.schedule, a.autoRelease, sig(a.founder, 'founder')] as const;
  return call('Treasury', 'bindPayee', encodeFunctionData({ abi: iTreasuryAbi, functionName: 'bindPayee', args }));
}

/** Treasury.openFacility (onlyLender). */
export function buildOpenFacility(a: { capMinor: bigint; reserveFloorBps: number }): HogeeCall<'Treasury'> {
  const bps = assertSmallUint(a.reserveFloorBps, 16, 'reserveFloorBps');
  if (bps > 10_000) throw new TxValueError('reserveFloorBps must be at most 10000');
  const args = [assertUint(a.capMinor, 128, 'capMinor'), bps] as const;
  return call('Treasury', 'openFacility', encodeFunctionData({ abi: iTreasuryAbi, functionName: 'openFacility', args }));
}

/** Treasury.fund (onlyLender). */
export function buildFund(a: { amountMinor: bigint }): HogeeCall<'Treasury'> {
  const args = [assertUint(a.amountMinor, 128, 'amountMinor')] as const;
  return call('Treasury', 'fund', encodeFunctionData({ abi: iTreasuryAbi, functionName: 'fund', args }));
}

/** Treasury.ownerSpend (relayer submits the founder-signed OwnerSpend; manual fallback). */
export function buildOwnerSpend(a: { req: OwnerSpendMessage; founder: OnchainSig }): HogeeCall<'Treasury'> {
  const args = [a.req, sig(a.founder, 'founder')] as const;
  return call('Treasury', 'ownerSpend', encodeFunctionData({ abi: iTreasuryAbi, functionName: 'ownerSpend', args }));
}

/** Treasury.queueLoosen (founder + lender signatures, §8.8). */
export function buildQueueLoosen(a: { req: LoosenRequestMessage; founder: OnchainSig; lender: OnchainSig }): HogeeCall<'Treasury'> {
  const args = [a.req, sig(a.founder, 'founder'), sig(a.lender, 'lender')] as const;
  return call('Treasury', 'queueLoosen', encodeFunctionData({ abi: iTreasuryAbi, functionName: 'queueLoosen', args }));
}

export function buildExecuteLoosen(a: { loosenId: Hex }): HogeeCall<'Treasury'> {
  const args = [assertHex32(a.loosenId, 'loosenId')] as const;
  return call('Treasury', 'executeLoosen', encodeFunctionData({ abi: iTreasuryAbi, functionName: 'executeLoosen', args }));
}

export function buildCancelLoosen(a: { loosenId: Hex }): HogeeCall<'Treasury'> {
  const args = [assertHex32(a.loosenId, 'loosenId')] as const;
  return call('Treasury', 'cancelLoosen', encodeFunctionData({ abi: iTreasuryAbi, functionName: 'cancelLoosen', args }));
}

/** Treasury.releaseStage (lender-signed StageRelease). */
export function buildReleaseStage(a: { req: StageReleaseMessage; lender: OnchainSig }): HogeeCall<'Treasury'> {
  const args = [a.req, sig(a.lender, 'lender')] as const;
  return call('Treasury', 'releaseStage', encodeFunctionData({ abi: iTreasuryAbi, functionName: 'releaseStage', args }));
}

// ---- PlanRegistry --------------------------------------------------------------------------------

/** PlanRegistry.commitPlan: lines/stages must be the exact arrays hashed into approval.linesHash/stagesHash. */
export function buildCommitPlan(a: {
  approval: PlanApprovalMessage;
  lines: readonly OnchainLine[];
  stages: readonly OnchainStage[];
  founder: OnchainSig;
}): HogeeCall<'PlanRegistry'> {
  const args = [a.approval, a.lines, a.stages, sig(a.founder, 'founder')] as const;
  return call('PlanRegistry', 'commitPlan', encodeFunctionData({ abi: iPlanRegistryAbi, functionName: 'commitPlan', args }));
}

/** PlanRegistry.registerFounderKey (onlyLender, once). qx = qy = 0 → ECDSA-only owner. */
export function buildRegisterFounderKey(a: { qx: Hex; qy: Hex; ownerEOA: Address }): HogeeCall<'PlanRegistry'> {
  const args = [assertHex32(a.qx, 'qx'), assertHex32(a.qy, 'qy'), assertAddress(a.ownerEOA, 'ownerEOA')] as const;
  return call(
    'PlanRegistry',
    'registerFounderKey',
    encodeFunctionData({ abi: iPlanRegistryAbi, functionName: 'registerFounderKey', args }),
  );
}

// ---- MilestoneEscrow / SalesOracle -----------------------------------------------------------------

/** MilestoneEscrow.fundMilestone (onlyAgent). */
export function buildFundMilestone(a: {
  orderId: Hex;
  idx: number;
  amountMinor: bigint;
  decisionId: Hex;
  rationaleHash: Hex;
}): HogeeCall<'MilestoneEscrow'> {
  const args = [
    assertHex32(a.orderId, 'orderId'),
    assertSmallUint(a.idx, 8, 'idx'),
    assertUint(a.amountMinor, 128, 'amountMinor'),
    assertHex32(a.decisionId, 'decisionId'),
    assertHex32(a.rationaleHash, 'rationaleHash'),
  ] as const;
  return call('MilestoneEscrow', 'fundMilestone', encodeFunctionData({ abi: iMilestoneEscrowAbi, functionName: 'fundMilestone', args }));
}

/** MilestoneEscrow.releaseMilestone (relayer submits the founder-signed MilestoneRelease). */
export function buildReleaseMilestone(a: { release: MilestoneReleaseMessage; founder: OnchainSig }): HogeeCall<'MilestoneEscrow'> {
  const args = [a.release, sig(a.founder, 'founder')] as const;
  return call(
    'MilestoneEscrow',
    'releaseMilestone',
    encodeFunctionData({ abi: iMilestoneEscrowAbi, functionName: 'releaseMilestone', args }),
  );
}

/** SalesOracle.recordSale (onlyOracle). saleIdHash = utf8Keccak(stripeEventId); amountBucket in minor units. */
export function buildRecordSale(a: { saleIdHash: Hex; amountBucket: bigint }): HogeeCall<'SalesOracle'> {
  const args = [assertHex32(a.saleIdHash, 'saleIdHash'), assertUint(a.amountBucket, 128, 'amountBucket')] as const;
  return call('SalesOracle', 'recordSale', encodeFunctionData({ abi: iSalesOracleAbi, functionName: 'recordSale', args }));
}

// ---- requests, decoding, intent ids --------------------------------------------------------------

/** Resolves the call's contract address from a deployment manifest's `contracts`. */
export function toTxRequest(c: HogeeCall, contracts: DeploymentContracts, extra: { value?: bigint; gas?: bigint } = {}): TxRequest {
  const deployed = contracts[c.contract];
  if (!deployed) throw new TxValueError(`deployment has no ${c.contract}`);
  return Object.freeze({ to: deployed.address, data: c.data, ...extra });
}

/** Decodes calldata built for `contract` (round-trip checks, evidence, the T27 verifier). */
export function decodeHogeeCall(contract: ContractName, data: Hex): { functionName: string; args: readonly unknown[] } {
  const decoded = decodeFunctionData({ abi: HOGEE_ABIS[contract], data });
  return { functionName: decoded.functionName, args: decoded.args ?? [] };
}

/** SPEND intentId (= on-chain spendId, `isIntentUsed`), §8.4. */
export function spendIntentId(params: IntentParams): Hex {
  return intentId(params);
}

/**
 * FUND_MILESTONE intent key (off-chain; `fundMilestone` has no intent registry), per the payments schema:
 * keccak256(abi.encode(bytes32 orderId, uint8 idx, uint128 amountMinor, uint128 cumulativeAfterMinor)).
 */
export function fundMilestoneIntentId(a: { orderId: Hex; idx: number; amountMinor: bigint; cumulativeAfterMinor: bigint }): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint8' }, { type: 'uint128' }, { type: 'uint128' }],
      [
        assertHex32(a.orderId, 'orderId'),
        assertSmallUint(a.idx, 8, 'idx'),
        assertUint(a.amountMinor, 128, 'amountMinor'),
        assertUint(a.cumulativeAfterMinor, 128, 'cumulativeAfterMinor'),
      ],
    ),
  );
}

/**
 * RELEASE_MILESTONE intent key (defined here, as the payments schema delegates it): each milestone is
 * released once, so the key is its settlementId keccak256(abi.encode(bytes32 orderId, uint8 idx)).
 * Recovery checks `MilestoneEscrow.milestones(orderId)[idx].released` on-chain (released stays true for good, even
 * after a failed payout: re-check M-1), and Treasury.settlementState of this id when it reads false (defence in depth).
 */
export function releaseMilestoneIntentId(a: { orderId: Hex; idx: number }): Hex {
  return milestoneSettlementId(assertHex32(a.orderId, 'orderId'), assertSmallUint(a.idx, 8, 'idx'));
}
