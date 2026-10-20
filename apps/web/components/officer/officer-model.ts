/**
 * The loan officer's dashboard as pure functions (ux3-officer; review #9, #2, #6): the figures, the short "What
 * happened" feed and the words for a request. Everything is read from queries the console already makes; nothing
 * here decides or pays. Money stays minor-unit strings.
 */
import { parseMinor, walletFigures, type Balances, type CapKind, type CfoReport, type Exception, type ExceptionStatus, type Payment, type PlanStage } from "@hogee/core";
import { KIND_LABEL } from "../../lib/exception-copy";
import { lineLabel } from "../../lib/format";
import { zonedDate, zonedDateTime } from "../sign/seal-time";

const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/**
 * The most the AI could pay on its own right now, as the chain would allow it: for each pocket that is not paused or
 * stopped, what is left of it and of its rolling window, added up, then capped by what is ready to spend (the
 * released budget and the funding). Zero when payments are paused or the AI's key is switched off or expired.
 */
export function aiCanPayNow(b: Pick<Balances, "pockets" | "escrowMinor" | "releasedMinor" | "fundedMinor" | "paused" | "agent">, nowSeconds: number): string {
  if (b.paused || b.agent.revoked || Number(b.agent.expiresAt) <= nowSeconds) return "0";
  const byPocket = b.pockets
    .filter((p) => !p.paused && !p.circuitOpen)
    .reduce((sum, p) => {
      const windowLeft = parseMinor(p.windowCap) - parseMinor(p.windowSpent);
      return sum + minBig(parseMinor(p.available), windowLeft > 0n ? windowLeft : 0n);
    }, 0n);
  // Ready to spend as every other page counts it (lib/money.ts readyToSpendOf: core walletFigures().freeMinor).
  const ready = walletFigures({ planTotalMinor: null, pockets: b.pockets, escrowMinor: b.escrowMinor, supplierPaidMinor: null, releasedMinor: b.releasedMinor, fundedMinor: b.fundedMinor }).freeMinor;
  return minBig(byPocket, parseMinor(ready)).toString();
}

