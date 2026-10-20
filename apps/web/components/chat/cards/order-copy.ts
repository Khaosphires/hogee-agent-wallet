/**
 * Founder-facing copy and the pure decisions of the deal form (terms card) and the order card, testable without
 * rendering (order-copy.test.ts). Words follow the UX plan's glossary: deal, safety wait, Deposit / Balance, delivery
 * check report, check code, receipt, public record. Every string passes the wording lint.
 *
 * Seller names never appear here: the cards render them from structured data (the search's candidates, the saved
 * terms), and the labels the cards send to the chat with an action (`act`) are fixed sentences with no name (G3).
 */
import type { ChatAction, OrderTerms, OrderTermsInput, PayoutAccountInput, TermsPreset } from "@hogee/core";
import { milestoneName, paymentCount, type Phase } from "../../../lib/order-phase";
import type { StepperStep } from "../../ui/stepper-steps";

// ---- schedule rows -------------------------------------------------------------------------------------------------

/** "Deposit (payment 1 of 2)": the founder's name for the row and its 1-based place. */
export function scheduleRowName(i: number, rows: readonly { readonly autoRelease: boolean }[]): string {
  return rows.length > 1 ? `${milestoneName(i, rows)} (${paymentCount(i, rows.length)})` : milestoneName(i, rows);
}

/** Who pays a row, as its pill says it: the wallet by itself, or Mei. */
export const payerText = (autoRelease: boolean): string => (autoRelease ? "Pays automatically" : "Waits for you");

/** When a row is paid (A8.13; security meaning kept: the deposit only after the wait, the rest only with her check and signature). */
export const conditionText = (autoRelease: boolean): string =>
  autoRelease ? "after the safety wait" : "after you upload a delivery check and sign";

/** A row's state on the order card: paid automatically, paid with her passkey, or still waiting. */
export function rowStatusText(row: { readonly autoRelease: boolean; readonly released: boolean }): string {
  if (row.released) return row.autoRelease ? "Paid automatically" : "Paid with your passkey";
  return row.autoRelease ? "Not paid yet" : "Waiting for you";
}

/** The pill tone of a row's state on the order card: paid (green), automatic (cobalt) or Mei's (waiting). */
export const rowStatusTone = (row: { readonly autoRelease: boolean; readonly released: boolean }): "paid" | "agent" | "waiting" =>
  row.released ? "paid" : row.autoRelease ? "agent" : "waiting";

/** What an unpaid row still waits for (the balance names the goods while they are on their way). */
export const rowWaitText = (autoRelease: boolean, goodsOnTheWay: boolean): string =>
  autoRelease ? conditionText(true) : goodsOnTheWay ? "after the goods arrive, your delivery check and your passkey" : conditionText(false);

// ---- the order card ------------------------------------------------------------------------------------------------

const RANK: Readonly<Record<Phase, number>> = { replaced: 0, unsigned: 0, binding: 1, cooling: 1, paying: 2, waiting: 3, done: 4 };

/**
 * Signed → Safety wait → Deposit paid (only when a payment is automatic) → You pay the balance. Tones say who acts
 * (DESIGN.md §7): the wait and the automatic deposit are cobalt, the balance waits on Mei, money landed is paid.
 */
export function orderSteps(phase: Phase, rows: readonly { readonly autoRelease: boolean }[]): StepperStep[] {
  const at = RANK[phase];
  const hasAuto = rows.some((r) => r.autoRelease);
  const state = (rank: number): StepperStep["state"] => (at > rank || (rank === 0 && phase !== "unsigned") ? "done" : at === rank ? "current" : "upcoming");
  const last = rows.length > 1 ? "You pay the balance" : "You pay";
  return [
    { label: "Signed", state: state(0) },
    { label: "Safety wait", state: state(1), tone: "agent" },
    ...(hasAuto ? [{ label: "Deposit paid", state: state(2), tone: state(2) === "done" ? "paid" : "agent" } as const] : []),
    { label: last, state: state(3), tone: state(3) === "done" ? "paid" : "waiting" },
  ];
}

/** The card's one pill per phase (A9.2). */
export const PHASE_PILL: Readonly<Partial<Record<Phase, { readonly tone: "cooling" | "agent" | "paid" | "waiting"; readonly text: string }>>> = {
  binding: { tone: "cooling", text: "Saving" },
  cooling: { tone: "cooling", text: "Safety wait" },
  paying: { tone: "agent", text: "Paying automatically" },
  waiting: { tone: "waiting", text: "Waiting on you" },
  unsigned: { tone: "waiting", text: "Waiting on you" },
  done: { tone: "paid", text: "Order complete" },
};

