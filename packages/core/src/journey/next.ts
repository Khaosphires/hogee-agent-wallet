/**
 * The Next step sentences (UX-PLAN §3): one plain sentence per step, so the web's Next step bar and the server's
 * "what do I do now?" reply say the same words. Three sentences carry a value the browser knows and the server
 * doesn't ({ready}: the amount ready to spend, {wait}: the safety wait left, {balance}: the balance to pay); without
 * the value, fillNextStep uses a plain sentence instead, so nothing ever shows a placeholder. Every sentence passes the
 * wording lint and fits 100 characters once filled (core test journey-next).
 */
import type { JourneyState } from "../schemas/journey";

export const NEXT_STEP_KEYS = [
  "passkey",
  "answer",
  "intake",
  "plan-refused",
  "sign-plan",
  "key-needed",
  "plan-saving",
  "funding",
  "find",
  "search-failed",
  "searching",
  "pick",
  "message",
  "deal",
  "sign-order",
  "order-saving",
  "safety-wait",
  "paying",
  "in-transit",
  "upload",
  "pay-balance",
  "done",
  "paused",
] as const;
export type NextStepKey = (typeof NEXT_STEP_KEYS)[number];

export const NEXT_STEP_TEXT: { readonly [K in NextStepKey]: string } = {
  passkey: "First, set up your passkey. You'll use it to approve things, like Touch ID.",
  answer: "Answer the question above.",
  intake: "Tell me what you sell, where you sell it, and your budget.",
  "plan-refused": "Your plan wasn't saved, and nothing changed. Check it and sign again.",
  "sign-plan": "Read your plan, then sign it with your passkey.",
  "key-needed": "To sign, you need a passkey. Ask your loan officer for your set-up code.",
  "plan-saving": "Saving your signed plan. This takes a few seconds.",
  funding: "Your loan officer is adding the money. You can look for suppliers now.",
  find: "{ready} is ready to spend. Next, find a supplier.",
  "search-failed": "The search didn't finish. Try again, or use the sample supplier list.",
  searching: "Hogee is looking for suppliers. This takes a minute.",
  pick: "Pick the suppliers you like from the list.",
  message: "Send the message to the supplier yourself. When you agree a deal, tell me.",
  deal: "Fill in the deal form, then save and sign it.",
  "sign-order": "Sign the order with your passkey.",
  "order-saving": "Saving your signed order. The safety wait starts next.",
  "safety-wait": "Safety wait: the deposit is paid automatically in {wait}. You can pause payments on the order card.",
  paying: "Paying the deposit now, as you signed.",
  "in-transit": "Deposit paid. When the goods arrive, press Goods arrived.",
  upload: "Take a photo of the goods and the delivery note, or upload an inspector's report.",
  "pay-balance": "Sign to pay the balance of {balance}.",
  done: "Order complete. Ask me how the business is doing any time.",
  paused: "Automatic payments are paused. To turn them back on, you and your loan officer must both agree.",
};

/** The sentence to use when a value is unknown (the server's reply, or the browser before the number loads). */
const WITHOUT_VALUE: { readonly [K in NextStepKey]?: string } = {
  find: "Your plan is active. Next, find a supplier.",
  "safety-wait": "Safety wait: then the deposit is paid automatically. You can pause payments on the order card.",
  "pay-balance": "Sign to pay the balance.",
};

export interface NextStepValues {
  /** The amount ready to spend, formatted ("4,000 BU"). */
  readonly ready?: string;
  /** The safety wait left, formatted ("0:09"). */
  readonly wait?: string;
  /** The balance to pay, formatted ("1,750 BU"). */
  readonly balance?: string;
}

const SLOT = /\{(ready|wait|balance)\}/g;

/** The sentence of a step with its values; a missing value means the plain sentence, never a placeholder. */
export function fillNextStep(key: NextStepKey, values: NextStepValues = {}): string {
  const text = NEXT_STEP_TEXT[key];
  const missing = [...text.matchAll(SLOT)].some((m) => !values[m[1] as keyof NextStepValues]);
  if (missing) return WITHOUT_VALUE[key] ?? text;
  return text.replace(SLOT, (_, slot: keyof NextStepValues) => values[slot] ?? "");
}

/**
 * The step the server can name from the journey's facts alone (no passkey on this device, no balances, no delivery
 * check): the stage's row of the plan's table. The browser's bar refines it (lib/next-step.ts). As the bar, a pause
 * overrides every step once the plan is committed (UX-PLAN §3, last row; rcfix-journey A-7).
 */
export function stageNextStep(state: JourneyState): NextStepKey {
  if (state.facts.paused === true && state.facts.planStatus === "COMMITTED") return "paused";
  return stageRow(state);
}

function stageRow(state: JourneyState): NextStepKey {
  const f = state.facts;
  switch (state.stage) {
    case "INTAKE":
      return "intake";
    case "NEEDS_REVIEW":
      return f.planStatus === "REVERTED" ? "plan-refused" : "sign-plan";
    case "FOUNDER_KEY_PENDING":
      return "key-needed";
    case "PLAN_PENDING":
      return "plan-saving";
    case "PLAN_ACTIVE":
      return f.search?.status === "FAILED" ? "search-failed" : "find";
    case "SEARCHING":
      return "searching";
    case "CANDIDATES":
      return "pick";
    case "PICKED":
      return "message";
    case "TERMS_DRAFT":
      return "deal";
    case "TERMS_CONFIRMED":
      return "sign-order";
    case "ORDER_PENDING":
      return "order-saving";
    case "COOLING":
      return "safety-wait";
    case "OPERATING":
      return f.order?.balancePaid === true ? "done" : f.order?.firstPaid ? "in-transit" : "paying";
  }
}

/** The server's "what next" sentence: "Next: " and the stage's step. */
export const nextStepText = (state: JourneyState): string => `Next: ${fillNextStep(stageNextStep(state))}`;
