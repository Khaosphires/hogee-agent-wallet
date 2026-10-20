/**
 * What a signed transaction asked a deployment contract to do, and what each payment row must match:
 *   - decodeCall: the Hogee function of a raw tx's calldata, only when it is sent to the contract that has it;
 *   - bindPaymentCall: a row's kind, line, payee, amount and decision equal its own tx's calldata (every kind the ABI
 *     allows: spend, fundMilestone, ownerSpend, releaseMilestone, executeLoosen of a reserve withdrawal);
 *   - bindPaymentEvents: a successful receipt carries exactly the event the row's kind emits, with the row's values
 *     (Spent, MilestoneFunded, OwnerSpent, MilestoneReleased, ReserveWithdrawn).
 */
import { decodeFunctionData, type Hex } from "viem";
import { CALL_CONTRACT, hogeeCallsAbi } from "./abi";
import type { ContractName, PaymentEntry } from "./bundle";
import type { ParsedTx } from "./crypto";
import { decisionIdToBytes32, Problems, sameHex, tagToBytes32 } from "./util";

export interface DecodedCall {
  readonly name: string;
  readonly args: readonly unknown[];
}

/** The Hogee call a tx makes, or null when its calldata is no Hogee function of the contract it is sent to. */
export function decodeCall(tx: ParsedTx, to: ContractName | null): DecodedCall | null {
  try {
    const call = decodeFunctionData({ abi: hogeeCallsAbi, data: tx.data as Hex });
    if (!to || CALL_CONTRACT[call.functionName] !== to) return null;
    return { name: call.functionName, args: (call.args ?? []) as readonly unknown[] };
  } catch {
    return null;
  }
}

type Struct = Readonly<Record<string, unknown>>;
const field = (v: unknown, name: string): unknown => (v as Struct)[name];
const same = (a: unknown, b: unknown): boolean => (typeof a === "string" && typeof b === "string" ? sameHex(a, b) : a === b);
const tagOf = (s: string | null): string | null => (s === null ? null : tagToBytes32(s));

/** The values a payment row commits to, in chain form. */
function rowValues(e: PaymentEntry) {
  const pay = e.payment;
  return {
    lineId: tagOf(pay.lineKey),
    payeeId: tagToBytes32(pay.payeeId),
    amount: BigInt(pay.amountMinor),
    invoiceHash: pay.invoiceHash,
    planVersion: pay.planVersion,
    decisionId: pay.decisionId ? decisionIdToBytes32(pay.decisionId) : null,
    rationaleHash: pay.rationaleHash,
    orderId: tagOf(e.orderId),
    idx: e.milestoneIdx,
    intentId: pay.intentId,
  };
}

/** The calls each payment kind may make (a founder-signed or adopted payment may come from an auto-release). */
const KIND_CALLS: Readonly<Record<string, readonly string[]>> = {
  SPEND: ["spend"],
  FUND_MILESTONE: ["fundMilestone"],
  OWNER_SPEND: ["ownerSpend"],
  RELEASE_MILESTONE: ["releaseMilestone", "fundMilestone"],
  WITHDRAW_RESERVE: ["executeLoosen"],
};

/** The row equals its own tx's calldata wherever the ABI carries the value. */
export function bindPaymentCall(e: PaymentEntry, call: DecodedCall | null, p: Problems): void {
  const pay = e.payment;
  const want = KIND_CALLS[pay.kind] ?? [];
  if (!call || !want.includes(call.name)) {
    p.add(`${pay.paymentId}: ${/^[AEIOU]/.test(pay.kind) ? "an" : "a"} ${pay.kind} row whose tx ${call ? `calls ${call.name}` : "is not a Hogee call of the right contract"}`);
    return;
  }
  const v = rowValues(e);
  const a = call.args;
  let ok = true;
  if (call.name === "spend") {
    ok = [v.lineId, v.payeeId, v.amount, v.invoiceHash, v.planVersion, v.decisionId, v.rationaleHash].every((x, i) => same(a[i], x));
  } else if (call.name === "fundMilestone") {
    ok = same(a[0], v.orderId) && a[1] === v.idx && (pay.kind === "RELEASE_MILESTONE" || (a[2] === v.amount && same(a[3], v.decisionId) && same(a[4], v.rationaleHash)));
  } else if (call.name === "ownerSpend") {
    const r = a[0];
    ok = same(field(r, "lineId"), v.lineId) && same(field(r, "payeeId"), v.payeeId) && field(r, "amountMinor") === v.amount && same(field(r, "invoiceHash"), v.invoiceHash);
  } else if (call.name === "releaseMilestone") {
    const r = a[0];
    ok = same(field(r, "orderId"), v.orderId) && field(r, "idx") === v.idx && field(r, "amountMinor") === v.amount;
  } else if (call.name === "executeLoosen") {
    ok = same(a[0], v.intentId);
  }
  if (!ok) p.add(`${pay.paymentId}: ${call.name} calldata differs from the payment row`);
}

export interface EventLike {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** The one event a successful payment tx emits for the row's kind, with the row's values. */
const KIND_EVENT: Readonly<Record<string, { readonly event: string; readonly match: (ev: Struct, v: ReturnType<typeof rowValues>) => boolean }>> = {
  SPEND: {
    event: "Spent",
    match: (ev, v) =>
      same(ev.spendId, v.intentId) && same(ev.lineId, v.lineId) && same(ev.payeeId, v.payeeId) && ev.amountMinor === v.amount && same(ev.invoiceHash, v.invoiceHash) &&
      Number(ev.planVersion) === v.planVersion && same(ev.decisionId, v.decisionId) && same(ev.rationaleHash, v.rationaleHash),
  },
  FUND_MILESTONE: {
    event: "MilestoneFunded",
    match: (ev, v) => same(ev.orderId, v.orderId) && Number(ev.idx) === v.idx && ev.amountMinor === v.amount && same(ev.decisionId, v.decisionId) && same(ev.rationaleHash, v.rationaleHash),
  },
  OWNER_SPEND: {
    event: "OwnerSpent",
    match: (ev, v) =>
      same(ev.spendId, v.intentId) && same(ev.lineId, v.lineId) && same(ev.payeeId, v.payeeId) && ev.amountMinor === v.amount && same(ev.invoiceHash, v.invoiceHash) && Number(ev.planVersion) === v.planVersion,
  },
  RELEASE_MILESTONE: {
    event: "MilestoneReleased",
    match: (ev, v) => same(ev.orderId, v.orderId) && Number(ev.idx) === v.idx && same(ev.payeeId, v.payeeId) && ev.amountMinor === v.amount,
  },
  WITHDRAW_RESERVE: {
    event: "ReserveWithdrawn",
    match: (ev, v) => same(ev.settlementId, v.intentId) && same(ev.taxPayeeId, v.payeeId) && ev.amountMinor === v.amount,
  },
};

/** A successful receipt of a payment carries exactly one event of the row's kind, equal to the row. */
export function bindPaymentEvents(e: PaymentEntry, events: readonly EventLike[], p: Problems): void {
  const rule = KIND_EVENT[e.payment.kind];
  if (!rule) return;
  const found = events.filter((ev) => ev.name === rule.event);
  if (found.length !== 1) {
    p.add(`${e.payment.paymentId}: its successful tx emits ${found.length} ${rule.event} events, not exactly one`);
    return;
  }
  if (!rule.match((found[0] as EventLike).args, rowValues(e))) p.add(`${e.payment.paymentId}: the ${rule.event} event differs from the payment row`);
}
