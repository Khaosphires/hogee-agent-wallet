/**
 * The chat journey as the browser sees it (VISION-DECISIONS §4, wave-1 brief v-chat-ui), kept free of React so it can
 * be unit-tested: what a button press sends, what a user bubble shows, where the founder is in the journey, and
 * whether a signature reached the chain. Every founder-visible string here passes the wording lint (the test runs it).
 */
import {
  ChatAction,
  NEEDS_GROUPS,
  actionLabel,
  walletFigures,
  type CfoView,
  type HogeeDataParts,
  type NeedsChecklist,
  type NeedsGroup,
  type NeedsItem,
  type NeedsStatus,
  type OrderTerms,
  type PlanIntent,
  type PlanRecord,
  type SignatureKind,
  type WalletFigures,
  type WalletInputs,
} from "@hogee/core";
import type { UIMessage } from "ai";
import { uuidv7 } from "./chat-session";
import { bu, pctOf } from "./format";

/** The chat's UI message (the same type as components/chat/message-parts HogeeUIMessage). */
export type JourneyMessage = UIMessage<unknown, HogeeDataParts>;
type Part = JourneyMessage["parts"][number];

// ---- the thread's mount ---------------------------------------------------------------------------------------
export interface ThreadLatch<T> {
  readonly sessionId: string;
  readonly initial: T[];
}

/**
 * When the thread may mount, and with which history. Once it has mounted for a session it stays mounted with the
 * history it started from: a refetch of GET /api/chat (every mutation invalidates all queries, the SignDialog's submit
 * included) briefly turns a 404 "new conversation" back into "pending", and unmounting then would drop the open
 * SignDialog and the reply in flight (int-e2e journey, 19 Oct).
 */
export function threadLatch<T>(prev: ThreadLatch<T> | null, sessionId: string | undefined, data: T[] | undefined, fresh: boolean): ThreadLatch<T> | null {
  if (!sessionId) return prev;
  if (prev?.sessionId === sessionId) return prev;
  if (data) return { sessionId, initial: data };
  if (fresh) return { sessionId, initial: [] };
  return null;
}

// ---- actions --------------------------------------------------------------------------------------------------
/** A fresh single-use action id (the server answers a replayed one with "already done"). */
export const newActionId = (): string => uuidv7();

/** The label the server stores as a button press's user text (core journey templates: one source of truth). */
export { actionLabel };

/**
 * The parts of the user message a button press appends: the label the founder pressed (shown in their bubble) and the
 * structured action. The action is checked against the schema first: a malformed one is never sent (fail closed).
 */
export function actionMessageParts(action: ChatAction, label: string): JourneyMessage["parts"] {
  const parsed = ChatAction.safeParse(action);
  if (!parsed.success) throw new Error("That button didn't work. Type what you want instead.");
  const text = label.trim() || actionLabel(parsed.data);
  return [
    { type: "text", text },
    { type: "data-action", data: { action: parsed.data } },
  ];
}

/** The action a USER message carries (a button press), if any. */
export function actionOf(message: JourneyMessage | undefined): ChatAction | undefined {
  if (message?.role !== "user") return undefined;
  for (const p of message.parts) if (p.type === "data-action") return p.data.action;
  return undefined;
}

export const textOf = (message: JourneyMessage): string =>
  message.parts
    .map((p) => (p.type === "text" ? p.text : ""))
    .join(" ")
    .trim();

/**
 * POST /api/chat body for the latest user message: `{sessionId, action}` for a button press (its label never reaches
 * the server: actions carry no free text), `{sessionId, message}` for typed text. "Try again" re-sends the same
 * message, so a retried button sends the same action (same actionId) and never its label.
 */
export function chatRequestBody(sessionId: string, last: JourneyMessage | undefined): { sessionId: string; action: ChatAction } | { sessionId: string; message: string } {
  const action = actionOf(last);
  if (action) return { sessionId, action };
  return { sessionId, message: last ? textOf(last) : "" };
}

