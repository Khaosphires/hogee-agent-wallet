/**
 * The Next step (UX-PLAN §3): the one thing Mei should do now, or who Mei is waiting for, from what the browser can
 * read without any new API (the thread, the current plan, the balances, the latest search, the saved order and its
 * escrow, and three browser-only conveniences: a passkey on this device, "Later" on the passkey card, and "goods
 * arrived"). Pure, so every row of the plan's table is a unit test (next-step.test.ts).
 *
 * Rules: the step never invents anything (an unknown input falls back to the stage's row); a button never opens a
 * signature by itself (the bar's press opens the same SignHost dialog the cards open); the sentences are core's
 * NEXT_STEP_TEXT, the same words as the server's "what do I do now?" reply.
 */
import { fillNextStep, type ChatAction, type JourneyStage, type NextStepKey, type PlanStatus, type SearchStatus, type SignatureKind } from "@hogee/core";
import { bu } from "./format";
import type { Phase } from "./order-phase";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type BarChatAction = DistributiveOmit<ChatAction, "actionId">;

/** Where a "Show me" button takes the founder (each card's element in the thread). */
export type ScrollTarget = "question" | "candidates" | "enquiry" | "terms" | "evidence";

export type NextStepAction =
  | { readonly kind: "focus-passkey"; readonly label: string }
  | { readonly kind: "scroll"; readonly target: ScrollTarget; readonly label: string }
  | { readonly kind: "sign"; readonly request: { readonly kind: SignatureKind; readonly refId: string; readonly title: string }; readonly label: string }
  | { readonly kind: "send"; readonly action: BarChatAction; readonly label: string; readonly secondary?: boolean }
  | { readonly kind: "goods-arrived"; readonly orderId: string; readonly label: string };

export interface NextStep {
  readonly key: NextStepKey;
  /** The journey stage this step belongs to (core deriveJourney's names), for `data-stage`. */
  readonly stage: JourneyStage;
  readonly text: string;
  /** A few words for the phone's strip (UX round 3): where things stand; the button carries the verb. */
  readonly short: string;
  /** At most one button, only when the step is Mei's. */
  readonly action: NextStepAction | null;
  /** Who we wait for when it isn't Mei's turn. */
  readonly who: "officer" | "hogee" | null;
}

/** What the thread itself says (journey-client threadFacts). */
export interface ThreadFactsInput {
  readonly latestSearchId: string | null;
  readonly pickedSupplierIds: readonly string[];
  readonly termsFormOpen: boolean;
  readonly openQuestion: boolean;
  readonly latestDraftId: string | null;
}

export interface NextStepInput {
  readonly thread: ThreadFactsInput;
  /** The one card waiting on Mei's signature (journey-client waitingSign). */
  readonly waiting: { readonly kind: SignatureKind; readonly refId: string } | null;
  readonly passkeyOnDevice: boolean;
  readonly passkeyCardDismissed: boolean;
  /** GET /api/plans/current status; null without a plan. */
  readonly planStatus: PlanStatus | null;
  /** GET /api/suppliers/search/:latestSearchId status; null until it loads. */
  readonly searchStatus: SearchStatus | null;
  /** The saved order (getOrderTerms of the latest saved terms) with its open balance milestone (getEscrow). */
  readonly order: {
    readonly orderId: string;
    readonly phase: Phase;
    readonly coolingEndsAt: string | null;
    readonly goodsArrived: boolean;
    /** The first milestone that waits on Mei (not automatic, not released), if any. */
    readonly balance: { readonly amountMinor: string; readonly evidenceHash: string | null } | null;
  } | null;
  readonly fundedMinor: string | null;
  /** Ready to spend (core walletFigures(balances).freeMinor). */
  readonly readyMinor: string | null;
  readonly paused: boolean;
  readonly nowMs: number | null;
}

const STAGE_OF: { readonly [K in NextStepKey]: JourneyStage } = {
  passkey: "INTAKE",
  answer: "INTAKE",
  intake: "INTAKE",
  "plan-refused": "NEEDS_REVIEW",
  "sign-plan": "NEEDS_REVIEW",
  "key-needed": "FOUNDER_KEY_PENDING",
  "plan-saving": "PLAN_PENDING",
  funding: "PLAN_ACTIVE",
  find: "PLAN_ACTIVE",
  "search-failed": "PLAN_ACTIVE",
  searching: "SEARCHING",
  pick: "CANDIDATES",
  message: "PICKED",
  deal: "TERMS_DRAFT",
  "sign-order": "TERMS_CONFIRMED",
  "order-saving": "ORDER_PENDING",
  "safety-wait": "COOLING",
  paying: "OPERATING",
  "in-transit": "OPERATING",
  upload: "OPERATING",
  "pay-balance": "OPERATING",
  done: "OPERATING",
  paused: "PLAN_ACTIVE",
};

