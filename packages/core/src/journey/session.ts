/**
 * How big a chat session may grow (audit run-9 lead 2, chat-session-history-unbounded). Button presses are free of the
 * model budget, so the message count is bounded per session here, the same way by the live API and the mock:
 *   - a session holds at most CHAT_SESSION_MAX_MESSAGES messages. A turn that would pass it (a press or a text turn
 *     stores two) is refused with sessionFullReply: one templated sentence, nothing stored, no model call, no effect;
 *   - reads of the messages themselves (GET /api/chat, the planner's turns) see the newest CHAT_HISTORY_WINDOW only.
 *     The journey's facts never depend on that window: they read the HISTORY_PART_TYPES parts of the whole (capped)
 *     session (history.ts).
 */
import { reply, type JourneyReply } from "./actions";
import { textPart } from "./parts";
import { TEXT } from "./templates";

export const CHAT_SESSION_MAX_MESSAGES = 600;
export const CHAT_HISTORY_WINDOW = 200;

/** A turn adding `adding` messages to a session of `stored` messages would pass the cap. */
export const sessionFull = (stored: number, adding: number): boolean => stored + adding > CHAT_SESSION_MAX_MESSAGES;

/** The reply to a turn in a full session: text only, so nothing in it can be pressed, signed or stored. */
export const sessionFullReply = (): JourneyReply =>
  reply([textPart(TEXT.sessionFull)], `Chat session full (${CHAT_SESSION_MAX_MESSAGES} messages): turn refused, nothing stored`);
