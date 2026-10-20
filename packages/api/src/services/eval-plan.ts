/**
 * E2 plan quality and E4 clarifying questions (project.md §15): POST /api/eval/plan runs the SHIPPED planner turn
 * (@hogee/agent runPlannerTurn: guarded model, redaction, grounding, @hogee/core compilePlan) on a dataset prompt, as
 * a NEW founder's first plan (no committed plan to replan against), and answers its questions the way the dataset says
 * the founder would (LABELING.md §2.4):
 *   - a question for the prompt's hiddenSlot gets the slot's true value (evals/datasets/e2/hidden-answers.jsonl);
 *   - any other question gets "it's in my first message" (an unnecessary question, E4);
 *   - ablation `no_questions` (and `no_pack`, which is single-shot) declines every question instead;
 *   - ablation `no_pack` also withholds the planner's country-pack tool (code still compiles with the verified pack,
 *     because the frozen response is a compiled PlanDraft).
 * Founder text is redacted before the planner sees it (fail closed), every model call is logged to llm_calls, and the
 * run is traced. Nothing is stored as a draft, so an eval plan can never be signed (PlanApproval needs a stored draft).
 * At most EVAL_PLAN_MAX_TURNS planner turns (each ≤ PLANNER_MAX_STEPS model calls) bound the cost of one request.
 */
import { runPlannerTurn, type PlannerContext, type PlannerOutcome, type PlannerTurn } from "@hogee/agent";
import { PACK_FACT_MISSING, type CountryCode, type DataQuestion, type EvalAblation, type IntentSlot, type PlanDraft, type PlanIntent } from "@hogee/core";
import type { Address } from "viem";
import type { ApiDeps, Scope } from "../context";
import { fail } from "../http/problem";
import { redactOrFail, replyFor } from "../routes/chat";
import { converter } from "../routes/plans";
import { llmCallSink, turnOf } from "./chat-store";
import { compileEnv, packFor } from "./compile";
import { newId, randomBytes32 } from "./ids";
import { appendEvalTrace } from "./traces";

export const EVAL_PLAN_MAX_TURNS = 4;
export const ALREADY_SAID = "That's already in my first message.";
export const DECLINE_ALL = "I can't answer questions right now. Please assume sensible defaults and propose the plan.";

export interface EvalPlanBody {
  readonly promptId: string;
  readonly text: string;
  readonly model: string;
  readonly repeat: number;
  readonly ablation?: EvalAblation;
}

export interface EvalPlanOutput {
  readonly intent: PlanIntent;
  readonly draft: PlanDraft;
  readonly turns: number;
}

interface HiddenSlot {
  readonly slot: IntentSlot;
  readonly answer: string;
}

/** The founder's scripted reply to a round of templated questions. Pure. */
export function autoAnswer(questions: readonly DataQuestion[], hidden: HiddenSlot | null, declineAll: boolean): string {
  if (declineAll) return DECLINE_ALL;
  const asked = hidden !== null && questions.some((q) => q.slot === hidden.slot);
  if (!asked) return ALREADY_SAID;
  return questions.length > 1 ? `${hidden.answer}. ${ALREADY_SAID.replace("That's", "The rest is")}` : hidden.answer;
}

/** The configured planner is the model under test: `model` must name it ("claude-sonnet-5-5" or "anthropic:claude-sonnet-5-5"). */
export function isPlannerModel(spec: { readonly modelId: string; readonly registryId: string }, model: string): boolean {
  return model === spec.modelId || model === spec.registryId;
}

/** A new founder's first-plan context in `country`: the facility as the chain holds it, converted for another country. */
async function firstPlanContext(deps: ApiDeps, scope: Scope, country: CountryCode): Promise<PlannerContext> {
  const env = await compileEnv(deps, scope, { firstPlan: true });
  const pack = await packFor(deps, country);
  let facility = env.facility;
  if (country !== env.facility.countryCode) {
    let convert: (minor: string) => string;
    try {
      convert = await converter(deps, env.facility.currency, pack.currency);
    } catch (error: unknown) {
      deps.log.warn("eval_plan_fx_unavailable", { pair: `${env.facility.currency}/${pack.currency}`, error });
      throw fail("NOT_FOUND", `No sourced FX rate ${env.facility.currency}/${pack.currency} is available for a ${country} prompt`);
    }
    facility = { ...env.facility, countryCode: country, currency: pack.currency, capMinor: convert(env.facility.capMinor), payees: [] };
  }
  return { facility, countryPack: pack, now: env.now, ids: { draftId: newId("draft"), planId: randomBytes32() as `0x${string}`, agentAddress: env.agent.toLowerCase() as Address } };
}