const WHO: { readonly [K in NextStepKey]?: "officer" | "hogee" } = {
  funding: "officer",
  "plan-saving": "hogee",
  searching: "hogee",
  "order-saving": "hogee",
  "safety-wait": "hogee",
  paying: "hogee",
};

/**
 * The bar's buttons use the verb of the card they act on (UX round 3: one name per action, so "Sign the plan" on the
 * plan card is "Sign the plan" on the bar too, and "Create passkey" matches the passkey card).
 */
export const SIGN_PLAN = "Sign the plan";
export const CREATE_PASSKEY = "Create passkey";
export const SIGN_ORDER = "Sign the order";
export const PAY_BALANCE = "Pay the balance";
export const PLAN_SIGN_TITLE = "Sign your plan";
export const ORDER_SIGN_TITLE = "Sign the order";
export const BALANCE_SIGN_TITLE = "Pay the balance after the delivery check";

/** "0:09", "12:30": what is left of the safety wait (never negative). */
export function waitLeft(coolingEndsAt: string | null, nowMs: number | null): string | undefined {
  if (!coolingEndsAt || nowMs === null) return undefined;
  const ends = Date.parse(coolingEndsAt);
  if (Number.isNaN(ends)) return undefined;
  const s = Math.max(0, Math.ceil((ends - nowMs) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * The phone strip's few words per step (UX round 3, first-timer #41): never cut off at 390 px, and never the button's
 * verb again. `{ready}`, `{wait}` and `{balance}` are filled like core's sentences; without the value the line drops it.
 */
export const STRIP_TEXT: { readonly [K in NextStepKey]: string } = {
  passkey: "First, a passkey",
  answer: "One question for you",
  intake: "Tell Hogee what you sell",
  "plan-refused": "Your plan wasn't saved",
  "sign-plan": "Your plan is ready",
  "key-needed": "You need a passkey",
  "plan-saving": "Saving your plan…",
  funding: "Money on its way",
  find: "{ready} ready",
  "search-failed": "The search didn't finish",
  searching: "Looking for suppliers…",
  pick: "Suppliers found",
  message: "Send your message",
  deal: "Fill in the deal",
  "sign-order": "Your order is ready",
  "order-saving": "Saving your order…",
  "safety-wait": "Safety wait {wait}",
  paying: "Paying the deposit…",
  "in-transit": "Waiting for the goods",
  upload: "Add the delivery check",
  "pay-balance": "Delivery check saved",
  done: "Order complete",
  paused: "Payments paused",
};

function stripText(key: NextStepKey, values: Parameters<typeof fillNextStep>[1]): string {
  const filled = STRIP_TEXT[key].replace(/\{(ready|wait|balance)\}/g, (_, k: "ready" | "wait" | "balance") => values?.[k] ?? "");
  // A value still loading: "ready to spend" alone reads wrong, so the line falls back to the stage's own words.
  if (key === "find" && !values?.ready) return "Your plan is active";
  return filled.replace(/\s+/g, " ").trim();
}

const step = (key: NextStepKey, action: NextStepAction | null = null, values: Parameters<typeof fillNextStep>[1] = {}): NextStep => ({
  key,
  stage: STAGE_OF[key],
  text: fillNextStep(key, values),
  short: stripText(key, values),
  action,
  who: WHO[key] ?? null,
});

const findSuppliers = (secondary = false): NextStepAction => ({ kind: "send", action: { type: "start_search" }, label: "Find suppliers", ...(secondary ? { secondary } : {}) });

/** Before a plan is signed: the passkey, the questions, the plan to sign. */
function beforePlan(i: NextStepInput): NextStep {
  const draftId = i.waiting?.kind === "PlanApproval" ? i.waiting.refId : i.thread.latestDraftId;
  if (i.planStatus === "SUBMITTED") return step("plan-saving");
  if (i.planStatus === "REVERTED" && draftId) return step("plan-refused", { kind: "sign", request: { kind: "PlanApproval", refId: draftId, title: PLAN_SIGN_TITLE }, label: "Sign again" });
  if (i.waiting?.kind === "PlanApproval") {
    const request = { kind: "PlanApproval" as const, refId: i.waiting.refId, title: PLAN_SIGN_TITLE };
    return i.passkeyOnDevice ? step("sign-plan", { kind: "sign", request, label: SIGN_PLAN }) : step("key-needed", { kind: "sign", request, label: CREATE_PASSKEY });
  }
  // Signed in this thread, not yet saved: the plan's record catches up in a moment.
  if (draftId) return step("plan-saving");
  if (!i.passkeyOnDevice && !i.passkeyCardDismissed) return step("passkey", { kind: "focus-passkey", label: CREATE_PASSKEY });
  if (i.thread.openQuestion) return step("answer", { kind: "scroll", target: "question", label: "Show me" });
  return step("intake");
}

/** An order exists: its phase decides (UX-PLAN §3 rows ORDER_PENDING to OPERATING). */
function orderStep(o: NonNullable<NextStepInput["order"]>, nowMs: number | null): NextStep | null {
  switch (o.phase) {
    case "binding":
      return step("order-saving");
    case "cooling":
      return step("safety-wait", null, { wait: waitLeft(o.coolingEndsAt, nowMs) });
    case "paying":
      return step("paying");
    case "waiting": {
      const balance = o.balance;
      const amount = balance ? bu(balance.amountMinor) : undefined;
      if (balance?.evidenceHash) {
        return step("pay-balance", { kind: "sign", request: { kind: "MilestoneRelease", refId: o.orderId, title: BALANCE_SIGN_TITLE }, label: PAY_BALANCE }, { balance: amount });
      }
      if (o.goodsArrived) return step("upload", { kind: "scroll", target: "evidence", label: "Show me" });
      return step("in-transit", { kind: "goods-arrived", orderId: o.orderId, label: "Goods arrived" });
    }
    case "done":
      return step("done", { kind: "send", action: { type: "show_cfo", view: "overview" }, label: "How are we doing?" });
    case "unsigned":
    case "replaced":
      return null;
  }
}

/** After the plan is signed: the order, the sign card, the deal form, the pick, the search, the money. */
function afterPlan(i: NextStepInput): NextStep {
  const w = i.waiting;
  if (w?.kind === "PlanApproval") {
    const request = { kind: "PlanApproval" as const, refId: w.refId, title: PLAN_SIGN_TITLE };
    return i.passkeyOnDevice ? step("sign-plan", { kind: "sign", request, label: SIGN_PLAN }) : step("key-needed", { kind: "sign", request, label: CREATE_PASSKEY });
  }
  if (w?.kind === "SupplierApproval") return step("sign-order", { kind: "sign", request: { kind: "SupplierApproval", refId: w.refId, title: ORDER_SIGN_TITLE }, label: SIGN_ORDER });
  const fromOrder = i.order ? orderStep(i.order, i.nowMs) : null;
  if (fromOrder) return fromOrder;
  const t = i.thread;
  if (t.termsFormOpen) return step("deal", { kind: "scroll", target: "terms", label: "Show the form" });
  if (t.pickedSupplierIds.length === 1 && t.pickedSupplierIds[0]) {
    return step("message", { kind: "send", action: { type: "start_terms", supplierId: t.pickedSupplierIds[0] }, label: "I've made a deal" });
  }
  if (t.pickedSupplierIds.length > 1) return step("message", { kind: "scroll", target: "enquiry", label: "Show the message" });
  if (t.latestSearchId) {
    if (i.searchStatus === "READY") return step("pick", { kind: "scroll", target: "candidates", label: "Show the list" });
    if (i.searchStatus === "FAILED") return step("search-failed", { kind: "send", action: { type: "start_search" }, label: "Try again" });
    return step("searching");
  }
  if (i.fundedMinor === "0") return step("funding", findSuppliers(true));
  return step("find", findSuppliers(), { ready: i.readyMinor !== null ? bu(i.readyMinor) : undefined });
}

/**
 * The card a step's button acts on, so the bar can step back while that card is on screen (UX round 3: one filled
 * button per action): the card the bar scrolls to, the passkey card, the card carrying the signature, the order card.
 * A chat action has none (the chip that repeats it is hidden instead).
 */
export type StepTarget =
  | { readonly kind: "scroll"; readonly target: ScrollTarget }
  | { readonly kind: "passkey" }
  | { readonly kind: "sign"; readonly signKind: SignatureKind; readonly refId: string }
  | { readonly kind: "order"; readonly orderId: string };

export function stepTarget(action: NextStepAction | null): StepTarget | null {
  switch (action?.kind) {
    case "scroll":
      return { kind: "scroll", target: action.target };
    case "focus-passkey":
      return { kind: "passkey" };
    case "sign":
      return action.request.kind === "MilestoneRelease"
        ? { kind: "order", orderId: action.request.refId }
        : { kind: "sign", signKind: action.request.kind, refId: action.request.refId };
    case "goods-arrived":
      return { kind: "order", orderId: action.orderId };
    default:
      return null;
  }
}

/**
 * Whether a card's chat button repeats the bar's (the same action type, and for a deal the same supplier): then the
 * card hides it, so the screen shows that action once.
 */
export function repeatsBar(bar: NextStepAction | null, action: BarChatAction): boolean {
  if (bar?.kind !== "send" || bar.action.type !== action.type) return false;
  if (bar.action.type === "start_terms" && action.type === "start_terms") return bar.action.supplierId === action.supplierId;
  return true;
}

/** The one Next step for the founder now. */
export function nextStep(i: NextStepInput): NextStep {
  if (i.planStatus !== "COMMITTED") return beforePlan(i);
  const s = afterPlan(i);
  // Stopped payments override every step after signing (UX-PLAN §3, last row); the stage stays where the journey is.
  if (i.paused) return { ...step("paused"), stage: s.stage };
  return s;
}
