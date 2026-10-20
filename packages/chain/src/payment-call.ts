/**
 * "What is stored is what is signed": before the sender signs for a `payments` row it decodes the calldata
 * and checks every field the row records (line, payee, amount, invoice, plan version, decision, rationale,
 * order/milestone). A mismatch means some code path built the wrong call, so nothing is signed.
 *
 * It also recomputes the row's `intent_id` from the calldata, so the CANCELLED proof
 * (`isIntentUsed(intent_id)` absent at `finalized`, intents.ts) is about the intent that was signed:
 * SPEND / OWNER_SPEND intentId(planId, lineId, payeeId, invoiceHash, amount) (the on-chain spendId; the row
 * has no planId, so the caller passes it), RELEASE_MILESTONE the milestone settlementId(orderId, idx),
 * WITHDRAW_RESERVE the loosenId. FUND_MILESTONE's key needs `cumulativeAfterMinor`, which is not in the
 * calldata; its CANCELLED proof fails safe instead (`unknown` unless the key matches the funded amount).
 */
import { decodeFunctionData, type Hex } from 'viem';
import { iMilestoneEscrowAbi, iTreasuryAbi } from './generated';
import { intentId, milestoneSettlementId } from './hashes';
import type { PaymentIntentFields } from './targets';
import { decisionIdToBytes32, shortIdToBytes32, ZERO_BYTES32 } from './values';

export interface PaymentCallContext {
  /** On-chain bytes32 planId of the facility's plan. Required for SPEND / OWNER_SPEND (null fails closed). */
  readonly planId: Hex | null;
}

const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;

type Expectation = readonly [field: string, actual: unknown, expected: unknown];

const norm = (v: unknown): string => (typeof v === 'string' ? v.toLowerCase() : String(v));

function firstMismatch(checks: readonly Expectation[]): string | null {
  for (const [field, actual, expected] of checks) {
    if (norm(actual) !== norm(expected)) return `${field} does not match the payment row`;
  }
  return null;
}

function decode(abi: typeof iTreasuryAbi | typeof iMilestoneEscrowAbi, data: Hex): { functionName: string; args: readonly unknown[] } | null {
  try {
    const d = decodeFunctionData({ abi, data });
    return { functionName: d.functionName, args: d.args ?? [] };
  } catch {
    return null;
  }
}

/** SPEND / OWNER_SPEND: the row's intent_id must be the spendId the contract derives from these calldata fields. */
function spendIntentMismatch(
  p: PaymentIntentFields,
  ctx: PaymentCallContext,
  f: { lineId: Hex; payeeId: Hex; invoiceHash: Hex; amountMinor: bigint },
): string | null {
  if (ctx.planId === null) return `planId is required to check a ${p.kind} intent_id`;
  if (!HEX32_RE.test(ctx.planId)) return 'planId must be bytes32';
  return firstMismatch([['intent_id', intentId({ planId: ctx.planId, ...f }), p.intentId]]);
}

const decision = (p: PaymentIntentFields): Hex => (p.decisionId === null ? ZERO_BYTES32 : decisionIdToBytes32(p.decisionId));
const order = (p: PaymentIntentFields): Hex | null => (p.orderId === null ? null : shortIdToBytes32(p.orderId, 'orderId'));

/** Returns null when `data` is the call the payment row describes, else a reason (never includes values). */
export function paymentCallMismatch(p: PaymentIntentFields, data: Hex, ctx: PaymentCallContext): string | null {
  const amount = BigInt(p.amountMinor);
  switch (p.kind) {
    case 'SPEND': {
      const d = decode(iTreasuryAbi, data);
      if (d?.functionName !== 'spend') return 'SPEND payments must call Treasury.spend';
      const [lineId, payeeId, amountMinor, invoiceHash, planVersion, decisionId, rationaleHash] = d.args as readonly [Hex, Hex, bigint, Hex, number, Hex, Hex];
      return (
        firstMismatch([
          ['lineId', lineId, p.lineId],
          ['payeeId', payeeId, shortIdToBytes32(p.payeeId, 'payeeId')],
          ['amountMinor', amountMinor, amount],
          ['invoiceHash', invoiceHash, p.invoiceHash],
          ['planVersion', planVersion, p.planVersion],
          ['decisionId', decisionId, decision(p)],
          ['rationaleHash', rationaleHash, p.rationaleHash],
        ]) ?? spendIntentMismatch(p, ctx, { lineId, payeeId, invoiceHash, amountMinor })
      );
    }
    case 'OWNER_SPEND': {
      const d = decode(iTreasuryAbi, data);
      if (d?.functionName !== 'ownerSpend') return 'OWNER_SPEND payments must call Treasury.ownerSpend';
      const req = d.args[0] as { lineId: Hex; payeeId: Hex; amountMinor: bigint; invoiceHash: Hex };
      return (
        firstMismatch([
          ['lineId', req.lineId, p.lineId],
          ['payeeId', req.payeeId, shortIdToBytes32(p.payeeId, 'payeeId')],
          ['amountMinor', req.amountMinor, amount],
          ['invoiceHash', req.invoiceHash, p.invoiceHash],
        ]) ?? spendIntentMismatch(p, ctx, { lineId: req.lineId, payeeId: req.payeeId, invoiceHash: req.invoiceHash, amountMinor: req.amountMinor })
      );
    }
    case 'FUND_MILESTONE': {
      const d = decode(iMilestoneEscrowAbi, data);
      if (d?.functionName !== 'fundMilestone') return 'FUND_MILESTONE payments must call MilestoneEscrow.fundMilestone';
      const [orderId, idx, amountMinor, decisionId, rationaleHash] = d.args;
      return firstMismatch([
        ['orderId', orderId, order(p)],
        ['idx', idx, p.milestoneIdx],
        ['amountMinor', amountMinor, amount],
        ['decisionId', decisionId, decision(p)],
        ['rationaleHash', rationaleHash, p.rationaleHash],
      ]);
    }
    case 'RELEASE_MILESTONE': {
      const d = decode(iMilestoneEscrowAbi, data);
      if (d?.functionName !== 'releaseMilestone') return 'RELEASE_MILESTONE payments must call MilestoneEscrow.releaseMilestone';
      const rel = d.args[0] as { orderId: Hex; idx: number; amountMinor: bigint };
      return firstMismatch([
        ['orderId', rel.orderId, order(p)],
        ['idx', rel.idx, p.milestoneIdx],
        ['amountMinor', rel.amountMinor, amount],
        ['intent_id', milestoneSettlementId(rel.orderId, rel.idx), p.intentId],
      ]);
    }
    case 'WITHDRAW_RESERVE': {
      const d = decode(iTreasuryAbi, data);
      if (d?.functionName !== 'executeLoosen') return 'WITHDRAW_RESERVE payments must call Treasury.executeLoosen';
      return firstMismatch([['loosenId', d.args[0], p.intentId]]);
    }
    default:
      return `unknown payment kind ${p.kind}`;
  }
}