/** "Just now", "5 min ago", "2 h ago", "Yesterday", "3 days ago", then "12 Oct" (UTC). A future time reads as its day. */
export function ago(ms: number, nowMs: number): string {
  const d = nowMs - ms;
  const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(ms));
  if (!Number.isFinite(ms) || d < -60_000) return day;
  if (d < 60_000) return "Just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} h ago`;
  if (d < 2 * 86_400_000) return "Yesterday";
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)} days ago`;
  return day;
}

// ---- What happened ------------------------------------------------------------------------------------------------

export type FeedKind = "agent" | "signed" | "officer";

export interface FeedItem {
  readonly key: string;
  readonly kind: FeedKind;
  readonly title: string;
  readonly at: number;
  readonly amountMinor?: string;
}

/** A mined payment (the chain has it): the states after INCLUDED, as GET /api/stats/autonomy counts them. */
const MINED: ReadonlySet<Payment["state"]> = new Set(["INCLUDED", "FINALIZED", "SETTLEMENT_REQUESTED", "SETTLED", "SETTLEMENT_FAILED"]);

/** What the founder signed, from the typed-data name in the record's summary: a template, never the summary itself. */
const SIGNED: readonly (readonly [RegExp, (founder: string) => string])[] = [
  [/\bPlanApproval\b/, (f) => `${f} signed the plan`],
  [/\bSupplierApproval\b/, (f) => `${f} signed a supplier order`],
  [/\bMilestone\w*\b/, (f) => `${f} signed a balance payment`],
  [/\bLoosenRequest\b/, (f) => `${f} signed a request for you`],
];

export function signatureTitle(summary: string, founder: string): string {
  const hit = SIGNED.find(([re]) => re.test(summary));
  return hit ? hit[1](founder) : `${founder} signed`;
}

const OFFICER: readonly (readonly [RegExp, string])[] = [
  [/\bfunded the facility\b/i, "You added money"],
  [/\bopened the facility\b/i, "You opened the loan"],
  [/\bapproved\b/i, "You approved a request"],
  [/\b(denied|vetoed|cancel)/i, "You turned down a request"],
];

export interface TraceLike {
  readonly traceId: string;
  readonly seq: number;
  readonly actor: string;
  readonly kind: string;
  readonly summary: string;
  readonly ts: string;
}

/** Payment kinds the AI decides by itself (as the autonomy counters: api dashboard.ts AGENT_PAYMENT_KINDS, re-check W-4). */
const AI_PAYMENT_KINDS: ReadonlySet<Payment["kind"]> = new Set(["SPEND", "FUND_MILESTONE"]);

/**
 * The newest few things the officer should know about: the AI's own payments (mined, of a kind the AI decides, with an
 * agent decision; a founder-signed release or owner spend is the founder's signature, listed as one), the founder's signatures
 * and the officer's own actions. Titles are templates; amounts come from the payment record.
 */
export function feedOf(input: { payments: readonly Payment[] | undefined; traces: readonly TraceLike[] | undefined; founder: string; limit?: number }): FeedItem[] {
  const paid: FeedItem[] = (input.payments ?? [])
    .filter((p) => AI_PAYMENT_KINDS.has(p.kind) && p.decisionId !== null && MINED.has(p.state))
    .map((p) => ({
      key: `pay:${p.paymentId}`,
      kind: "agent",
      title: p.kind === "SPEND" ? `${lineLabel(p.lineKey ?? "")} paid by itself` : "Supplier deposit paid by itself",
      at: Date.parse(p.updatedAt),
      amountMinor: p.amountMinor,
    }));
  const people: FeedItem[] = (input.traces ?? []).flatMap((t): FeedItem[] => {
    const at = Date.parse(t.ts);
    if (t.actor === "founder" && t.kind === "SIGNATURE") return [{ key: `t:${t.traceId}:${t.seq}`, kind: "signed", title: signatureTitle(t.summary, input.founder), at }];
    if (t.actor === "officer") {
      const hit = OFFICER.find(([re]) => re.test(t.summary));
      return hit ? [{ key: `t:${t.traceId}:${t.seq}`, kind: "officer", title: hit[1], at }] : [];
    }
    return [];
  });
  // A mix, so a busy week of small payments never pushes the founder's signatures off: half each, newest first.
  const limit = input.limit ?? 6;
  const newest = (items: FeedItem[], n: number) => items.filter((i) => Number.isFinite(i.at)).sort((a, b) => b.at - a.at).slice(0, n);
  const half = Math.ceil(limit / 2);
  const people6 = newest(people, limit);
  const paid6 = newest(paid, Math.max(half, limit - people6.length));
  return [...paid6, ...people6.slice(0, Math.max(limit - paid6.length, 0))].sort((a, b) => b.at - a.at);
}

// ---- Requests -----------------------------------------------------------------------------------------------------

/** Plain status words (never the code). */
export const STATUS_WORD: Readonly<Record<ExceptionStatus, string>> = {
  OPEN: "Waiting for signatures",
  FOUNDER_SIGNED: "Signed by the founder, waiting for you",
  APPROVED: "You approved it",
  QUEUED: "In its safety wait",
  EXECUTABLE: "Wait over",
  EXECUTED: "Done",
  DENIED: "Turned down",
  CANCELLED: "Cancelled",
  EXPIRED: "Ran out of time",
};

/** A request's title: always the template for its kind, never the title the server or the seed wrote. */
export const requestTitle = (e: Pick<Exception, "kind">): string => KIND_LABEL[e.kind];

/** One value in a request's detail; the row renders it (Money for money, monospace for ids and check codes). */
export type DetailValue =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "money"; readonly minor: string }
  /** An id to check letter by letter; `rail` adds how the facility pays payees, `before` a word in front of it. */
  | { readonly kind: "id"; readonly id: string; readonly before?: string; readonly rail?: true }
  /**
   * A 32-byte check code: `full` shows all 66 characters, wrapped (a code the officer checks letter by letter: there
   * is no hover on a phone, rcfix H-4); otherwise shortened, the full value on hover.
   */
  | { readonly kind: "code"; readonly hex: string; readonly full?: true };

export interface DetailRow {
  readonly label: string;
  readonly value: DetailValue;
}

const text = (t: string): DetailValue => ({ kind: "text", text: t });
const money = (minor: string): DetailValue => ({ kind: "money", minor });
const id = (value: string, extra: { before?: string; rail?: true } = {}): DetailValue => ({ kind: "id", id: value, ...extra });

/** The limit a RAISE_CAP raises, in the words of the founder's signing panel (lib/signed-rows.ts). */
const CAP_WORD: Readonly<Record<CapKind, string>> = { perTx: "Most per payment", window: "Most per week" };

/**
 * An end date in the facility's own zone with its year, "15 Dec 2026, 08:00 SGT" (seal-time: SGD → SGT, MYR → MYT,
 * else UTC), the same clock the founder signed it on. A value past what a date can hold (uint64 allows it) is still
 * shown, as its number, never as a blank or a crash: a "never ends" request is exactly the one to see.
 */
function endDate(seconds: string, currency: string | undefined): string {
  const n = Number(seconds);
  if (!Number.isFinite(n) || Number.isNaN(new Date(n * 1000).getTime())) return `Too far ahead to show as a date (${seconds} in seconds)`;
  const at = zonedDateTime(n, currency);
  const time = at?.slice(at.indexOf(", ") + 2);
  return time ? `${zonedDate(n, currency)}, ${time}` : zonedDate(n, currency);
}

/**
 * What the officer approves (or lets happen by not vetoing), row by row: built ONLY from the request's typed payload,
 * never from `e.title`, which the server or the seed wrote (6dc22f0 replaced it with the kind's template; run-10 found
 * the detail lost with it). Exhaustive over ExceptionKind: a new kind fails the typecheck here until it has rows.
 */
export function requestDetail(e: Exception, currency?: string): readonly DetailRow[] {
  switch (e.kind) {
    case "RAISE_CAP":
      return [
        { label: "Pocket", value: text(lineLabel(e.payload.lineKey)) },
        { label: "Which limit", value: text(CAP_WORD[e.payload.cap]) },
        { label: "New limit", value: money(e.payload.newCapMinor) },
      ];
    case "ADD_PAYEE":
      return [
        { label: "Who can be paid", value: id(e.payload.payeeId, { rail: true }) },
        { label: "Paid from", value: text(`${lineLabel(e.payload.lineKey)} pocket`) },
      ];
    case "EXTEND_EXPIRY":
      return [
        { label: "What", value: text(e.payload.target === "agent" ? "The AI's paying key" : `${lineLabel(e.payload.lineKey)} pocket`) },
        { label: "New end date", value: text(endDate(e.payload.newExpiresAt, currency)) },
      ];
    case "MOVE_POCKETS":
      return [
        { label: "From pocket", value: text(lineLabel(e.payload.fromLineKey)) },
        { label: "To pocket", value: text(lineLabel(e.payload.toLineKey)) },
        { label: "Amount", value: money(e.payload.amountMinor) },
      ];
    case "UNPAUSE":
      return [{ label: "Restarts", value: text(e.payload.lineKey === undefined ? "Every payment, from every pocket" : `Payments from the ${lineLabel(e.payload.lineKey)} pocket`) }];
    case "WITHDRAW_RESERVE":
      return [
        { label: "Pays", value: money(e.payload.amountMinor) },
        { label: "To", value: id(e.payload.taxPayeeId, { rail: true }) },
        { label: "From", value: text("Tax money") },
      ];
    case "RELEASE_ESCROW_BALANCE":
      return [
        { label: "Order", value: id(e.payload.orderId) },
        { label: "Which payment", value: text(`Payment ${e.payload.idx + 1}`) },
        { label: "Delivery check code", value: { kind: "code", hex: e.payload.evidenceHash, full: true } },
      ];
    case "RELEASE_STAGE":
      return [{ label: "Budget part", value: id(e.payload.stageId) }];
    case "REPLAN":
      return [{ label: "New plan draft", value: id(e.payload.draftId) }];
    case "POLICY_ESCALATION": {
      const p = e.payload.proposal;
      return [
        { label: "Pays", value: money(p.amountMinor) },
        { label: "To", value: id(p.payeeId, { rail: true }) },
        { label: "From", value: text(`${lineLabel(p.lineKey)} pocket`) },
        { label: "For", value: p.invoiceId !== undefined ? id(p.invoiceId, { before: "invoice" }) : text(`daily ads payment #${p.pacingSlot}`) },
      ];
    }
    default: {
      const unknown: never = e;
      throw new Error(`No detail for request kind ${String((unknown as { kind?: unknown }).kind)}`);
    }
  }
}