/** Option labels by value, so an answered question chip shows as its label in the user's bubble. */
export function optionLabels(messages: readonly JourneyMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) for (const p of m.parts) if (p.type === "data-question") for (const o of p.data.options) map.set(o.value, o.label);
  return map;
}

/** A user bubble: the chip's label for an answered question, the typed text, or (no text) the stored action label. */
export function userBubbleText(message: JourneyMessage, labels: ReadonlyMap<string, string>): string {
  const text = textOf(message);
  if (text) return labels.get(text) ?? text;
  const action = actionOf(message);
  return action ? actionLabel(action) : "";
}

/** Every action id the founder has pressed in this thread (a pressed next-step button shows as chosen). */
export function chosenActionIds(messages: readonly JourneyMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    const a = actionOf(m);
    if (a) ids.add(a.actionId);
  }
  return ids;
}

export const signKey = (kind: SignatureKind, refId: string): string => `${kind}:${refId}`;

/** The signatures the founder reported as sent in this thread (`signed` actions), as signKey()s. */
export function signedKeys(messages: readonly JourneyMessage[]): Set<string> {
  const keys = new Set<string>();
  for (const m of messages) {
    const a = actionOf(m);
    if (a?.type === "signed") keys.add(signKey(a.kind, a.refId));
  }
  return keys;
}

export interface WaitingSign {
  readonly key: string;
  readonly kind: SignatureKind;
  readonly refId: string;
  readonly title: string;
}

/**
 * The one card that waits on the founder (DESIGN.md §2: only it is lifted, never two): the latest needs or sign card
 * whose signature the founder hasn't sent. A sign card for a draft whose needs card is in the same reply counts as that card.
 */
export function waitingSign(messages: readonly JourneyMessage[]): WaitingSign | null {
  const signed = signedKeys(messages);
  let latest: WaitingSign | null = null;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const p of m.parts) {
      if (p.type === "data-needs") latest = { key: signKey("PlanApproval", p.data.draftId), kind: "PlanApproval", refId: p.data.draftId, title: "Sign your plan" };
      else if (p.type === "data-sign" && latest?.key !== signKey(p.data.kind, p.data.refId)) latest = { key: signKey(p.data.kind, p.data.refId), kind: p.data.kind, refId: p.data.refId, title: p.data.title };
    }
  }
  return latest && !signed.has(latest.key) ? latest : null;
}

export const waitingSignKey = (messages: readonly JourneyMessage[]): string | null => waitingSign(messages)?.key ?? null;

/**
 * The wallet's figures (DESIGN.md §6), the same math in live and mock (core walletFigures): what is left of the plan
 * (total − spent − committed to escrow, so a signed order counts at once), what the agent may spend right now
 * (Σ available, capped by the released stage and the funding, as the chain caps it), and the escrow split into what it paid out to suppliers and what it still holds, from the committed
 * plan, the chain-raw balances and the CFO report's supplier cost (null while that report is unknown). null without a
 * plan or balances (no invented zeroes).
 */
export function walletSummary(
  planTotalMinor: string | undefined,
  balances: Pick<WalletInputs, "pockets" | "escrowMinor" | "releasedMinor" | "fundedMinor"> | undefined,
  supplierPaidMinor: string | null = null,
): WalletFigures | null {
  if (planTotalMinor === undefined || balances === undefined) return null;
  const { pockets, escrowMinor, releasedMinor, fundedMinor } = balances;
  return walletFigures({ planTotalMinor, pockets, escrowMinor, supplierPaidMinor, releasedMinor, fundedMinor });
}

/** The order card's pause link: the link, "Pausing…" once the API took the request, or paused. */
export type StopPaymentsView = "offer" | "pausing" | "paused";

/**
 * "paused" only when the balances say the chain is paused (as the wallet rail): a pause the API accepted is queued until
 * the chain applies it (RCFIX10 A-4), so until then it is "pausing", never "paused".
 */
export const stopPaymentsView = (pausedOnChain: boolean, requested: boolean): StopPaymentsView => (pausedOnChain ? "paused" : requested ? "pausing" : "offer");

