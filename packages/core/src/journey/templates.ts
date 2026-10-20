/**
 * Every founder-facing sentence of the chat journey (VISION-DECISIONS §4, §9). No model text is ever shown: replies are
 * these templates plus data parts. Seller names and listing titles never appear here, because text parts are fed back
 * to the model (api chat-store turnOf); they travel only in data parts or over REST. Plain, warm and short; every
 * string passes the wording lint (core test journey-templates).
 */
import type { CfoView, JourneyStage, TermsPreset } from "../schemas/enums";
import type { ChatAction } from "../schemas/journey";
import type { JourneyFailure } from "./effects";

/** The base sentence of each stage (stateText adds the variants that depend on facts). */
export const STAGE_TEXT: { readonly [S in JourneyStage]: string } = {
  INTAKE: "Tell me what you sell, where you sell it, and your budget. I'll list what your business needs. Then you approve it.",
  NEEDS_REVIEW: "Here's your plan. Read it, then sign it with your passkey.",
  FOUNDER_KEY_PENDING: "Your plan is ready to sign. First you need a passkey, and your loan officer must approve it. The sign button shows you how.",
  PLAN_PENDING: "Your plan is signed. It's being saved to the public record now. When that's done, I can find suppliers.",
  PLAN_ACTIVE:
    "Your plan is active. Next, let's find suppliers. A separate AI reads each web page. It can't move money, and nothing written on a page can either.",
  SEARCHING: "I'm looking for suppliers now. I check each page before I rank it.",
  CANDIDATES:
    "These suppliers passed my checks. They come from the web and are unverified: nobody has checked who they are yet. Pick one or more, and I'll write a message for you to send.",
  PICKED: 'When you and a supplier agree on a price and how to pay, tell me. For example: "I went with #2, 30% deposit, 70% on delivery."',
  TERMS_DRAFT:
    "Fill in the deal form: how the payment is split, how many units, the total price, and the supplier's company bank account. Then press Save and sign.",
  TERMS_CONFIRMED: "Your deal is saved. Now sign the order with your passkey. This lets your wallet pay this supplier, and only on the schedule you saw.",
  ORDER_PENDING: "Your order is signed and is being saved to the public record. Then a short safety wait starts. You can still pause payments during it.",
  COOLING:
    "Your wallet can now pay this supplier. First comes a short safety wait. You or your loan officer can pause payments during it. After the wait, the deposit is paid automatically. The balance waits for you.",
  OPERATING: "The safety wait is over. The deposit is paid automatically, within your rules. The balance waits for the delivery check and your passkey.",
};

