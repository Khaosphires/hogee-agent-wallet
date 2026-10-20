/**
 * Founder-facing milestone and terms copy (core MILESTONE_LABELS: "Deposit on order", "Balance after delivery check",
 * ...), plus the pure helpers the terms and order cards share. v-terms owns this file (VISION-DECISIONS §7). Every
 * string here passes the wording check (milestone-labels.test.ts).
 */
import { MILESTONE_LABELS, TERMS_PRESETS, termsToSchedule, type MilestoneInput, type MilestoneTrigger, type TermsErrorCode, type TermsPreset } from "@hogee/core";

export function milestoneLabel(trigger: MilestoneTrigger): string {
  return MILESTONE_LABELS[trigger];
}

/** A web supplier's order (VISION-DECISIONS §3): order-w<12>-NNN. */
export const WEB_ORDER_RE = /^order-w[a-z2-7]{12}-\d{3}$/;
const CATALOG_NAMES = ["Sample", "Deposit", "Balance", "Holdback"] as const;

/**
 * The label of each escrow milestone. With the order's terms (their triggers), the trigger labels. A web order
 * without them: its auto milestone is the deposit and its last the balance. A catalog order keeps sample, deposit,
 * balance.
 */
export function escrowMilestoneLabels(orderId: string, rows: readonly { readonly autoRelease: boolean }[], triggers?: readonly MilestoneTrigger[]): string[] {
  if (triggers && triggers.length === rows.length) return triggers.map((t) => MILESTONE_LABELS[t]);
  if (WEB_ORDER_RE.test(orderId)) {
    return rows.map((r, i) => (r.autoRelease ? MILESTONE_LABELS.ON_ORDER : i === rows.length - 1 ? MILESTONE_LABELS.ON_DELIVERY_INSPECTED : `Milestone ${i + 1}`));
  }
  return rows.map((_, i) => CATALOG_NAMES[i] ?? `Milestone ${i + 1}`);
}

/** The split each preset offers (the radio's accessible name starts with it). */
export const PRESET_LABELS: { readonly [P in TermsPreset]: { readonly split: string; readonly detail: string } } = {
  P30_70: { split: "30/70", detail: "30% deposit on order, 70% after the delivery check" },
  P50_50: { split: "50/50", detail: "50% deposit on order, 50% after the delivery check" },
  P0_100: { split: "0/100", detail: "Everything after the delivery check" },
  P30_40_30: { split: "30/40/30", detail: "30% on order, 40% on shipment, 30% after the delivery check" },
};
export const PRESET_ORDER: readonly TermsPreset[] = TERMS_PRESETS;

/** Plain English for every TERMS_* refusal (the API names the code in error.details.reason). */
export const TERMS_ERROR_TEXT: { readonly [C in TermsErrorCode]: string } = {
  TERMS_COUNT: "A schedule has 1 to 8 payments.",
  TERMS_PCT_RANGE: "Each payment must be more than 0% and at most 100% of the total.",
  TERMS_PCT_SUM: "The payments must add up to 100%.",
  TERMS_TRIGGER_ORDER: "Payments must follow the order: on order, sample approval, shipment, delivery check.",
  TERMS_LAST_NOT_INSPECTED: "The last payment must be the balance after the delivery check.",
  TERMS_TOTAL_INVALID: "Enter the total as a whole number of BU above zero.",
  TERMS_OVER_POCKET: "The total is more than your supplier pocket has free. Lower it, or ask Hogee to move budget.",
  TERMS_MILESTONE_ZERO: "Every payment must be at least 1 BU. Raise the total or change the split.",
  TERMS_AUTO_NOT_FIRST: "Payments the agent makes by itself must come first.",
  TERMS_WEB_AUTO_COUNT: "A supplier found on the web gets at most one payment the agent makes by itself.",
  TERMS_AUTO_OVER_PER_TX: "The deposit is above your supplier pocket's per-payment limit. Pick a smaller deposit or 0/100.",
  TERMS_UPFRONT_OVER_HALF: "The agent may pay at most half of the total before delivery.",
  TERMS_UPFRONT_OVER_WINDOW: "The deposit is above what your supplier pocket may still pay this week.",
  TERMS_CANDIDATE: "This supplier is no longer on a recent search. Search again, then pick it.",
  TERMS_CURRENCY: "This facility's currency does not match the server's. Nothing was saved.",
  TERMS_PAYEE_PERSONAL: "Hogee pays suppliers only into a company account, never a personal one.",
  TERMS_ACCOUNT_FORMAT: "That account number does not look like a bank account number.",
  TERMS_HOLDER_MISMATCH: "The account holder must be a company whose name matches the seller on the listing.",
  TERMS_SANCTIONS: "The account holder or the seller is on a sanctions list. This supplier cannot be paid.",
  TERMS_ALREADY_BOUND: "This supplier already has its order. A supplier found on the web gets one order.",
  TERMS_SUPERSEDED: "These terms were replaced by newer ones. Use the newest terms.",
};

