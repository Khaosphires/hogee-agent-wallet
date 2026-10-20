/**
 * §26.1 step 1 + VISION-DECISIONS §4, §9: POST /api/chat (founder) and GET /api/chat/:sessionId.
 *
 * A turn passes the rate limits first (per persona chat session, client address and server; 429): free text uses the
 * text bucket, a button's structured action its own bucket. Then:
 *   - text (journey/text.ts): the server's model budget (503 when used up, before the text is redacted, read or
 *     stored) → redaction (down → 502, nothing stored or sent) → the planner while the plan is drafted, else the router
 *     (classifySkill) and core's templated replies;
 *   - an action (journey/actions.ts): no model and no redaction (ids only); single use per session.
 * Every reply is templated text plus data parts that passed ChatDataPart.parse before they were stored; the stored parts
 * are streamed as an AI SDK UI-message stream. GET drops (and traces) a stored part that no longer parses instead of
 * failing the whole history.
 */
import type { ApiDeps, Scope } from "../context";
import { chatAction, chatText } from "../journey/index";
import { readChatHistory } from "../journey/persist";
import { fail } from "../http/problem";
import { ChatRateLimiter, DEFAULT_ACTION_RATE, DEFAULT_CHAT_RATE, clientAddress } from "../http/rate-limit";
import type { RouteGroup } from "../http/register";
import { sessionExists, toChatMessage } from "../services/chat-store";
import { budgetProblem, rateLimited } from "../services/refusals";
import { pool } from "../services/sql";

// Kept here for the eval services (eval-plan, eval-case) that run the planner the way chat does.
export { plannerContext, redactOrFail, replyFor, type Reply } from "../journey/planner";

async function getChat(deps: ApiDeps, scope: Scope, sessionId: string) {
  const db = pool(deps.db);
  if (!(await sessionExists(db, scope, sessionId))) throw fail("NOT_FOUND", "No such chat session");
  return (await readChatHistory(deps, db, scope, sessionId)).map(toChatMessage);
}

/**
 * The chat group of one app. Its rate limiters are per app (so per server): text turns use `deps.config.chatRate`
 * (DEFAULT_CHAT_RATE when absent), actions their own DEFAULT_ACTION_RATE bucket, unless a test injects either.
 */
export function chatRoutes(opts: { readonly limiter?: ChatRateLimiter; readonly actionLimiter?: ChatRateLimiter } = {}): RouteGroup {
  let limiter = opts.limiter;
  let actionLimiter = opts.actionLimiter;
  return {
    chat: async ({ req, deps, scope, persona, c }) => {
      const body = req.body;
      const now = deps.clock();
      // VISION-DECISIONS §5, §9: a button's structured action skips the model and redaction, not the rate limit.
      if ("action" in body) {
        actionLimiter ??= new ChatRateLimiter(DEFAULT_ACTION_RATE);
        const refused = actionLimiter.take({ session: `${persona}|${body.sessionId}`, client: clientAddress(c) }, now);
        if (refused) throw await rateLimited(c, deps, scope, refused, actionLimiter.traceRefusal(now));
        return chatAction(deps, scope, body.sessionId, body.action, persona);
      }
      limiter ??= new ChatRateLimiter(deps.config.chatRate ?? DEFAULT_CHAT_RATE);
      const refusal = limiter.take({ session: `${persona}|${body.sessionId}`, client: clientAddress(c) }, now);
      if (refusal) throw await rateLimited(c, deps, scope, refusal, limiter.traceRefusal(now));
      try {
        deps.agent.budget.assertOpen(); // used up: refuse before the text is redacted, read or stored
        return await chatText(deps, scope, body.sessionId, body.message, persona);
      } catch (error: unknown) {
        throw (await budgetProblem(c, deps, scope, "chat", error)) ?? error;
      }
    },
    getChat: ({ req, deps, scope }) => getChat(deps, scope, req.params.sessionId),
  };
}
