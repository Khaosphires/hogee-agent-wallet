/**
 * One entry point that binds any settlement row to the chain (settle.ts), per kind:
 * - SPEND / OWNER_SPEND: settle-verify.ts (intent recompute, isIntentUsed, the finalized Spent / OwnerSpent log);
 * - RELEASE_MILESTONE / FUND_MILESTONE (autoRelease): settle-verify-escrow.ts (the finalized MilestoneReleased);
 * - WITHDRAW_RESERVE: below. The row's tx has a finalized Treasury `ReserveWithdrawn(settlementId = intent_id,
 *   taxPayeeId, amount)` naming the row's payee and amount, and the destination is the tax payee's account fixed at
 *   deployment (Treasury.platformPayoutAccountHash, T1). There is no on-chain invoice: the key's second component is
 *   the deployment scope (settle-chain.ts deploymentKeyScope), so the key derives from the on-chain loosenId alone.
 * Every destination goes through settle-chain.ts verifyDestination. Any mismatch is a verdict: the caller halts and pays
 * and attests nothing.
 */
import { iTreasuryAbi, milestoneSettlementId, type DeploymentManifest } from '@hogee/chain';
import { parseEventLogs, type Hex } from 'viem';
import { bytes32OfShortId, deploymentKeyScope, finalizedHead, finalizedLogsOf, no, ok, same, destinationVerdict, verifyDestination, type BindingResult, type SettlementRow, type VerifyClient } from './settle-chain';
import { verifyMilestoneBinding } from './settle-verify-escrow';
import { verifyLineSpendBinding } from './settle-verify';

/**
 * The on-chain settlementId the row's settlement state is read under: intent_id for every kind whose intent IS the
 * settlement id (spendId, milestone settlementId, loosenId); the milestone's id for an auto-releasing funding (whose
 * intent_id is the funding key). Null when the row cannot name one (the binding then fails too).
 */
export function rowSettlementId(row: Pick<SettlementRow, 'kind' | 'intent_id' | 'order_id' | 'milestone_idx'>): Hex | null {
  if (row.kind !== 'FUND_MILESTONE') return row.intent_id;
  const order = bytes32OfShortId(row.order_id);
  const idx = row.milestone_idx;
  if (order === null || idx === null || !Number.isInteger(idx) || idx < 0 || idx > 255) return null;
  return milestoneSettlementId(order, idx);
}

async function verifyReserveBinding(client: VerifyClient, treasury: Hex, scope: Hex, row: SettlementRow): Promise<BindingResult> {
  const payee = bytes32OfShortId(row.payee_id);
  if (row.line_id !== null || payee === null) return no('INTENT_MISMATCH', 'a reserve withdrawal names no line and a ShortId tax payee');
  const head = await finalizedHead(client);
  const logs = await finalizedLogsOf(client, row.tx_hash, head.number, treasury);
  const ev = logs ? parseEventLogs({ abi: iTreasuryAbi, logs, eventName: 'ReserveWithdrawn' }).find((l) => same(l.args.settlementId, row.intent_id)) : undefined;
  if (!ev) return no('SPEND_MISMATCH', 'no finalized ReserveWithdrawn log for this loosen id in the row tx');
  if (!same(ev.args.taxPayeeId, payee) || ev.args.amountMinor !== BigInt(row.amount_minor)) return no('SPEND_MISMATCH', 'the finalized ReserveWithdrawn log differs from the row');
  const dest = await verifyDestination(client, treasury, head, { kind: 'platform', payee }, row);
  const keys = { settlementId: row.intent_id, invoiceHash: scope };
  if (!dest.ok) return no(destinationVerdict(dest), dest.detail, keys);
  return ok({ ...keys, amountMinor: ev.args.amountMinor, destination: dest.destination });
}

/** The row's binding to the chain at `finalized` (module doc). RPC errors throw. */
export async function verifySettlementBinding(
  client: VerifyClient,
  deployment: Pick<DeploymentManifest, 'chainId' | 'contracts'>,
  planId: Hex | null,
  row: SettlementRow,
): Promise<BindingResult> {
  const contracts = deployment.contracts;
  const scope = deploymentKeyScope(deployment.chainId, contracts.Treasury.address);
  switch (row.kind) {
    case 'SPEND':
    case 'OWNER_SPEND':
      return verifyLineSpendBinding(client, contracts.Treasury.address, planId, row);
    case 'RELEASE_MILESTONE':
    case 'FUND_MILESTONE':
      return verifyMilestoneBinding(client, contracts, scope, row);
    case 'WITHDRAW_RESERVE':
      return verifyReserveBinding(client, contracts.Treasury.address, scope, row);
    default:
      return no('INTENT_MISMATCH', 'not a settlement kind');
  }
}
