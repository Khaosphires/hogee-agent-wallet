/**
 * Binds a line-pocket settlement row to the chain before anything is paid or attested (security audit run-3). For a
 * SPEND (agent, `Spent`) or OWNER_SPEND (founder's fallback, `OwnerSpent`) row:
 *   1. INTENT: intentId(committed planId, line, payee, invoiceHash, amount) recomputed from the row equals intent_id
 *      (= spendId = settlementId, the same formula for both kinds);
 *   2. SPEND: Treasury.isIntentUsed(intent_id) at `finalized`, and the row's tx has a canonical, successful receipt at
 *      or below the finalized block whose Treasury log carries exactly this outflow: `Spent` (spendId, line, payee,
 *      amount, invoice, planVersion, decision, rationale) or `OwnerSpent` (spendId, line, payee, amount, invoice; its
 *      planVersion is the version at execution, not a signed field, so it is not compared);
 *   3. DESTINATION: settle-chain.ts verifyDestination against the line binding (T1).
 * The verified on-chain amount is what gets paid, and the key's invoice is the on-chain one. Every failure is a verdict
 * (the caller halts); RPC errors throw. Milestones: settle-verify-escrow.ts; reserve withdrawals: settle-binding.ts.
 */
import { iTreasuryAbi, intentId } from '@hogee/chain';
import { parseEventLogs, type Hex } from 'viem';
import { bytes32OfShortId, decisionMatches, finalizedHead, finalizedLogsOf, no, ok, same, destinationVerdict, verifyDestination, type BindingResult, type SettlementRow, type VerifiedSettlement, type VerifyClient } from './settle-chain';

export type { BindingResult, VerifyClient } from './settle-chain';
/** Name kept for importers: every settlement kind shares SettlementRow. */
export type SpendRow = SettlementRow;
/** Name kept for importers: every settlement kind shares VerifiedSettlement. */
export type VerifiedSpend = VerifiedSettlement;

/** SPEND (`Spent`) and OWNER_SPEND (`OwnerSpent`): steps 1-3 of the module doc. */
export async function verifyLineSpendBinding(client: VerifyClient, treasury: Hex, planId: Hex | null, row: SettlementRow): Promise<BindingResult> {
  const owner = row.kind === 'OWNER_SPEND';
  if (planId === null) return no('INTENT_MISMATCH', 'no committed plan to recompute the intent from');
  const payee = bytes32OfShortId(row.payee_id);
  if (row.line_id === null || payee === null) return no('INTENT_MISMATCH', 'the row names no line or no ShortId payee');
  const amount = BigInt(row.amount_minor);
  const recomputed = intentId({ planId, lineId: row.line_id, payeeId: payee, invoiceHash: row.invoice_hash, amountMinor: amount });
  if (!same(recomputed, row.intent_id)) return no('INTENT_MISMATCH', 'intent_id does not recompute from the row');

  const head = await finalizedHead(client);
  const used = await client.readContract({ address: treasury, abi: iTreasuryAbi, functionName: 'isIntentUsed', args: [row.intent_id], blockNumber: head.number });
  if (!used) return no('SPEND_MISMATCH', 'the intent is not used on-chain at finalized');
  const logs = await finalizedLogsOf(client, row.tx_hash, head.number, treasury);
  const event = owner ? 'OwnerSpent' : 'Spent';
  const ev = logs ? parseEventLogs({ abi: iTreasuryAbi, logs, eventName: ['Spent', 'OwnerSpent'] }).find((l) => l.eventName === event && same(l.args.spendId, row.intent_id)) : undefined;
  if (!ev) return no('SPEND_MISMATCH', `no finalized ${event} log for this intent in the row tx`);
  const a = ev.args;
  let matches = same(a.lineId, row.line_id) && same(a.payeeId, payee) && a.amountMinor === amount && same(a.invoiceHash, row.invoice_hash);
  if (ev.eventName === 'Spent') {
    matches &&= Number(ev.args.planVersion) === Number(row.plan_version) && decisionMatches(ev.args.decisionId, row.decision_id) && same(ev.args.rationaleHash, row.rationale_hash);
  }
  if (!matches) return no('SPEND_MISMATCH', `the finalized ${event} log differs from the row`);

  const dest = await verifyDestination(client, treasury, head, { kind: 'line', lineId: row.line_id, payee }, row);
  const keys = { settlementId: row.intent_id, invoiceHash: a.invoiceHash };
  if (!dest.ok) return no(destinationVerdict(dest), dest.detail, keys);
  return ok({ ...keys, amountMinor: a.amountMinor, destination: dest.destination });
}

/** SPEND rows (kept for importers; verifyLineSpendBinding serves both line kinds). */
export async function verifySpendBinding(client: VerifyClient, treasury: Hex, planId: Hex | null, row: SettlementRow): Promise<BindingResult> {
  return verifyLineSpendBinding(client, treasury, planId, { ...row, kind: 'SPEND' });
}
