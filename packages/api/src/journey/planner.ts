/**
 * The intake text path (§26.1 step 1, kept from routes/chat.ts): while the plan is being drafted (INTAKE,
 * NEEDS_REVIEW, FOUNDER_KEY_PENDING) the founder's REDACTED text goes to the planner behind the real guard; code turns
 * its outcome into TEMPLATED parts (questions, plan explanation, refusals): no model text is shown. A plan reply is the
 * explanation + data-intent + data-plan-draft + data-needs (core buildNeeds over the stored draft and its pack; left
 * out, never invented, when it cannot be built) + data-sign{PlanApproval} (VISION-DECISIONS §4).
 * Memory only ever holds a founder's own template answer (an enumerated option value), signed, with its message id.
 */
import { runPlannerTurn, type MemoryEntry, type PlanExplanation, type PlannerOutcome, type PlannerTurn } from "@hogee/agent";
import { PACK_FACT_MISSING, buildNeeds, needsPart, planSignPart, type JourneyPart, type PlanDraft } from "@hogee/core";
import type { ApiDeps, Scope } from "../context";
import { fail } from "../http/problem";
import { answeredSlot, insertMemory, lastQuestions, llmCallSink, readMemory, turnOf, userTurnMemory, type StoredMessage } from "../services/chat-store";
import { compileEnv, packFor, storeDraft } from "../services/compile";
import { requireFacility } from "../services/facility";
import { newId } from "../services/ids";
import { inTx, pool } from "../services/sql";
import { appendTrace } from "../services/traces";
import { persistTurn, type NewChatMessage } from "./persist";
import { streamParts } from "./stream";

type Part = Record<string, unknown>;

const TEXT = {
  questions: "A few quick questions first.",
  secret: "I can't share prompts, keys or internal settings. I can help you plan your budget.",
  refusal: "I can't help with that. I can help you plan your budget.",
  rejected: "I couldn't turn that into a plan yet. Tell me what you sell, where you sell it, and your budget.",
  compileFailed: "That plan doesn't fit your loan's rules yet. Could you change the budget or the product?",
  packIncomplete: "I can't build this plan yet. Some country rules it needs are missing, and I won't guess them.",
  planNext: "Read it below, then sign it with your passkey.",
} as const;

/**
 * The plan reply (UX-PLAN REWRITES A2.59-A2.64): the explainer's total, budget releases and the most the AI could
 * pay, then what to do next. The per-pocket sentences stay out of the bubble: the card below shows each pocket.
 */
const CARD_SHOWS: ReadonlySet<string> = new Set(["plan.line", "plan.pacing", "plan.payees"]);
export const planReplyText = (ex: PlanExplanation): string => [...ex.sentences.filter((s) => !CARD_SHOWS.has(s.templateId)).map((s) => s.text), TEXT.planNext].join(" ");

/** Trace summaries are ≤500 characters (TraceEvent.summary). */
const SUMMARY_MAX = 500;

export async function redactOrFail(deps: ApiDeps, text: string): Promise<string> {
  try {
    const r = await deps.agent.redactor.redact(text);
    if (typeof r?.text !== "string") throw new Error("malformed redaction result");
    return r.text;
  } catch {
    deps.log.warn("redaction_unavailable", { route: "chat" });
    throw fail("UPSTREAM", "Privacy redaction is unavailable, so nothing was stored or sent. Try again shortly.");
  }
}

export interface Reply {
  readonly parts: Part[];
  readonly summary: string;
  readonly reasonCode?: string;
}

const text = (t: string): Part => ({ type: "text", text: t });

export function replyFor(o: PlannerOutcome): Reply {
  switch (o.kind) {
    case "questions":
      return {
        parts: [text(TEXT.questions), ...o.questions.map((q) => ({ type: "data-question", id: q.questionId, data: q }))],
        summary: `Planner asked ${o.questions.length} templated question(s): ${o.questions.map((q) => q.slot).join(", ")}`,
        ...(o.decision.rationale.reasonCode ? { reasonCode: o.decision.rationale.reasonCode } : {}),
      };
    case "plan":
      return {
        parts: [
          text(planReplyText(o.explanation)),
          { type: "data-intent", id: `intent-${o.draft.draftId}`, data: { intent: o.intent } },
          { type: "data-plan-draft", id: o.draft.draftId, data: { draftId: o.draft.draftId } },
        ],
        summary: `Planner proposed a plan intent; code compiled draft ${o.draft.draftId} (blast radius ${o.draft.blastRadiusMinor} minor)`,
      };
    case "refused":
      return { parts: [text(o.reason === "SECRET_REQUEST" ? TEXT.secret : TEXT.refusal)], summary: `Planner turn refused (${o.reason})`, reasonCode: o.reason };
    case "rejected": {
      // A pack gap is not the founder's to fix: say so, and record the missing leaves in the trace for the data owner.
      const gap = o.missingFacts ? `: ${PACK_FACT_MISSING}:${o.missingFacts.join(",")}` : "";
      const reply = o.reason !== "COMPILE_FAILED" ? TEXT.rejected : o.missingFacts ? TEXT.packIncomplete : TEXT.compileFailed;
      return {
        parts: [text(reply)],
        summary: `Planner proposal not used (${o.reason}${gap})`.slice(0, SUMMARY_MAX),
        reasonCode: o.decision.rationale.reasonCode ?? o.reason,
      };
    }
  }
}

