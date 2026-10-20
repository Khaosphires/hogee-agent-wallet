/**
 * Binds a milestone settlement row to the chain (§9.1: settle on `MilestoneReleased`; settlementId =
 * keccak256(abi.encode(orderId, idx))). Two rows can carry one:
 * - RELEASE_MILESTONE (the founder's MilestoneRelease, relayed): intent_id must BE the milestone settlementId;
 * - FUND_MILESTONE whose funding completed an autoRelease milestone: MilestoneEscrow releases it inside the same
 *   fundMilestone call. The row must be that funding (its finalized MilestoneFunded matches the row's amount, decision
 *   and rationale, and intent_id is fundMilestoneIntentId(orderId, idx, amount, fundedTotal)); a funding that released
 *   nothing is not a settlement (verdict NONE), and only fundings of an autoRelease milestone that reads released at
 *   `finalized` are even looked at.
 * Then, for both: the row tx's finalized MilestoneReleased for this (orderId, idx, settlementId) names the row's payee;
 * the escrow order at `finalized` pays that payee on the row's line; and the destination is the account whose hash the
 * founder signed in the SupplierApproval (the line binding, settle-chain.ts verifyDestination, T1). The paid amount is
 * the released amount from the event. Milestones have no on-chain invoice: the idempotency key's second component is the
 * deployment scope (settle-chain.ts deploymentKeyScope), so the key derives from the on-chain settlementId alone (never
 * the DB invoice_hash), and each settlementId is settled once ever (escrowRelease reverts SettlementClosed on a reused
 * id; after a failSettlement the milestone is never paid again, whichever escrow version un-released it or not).
 */
import { fundMilestoneIntentId, iMilestoneEscrowAbi, milestoneSettlementId, type DeploymentContracts } from '@hogee/chain';
import { parseEventLogs, type Hex, type Log } from 'viem';
import { bytes32OfShortId, decisionMatches, finalizedHead, finalizedLogsOf, no, ok, same, destinationVerdict, verifyDestination, type BindingResult, type FinalizedHead, type SettlementRow, type VerifyClient } from './settle-chain';

const none = (detail: string): BindingResult => ({ verdict: 'NONE', detail });

interface MilestoneRef {
  readonly escrow: Hex;
  readonly order: Hex;
  readonly idx: number;
  readonly payee: Hex;
  readonly lineId: Hex;
  readonly settlementId: Hex;
}

function refOf(contracts: DeploymentContracts, row: SettlementRow): MilestoneRef | null {
  const escrow = contracts.MilestoneEscrow?.address;
  const order = bytes32OfShortId(row.order_id);
  const payee = bytes32OfShortId(row.payee_id);
  const idx = row.milestone_idx;
  if (!escrow || !order || !payee || row.line_id === null || idx === null || !Number.isInteger(idx) || idx < 0 || idx > 255) return null;
  return { escrow, order, idx, payee, lineId: row.line_id, settlementId: milestoneSettlementId(order, idx) };
}

/** FUND_MILESTONE: the row is exactly this funding; null when it is, else the mismatch. */
function fundingMismatch(logs: Log[], m: MilestoneRef, row: SettlementRow): BindingResult | null {
  const funded = parseEventLogs({ abi: iMilestoneEscrowAbi, logs, eventName: 'MilestoneFunded' }).find((l) => same(l.args.orderId, m.order) && Number(l.args.idx) === m.idx);
  const a = funded?.args;
  if (!a || a.amountMinor !== BigInt(row.amount_minor) || !decisionMatches(a.decisionId, row.decision_id) || !same(a.rationaleHash, row.rationale_hash)) {
    return no('SPEND_MISMATCH', 'no finalized MilestoneFunded log matching the row in its tx');
  }
  const key = fundMilestoneIntentId({ orderId: m.order, idx: m.idx, amountMinor: a.amountMinor, cumulativeAfterMinor: a.fundedTotalMinor });
  return same(key, row.intent_id) ? null : no('INTENT_MISMATCH', 'intent_id is not the key of this funding');
}

/** A funding row is only worth a receipt read when its milestone is autoRelease and reads released at finalized. */
async function autoReleased(client: VerifyClient, m: MilestoneRef, head: FinalizedHead): Promise<boolean> {
  const ms = await client.readContract({ address: m.escrow, abi: iMilestoneEscrowAbi, functionName: 'milestones', args: [m.order], blockNumber: head.number });
  const it = ms[m.idx];
  return it !== undefined && it.autoRelease && it.released;
}

export async function verifyMilestoneBinding(client: VerifyClient, contracts: DeploymentContracts, scope: Hex, row: SettlementRow): Promise<BindingResult> {
  const m = refOf(contracts, row);
  const funding = row.kind === 'FUND_MILESTONE';
  if (!m) return no('INTENT_MISMATCH', 'the row names no escrow milestone (order, idx, line, ShortId payee)');
  if (!funding && !same(m.settlementId, row.intent_id)) return no('INTENT_MISMATCH', 'intent_id is not the milestone settlement id');
  const head = await finalizedHead(client);
  if (funding && !(await autoReleased(client, m, head))) return none('the funded milestone is not an auto-released one');

  const logs = await finalizedLogsOf(client, row.tx_hash, head.number, m.escrow);
  if (!logs) return no('SPEND_MISMATCH', 'the row tx has no canonical, successful receipt at or below finalized');
  if (funding) {
    const mismatch = fundingMismatch(logs, m, row);
    if (mismatch) return mismatch;
  }
  const released = parseEventLogs({ abi: iMilestoneEscrowAbi, logs, eventName: 'MilestoneReleased' }).find((l) => same(l.args.settlementId, m.settlementId));
  if (!released) return funding ? none('this funding released nothing') : no('SPEND_MISMATCH', 'no finalized MilestoneReleased log for this milestone in the row tx');
  const a = released.args;
  const amountOk = funding || a.amountMinor === BigInt(row.amount_minor);
  if (!same(a.orderId, m.order) || Number(a.idx) !== m.idx || !same(a.payeeId, m.payee) || !amountOk) {
    return no('SPEND_MISMATCH', 'the finalized MilestoneReleased log differs from the row');
  }
  const o = await client.readContract({ address: m.escrow, abi: iMilestoneEscrowAbi, functionName: 'order', args: [m.order], blockNumber: head.number });
  if (!o.exists || !same(o.payeeId, m.payee) || !same(o.lineId, m.lineId)) return no('SPEND_MISMATCH', 'the escrow order does not pay this payee on this line');

  const dest = await verifyDestination(client, contracts.Treasury.address, head, { kind: 'line', lineId: o.lineId, payee: m.payee }, row);
  const keys = { settlementId: m.settlementId, invoiceHash: scope };
  if (!dest.ok) return no(destinationVerdict(dest), dest.detail, keys);
  return ok({ ...keys, amountMinor: a.amountMinor, destination: dest.destination });
}
