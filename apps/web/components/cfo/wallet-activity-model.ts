/**
 * The Wallet's Activity feed (UX2 brief §3, UX round 3 Steve #12) as pure functions, so it is unit-tested without the
 * API: one list, newest first, built only from what the page already reads, with runs of the same thing folded.
 *
 *   - **Payments** are Mei's receipts (lib/receipts.ts receiptsOf: supplier payments from the order's schedule, pocket
 *     payments from GET /api/payments; refused attempts moved no money and get no row).
 *   - **Sales** are the CFO report's latest sales (sales.recent): money in, labelled "Sample" whenever the sales are.
 *   - **What Hogee's AI changed by itself** (agentActions): only ever a stricter limit, no money moved.
 *
 * Kinds mix by time. A run of the same thing next to each other (five Ads payments, three sales) folds into one row
 * ("Ads · 5 payments", the run's total); a supplier payment, a failed transfer and an AI change never fold. A failed
 * bank transfer is a waiting-tone "Needs a look" row: core's failSettlement put the BU back in the pocket. A time ahead
 * of this browser's clock reads "Just now", never a future date.
 *
 * Money stays a minor-unit string, signed by direction (money in positive, money out negative).
 */
import { LINE_KEYS, type CfoAgentAction, type CfoReport } from "@hogee/core";
import type { Receipt } from "../../lib/receipts";
import { lineLabel, localDateTime } from "../../lib/format";
import { agentActionText } from "./cfo-model";

export type ActivityKind = "sale" | "payment" | "ai";

/** How the row's second line reads (and which mark it wears): who acted, or the payment's state. */
export type ActivityStatus = "sale" | "auto" | "passkey" | "you" | "tax" | "sending" | "failed" | "ai";

export interface ActivityItem {
  readonly key: string;
  readonly kind: ActivityKind;
  /** ISO time, or null for a supplier payment whose row isn't loaded yet (it was just paid: it sorts first). */
  readonly at: string | null;
  readonly title: string;
  /** Signed minor units: positive money in, negative money out; null when no money moved (an AI change). */
  readonly amountMinor: string | null;
  /** The pocket a payment left from (its colour and icon), null for sales and wallet-wide changes. */
  readonly lineKey: string | null;
  readonly status: ActivityStatus;
  readonly txHash: string | null;
  /** A supplier payment (it never folds: each one is a step of an order). */
  readonly supplier: boolean;
}

export const STATUS_TEXT: Readonly<Record<ActivityStatus, string>> = {
  sale: "Sale",
  auto: "Automatic",
  passkey: "You signed",
  you: "Paid by you",
  tax: "You both signed",
  sending: "Sending",
  failed: "Needs a look",
  ai: "Hogee's AI, by itself",
};

/** The receipt's status: its state first (sending, failed), then who paid it. */
function receiptStatus(r: Pick<Receipt, "how" | "state">): ActivityStatus {
  if (r.state === "sending") return "sending";
  if (r.state === "failed") return "failed";
  return r.how;
}

const negate = (minor: string): string => (minor === "0" ? "0" : `-${minor}`);

