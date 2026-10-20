/**
 * Canned planner conversation for POST /api/chat (project.md §4 stages 1–2, §26.6 frozen data parts), in the served
 * demo's words (chat-script.ts: Mei for SG, Rina for MY). Streams an AI SDK 7 UI-message stream; the history is kept
 * server-side (append-only) for GET /api/chat/:id, which returns the newest CHAT_HISTORY_WINDOW messages. In the fresh
 * and lived SG scenarios typed text runs the chat journey instead (journey/index.ts: the same scripted intake, then core's
 * journey); the default scenario keeps this script, except that a quick or CFO question ("is my money safe?", "what do
 * I do now?", "how are we doing?") gets the journey's templated answer first (mockCannedQuick, first-timer #30). Both
 * stop at core CHAT_SESSION_MAX_MESSAGES (refuseFullSession).
 */
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { CHAT_DONE, CHAT_SCRIPTS } from "./chat-script";
import { journeyTextOn, mockCannedQuick, mockJourneyText, mockSessionFull, refuseFullSession } from "./journey/index";
import { nextId, type ChatSession, type MockState } from "./store";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function chatSession(st: MockState, sessionId: string): ChatSession {
  let session = st.chats.get(sessionId);
  if (!session) {
    session = { messages: [], turn: 0 };
    st.chats.set(sessionId, session);
  }
  return session;
}

/** Streams the next canned turn (or a quick question's template) and appends both messages to the session history. */
export function streamChatTurn(st: MockState, sessionId: string, message: string, delayMs = 18): Response | Promise<Response> {
  if (journeyTextOn(st)) return mockJourneyText(st, sessionId, message, delayMs);
  if (mockSessionFull(st, sessionId)) return refuseFullSession(st, sessionId, "text", delayMs);
  const template = mockCannedQuick(st, sessionId, message, delayMs);
  if (template) return template;
  const session = chatSession(st, sessionId);
  session.messages.push({ id: nextId(st, "msg"), role: "user", parts: [{ type: "text", text: message }] });
  const turn = CHAT_SCRIPTS[st.profile.country].turns[session.turn] ?? CHAT_DONE;
  session.turn += 1;
  const parts = turn.parts({ draft: st.loaded.scenario["plan-draft.json"], shortlistRequestId: st.loaded.scenario["shortlist.json"].requestId });
  const messageId = nextId(st, "msg");
  session.messages.push({ id: messageId, role: "assistant", parts: [{ type: "text", text: turn.text }, ...parts] });

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      writer.write({ type: "start", messageId });
      const textId = `${messageId}-text`;
      writer.write({ type: "text-start", id: textId });
      for (const word of turn.text.split(/(?<= )/)) {
        writer.write({ type: "text-delta", id: textId, delta: word });
        if (delayMs > 0) await sleep(delayMs);
      }
      writer.write({ type: "text-end", id: textId });
      for (const part of parts) writer.write(part as Parameters<typeof writer.write>[0]);
      writer.write({ type: "finish" });
    },
  });
  return createUIMessageStreamResponse({ stream });
}