// ---- the thread's own facts (Next step, de-dup, the cards' context) ----------------------------------------------
export interface ThreadFacts {
  /** The newest web search the thread shows (data-search or data-candidates). */
  readonly latestSearchId: string | null;
  /** The suppliers of the newest message drafted after that search (a pick that took effect). */
  readonly pickedSupplierIds: readonly string[];
  /** A deal form shown after the latest saved deal and the latest search. */
  readonly termsFormOpen: boolean;
  /** The termsId of the newest terms_saved press. */
  readonly savedTermsId: string | null;
  /** The newest message is the assistant's question, still unanswered. */
  readonly openQuestion: boolean;
  /** The newest plan draft the thread shows (data-needs or data-plan-draft). */
  readonly latestDraftId: string | null;
}

/** What the thread says about the journey: one pass over the parts, newest wins (pure; next-step and the cards read it). */
export function threadFacts(messages: readonly JourneyMessage[]): ThreadFacts {
  let n = 0;
  let searchId: string | null = null;
  let searchAt = 0;
  let pickedIds: readonly string[] = [];
  let pickedAt = 0;
  let termsAt = 0;
  let savedId: string | null = null;
  let savedAt = 0;
  let draft: string | null = null;
  for (const m of messages) {
    for (const p of m.parts) {
      n += 1;
      if (m.role === "user") {
        if (p.type === "data-action" && p.data.action.type === "terms_saved") [savedId, savedAt] = [p.data.action.termsId, n];
        continue;
      }
      if ((p.type === "data-search" || p.type === "data-candidates") && searchId !== p.data.searchId) [searchId, searchAt] = [p.data.searchId, n];
      else if (p.type === "data-enquiry") [pickedIds, pickedAt] = [p.data.supplierIds, n];
      else if (p.type === "data-terms") termsAt = n;
      else if (p.type === "data-needs" || p.type === "data-plan-draft") draft = p.data.draftId;
    }
  }
  const last = messages.at(-1);
  return {
    latestSearchId: searchId,
    pickedSupplierIds: searchId !== null && pickedAt > searchAt ? pickedIds : [],
    termsFormOpen: termsAt > Math.max(savedAt, searchAt),
    savedTermsId: savedId,
    openQuestion: last?.role === "assistant" && last.parts.some((p) => p.type === "data-question"),
    latestDraftId: draft,
  };
}

// ---- the founder's presses, as events (UX-PLAN D4: never a bubble they didn't type) ---------------------------------
const SIGNED_EVENT: Partial<Record<SignatureKind, string>> = {
  PlanApproval: "You signed your plan",
  SupplierApproval: "You signed the order",
  MilestoneRelease: "You signed to pay the balance",
};
const CFO_EVENT: Record<CfoView, string> = {
  overview: "You asked how the business is doing",
  spending: "You asked about your spending",
  sales: "You asked about your sales",
  pnl: "You asked about your profit or loss",
  forecast: "You asked for the forecast",
  reserve: "You asked about your tax money",
};

/**
 * The quiet past-tense line a pressed button leaves in the thread (UX-PLAN D4), or null when the press was not theirs:
 * the search card sends show_candidates by itself once the list is ready, so it leaves no line. The stored message
 * is unchanged (the server's history and single-use action ids rely on it); only how it shows changes.
 */
export function actionEventText(action: ChatAction): string | null {
  switch (action.type) {
    case "start_search":
      return "You asked Hogee to find suppliers";
    case "use_catalog":
      return "You asked for the sample supplier list";
    case "show_candidates":
      return null;
    case "pick":
      return action.supplierIds.length === 1 ? "You picked 1 supplier" : `You picked ${action.supplierIds.length} suppliers`;
    case "start_terms":
      return "You opened the deal form";
    case "terms_saved":
      return "You saved the deal";
    case "signed":
      return SIGNED_EVENT[action.kind] ?? "You signed";
    case "show_cfo":
      return CFO_EVENT[action.view];
  }
}

