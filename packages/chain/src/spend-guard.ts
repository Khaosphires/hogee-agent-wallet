/**
 * Chain actions that move value (security-audit run-2 follow-up). Value leaves the Treasury or the escrow
 * only through `payments` rows (SPEND, OWNER_SPEND, FUND_MILESTONE, RELEASE_MILESTONE, WITHDRAW_RESERVE),
 * which carry an intent and the REVERTED / CANCELLED proofs. A `chain_actions` row naming one of those
 * functions exists only as red-team evidence (forced reverts, §13.1 principle 6), whose explicit gas skips
 * `eth_estimateGas`. So before signing such a row the sender simulates the call with `eth_call` at `latest`
 * from the signer, and signs only when it REVERTS with a Hogee custom error (CapExceeded, PayeeNotBound, …).
 * A call that succeeds, or a revert that is not a Hogee error, is refused with SpendActionRefusedError.
 *
 * Value-moving: Treasury.spend / ownerSpend, MilestoneEscrow.fundMilestone / releaseMilestone, and
 * Treasury.executeLoosen unless the queued loosen is known (status QUEUED) and is not a reserve withdrawal.
 * The simulation is at `latest`; a state change before inclusion can still change the outcome, which the
 * red-team result (`status: 'success'`) then reports.
 */
import { decodeFunctionData, type Address } from 'viem';
import type { HogeePublicClient } from './clients';
import { iTreasuryAbi } from './generated';
import { HOGEE_KINDS } from './kinds';
import { decodeRevertData, hogeeErrorAbi, revertDataFromError, type DecodedRevert } from './revert';
import { SignTargetError } from './targets';
import type { TxRequest } from './tx-builder';

export type SpendGuardClient = Pick<HogeePublicClient, 'call' | 'readContract'>;

/** `chain_actions.kind` values whose call always moves value. */
export const VALUE_MOVING_ACTIONS: readonly string[] = Object.freeze([
  'Treasury.spend',
  'Treasury.ownerSpend',
  'MilestoneEscrow.fundMilestone',
  'MilestoneEscrow.releaseMilestone',
]);

const EXECUTE_LOOSEN = 'Treasury.executeLoosen';

export type SpendRefusal = 'call_succeeds' | 'not_a_hogee_revert';

export class SpendActionRefusedError extends SignTargetError {
  override readonly name: string = 'SpendActionRefusedError';
  constructor(
    readonly actionKind: string,
    readonly reason: SpendRefusal,
  ) {
    super(
      reason === 'call_succeeds'
        ? `${actionKind} would succeed: value moves only through payments rows; a chain action may only be a forced revert`
        : `${actionKind} does not revert with a Hogee error; refusing to sign it as a chain action`,
    );
  }
}

const HOGEE_ERROR_NAMES = new Set(hogeeErrorAbi.map((e) => e.name));

/** Does this chain action move value? Reads the queued loosen for executeLoosen (fails closed on unknowns). */
export async function movesValue(client: SpendGuardClient, actionKind: string, request: TxRequest): Promise<boolean> {
  if (VALUE_MOVING_ACTIONS.includes(actionKind)) return true;
  if (actionKind !== EXECUTE_LOOSEN) return false;
  const decoded = decodeFunctionData({ abi: iTreasuryAbi, data: request.data });
  if (decoded.functionName !== 'executeLoosen') return true;
  const [loosenId] = decoded.args;
  const queued = await client.readContract({ address: request.to, abi: iTreasuryAbi, functionName: 'queuedLoosen', args: [loosenId], blockTag: 'latest' });
  return !(queued.status === HOGEE_KINDS.LOOSEN_STATUS_QUEUED && queued.kind !== HOGEE_KINDS.LOOSEN_WITHDRAW_RESERVE);
}

/** Simulates the call from `signer` at `latest`; returns its Hogee revert, else throws SpendActionRefusedError. */
export async function assertSimulatedRevert(client: SpendGuardClient, a: { actionKind: string; signer: Address; request: TxRequest }): Promise<DecodedRevert> {
  try {
    await client.call({ account: a.signer, to: a.request.to, data: a.request.data, value: 0n, blockTag: 'latest' });
  } catch (error: unknown) {
    const revert = revertDataFromError(error);
    const decoded = revert ? decodeRevertData(revert) : null;
    if (decoded && HOGEE_ERROR_NAMES.has(decoded.name)) return decoded;
    throw new SpendActionRefusedError(a.actionKind, 'not_a_hogee_revert');
  }
  throw new SpendActionRefusedError(a.actionKind, 'call_succeeds');
}

/**
 * The guard the sender runs for every chain action before signing: null for an action that moves no value;
 * for a value-moving one, its simulated Hogee revert (else SpendActionRefusedError).
 */
export async function guardValueMovingAction(
  client: SpendGuardClient,
  a: { actionKind: string; signer: Address; request: TxRequest },
): Promise<DecodedRevert | null> {
  if (!(await movesValue(client, a.actionKind, a.request))) return null;
  return assertSimulatedRevert(client, a);
}