function noPlan(o: PlannerOutcome, turns: number): never {
  const reason = o.kind === "questions" ? "STILL_ASKING" : o.kind === "refused" ? o.reason : o.kind === "rejected" ? o.reason : "UNKNOWN";
  const missingFacts = o.kind === "rejected" && o.missingFacts ? [...o.missingFacts] : null;
  const gap = missingFacts ? `; ${PACK_FACT_MISSING}:${missingFacts.join(",")}` : "";
  throw fail("COMPILE_FAILED", `No plan after ${turns} planner turn(s): the planner ${o.kind === "questions" ? "was still asking" : o.kind} (${reason}${gap})`, {
    details: { reason: "NO_PLAN", outcome: o.kind, reasonCode: o.decision.rationale.reasonCode ?? reason, turns, ...(missingFacts ? { missingFacts } : {}) },
  });
}

export async function evalPlan(deps: ApiDeps, scope: Scope, body: EvalPlanBody, signal?: AbortSignal): Promise<EvalPlanOutput> {
  const found = await deps.catalog.e2Prompt(body.promptId);
  if (!found) throw fail("NOT_FOUND", `No E2 prompt ${body.promptId} in evals/datasets/e2/prompts.jsonl`);
  if (found.row.text.trim() !== body.text.trim()) throw fail("VALIDATION", "text differs from the dataset row of this promptId (labels are written for that text)");
  const declineAll = body.ablation !== undefined;
  const hiddenSlot = found.row.hiddenSlot;
  if (hiddenSlot && found.hiddenAnswer === null && !declineAll) {
    throw fail("NOT_FOUND", `No hidden-slot answer for ${body.promptId} (${hiddenSlot}) in evals/datasets/e2/hidden-answers.jsonl`);
  }
  const hidden = hiddenSlot && found.hiddenAnswer !== null ? { slot: hiddenSlot, answer: found.hiddenAnswer } : null;
  const traceId = newId("trace");
  const models = deps.agent.models({ facilityId: scope.facilityId, traceId }, llmCallSink(deps));
  if (!isPlannerModel(models.planner.spec, body.model)) {
    throw fail("VALIDATION", `This server's planner is ${models.planner.spec.registryId}; start the API with PLANNER_MODEL=${body.model} to evaluate that model`);
  }
  const context = await firstPlanContext(deps, scope, found.row.country);
  const turns: PlannerTurn[] = [{ role: "user", text: await redactOrFail(deps, body.text) }];
  const tag = `[eval E2 ${body.promptId} r${body.repeat}${body.ablation ? ` ${body.ablation}` : ""}]`;
  for (let turn = 1; ; turn += 1) {
    signal?.throwIfAborted();
    const outcome = await runPlannerTurn({ turns, context }, { model: models.planner, countryPackTool: body.ablation !== "no_pack", ...(signal ? { abortSignal: signal } : {}) });
    await traceTurn(deps, scope, traceId, tag, outcome);
    if (outcome.kind === "plan") return { intent: outcome.intent, draft: outcome.draft, turns: turn };
    if (outcome.kind !== "questions" || turn >= EVAL_PLAN_MAX_TURNS) noPlan(outcome, turn);
    const asked = turnOf({ id: "q", seq: 0, role: "assistant", parts: replyFor(outcome).parts });
    if (asked) turns.push(asked);
    turns.push({ role: "user", text: await redactOrFail(deps, autoAnswer(outcome.questions, hidden, declineAll)) });
  }
}

async function traceTurn(deps: ApiDeps, scope: Scope, traceId: string, tag: string, o: PlannerOutcome): Promise<void> {
  const r = o.decision.rationale;
  for (const llmCallId of r.llmCallIds) {
    await appendEvalTrace(deps.db, { facilityId: scope.facilityId, traceId, actor: "planner", kind: "LLM_CALL", summary: `${tag} planner model call (redacted prompt; hashes in llm_calls)`, refs: { llmCallId } });
  }
  await appendEvalTrace(deps.db, {
    facilityId: scope.facilityId,
    traceId,
    actor: "planner",
    kind: "PROPOSAL",
    summary: `${tag} planner turn → ${o.kind}${o.kind === "questions" ? ` (${o.questions.map((q) => q.slot).join(", ")})` : ""}; nothing stored or signed`,
    ...(r.reasonCode ? { reasonCode: r.reasonCode } : {}),
    refs: { decisionId: r.decisionId },
  });
}