export async function plannerContext(deps: ApiDeps, scope: Scope) {
  const env = await compileEnv(deps, scope);
  const pack = await packFor(deps, env.facility.countryCode);
  return {
    facility: env.facility,
    countryPack: pack,
    now: env.now,
    ids: { draftId: newId("draft"), planId: env.planId, agentAddress: env.agent.toLowerCase() as `0x${string}` },
    ...(env.current ? { current: env.current } : {}),
    ...(env.current && env.currentIntent ? { currentIntent: env.currentIntent } : {}),
  };
}

/**
 * The plan reply's journey cards: the needs checklist (core buildNeeds over the compiled draft and the pack it was
 * compiled with; left out, never invented, when it cannot vouch for it) and the PlanApproval card.
 */
async function planCards(deps: ApiDeps, scope: Scope, draft: PlanDraft): Promise<JourneyPart[]> {
  try {
    const [facility, pack] = await Promise.all([requireFacility(pool(deps.db), scope), packFor(deps, draft.manifest.countryCode)]);
    return [needsPart(buildNeeds(draft, pack, { reserveFloorBps: Number(facility.reserve_floor_bps) })), planSignPart(draft.draftId)];
  } catch (e: unknown) {
    deps.log.warn("needs_unavailable", { draftId: draft.draftId, error: e instanceof Error ? e.name : "ERROR" });
    return [planSignPart(draft.draftId)];
  }
}

/**
 * One planner turn. `history` is the session so far (invalid stored parts already dropped), `redacted` the founder's
 * message after redaction.
 */
export async function plannerTurn(deps: ApiDeps, scope: Scope, sessionId: string, redacted: string, history: readonly StoredMessage[]): Promise<Response> {
  await requireFacility(pool(deps.db), scope);
  const userId = newId("msg");
  const answer = answeredSlot(redacted, lastQuestions(history));
  const remembered: MemoryEntry | undefined = answer ? userTurnMemory(deps, scope, sessionId, userId, answer) : undefined;
  const memory = [...(await readMemory(deps, scope)), ...(remembered ? [remembered] : [])];
  const turns: PlannerTurn[] = [...history.map(turnOf).filter((t): t is PlannerTurn => t !== undefined), { role: "user", text: redacted }];
  const traceId = newId("trace");
  const models = deps.agent.models({ facilityId: scope.facilityId, traceId }, llmCallSink(deps));
  const outcome = await runPlannerTurn({ turns: turns.slice(-60), context: await plannerContext(deps, scope) }, { model: models.planner, memory });
  const reply = replyFor(outcome);
  const cards = outcome.kind === "plan" ? await planCards(deps, scope, outcome.draft) : [];
  const parts = [...reply.parts, ...cards] as Part[];
  const assistantId = newId("msg");
  await inTx(deps.db, async (q) => {
    const messages: NewChatMessage[] = [
      { id: userId, role: "user", parts: [text(redacted)] },
      { id: assistantId, role: "assistant", parts },
    ];
    await persistTurn(q, scope, sessionId, messages, outcome.kind === "plan" ? outcome.intent : undefined);
    if (outcome.kind === "plan") await storeDraft(q, scope, outcome.draft, { sessionId });
    if (remembered) await insertMemory(q, remembered);
    for (const llmCallId of outcome.decision.rationale.llmCallIds) {
      await appendTrace(q, { facilityId: scope.facilityId, traceId, actor: "planner", kind: "LLM_CALL", summary: "Planner model call (redacted prompt; hashes in llm_calls)", refs: { llmCallId } });
    }
    await appendTrace(q, {
      facilityId: scope.facilityId,
      traceId,
      actor: "planner",
      kind: "PROPOSAL",
      summary: reply.summary,
      ...(reply.reasonCode ? { reasonCode: reply.reasonCode } : {}),
      refs: { decisionId: outcome.decision.rationale.decisionId },
    });
  });
  return streamParts(assistantId, parts);
}
