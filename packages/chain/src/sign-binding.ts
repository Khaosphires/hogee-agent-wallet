/**
 * Binds what the worker signs to the row's deployment (security-audit run-2 hardening). One worker key
 * serves several facilities, and every facility has its own deployment, so a mis-resolved `to` must fail
 * closed BEFORE signing. For the row it signs for, the sender checks:
 * - the facility row names the deployment the caller resolved (`deployment_id`, `chain_id`);
 * - `to` is that deployment's contract for the row's kind (payments: by payment kind; chain actions: the
 *   `<Contract>` of `<Contract>.<function>`), and `value` is 0 (every Hogee entry point is nonpayable);
 * - chain actions: the calldata decodes as `<function>` of that contract, a state-changing function;
 * - payments: the calldata is the call the row describes, `intent_id` included (payment-call.ts).
 * Every check returns a reason (never values) or null.
 */
import { decodeFunctionData, getAbiItem, getAddress, isAddress, type Abi, type Address, type Hex } from 'viem';
import { CONTRACT_NAMES, type ContractName, type DeploymentContracts, type DeploymentManifest } from './deployments';
import { paymentCallMismatch } from './payment-call';
import { SignTargetError, type FacilityDeployment, type SignedRow } from './targets';
import { HOGEE_ABIS, type TxRequest } from './tx-builder';

/** The deployment a facility signs against: its manifest, or the part of it the sender checks. */
export type SignDeployment = Pick<DeploymentManifest, 'deploymentId' | 'chainId' | 'contracts'>;

/** The contract each payment kind calls (payment-call.ts checks the function and its arguments). */
export const PAYMENT_KIND_CONTRACT: { readonly [kind: string]: ContractName } = Object.freeze({
  SPEND: 'Treasury',
  OWNER_SPEND: 'Treasury',
  WITHDRAW_RESERVE: 'Treasury',
  FUND_MILESTONE: 'MilestoneEscrow',
  RELEASE_MILESTONE: 'MilestoneEscrow',
});

const ACTION_KIND_RE = /^([A-Za-z]+)\.([A-Za-z_][A-Za-z0-9_]*)$/;

/** `<Contract>.<function>` of a `chain_actions.kind`, or null when it names no Hogee contract. */
export function parseActionKind(kind: string): { contract: ContractName; functionName: string } | null {
  const m = ACTION_KIND_RE.exec(kind);
  if (!m) return null;
  const [, contract, functionName] = m;
  if (!contract || !functionName || !(CONTRACT_NAMES as readonly string[]).includes(contract)) return null;
  return { contract: contract as ContractName, functionName };
}

function toMismatch(contract: ContractName, to: Address, contracts: DeploymentContracts): string | null {
  const deployed = contracts[contract];
  if (!deployed) return `deployment has no ${contract}`;
  if (typeof to !== 'string' || !isAddress(to, { strict: false })) return 'to is not an address';
  return getAddress(to) === getAddress(deployed.address) ? null : `to is not the deployment's ${contract}`;
}

function actionCallMismatch(contract: ContractName, functionName: string, data: TxRequest['data']): string | null {
  const abi = HOGEE_ABIS[contract] as Abi;
  let decoded: string;
  try {
    decoded = decodeFunctionData({ abi, data }).functionName;
  } catch {
    decoded = '';
  }
  if (decoded !== functionName) return `calldata is not ${contract}.${functionName}`;
  const item = getAbiItem({ abi, name: functionName });
  const mutability = item && item.type === 'function' ? item.stateMutability : 'view';
  return mutability === 'view' || mutability === 'pure' ? `${contract}.${functionName} is not a state-changing function` : null;
}

export interface SignBindingContext {
  readonly contracts: DeploymentContracts;
  /** On-chain planId of the facility's plan; SPEND / OWNER_SPEND rows need it (their intent_id is recomputed). */
  readonly planId: Hex | null;
}

/** Null when `request` is a call the row may sign on this deployment, else the first reason it may not. */
export function signBindingMismatch(row: SignedRow, request: TxRequest, ctx: SignBindingContext): string | null {
  if (request.value !== undefined && request.value !== 0n) return 'value must be 0 (Hogee entry points are nonpayable)';
  if (row.target.table === 'payments') {
    if (!row.payment) return 'payment row has no payment fields';
    const contract = PAYMENT_KIND_CONTRACT[row.payment.kind];
    if (!contract) return `unknown payment kind ${row.payment.kind}`;
    return toMismatch(contract, request.to, ctx.contracts) ?? paymentCallMismatch(row.payment, request.data, { planId: ctx.planId });
  }
  const kind = row.actionKind === null ? null : parseActionKind(row.actionKind);
  if (!kind) return 'chain action kind names no Hogee contract function';
  return toMismatch(kind.contract, request.to, ctx.contracts) ?? actionCallMismatch(kind.contract, kind.functionName, request.data);
}

/** Null when the facility row names `deployment` on `chainId`, else the reason it does not. */
export function facilityDeploymentMismatch(facility: FacilityDeployment | null, deployment: SignDeployment, chainId: number): string | null {
  if (deployment.chainId !== chainId) return 'chainId is not the deployment chainId';
  if (!facility) return 'facility not found';
  if (facility.deploymentId !== deployment.deploymentId) return 'facility deployment_id is not the deployment';
  if (facility.chainId !== chainId) return 'facility chain_id is not the signing chainId';
  return null;
}

export class DeploymentMismatchError extends SignTargetError {
  override readonly name: string = 'DeploymentMismatchError';
}

/**
 * Throws DeploymentMismatchError unless the facility row names `deployment` on `chainId`. The sender, recovery
 * and finality call it before touching any row, so a mis-resolved manifest can neither sign against another
 * facility's contracts nor read another deployment's `isIntentUsed` as `absent` (a false CANCELLED proof).
 */
export function assertFacilityDeployment(facilityId: string, facility: FacilityDeployment | null, deployment: SignDeployment, chainId: number): void {
  const mismatch = facilityDeploymentMismatch(facility, deployment, chainId);
  if (mismatch) throw new DeploymentMismatchError(`facility ${facilityId}: ${mismatch}`);
}