/** The pill while the goods are on their way: nothing is Mei's to do yet. */
export const TRANSIT_PILL = { tone: "cooling", text: "Waiting for the goods" } as const;

export const ORDER_TEXT = {
  replaced: "This deal was replaced by a newer one. Nothing was paid under it.",
  unsigned: "Nothing is paid until you sign.",
  binding: "Saving your signature to the public record. The safety wait starts when that's done.",
  coolingLead: "Pays automatically in",
  coolingOver: "Safety wait over",
  coolingNote: "You or your loan officer can pause it during the wait. Your order stays, and you and your loan officer can turn payments back on together.",
  stopLink: "Pause all automatic payments",
  stopped: "Automatic payments paused",
  stopTitle: "Pause all automatic payments?",
  stopBody: "Pauses every automatic payment right away. Your order stays. To turn them back on, you and your loan officer must both agree, and then wait a short time.",
  stopConfirm: "Pause now",
  stopFailed: "The pause didn't go through. Nothing else changed.",
  agentPaidTitle: "Paid automatically, as you signed",
  agentPaidBody: "It couldn't pay a different amount, pay a different account, or pay the balance before you approve it.",
  done: "Order complete. Every payment of this order is made.",
  receipt: "Receipt",
} as const;

/** Waiting for the goods, per payment the founder makes (the gate applies to the payment after the delivery check). */
export const TRANSIT_TEXT = "In production. When the goods arrive, press Goods arrived.";
export const UPLOAD_TEXT =
  "Take a photo of the goods and the delivery note, or upload an inspector's report. Then sign to pay the balance. Only a check code of the file goes in the public record, not the file itself.";
export const UPLOAD_TEXT_EARLY = "Upload the report for this payment. Then sign to pay it. Only a check code of the file goes in the public record, not the file itself.";
export const PAY_TEXT = (amount: string, last: boolean): string => (last ? `Delivery check saved. Sign to pay the balance of ${amount}.` : `Report saved. Sign to pay ${amount}.`);
export const PAY_SIGNED_TEXT = "Signed. The balance is paid once it's saved.";
export const PAY_BUTTON = (last: boolean): string => (last ? "Pay the balance" : "Pay this payment");
/** The MilestoneRelease dialog title (the client's title, D16 item 5). */
export const PAY_DIALOG_TITLE = (last: boolean): string => (last ? "Pay the balance after the delivery check" : "Pay this payment after the check");
export const UPLOAD_BUTTON = "Upload report";
export const DROP_HINT = "Drop the PDF or photo here, or choose a file";
/** On a touch screen there is nothing to drop (first-timer #25). */
export const DROP_HINT_TOUCH = "Take a photo or choose a file";

/** A receipt line under the card, one per payment made (A9.19); before any, what it will pay. */
export function receiptText(holder: string, paidName: string | null): string {
  return paidName ? `${paidName}: paid to ${holder} and saved in the public record.` : `Pays ${holder} (sample bank account). The receipt shows here after a payment.`;
}
/** UX round 3: one word for made-up data, "Sample". */
export const PRACTICE_ACCOUNT = "Sample bank account: no real transfer.";

// ---- the deal form (terms card) ------------------------------------------------------------------------------------

export const TERMS_TEXT = {
  description: "Check the split, and the bank account the supplier gave you.",
  savedDescription: "Saved. Nothing is paid until you sign.",
  closed: "This form is closed. If you saved a deal, it's on the order card below.",
  splitLegend: "How you pay",
  splitHelp: "Pick the split you agreed with the supplier.",
  splitAsked: "You gave a percentage without saying when it's due. Pick the split that matches what you agreed.",
  quantity: "How many units",
  total: "Total price (BU)",
  totalHelp: "Whole numbers only. Use the price you agreed.",
  accountLegend: "Supplier's bank account (they give it to you, and you type it in)",
  accountAsk: "Ask the supplier for their company bank account.",
  holder: "Name on the account",
  bank: "Bank",
  account: "Account number",
  accountType: "Account type",
  company: "Company account",
  personal: "Personal account",
  practice: "Sample payment: no real bank transfer happens in this demo.",
  preview: "Preview: who gets paid, and when",
  schedule: "Who gets paid, and when",
  previewEmpty: "Pick a split and enter the total to see who gets paid, and when.",
  autoTotal: "Paid automatically",
  heldTotal: "Waits for you",
  nextAfterSave: "Next: sign with your passkey.",
  nextAfterSaveBody: "The deposit is only paid after you sign and the safety wait ends.",
  save: "Save and sign",
  saving: "Saving…",
  opening: "Opening the sign sheet…",
  signAgain: "Sign the order",
  searchGone: "This search is no longer available. Search again, then pick the supplier.",
} as const;