// ---- one card per thing (UX-PLAN D7) -------------------------------------------------------------------------------
/** The thing a card shows, when the server may send it again later (null: every copy is its own). */
export function cardKey(part: Part): string | null {
  switch (part.type) {
    case "data-needs":
      return `plan:${part.data.draftId}`;
    case "data-sign":
      return part.data.kind === "PlanApproval" ? `plan-sign:${part.data.refId}` : `sign:${part.data.kind}:${part.data.refId}`;
    case "data-order":
      return `order:${part.data.termsId}`;
    case "data-candidates":
      return `candidates:${part.data.searchId}`;
    case "data-search":
      return `search:${part.data.searchId}`;
    case "data-shortlist":
      return `shortlist:${part.data.requestId}`;
    case "data-terms":
      return `terms:${part.data.supplierId}`;
    case "data-cfo":
      return `cfo:${part.data.view}`;
    case "data-plan-draft":
      return `plan-draft:${part.data.draftId}`;
    default:
      return null;
  }
}

/** How a part shows: in full, as one quiet line pointing at the copy that is shown, or not at all. */
export type PartView = { readonly mode: "full" } | { readonly mode: "moved"; readonly to: string; readonly below: boolean } | { readonly mode: "hidden" };

/** The DOM id of a part (the "moved" line links to it). */
export const partAnchor = (message: number, part: number): string => `part-${message}-${part}`;

/**
 * Which copy of each card shows in full: the newest one. Older copies become one "Updated below" line. Two special
 * cases: a plan's needs card is the plan's one sign surface, so a later bare PlanApproval card for the same draft
 * points up to it (the needs card's own reply covers its sign card, as before); a plan-draft link only shows where no
 * needs card is beside it, newest copy only. Keys: `${messageIndex}:${partIndex}`.
 */
export function partViews(messages: readonly JourneyMessage[]): ReadonlyMap<string, PartView> {
  const newest = new Map<string, [number, number]>();
  const needsAt = new Map<string, [number, number]>();
  messages.forEach((m, i) =>
    m.parts.forEach((p, j) => {
      if (m.role !== "assistant") return;
      const key = cardKey(p);
      if (key) newest.set(key, [i, j]);
      if (p.type === "data-needs") needsAt.set(p.data.draftId, [i, j]);
    }),
  );
  const views = new Map<string, PartView>();
  messages.forEach((m, i) =>
    m.parts.forEach((p, j) => {
      if (m.role !== "assistant") return;
      const key = cardKey(p);
      if (!key) return;
      const here = `${i}:${j}`;
      if (p.type === "data-plan-draft") {
        const besideNeeds = m.parts.some((x) => x.type === "data-needs");
        const [ni, nj] = newest.get(key) ?? [i, j];
        views.set(here, besideNeeds || ni !== i || nj !== j ? { mode: "hidden" } : { mode: "full" });
        return;
      }
      if (p.type === "data-sign" && p.data.kind === "PlanApproval") {
        const needs = needsAt.get(p.data.refId);
        if (needs && needs[0] !== i) {
          views.set(here, { mode: "moved", to: partAnchor(needs[0], needs[1]), below: needs[0] > i });
          return;
        }
      }
      const [ni, nj] = newest.get(key) ?? [i, j];
      views.set(here, ni === i && nj === j ? { mode: "full" } : { mode: "moved", to: partAnchor(ni, nj), below: true });
    }),
  );
  return views;
}

// ---- what I heard (UX-PLAN D7: the intent as one plain line) -------------------------------------------------------
const COUNTRY: Record<PlanIntent["countryCode"], string> = { SG: "Singapore", MY: "Malaysia", ID: "Indonesia" };
const RESIDENCY: Record<PlanIntent["residency"], string> = { citizen: "citizen", pr: "permanent resident", foreigner: "foreigner" };
const PRODUCT: Record<PlanIntent["productCategory"], string> = {
  drinkware_food_contact: "cups and bottles",
  cosmetics: "beauty products",
  electrical: "electrical goods",
  apparel: "clothes",
  food: "food",
  other: "your products",
};
const CHANNEL: Record<PlanIntent["sellChannel"], string> = { shopee: "Shopee", tiktok_shop: "TikTok Shop", lazada: "Lazada", own_site: "your own website" };

