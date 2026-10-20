/**
 * Mei's receipts (UX-PLAN D8: "recent payments become Receipts", no "Escrow funding" row for Mei): one row per payment
 * that left her wallet or is leaving it, in plain words. Pure, so it is unit-tested without the API.
 *
 *   - **Supplier payments** come from the order's escrow schedule (GET /api/escrow/:orderId, the same source as the
 *     order card): each released milestone is one receipt, "Deposit (payment 1 of 2)", paid automatically (an
 *     autoRelease milestone) or with her passkey (the balance). Its time and receipt link come from the matching
 *     payment row (FUND_MILESTONE for an automatic one, RELEASE_MILESTONE for one she signed), matched by amount. Money
 *     moved into the held box for a later step is not a payment to anyone, so it gets no row.
 *   - **Pocket payments** (SPEND, OWNER_SPEND, WITHDRAW_RESERVE) come from GET /api/payments.
 *   - Refused, reverted, dropped or cancelled attempts moved no money: they stay in the activity record (Proof).
 */
import type { EscrowMilestone, Payment, PaymentState } from "@hogee/core";
import { lineLabel } from "./format";

export type ReceiptHow = "auto" | "passkey" | "you" | "tax";
export type ReceiptState = "sending" | "paid" | "failed";

export interface Receipt {
  readonly key: string;
  /** ISO time of the payment row, or null when the schedule says paid and its row isn't loaded yet. */
  readonly at: string | null;
  /** "Deposit", "Balance", "Ads", "Tax payment". */
  readonly title: string;
  /** "payment 1 of 2", for supplier payments. */
  readonly count: string | null;
  readonly amountMinor: string;
  /** Who was paid, for supplier payments (the supplier's checked display name). */
  readonly supplierId: string | null;
  readonly how: ReceiptHow;
  readonly state: ReceiptState;
  readonly txHash: string | null;
}

/** The founder's supplier order and its schedule, as the order card reads it. */
export interface SupplierOrderIn {
  readonly supplierId: string;
  readonly orderId: string;
  readonly schedule: readonly Pick<EscrowMilestone, "idx" | "amountMinor" | "released" | "autoRelease">[];
}

/** Plain code-unit order (ISO times sort as text; localeCompare would put "~" before digits). */
const byText = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

const NO_MONEY_MOVED: ReadonlySet<PaymentState> = new Set(["POLICY_DENIED", "REVERTED", "DROPPED", "CANCELLED"]);
const SENDING: ReadonlySet<PaymentState> = new Set(["PROPOSED", "POLICY_OK", "SIGNED", "BROADCAST"]);

export function receiptState(state: PaymentState): ReceiptState | null {
  if (NO_MONEY_MOVED.has(state)) return null;
  if (state === "SETTLEMENT_FAILED") return "failed";
  return SENDING.has(state) ? "sending" : "paid";
}

/** A web supplier's order (order-w<12>-NNN); a catalog order keeps its sample, deposit, balance names. */
const WEB_ORDER_RE = /^order-w[a-z2-7]{12}-\d{3}$/;
const CATALOG_NAMES = ["Sample order", "Deposit", "Balance"] as const;

/** Each payment's name (UX-PLAN D18): Deposit · Balance; three parts Deposit · Second payment · Balance. */
export function paymentNames(orderId: string, n: number): string[] {
  if (!WEB_ORDER_RE.test(orderId) && n === CATALOG_NAMES.length) return [...CATALOG_NAMES];
  if (n === 1) return ["Payment"];
  return Array.from({ length: n }, (_, i) => (i === 0 ? "Deposit" : i === n - 1 ? "Balance" : n === 3 ? "Second payment" : `Payment ${i + 1}`));
}

type PaymentIn = Pick<Payment, "paymentId" | "kind" | "lineKey" | "payeeId" | "amountMinor" | "state" | "txHash" | "updatedAt">;