/** Each split in plain words under its "30/70" (UX round 3, first-timer #21): what is paid now, and when the rest is. */
export const SPLIT_PLAIN: { readonly [P in TermsPreset]: string } = {
  P30_70: "30% now, 70% after delivery",
  P50_50: "Half now, half after delivery",
  P0_100: "All after delivery",
  P30_40_30: "30% now, 40% shipped, 30% delivered",
};

/**
 * The hint under "Name on the account" (first-timer #22): the holder check wants the full company name. It never
 * offers the listing's name to copy: the check compares what the supplier's bank details say with the listing, and a
 * name handed over here would let a different account through.
 */
export const HOLDER_HINT = "Type it in full, exactly as the supplier's bank details give it (for example, ending in “Co., Ltd.”).";

/** "What you're saving" (A8.16, a security sentence: the deposit by itself after the wait, the rest only when she approves). */
export const confirmingText = (name: string, auto: string, held: string): string =>
  `Your wallet may pay ${name} ${auto} automatically after the safety wait, and ${held} only when you approve it. Nothing is paid until you sign.`;

/** The grey reason under a split that can't be picked (never red: she didn't choose it). */
export const blockedSplitText = (split: string, reason: string): string => `${split} isn't possible: ${reason}`;

/**
 * The labels the cards send with their actions. They become the founder's message in the chat history, so they are
 * fixed sentences: never a seller name, an amount or an account (G3).
 */
export const ACTION_LABEL = {
  termsSaved: "I saved the deal",
  pickOne: "I picked 1 supplier",
  pickMany: (n: number): string => `I picked ${n} suppliers`,
  showCandidates: "Show the suppliers",
  catalog: "Use the sample list",
  retrySearch: "Try the search again",
} as const;

// ---- Save and sign (G2) --------------------------------------------------------------------------------------------

export interface TermsForm {
  readonly supplierId: string;
  readonly searchId: string;
  readonly quantity: number;
  readonly totalMinor: bigint;
  readonly milestones: readonly { readonly bps: number; readonly trigger: OrderTermsInput["milestones"][number]["trigger"] }[];
  readonly holder: string;
  readonly bank: string;
  readonly account: string;
  readonly payeeType: PayoutAccountInput["payeeType"];
}

/**
 * The POST /api/orders/terms body. The payout account comes ONLY from what the founder typed into this form (trimmed);
 * nothing from the chat, the listing or the prefill reaches it (G12).
 */
export function termsBody(f: TermsForm): OrderTermsInput {
  return {
    supplierId: f.supplierId,
    searchId: f.searchId,
    quantity: f.quantity,
    totalMinor: f.totalMinor.toString(),
    milestones: f.milestones.map((m) => ({ bps: m.bps, trigger: m.trigger })),
    payout: { holderName: f.holder.trim(), bankName: f.bank.trim(), accountNumber: f.account, payeeType: f.payeeType },
  };
}

export interface SaveAndSignDeps {
  /** POST /api/orders/terms; rejects on any refusal. */
  readonly save: (body: OrderTermsInput) => Promise<OrderTerms>;
  /** Tells the chat the terms were saved (the `terms_saved` action; the server then offers the sign card too). */
  readonly act: (action: ChatAction, label: string) => void;
  /** Opens the thread's sign sheet for the order (SignHost). */
  readonly openSheet: (req: { readonly kind: "SupplierApproval"; readonly refId: string; readonly title: string }) => void;
  readonly newActionId: () => string;
}

/**
 * "Save and sign" (UX-PLAN D2, G2): still two server steps. First the terms are saved; only when the server says
 * they are CONFIRMED does the chat hear `terms_saved` and the SupplierApproval sheet open for those terms. A failed
 * or refused save opens nothing and tells nothing; the error goes back to the form.
 */
export async function saveAndSign(body: OrderTermsInput, title: string, deps: SaveAndSignDeps): Promise<OrderTerms> {
  const terms = await deps.save(body);
  if (terms.status !== "CONFIRMED") throw new Error(`terms ${terms.termsId} are ${terms.status}, not CONFIRMED`);
  deps.act({ type: "terms_saved", actionId: deps.newActionId(), termsId: terms.termsId }, ACTION_LABEL.termsSaved);
  deps.openSheet({ kind: "SupplierApproval", refId: terms.termsId, title });
  return terms;
}

/** The order sign sheet's title (client side, D16 item 5). The name comes from the card's structured data. */
export const orderSheetTitle = (name: string): string => `Sign your order with ${name}`;