export const TEXT = {
  planRefused: "Your plan wasn't saved, so nothing changed. Check it below and sign again.",
  searchFailed: "The supplier search didn't finish, so nothing was ranked. Try again, or use Hogee's sample supplier list.",
  catalog: "This is Hogee's sample supplier list, not a web search. You approve these suppliers on the Suppliers page.",
  firstPaid: "The deposit was paid automatically, within your rules. The balance waits until the goods arrive, you upload the delivery check, and you sign.",
  bindFailed:
    "Your order didn't go through, so nothing was paid and that money is free again. You can't order from this supplier again here. Please choose another one.",
  alreadyDone: "That's already done.",
  stale: "That list is out of date.",
  notYet: "That step isn't open yet.",
  needPlanFirst: "First, let's agree your plan and sign it.",
  searchStarted: "I'm looking for suppliers now. I check each page before I rank it.",
  catalogReady: "Here is Hogee's sample supplier list instead. It is not a web search.",
  catalogWaiting: "I've asked for the sample supplier list. It will show below.",
  stillSearching: "Still looking. The list shows here when it's ready.",
  enquiry: "Here is your message. Copy it and send it yourself. Hogee never sends messages for you. When you agree on a price and how to pay, tell me.",
  catalogPick: "Suppliers from the sample list are approved on the Suppliers page. To use a web supplier, search the web again.",
  termsForm: "Here is the deal form. Choose how the payment is split. Enter how many units, the total price and the supplier's company bank account. Then press Save and sign.",
  termsPreset: "I've filled in that split. Now enter how many units, the total price and the supplier's company bank account. Then press Save and sign.",
  termsPresetCheck: "I've filled in that split. At the listed price, it might go over your wallet's limits. The form checks this when you enter the total.",
  termsFromText: "I've filled in the deal you told me about. Check it, add the total price and the supplier's company bank account, then press Save and sign.",
  termsNoSplit: "I didn't catch how the payment is split. Please pick one in the form.",
  termsQuestion: "One question: do you pay the deposit when you order, or when the goods ship? Pick a split below, or type it again.",
  whichSupplier: 'Which supplier did you go with? Pick it in the list, or type its number, like: "went with #2".',
  noSuchRank: "I can't find that number in your latest list.",
  termsLocked: "This supplier's order is already signed, so the deal can't change here.",
  termsSaved: "Your deal is saved. Sign the order with your passkey. Then your wallet can pay this supplier.",
  termsMissing: "I can't find that saved deal. Here's where you are.",
  planSigned: "Signed. I'm saving your plan to the public record now.",
  planLive: "Signed. Your plan is now active.",
  orderSigned: "Signed. I'm saving your order to the public record now.",
  releaseSigned: "Signed. The balance is paid once it's saved.",
  orderComplete: "Order complete: the deposit and the balance are paid. Ask me how the business is doing any time.",
  signatureNotSeen: "I don't see that signature yet. If you've just signed, give it a moment.",
  signatureNoted: "Thanks. I'll tell you when it's saved.",
  cfoLater: "Once your plan is active, I can show you your numbers.",
  findSuppliers: "I can look for suppliers for you. Press the button when you're ready.",
  pickByNumber: "Here's that pick. Press the button to confirm it.",
  pickInList: "Pick the suppliers you like in the list.",
  planInfo: "Your signed plan sets every pocket and limit. You can see it on the Plan page. To change it, you sign a new plan.",
  help: "I can help you plan your budget, find suppliers, record the deals you make, and show your numbers. Money only moves by the rules you signed.",
  outOfScope: "I can't do that from the chat. Payments follow the rules you signed: the deposit can go automatically, and everything else waits for you.",
  sessionFull: "This conversation is full, so I can't add to it. Choose Clear this chat in the menu at the top to start a fresh one. Your plan, order and money stay.",
  // Quick replies (quick.ts, UX-PLAN D5): templates only, filled from the journey state, never model text.
  safetyBeforePlan: "Nothing can be paid yet. Money only moves after you sign your plan with your passkey, and then only inside its limits. Hogee never sends messages for you.",
  safety:
    "Your money is protected in three ways. Your wallet can only pay who and what your signed plan allows, up to its limits. A new supplier waits through a safety wait first, and the balance needs the delivery check and your passkey. You or your loan officer can pause all automatic payments at any time.",
  supplier: "The suppliers' names and web pages are on the list below. Copy your message and send it to them yourself. Hogee never sends messages for you.",
  supplierBeforeSearch: "You haven't picked a supplier yet. Press Find suppliers when you're ready.",
  supplierOrder: "Your supplier's name is on the order card below. Hogee never sends messages for you.",
  // The mock's canned scenarios (default, Malaysia): their seeded orders are not in the chat's own history.
  supplierPage: "Your suppliers, and what each order has paid, are on the Suppliers page. Hogee never sends messages for you.",
  // "What do I do now?" before the questions, without a passkey: the Next step bar's first step (first-timer #1, #3).
  nextPasskey: "Next: set up your passkey with the set-up code from your loan officer. No code yet? Press Later and tell me what you sell.",
  // "What did the AI pay by itself?" (first-timer #27, #30): what is always true, and where the count is.
  aiBeforePlan: "Nothing yet. Hogee's AI can't pay anyone until you sign your plan. Then it pays only inside the limits you signed.",
  ai: "Hogee's AI pays only what your signed plan allows: who gets paid, what for, and how much. It can make a limit stricter, never looser. Every payment it made by itself is listed in the Wallet, under Activity.",
  aiDeposit: "Your supplier's deposit was paid automatically, as you signed.",
} as const;