/** The supplier's released milestones as receipts, each matched to one payment row (never the same row twice). */
function supplierReceipts(order: SupplierOrderIn, payments: readonly PaymentIn[]): Receipt[] {
  const names = paymentNames(order.orderId, order.schedule.length);
  const used = new Set<string>();
  const rows = [...payments].filter((p) => p.payeeId === order.supplierId && !NO_MONEY_MOVED.has(p.state));
  return [...order.schedule]
    .sort((a, b) => a.idx - b.idx)
    .flatMap((m, i): Receipt[] => {
      if (!m.released) return [];
      const kind = m.autoRelease ? "FUND_MILESTONE" : "RELEASE_MILESTONE";
      // Oldest first, so an earlier milestone of the same amount takes the earlier row.
      const row = rows
        .filter((p) => p.kind === kind && p.amountMinor === m.amountMinor && !used.has(p.paymentId))
        .sort((a, b) => byText(a.updatedAt, b.updatedAt))[0];
      if (row) used.add(row.paymentId);
      return [
        {
          key: `${order.orderId}-${m.idx}`,
          at: row?.updatedAt ?? null,
          title: names[i] ?? `Payment ${i + 1}`,
          count: `payment ${i + 1} of ${order.schedule.length}`,
          amountMinor: m.amountMinor,
          supplierId: order.supplierId,
          how: m.autoRelease ? "auto" : "passkey",
          state: row ? (receiptState(row.state) ?? "paid") : "paid",
          txHash: row?.txHash ?? null,
        },
      ];
    });
}

/** A payment from a pocket (or the tax money) as a receipt; null when it moved no money or belongs to an order. */
function pocketReceipt(p: PaymentIn): Receipt | null {
  if (p.kind === "FUND_MILESTONE" || p.kind === "RELEASE_MILESTONE") return null;
  const state = receiptState(p.state);
  if (state === null) return null;
  const tax = p.kind === "WITHDRAW_RESERVE";
  return {
    key: p.paymentId,
    at: p.updatedAt,
    title: tax ? "Tax payment" : lineLabel(p.lineKey ?? ""),
    count: null,
    amountMinor: p.amountMinor,
    supplierId: null,
    how: tax ? "tax" : p.kind === "OWNER_SPEND" ? "you" : "auto",
    state,
    txHash: p.txHash ?? null,
  };
}

/** Every receipt, newest first (a supplier receipt without its row yet sorts first: it was just paid). */
export function receiptsOf(payments: readonly PaymentIn[], orders: readonly SupplierOrderIn[]): Receipt[] {
  const all = [...orders.flatMap((o) => supplierReceipts(o, payments)), ...payments.flatMap((p) => pocketReceipt(p) ?? [])];
  return all.sort((a, b) => byText(b.at ?? "~", a.at ?? "~"));
}

/** The supplier payees in the payment list: whose orders the receipts need. */
export const supplierPayees = (payments: readonly Pick<Payment, "kind" | "payeeId">[]): string[] => [
  ...new Set(payments.filter((p) => p.kind === "FUND_MILESTONE" || p.kind === "RELEASE_MILESTONE").map((p) => p.payeeId)),
];

const HOW_TEXT: Readonly<Record<ReceiptHow, string>> = {
  auto: "automatically, within your rules",
  passkey: "with your passkey",
  you: "by you",
  tax: "as a tax payment you and your loan officer signed",
};

/** The receipt's second line, in the tense of its state: "Paid automatically, within your rules", "Sending with your passkey". */
export function howText(r: Pick<Receipt, "how" | "state">): string {
  const how = HOW_TEXT[r.how];
  if (r.state === "sending") return `Sending ${how}`;
  if (r.state === "failed") return `Sent ${how}, but the bank transfer failed`;
  return `Paid ${how}`;
}

export const STATE_TEXT: Readonly<Record<ReceiptState, string>> = {
  sending: "Sending",
  paid: "Paid",
  failed: "Bank transfer failed",
};
