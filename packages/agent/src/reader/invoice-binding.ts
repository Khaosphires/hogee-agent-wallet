/**
 * From a Reader result to a policy proposal (project.md §7.3, D6, T1/T17/T32). The document can fill typed fields;
 * it can never choose WHO is paid or WHICH action runs:
 *
 * - the payee, the line and the order are TRUSTED inputs (DB bindings the founder signed), typed `Trusted<…>`, so an
 *   untrusted Reader value in their place is a compile error (and the policy engine re-checks the label);
 * - invoice spend: the amount is the Reader's grounded total, still labelled UNTRUSTED, so the policy engine bounds it
 *   by the line caps; it is never raised by anything in the text;
 * - milestone invoice: the amount is the signed schedule's, never the document's;
 * - flags only accumulate (Reader flags + account mismatch + amount mismatch); any escalating flag sends an otherwise
 *   valid spend or milestone funding to the loan officer (core ESCALATING_INVOICE_FLAGS): the flags travel IN the
 *   proposal, so the policy engine enforces it, not the caller.
 */
import {
  ESCALATING_INVOICE_FLAGS,
  TRUSTED_PUBLIC,
  lineIdOf,
  spendIntentId,
  stringToBytes32,
  trusted,
  type CurrencyCode,
  type FundMilestoneProposalIn,
  type Hex32,
  type Id,
  type LineKey,
  type PayeeId,
  type PolicyEscrowOrder,
  type SpendProposalIn,
  type Trusted,
} from "@hogee/core";
import { payoutTargetKey } from "./prefilter";
import type { InvoiceReading } from "./reader";

export interface InvoiceSpendInput {
  readonly reading: InvoiceReading;
  readonly invoiceId: Id;
  /** The invoice's dedup hash, from the stored invoice record (see the report: not frozen in G0). */
  readonly invoiceHash: Hex32;
  /** The line the invoice was registered against (DB). */
  readonly lineKey: Trusted<LineKey>;
  /** The bound payee the invoice was registered for (payee registry). NEVER taken from the document. */
  readonly payeeId: Trusted<PayeeId>;
  /** The payee's registered payout account (registry), for comparison only. */
  readonly boundAccountNumber?: Trusted<string, "private">;
  readonly plan: { readonly planId: Hex32; readonly version: number };
  readonly displayCurrency: CurrencyCode;
}

export type InvoiceSpendBinding =
  | { readonly proposal: SpendProposalIn; readonly flags: readonly string[]; readonly reason?: undefined }
  | { readonly proposal: null; readonly flags: readonly string[]; readonly reason: "NO_AMOUNT" | "CURRENCY_MISMATCH" };

/** Any stated payout target (account number or PayNow target) other than the bound one is a change, compared canonically. */
function accountFlags(reading: InvoiceReading, bound: Trusted<string, "private"> | undefined): string[] {
  const stated = reading.fields.accountNumbers?.value ?? [];
  if (!bound || stated.length === 0) return [];
  const boundKey = payoutTargetKey(bound.value);
  return stated.every((a) => payoutTargetKey(a) === boundKey) ? [] : ["PAYEE_DETAILS_CHANGED"];
}

const sortedUnique = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

/** Build the SPEND proposal for a registered invoice of a bound payee. */
export function bindInvoiceSpend(input: InvoiceSpendInput): InvoiceSpendBinding {
  const { reading } = input;
  const flags = sortedUnique([...reading.invoiceFlags, ...accountFlags(reading, input.boundAccountNumber)]);
  const total = reading.fields.total;
  if (!total) return { proposal: null, flags, reason: "NO_AMOUNT" };
  if (total.value.currency !== input.displayCurrency) return { proposal: null, flags: sortedUnique([...flags, "AMOUNT_MISMATCH"]), reason: "CURRENCY_MISMATCH" };
  const lineKey = input.lineKey.value;
  const payeeId = input.payeeId.value;
  const amountMinor = { value: total.value.amountMinor, taint: total.taint, source: total.source };
  const intentId = spendIntentId({
    planId: input.plan.planId,
    lineId: lineIdOf(lineKey),
    payeeId: stringToBytes32(payeeId),
    invoiceHash: input.invoiceHash,
    amountMinor: BigInt(amountMinor.value),
  });
  const proposal: SpendProposalIn = {
    kind: "SPEND",
    // The action (pay this registered invoice, from this line, to this bound payee) is chosen from DB records by
    // trusted code; the document only supplies a bounded, still-untrusted amount.
    origin: TRUSTED_PUBLIC,
    lineKey: input.lineKey,
    payeeId: input.payeeId,
    amountMinor,
    invoiceHash: input.invoiceHash,
    intentId,
    planVersion: input.plan.version,
    basis: { invoiceId: input.invoiceId, flags },
  };
  return { proposal, flags };
}

export interface MilestoneInvoiceInput {
  readonly reading: InvoiceReading;
  readonly order: Trusted<PolicyEscrowOrder>;
  readonly idx: number;
  readonly planVersion: number;
}

export interface MilestoneInvoiceBinding {
  /** Carries `invoiceFlags`, so evaluateFundMilestone itself returns NEEDS_OFFICER for an escalating flag. */
  readonly proposal: FundMilestoneProposalIn;
  readonly flags: readonly string[];
  /** True when a flag sends the funding to the loan officer (informational: the policy engine enforces it). */
  readonly escalate: boolean;
}

/** Build the FUND_MILESTONE proposal: amount and order from the signed schedule; the invoice can only add flags. */
export function bindMilestoneInvoice(input: MilestoneInvoiceInput): MilestoneInvoiceBinding {
  const order = input.order.value;
  const milestone = order.milestones[input.idx];
  if (!milestone) throw new RangeError(`order ${order.orderId} has no milestone ${input.idx}`);
  const stated = input.reading.fields.total?.value;
  const mismatch = stated !== undefined && stated.amountMinor !== milestone.amountMinor ? ["AMOUNT_MISMATCH"] : [];
  const flags = sortedUnique([...input.reading.invoiceFlags, ...mismatch]);
  const proposal: FundMilestoneProposalIn = {
    kind: "FUND_MILESTONE",
    origin: TRUSTED_PUBLIC,
    orderId: trusted(order.orderId, `${input.order.source}#orderId`),
    idx: input.idx,
    amountMinor: trusted(milestone.amountMinor, `${input.order.source}#schedule`),
    planVersion: input.planVersion,
    invoiceFlags: flags,
  };
  return { proposal, flags, escalate: flags.some((f) => ESCALATING_INVOICE_FLAGS.has(f)) };
}