/** "Singapore citizen · cups and bottles · Shopee · up to 10,000 BU": what Hogee understood, in the founder's words, no codes. */
export function heardLine(intent: PlanIntent): string {
  const who = intent.residency === "citizen" ? `${COUNTRY[intent.countryCode]} citizen` : `${RESIDENCY[intent.residency]} in ${COUNTRY[intent.countryCode]}`;
  return [who, PRODUCT[intent.productCategory], CHANNEL[intent.sellChannel], `up to ${bu(intent.budgetCeilingMinor)}`].join(" · ");
}

// ---- announcements --------------------------------------------------------------------------------------------
const CARD_NAMES: Partial<Record<Part["type"], string>> = {
  "data-question": "a question",
  "data-intent": "what I heard",
  "data-plan-draft": "your plan",
  "data-shortlist": "a supplier list",
  "data-redflag": "a warning",
  "data-needs": "what your business needs",
  "data-sign": "something to sign",
  "data-next": "next steps",
  "data-search": "a supplier search",
  "data-candidates": "suppliers to choose from",
  "data-enquiry": "a message to copy",
  "data-terms": "a deal form",
  "data-order": "an order",
  "data-cfo": "a money summary",
};

const listOf = (xs: readonly string[]): string => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1) ?? ""}`);

/** What the live region says when a reply lands: the cards it brought, once each ("Hogee replied with …"). */
export function announcementFor(message: JourneyMessage): string {
  const names = [...new Set(message.parts.map((p) => CARD_NAMES[p.type]).filter((n): n is string => Boolean(n)))];
  return names.length === 0 ? "Hogee replied." : `Hogee replied with ${listOf(names)}.`;
}

// ---- signatures -----------------------------------------------------------------------------------------------
/**
 * `superseded`: the record now carries another signature's tx than the one this page's submit answered with (the mock
 * store was rebuilt from another tab). Terminal: polling would never show this signature, so the stub asks for a reload.
 */
export type SignState = "idle" | "submitted" | "confirmed" | "failed" | "superseded";
export interface SignProgress {
  readonly state: SignState;
  readonly txHash: string | null;
}

export interface SignProgressInput {
  readonly kind: SignatureKind;
  /** The founder submitted this signature (this page, or a `signed` action in the thread). */
  readonly submitted: boolean;
  /** The tx hash submitSignature answered with, if it had one yet. */
  readonly submittedTx: string | null;
  /** The current plan's tx hash when the signature was sent (so a plan committed earlier is not read as this one). */
  readonly baselineTx: string | null;
  readonly plan?: Pick<PlanRecord, "status" | "txHash"> | null;
  readonly terms?: (Pick<OrderTerms, "status" | "orderId" | "schedule"> & Partial<Pick<OrderTerms, "bindTxHash">>) | null;
}

/** False only when both txs are known and differ: a record changed by another signature than this page's submit. */
const sameOrUnknown = (submittedTx: string | null, recordTx: string | null | undefined): boolean => submittedTx === null || !recordTx || recordTx === submittedTx;

/** The tx the record read back carries for this kind (the plan's commit, the order's bindPayee), if any. */
function recordTxOf(i: SignProgressInput): string | null {
  if (i.kind === "PlanApproval") return i.plan?.txHash ?? null;
  if (i.kind === "SupplierApproval") return i.terms?.bindTxHash ?? null;
  return null;
}

/**
 * Whether a submitted signature reached the chain, read from the record it changes: PlanApproval → the current plan
 * is COMMITTED (or REVERTED) with a tx other than the one before; SupplierApproval → its terms are USED by an order.
 * Other kinds have no reader here and stay "submitted" with the submit's tx. Never claims more than the record shows.
 * When the submit answered with a tx, the record must carry that tx (run-10 v-1: the mock reuses the seeded draftId in
 * every store build, and the Sample business commits the same draft with its own made-up tx). A live submit is queued
 * without one; then the plan's first new commit after the dialog opened (`baselineTx`) is this signature's.
 * A record that carries another tx than the submit's is `superseded` (RCFIX10 W-5): the mock applies a signature before
 * it answers the submit (and the dialog re-reads every query before the page records it), so that record was rebuilt or
 * changed by another signature and this one will never show there. Live answers the submit without a tx: never superseded.
 */
export function signProgress(i: SignProgressInput): SignProgress {
  if (!i.submitted) return { state: "idle", txHash: null };
  if (i.kind === "PlanApproval" && i.plan && i.plan.txHash && i.plan.txHash !== i.baselineTx && sameOrUnknown(i.submittedTx, i.plan.txHash)) {
    if (i.plan.status === "COMMITTED") return { state: "confirmed", txHash: i.plan.txHash };
    if (i.plan.status === "REVERTED") return { state: "failed", txHash: i.plan.txHash };
  }
  if (i.kind === "SupplierApproval" && i.terms?.status === "USED" && i.terms.orderId && sameOrUnknown(i.submittedTx, i.terms.bindTxHash)) {
    // The order's seal is the bindPayee tx this approval sent (the order card stamps the same one).
    return { state: "confirmed", txHash: i.submittedTx ?? i.terms.bindTxHash ?? i.terms.schedule.find((r) => r.txHash)?.txHash ?? null };
  }
  if (!sameOrUnknown(i.submittedTx, recordTxOf(i))) return { state: "superseded", txHash: i.submittedTx };
  return { state: "submitted", txHash: i.submittedTx };
}

/** How often to re-read the record (ms): only while the signature is out and the record doesn't show it yet, else never. */
export const signPollInterval = (p: SignProgress, everyMs: number): number | false => (p.state === "submitted" ? everyMs : false);

// ---- this browser's seals (localStorage hogee.signedAt) -------------------------------------------------------------
/** What this browser keeps about a signature it sent: when (its own clock), how, and the tx it made once known. */
export interface SignedLocally {
  readonly at: number;
  readonly method: "passkey" | "wallet";
  /** null until known (a live submit is queued without one) and in entries kept before 19 Oct: such an entry matches no seal. */
  readonly txHash: string | null;
}

/** Date's own range (ms), so a kept time always prints. */
const MAX_DATE_MS = 8.64e15;

/** A kept entry, if well formed; anything else (it is the browser's storage: never trusted) reads as nothing kept. */
export function parseSignedLocally(entry: unknown): SignedLocally | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const { at, method, txHash } = entry as Record<string, unknown>;
  if (typeof at !== "number" || !Number.isFinite(at) || Math.abs(at) > MAX_DATE_MS) return undefined;
  if (method !== "passkey" && method !== "wallet") return undefined;
  return { at, method, txHash: typeof txHash === "string" && txHash !== "" ? txHash : null };
}

/**
 * True when a seal is the signature this browser sent: the tx this browser recorded for it is the seal's own. A (kind,
 * refId) match alone is not enough (the mock reuses refIds across store builds), so no recorded tx, or another one,
 * is never this browser's: the seal then shows no method or time, and the Sample tag while the sample business is on.
 */
export const isOwnSeal = (recordedTx: string | null | undefined, sealTx: string | null | undefined): boolean =>
  typeof recordedTx === "string" && recordedTx !== "" && recordedTx === sealTx;

/**
 * True when this page's own record (its submit's tx `recordTx`) is behind the seal `sealTx`. A live submit is queued
 * without a tx (null): then the seal its own confirmation read is the founder's (signProgress: the first new record after the
 * dialog opened; the mock, where store builds reuse refIds, always answers with the tx).
 */
export const pageOwnsSeal = (recordTx: string | null, sealTx: string | null | undefined): boolean => isOwnSeal(recordTx ?? sealTx, sealTx);

/** The stamp's method and time this browser kept for the seal `sealTx`, only when it is this browser's (fail closed). */
export function keptSignature(entry: unknown, sealTx: string | null): { readonly signedAt: string; readonly method: SignedLocally["method"] } | undefined {
  const kept = parseSignedLocally(entry);
  return kept && isOwnSeal(kept.txHash, sealTx) ? { signedAt: new Date(kept.at).toISOString(), method: kept.method } : undefined;
}

/**
 * The kept entries with the tx of this page's own signature filled in, once its seal confirmed (a live submit is queued
 * without a tx). Only the entry this page wrote (same `at`) and only while it has no tx; otherwise undefined: no write.
 */
export function withSignedTx(entries: Readonly<Record<string, unknown>>, key: string, at: number, txHash: string): Record<string, unknown> | undefined {
  const kept = parseSignedLocally(entries[key]);
  if (!kept || kept.at !== at || kept.txHash !== null || !txHash) return undefined;
  return { ...entries, [key]: { ...kept, txHash } };
}

// ---- needs checklist ------------------------------------------------------------------------------------------
const GROUP_LABELS: Record<NeedsGroup, string> = {
  REGISTRATION: "Registrations",
  BUDGET_LINE: "Budget lines",
  SUPPLIER: "Suppliers to find",
  ACCOUNT: "Accounts to open",
  TAX_RESERVE: "Tax reserve",
};

export function needsGroups(n: NeedsChecklist): { group: NeedsGroup; label: string; items: NeedsItem[] }[] {
  return NEEDS_GROUPS.map((group) => ({ group, label: GROUP_LABELS[group], items: n.items.filter((i) => i.group === group) })).filter((g) => g.items.length > 0);
}

const STATUS_LABELS: Record<NeedsStatus, string> = { TODO: "To do", IN_PLAN: "In your plan", DONE: "Done" };
export const needsStatusLabel = (s: NeedsStatus): string => STATUS_LABELS[s];

export function needsCounts(n: NeedsChecklist): Record<NeedsStatus, number> {
  const counts: Record<NeedsStatus, number> = { TODO: 0, IN_PLAN: 0, DONE: 0 };
  for (const i of n.items) counts[i.status] += 1;
  return counts;
}

/** Where an item comes from, in the plan page's words (components/plan/rule-list originOf). */
export function needsSourceLabel(sourceRef: string | null): string {
  if (sourceRef === null) return "No source yet";
  if (sourceRef.startsWith("constitution:")) return "On-chain constitution";
  if (sourceRef.startsWith("compiler:")) return "Plan compiler";
  return "Country pack";
}

/** Basis points as a short percentage: 500 → "5%", 250 → "2.5%". */
export const percentOfBps = (bps: number): string => `${bps / 100}%`;

export function needsAmountText(amountMinor: string | null): string | null {
  if (amountMinor === null) return null;
  return amountMinor === "0" ? "Free" : bu(amountMinor);
}

/** "10,000 BU" split for display: the figure and its unit (DESIGN.md §2: the BU suffix is set smaller, in ink-3). */
export function buFigure(minor: string): { figure: string; unit: "BU" } {
  return { figure: bu(minor).replace(/ BU$/, ""), unit: "BU" };
}

/** The budget-line allocation bar: each line with an amount, its share of their sum (0..100, bigint maths). */
export function budgetBar(n: NeedsChecklist): { lineKey: string; title: string; amountMinor: string; pct: number }[] {
  const lines = n.items.filter((i): i is NeedsItem & { lineKey: string; amountMinor: string } => i.group === "BUDGET_LINE" && i.lineKey !== null && i.amountMinor !== null);
  const sum = lines.reduce((acc, l) => acc + BigInt(l.amountMinor), 0n).toString();
  return lines.map((l) => ({ lineKey: l.lineKey, title: l.title, amountMinor: l.amountMinor, pct: pctOf(l.amountMinor, sum) }));
}

// ---- enquiry --------------------------------------------------------------------------------------------------
/** What Copy puts on the clipboard: the subject line, a blank line, then the body. */
export const enquiryClipboardText = (e: { subject: string; body: string }): string => `Subject: ${e.subject}\n\n${e.body}`;
