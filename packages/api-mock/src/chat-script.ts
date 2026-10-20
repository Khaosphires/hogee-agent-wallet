/**
 * The canned planner conversation per demo (project.md §4 stages 1–2, §26.6 frozen data parts): three questions, the
 * intent and plan draft, then the shortlist with its red flag. Mei's speaks Singapore and S$ (SG-DECISIONS); Rina's is
 * unchanged. No store import, so the seed can build Mei's seeded chat history from the same turns.
 */
import type { ChatMessage, DataQuestion, IntentSlot, PlanDraft } from "@hogee/core";
import type { MockCountry } from "./profile";

export type ChatPart = ChatMessage["parts"][number];

export interface ChatTurnCtx {
  readonly draft: PlanDraft;
  readonly shortlistRequestId: string;
}

export interface ChatTurn {
  readonly text: string;
  readonly parts: (ctx: ChatTurnCtx) => ChatPart[];
}

export interface ChatScript {
  /** The founder's first message in a seeded history. */
  readonly opener: string;
  readonly turns: readonly ChatTurn[];
  /** The founder's answer after each turn but the last, in a seeded history. */
  readonly replies: readonly string[];
}

const question = (questionId: string, slot: IntentSlot, text: string, options: DataQuestion["options"]): ChatPart => ({
  type: "data-question",
  id: questionId,
  data: { questionId, slot, text, options },
});

const residency = (text: string, country: string, citizen: string): ChatTurn => ({
  text,
  parts: () => [
    question("q-residency", "residency", `What is your residency status in ${country}?`, [
      { value: "citizen", label: citizen },
      { value: "pr", label: "Permanent resident" },
      { value: "foreigner", label: "Foreigner" },
    ]),
  ],
});

const category = (text: string): ChatTurn => ({
  text,
  parts: () => [
    question("q-category", "productCategory", "What kind of product is it?", [
      { value: "drinkware_food_contact", label: "Cups or bottles (they touch food or drink)" },
      { value: "other", label: "Something else" },
    ]),
  ],
});

const budget = (text: string, loan: string, currency: string): ChatTurn => ({
  text,
  parts: () => [
    question("q-budget", "budgetCeilingMinor", `Your loan is ${loan}. Should the plan stay inside that?`, [
      { value: "1000000", label: `Yes, 10,000 BU (loan in ${currency})` },
      { value: "500000", label: "Lower it to 5,000 BU" },
    ]),
  ],
});

const INTENT: ChatTurn = {
  text: "Here's your plan, built by Hogee's code from your answers. Read it, then sign it with your passkey.",
  parts: ({ draft }) => [
    { type: "data-intent", id: "intent-1", data: { intent: draft.intent } },
    { type: "data-plan-draft", id: "plan-draft-1", data: { draftId: draft.draftId } },
  ],
};

const SHORTLIST: ChatTurn = {
  text: "I asked for a supplier shortlist. One listing contains text aimed at AI agents, so it is flagged and blocked; it can't change the ranking.",
  parts: ({ shortlistRequestId }) => [
    { type: "data-shortlist", id: "shortlist-1", data: { requestId: shortlistRequestId } },
    {
      type: "data-redflag",
      id: "redflag-1",
      data: { text: "A supplier listing tells AI agents to rank it first. Instructions found inside listings are ignored.", source: "listing:supplier-c" },
    },
  ],
};

export const CHAT_SCRIPTS: { readonly [C in MockCountry]: ChatScript } = {
  SG: {
    opener: "I want to sell custom insulated tumblers on Shopee Singapore, budget S$10,000",
    turns: [
      residency(
        "Thanks, Mei. Three quick questions so the plan fits you. First: are you a Singapore citizen, a permanent resident, or a foreigner? It decides which business registration you can use.",
        "Singapore",
        "Singapore citizen",
      ),
      category(
        "Got it. Insulated tumblers touch food and drink, so the product rules differ from other goods: Singapore's food agency (SFA) registers importers of food-contact articles. Is that the product?",
      ),
      budget("Last one: you said a budget of S$10,000.", "S$10,000", "SGD"),
      INTENT,
      SHORTLIST,
    ],
    replies: ["I am a Singapore citizen.", "Yes, insulated tumblers.", "Yes, keep the plan within S$10,000.", "Looks right. Please find suppliers."],
  },
  MY: {
    opener: "I want to sell custom insulated tumblers on Shopee, budget RM10,000",
    turns: [
      residency(
        "Thanks, Rina. Three quick questions so the plan fits you. First: are you a Malaysian citizen, a permanent resident, or a foreigner? It decides which business registration you can use.",
        "Malaysia",
        "Malaysian citizen",
      ),
      category("Got it. Insulated tumblers touch food and drink, so the product rules differ from other goods. Is that the product?"),
      budget("Last one: you said a budget of RM10,000.", "RM10,000", "MYR"),
      INTENT,
      SHORTLIST,
    ],
    replies: ["I am a Malaysian citizen.", "Yes, insulated tumblers.", "Yes, keep the plan within RM10,000.", "Looks right. Please find suppliers."],
  },
};

export const CHAT_DONE: ChatTurn = {
  text: "Your plan and shortlist are ready. Use the Plan and Suppliers tabs to review and sign.",
  parts: () => [],
};

/** The whole scripted conversation as a finished history (GET /api/chat/:sessionId), tagged with its session id. */
export function cannedTranscript(country: MockCountry, ctx: ChatTurnCtx, sessionId: string): ChatMessage[] {
  const script = CHAT_SCRIPTS[country];
  const metadata = { sessionId };
  const messages: ChatMessage[] = [{ id: "chat-1", role: "user", metadata, parts: [{ type: "text", text: script.opener }] }];
  script.turns.forEach((turn, i) => {
    messages.push({ id: `chat-${messages.length + 1}`, role: "assistant", metadata, parts: [{ type: "text", text: turn.text }, ...turn.parts(ctx)] });
    const reply = script.replies[i];
    if (reply) messages.push({ id: `chat-${messages.length + 1}`, role: "user", metadata, parts: [{ type: "text", text: reply }] });
  });
  return messages;
}