const TERMS_CODES = new Set<string>(Object.keys(TERMS_ERROR_TEXT));

/** A failed submit → its TERMS_* code (or null) and the sentence to show. Never the server's raw message for a code. */
export function termsErrorOf(error: { readonly status?: number; readonly message: string; readonly details?: Record<string, unknown> }): { code: TermsErrorCode | null; text: string } {
  const reason = error.details?.reason;
  if (typeof reason === "string" && TERMS_CODES.has(reason)) {
    const code = reason as TermsErrorCode;
    if (error.status === 503) return { code, text: "The sanctions screening could not run, so nothing was saved. Try again in a moment." };
    return { code, text: TERMS_ERROR_TEXT[code] };
  }
  return { code: null, text: "The terms could not be saved. Nothing was paid or changed. Check the form and try again." };
}

/** "4,000" or "4000" → minor units of a whole BU amount; null for anything else (no decimals, no sign). */
export function buInputToMinor(text: string): bigint | null {
  const t = text.trim().replace(/,/g, "");
  if (!/^[1-9][0-9]{0,15}$/.test(t)) return null;
  return BigInt(t) * 100n;
}

/** A positive whole quantity, at most 100,000. */
export function quantityOf(text: string): number | null {
  const t = text.trim().replace(/,/g, "");
  if (!/^[1-9][0-9]{0,5}$/.test(t)) return null;
  const n = Number(t);
  return n <= 100_000 ? n : null;
}

export interface PreviewRow {
  readonly idx: number;
  readonly trigger: MilestoneTrigger;
  readonly label: string;
  readonly amountMinor: string;
  readonly autoRelease: boolean;
}

/**
 * The split of `total` before it is saved (core termsToSchedule's rounding; limits left to the server, which checks
 * them again with the current pocket). A structural problem returns its code instead.
 */
export function previewSchedule(totalMinor: bigint | null, milestones: readonly MilestoneInput[]): { rows: PreviewRow[] } | { code: TermsErrorCode } {
  if (totalMinor === null) return { code: "TERMS_TOTAL_INVALID" };
  const open = { freeMinor: totalMinor, perTxCapMinor: totalMinor, windowCapMinor: totalMinor };
  const r = termsToSchedule({ totalMinor, milestones, origin: "web" }, open);
  if (!r.ok) return { code: r.code };
  return {
    rows: milestones.map((m, idx) => ({ idx, trigger: m.trigger, label: MILESTONE_LABELS[m.trigger], amountMinor: (r.amounts[idx] as bigint).toString(), autoRelease: r.autoRelease[idx] as boolean })),
  };
}

/** "ending 6789" for an account number (never the whole number on screen). */
export const accountEnding = (accountNumber: string): string => `ending ${accountNumber.slice(-4)}`;