/** "Lowered the Ads weekly limit to 525 BU" (the row's second line says it was Hogee's AI). */
export function aiTitle(a: Pick<CfoAgentAction, "action" | "lineKey" | "newValue">): string {
  const text = agentActionText(a).replace(/^Hogee's AI /, "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** ISO times sort as text; null ("just paid") sorts before everything. */
const newestFirst = (a: ActivityItem, b: ActivityItem): number => {
  const x = a.at ?? "~";
  const y = b.at ?? "~";
  return x < y ? 1 : x > y ? -1 : 0;
};

export interface ActivityIn {
  readonly receipts: readonly Receipt[];
  /** Supplier display names by supplier id (structured data, already wording-checked). */
  readonly names: ReadonlyMap<string, string>;
  readonly report: Pick<CfoReport, "sales" | "agentActions"> | null;
}

/** Every row of the feed, newest first (before folding). */
export function activityOf({ receipts, names, report }: ActivityIn): ActivityItem[] {
  const payments = receipts.map((r): ActivityItem => {
    const name = r.supplierId ? names.get(r.supplierId) : undefined;
    return {
      key: `payment-${r.key}`,
      kind: "payment",
      at: r.at,
      title: name ? `${r.title} to ${name}` : r.title,
      amountMinor: negate(r.amountMinor),
      lineKey: r.how === "tax" ? null : r.supplierId ? "SUPPLIER" : lineKeyOfLabel(r.title),
      status: receiptStatus(r),
      txHash: r.txHash,
      supplier: r.supplierId !== null,
    };
  });
  const sales = (report?.sales.recent ?? []).map(
    (s): ActivityItem => ({ key: `sale-${s.saleId}`, kind: "sale", at: s.at, title: "Sale", amountMinor: s.amountMinor, lineKey: null, status: "sale", txHash: s.txHash, supplier: false }),
  );
  const ai = (report?.agentActions ?? []).map(
    (a): ActivityItem => ({
      key: `ai-${a.at}-${a.action}-${a.lineKey ?? ""}`,
      kind: "ai",
      at: a.at,
      title: aiTitle(a),
      amountMinor: null,
      lineKey: a.lineKey,
      status: "ai",
      txHash: a.txHash,
      supplier: false,
    }),
  );
  return [...payments, ...sales, ...ai].sort(newestFirst);
}

/** A pocket receipt's title is its pocket's plain name (lineLabel); the key behind it gives the row its colour and icon. */
export function lineKeyOfLabel(title: string): string | null {
  return LINE_KEYS.find((k) => lineLabel(k) === title) ?? null;
}

// ---- Folding runs ------------------------------------------------------------------------------------------------
/** One row of the feed: a single item, or a run of the same thing folded into one ("Ads · 5 payments"). */
export type FeedRow =
  | { readonly fold: false; readonly key: string; readonly item: ActivityItem }
  | {
      readonly fold: true;
      readonly key: string;
      /** Newest first; the row shows the newest one's time. */
      readonly items: readonly ActivityItem[];
      readonly title: string;
      /** The run's signed total (minor units). */
      readonly totalMinor: string;
      readonly kind: ActivityKind;
      readonly lineKey: string | null;
      readonly status: ActivityStatus;
    };

/** What makes two neighbouring items "the same thing": null for an item that never folds. */
function foldKey(i: ActivityItem): string | null {
  if (i.kind === "sale") return "sale";
  if (i.kind !== "payment" || i.supplier || i.status === "failed" || i.status === "tax") return null;
  return `payment:${i.lineKey ?? ""}:${i.status}`;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Folds each run of ≥ 2 neighbouring items with the same fold key into one row; the order stays newest first. */
export function foldRuns(items: readonly ActivityItem[]): FeedRow[] {
  const rows: FeedRow[] = [];
  let i = 0;
  while (i < items.length) {
    const first = items[i] as ActivityItem;
    const key = foldKey(first);
    let j = i + 1;
    while (key !== null && j < items.length && foldKey(items[j] as ActivityItem) === key) j += 1;
    if (j - i < 2) {
      rows.push({ fold: false, key: first.key, item: first });
    } else {
      const run = items.slice(i, j);
      const total = run.reduce((s, x) => s + BigInt(x.amountMinor ?? "0"), 0n);
      const title = first.kind === "sale" ? plural(run.length, "sale", "sales") : `${first.title} · ${plural(run.length, "payment", "payments")}`;
      rows.push({ fold: true, key: `fold-${first.key}`, items: run, title, totalMinor: total.toString(), kind: first.kind, lineKey: first.lineKey, status: first.status });
    }
    i = j;
  }
  return rows;
}

// ---- What the AI did by itself -----------------------------------------------------------------------------------
/** Payments the wallet made by itself (no signature at the time): the agent's pocket payments and an automatic deposit. */
export const automaticPayments = (receipts: readonly Pick<Receipt, "how" | "state">[]): number =>
  receipts.filter((r) => r.how === "auto" && r.state !== "failed").length;

/**
 * The line under the feed when the AI changed no limit (first-timer #27): what it did pay, all of it inside what Mei
 * signed, so "changed nothing" never sits next to a payment it made by itself.
 */
export function aiSummary(automatic: number): string {
  if (automatic === 0) return "Hogee's AI hasn't paid or changed anything by itself yet. It can only make limits stricter.";
  return `Hogee's AI paid only what you signed (${plural(automatic, "automatic payment", "automatic payments")}) and changed no limits.`;
}

// ---- Times -------------------------------------------------------------------------------------------------------
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "Just now", "5 min ago", "2 h ago", "Yesterday", "3 days ago", then the day ("12 Oct", in the facility's time). A time
 * ahead of this browser's clock reads "Just now": never "in 2 h", never a future date. Unreadable: "Unknown time".
 */
export function relativeTime(iso: string | null, nowMs: number, currency?: string): string {
  if (iso === null) return "Just now";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "Unknown time";
  const ago = nowMs - t;
  if (ago < MINUTE) return "Just now";
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)} min ago`;
  if (ago < DAY) return `${Math.floor(ago / HOUR)} h ago`;
  if (ago < 2 * DAY) return "Yesterday";
  if (ago < 7 * DAY) return `${Math.floor(ago / DAY)} days ago`;
  return localDateTime(iso, currency).split(",")[0] ?? "";
}