// ---- Releases -----------------------------------------------------------------------------------------------------

export interface ReleaseRow {
  readonly n: number;
  readonly stageId: string;
  readonly releaseMinor: string;
  readonly released: boolean;
  /** The sales goal, when the part opens on sales in BU. */
  readonly goal?: { readonly targetMinor: string; readonly deadline: string };
}

/** The plan's budget parts in order, each released once the chain's released total covers it. */
export function releaseRows(stages: readonly Pick<PlanStage, "stageId" | "releaseMinor" | "gate">[], releasedMinor: string): ReleaseRow[] {
  const released = parseMinor(releasedMinor);
  let upTo = 0n;
  return stages.map((s, i) => {
    upTo += parseMinor(s.releaseMinor);
    const goal = s.gate?.metric === "salesMinor" ? { targetMinor: s.gate.target, deadline: s.gate.deadline } : undefined;
    return { n: i + 1, stageId: s.stageId, releaseMinor: s.releaseMinor, released: released >= upTo, ...(goal ? { goal } : {}) };
  });
}

/** Sales so far as a share of a goal, 0..100. */
export function goalPct(salesMinor: string, targetMinor: string): number {
  const target = parseMinor(targetMinor);
  if (target === 0n) return 0;
  const pct = Number((parseMinor(salesMinor) * 1000n) / target) / 10;
  return Math.min(100, pct);
}

// ---- Sales ------------------------------------------------------------------------------------------------------

/** Sales as the Wallet counts them (review #6, friction #39): one rule, shared with the Wallet and the Plan. */
export { salesFigure, type SalesFigure } from "../cfo/cfo-model";