/** Founder-facing sentence for a failed effect (search refused, catalog unavailable, ...). */
export const FAILURE_TEXT: { readonly [F in JourneyFailure]: string } = {
  NO_PLAN: "Your plan isn't active yet, so I can't search. Try again once it's saved.",
  BUSY: "A search is already running, or you searched a moment ago. Try again in a minute.",
  BUDGET: "I've used up today's AI reading limit, so I can't read web pages right now. Hogee's sample supplier list still works.",
  NOT_FOUND: "I can't find that supplier in your latest list.",
  UNAVAILABLE: "That step couldn't run just now. Try again shortly.",
};

/** What the founder asked to see, one sentence per CFO view. */
export const CFO_TEXT: { readonly [V in CfoView]: string } = {
  overview: "Here is how the business is doing, from your own records.",
  spending: "Here is what each pocket has spent.",
  sales: "Here are your sales so far.",
  pnl: "Here is your profit or loss: the money in, minus the money out.",
  forecast: "Here is my best guess at what comes next, and how I worked it out.",
  reserve: "Here is the money kept for your tax.",
};

/** The user-message text stored for a pressed button when no data-next label matches (journey-client mirrors it). */
export function actionLabel(action: ChatAction): string {
  switch (action.type) {
    case "start_search":
      return "Find suppliers";
    case "use_catalog":
      return "Use the sample list";
    case "show_candidates":
      return "Show the suppliers";
    case "pick":
      return action.supplierIds.length === 1 ? "Pick 1 supplier" : `Pick ${action.supplierIds.length} suppliers`;
    case "start_terms":
      return "Fill in the deal";
    case "terms_saved":
      return "Deal saved";
    case "signed":
      return "Signed";
    case "show_cfo":
      return CFO_BUTTON[action.view];
  }
}

/** Button labels (≤ 40 characters, data-next). */
export const BUTTON = {
  findSuppliers: "Find suppliers",
  retrySearch: "Try the search again",
  useCatalog: "Use the sample list",
  searchWebAgain: "Search the web again",
  agreedTerms: "I've made a deal",
  reopenTerms: "Open the deal form again",
  showSuppliers: "Show the suppliers",
} as const;

export const agreedTermsWith = (rank: number | null, position: number): string =>
  rank === null ? `I made a deal (pick ${position})` : `I made a deal with #${rank}`;

export const pickRanksLabel = (ranks: readonly number[]): string =>
  ranks.length === 1 ? `Pick #${ranks[0]}` : `Pick ${ranks.slice(0, -1).map((r) => `#${r}`).join(", ")} and #${ranks.at(-1)}`;

export const CFO_BUTTON: { readonly [V in CfoView]: string } = {
  overview: "How are we doing?",
  spending: "Show spending",
  sales: "Show sales",
  pnl: "Show profit and loss",
  forecast: "Show the forecast",
  reserve: "Show my tax money",
};

/** The clarifying-question buttons (one per preset). */
export const PRESET_BUTTON: { readonly [P in TermsPreset]: string } = {
  P30_70: "30% on order, 70% after delivery",
  P50_50: "Half on order, half after delivery",
  P0_100: "All after the delivery check",
  P30_40_30: "30% order, 40% shipment, 30% delivery",
};

/** Inline signature cards (data-sign). */
export const SIGN = {
  plan: { title: "Sign your plan", summary: "Sign the plan with your passkey. Its pockets and limits become rules your wallet must follow.", cta: "Sign the plan" },
  supplier: {
    title: "Sign the order",
    summary:
      "Sign with your passkey. Your wallet may then pay this supplier, but only on the schedule you saved. A short safety wait comes first, and you can still pause payments during it.",
    cta: "Sign the order",
  },
} as const;

/** The base sentence of a stage (STUB signature kept). */
export function stageText(stage: JourneyStage): string {
  return STAGE_TEXT[stage];
}
