/**
 * Planner turn (project.md §4 stage 1-2, §7.1, §7.2): chat → clarifying questions → proposePlanIntent → compilePlan.
 *
 * Plan-then-execute: the model may call read-only tools, then ends its turn with ONE terminal proposal (no `execute`):
 * askClarifyingQuestions (slots) or proposePlanIntent (a PlanIntent). Deterministic code then acts:
 *   - questions → templated `data-question` parts (questions.ts);
 *   - intent → zod + grounding (grounding.ts: the budget must be what the founder said) → @hogee/core compilePlan,
 *     which builds every amount, cap, payee, stage and rule and checks the constitution;
 *   - a refusal (HTTP 200 + stop_reason "refusal") → `refused`; two malformed proposals (the SDK feeds the first error
 *     back once, append-only) → `rejected`; plain text → `rejected` (model text is never shown).
 * A request for prompts or keys (T30) is refused by code before any model call. Every outcome carries a rationale and
 * its salted hash, citing the LLM call-log ids, so the decision is auditable.
 */
import { generateText, isStepCount, type ModelMessage, type StopCondition } from "ai";
import { z } from "zod";
import {
  CompileError,
  PackFactMissingError,
  ZERO_HEX32,
  compilePlan,
  constitutionOk,
  detectImperativeText,
  formatBu,
  hashObject,
  planHash,
  type CommittedPlan,
  type CompileFacility,
  type CompileIds,
  type CountryPack,
  type DataQuestion,
  type IntentSlot,
  type PlanDraft,
  type PlanIntent,
  type UnixSeconds,
} from "@hogee/core";
import { explainPlanDraft, type PlanExplanation } from "../explainer/explainer";
import { assertGuardedModel, type GuardedModel } from "../guard/guarded-model";
import { defaultRandomBytes, rationaleCommitment, uuidV7, type RandomBytes, type RationaleCommitment } from "../hash";
import { renderMemoryBlock, type MemoryEntry } from "../memory/memory";
import { classifyStop } from "../models/rules";
import { groundIntent, type PlannerTurn } from "./grounding";
import { PLANNER_INSTRUCTIONS } from "./instructions";
import { questionsFor } from "./questions";
import { ASK_TOOL, PROPOSE_TOOL, plannerTools, type PlannerPorts } from "./tools";

export type { PlannerTurn } from "./grounding";

export const PLANNER_MAX_STEPS = 6;
/** The first malformed proposal is fed back once; the second ends the turn. */
export const PLANNER_MAX_INVALID_CALLS = 2;

export interface PlannerContext {
  readonly facility: CompileFacility;
  readonly countryPack: CountryPack;
  /** Commit time for the draft, unix seconds. */
  readonly now: UnixSeconds | bigint;
  readonly ids: CompileIds;
  /** For a replan: the committed plan it replaces. */
  readonly current?: CommittedPlan;
  /** For a replan: the intent the committed plan was compiled from (compilePlan keeps what the new intent does not change). */
  readonly currentIntent?: PlanIntent;
}

export interface PlannerDeps {
  /** A model guardModel created, with role "planner" (anything else throws UnguardedModelError). */
  readonly model: GuardedModel;
  readonly ports?: PlannerPorts;
  /** Verified memory entries (verifyMemory). Entries of any other facility than `context.facility` are dropped. */
  readonly memory?: readonly MemoryEntry[];
  readonly randomBytes?: RandomBytes;
  readonly clockMs?: () => number;
  /** false withholds the country-pack tool (E2 `no_pack` ablation, /api/eval/plan only). Default true. */
  readonly countryPackTool?: boolean;
  /** Aborts every model call of the turn (the /api/eval/* deadline). Absent: no caller deadline. */
  readonly abortSignal?: AbortSignal;
}

export interface PlannerInput {
  /** Append-only conversation; the last turn is the founder's new message. Already redacted text is fine. */
  readonly turns: readonly PlannerTurn[];
  readonly context: PlannerContext;
}

export type PlannerOutcomeKind = "PLAN_INTENT" | "QUESTIONS" | "REFUSED" | "REJECTED";

export interface PlannerRationale {
  readonly schema: "hogee.rationale.v1";
  readonly decisionId: string;
  readonly actor: "planner";
  readonly kind: PlannerOutcomeKind;
  readonly model: string;
  readonly llmCallIds: readonly string[];
  readonly promptHashes: readonly string[];
  readonly reasonCode?: string;
  readonly slots?: readonly IntentSlot[];
  readonly intentHash?: string;
  readonly draftId?: string;
  readonly planHash?: string;
  readonly blastRadiusMinor?: string;
  readonly constitutionOk?: boolean;
  readonly grounding?: { readonly budgetCeilingMinor: string };
  readonly templateIds: readonly string[];
}

type Decision = RationaleCommitment<PlannerRationale>;

export type PlannerOutcome =
  | { readonly kind: "questions"; readonly questions: readonly DataQuestion[]; readonly decision: Decision }
  | { readonly kind: "plan"; readonly intent: PlanIntent; readonly draft: PlanDraft; readonly explanation: PlanExplanation; readonly decision: Decision }
  | { readonly kind: "refused"; readonly reason: "MODEL_REFUSAL" | "SECRET_REQUEST"; readonly decision: Decision }
  | {
      readonly kind: "rejected";
      readonly reason: "MALFORMED_INTENT" | "NO_PROPOSAL" | "COMPILE_FAILED";
      readonly detail: string;
      readonly decision: Decision;
      /** COMPILE_FAILED only: the country-pack leaves the intent needs and the pack lacks (PACK_FACT_MISSING). */
      readonly missingFacts?: readonly string[];
    };

export class PlannerInputError extends Error {
  override readonly name = "PlannerInputError";
}

const Turns = z
  .array(z.strictObject({ role: z.enum(["user", "assistant"]), text: z.string().min(1).max(8_000) }))
  .min(1)
  .max(60)
  .refine((t) => t.at(-1)?.role === "user", "the last turn must be the founder's");

function contextBlock(ctx: PlannerContext, memory: readonly MemoryEntry[]): string {
  const f = ctx.facility;
  const lines = [
    "<context>",
    `Facility country: ${f.countryCode}. Currency: ${f.currency}. Facility limit: ${formatBu(f.capMinor)} (1 BU = 1 ${f.currency}).`,
    ...(memory.length > 0 ? [renderMemoryBlock(memory)] : []),
    "</context>",
  ];
  return lines.join("\n");
}

/** Only this facility's memory reaches the prompt, whatever the caller passed (security audit run-3). */
function facilityMemory(memory: readonly MemoryEntry[] | undefined, ctx: PlannerContext): MemoryEntry[] {
  return (memory ?? []).filter((e) => e.facilityId === ctx.facility.facilityId);
}

function toMessages(turns: readonly PlannerTurn[], ctx: PlannerContext, memory: readonly MemoryEntry[]): ModelMessage[] {
  return turns.map((t, i): ModelMessage => {
    if (t.role === "assistant") return { role: "assistant", content: t.text };
    if (i < turns.length - 1) return { role: "user", content: t.text };
    return { role: "user", content: [{ type: "text", text: contextBlock(ctx, memory) }, { type: "text", text: t.text }] };
  });
}

interface CallLike {
  readonly toolName: string;
  readonly input: unknown;
  readonly invalid: boolean;
}
interface StepLike {
  readonly refused: boolean;
  readonly calls: readonly CallLike[];
}

function callsOf(toolCalls: readonly unknown[]): CallLike[] {
  return toolCalls.flatMap((c) => {
    if (typeof c !== "object" || c === null) return [];
    const x = c as { toolName?: unknown; input?: unknown; invalid?: unknown };
    return typeof x.toolName === "string" ? [{ toolName: x.toolName, input: x.input, invalid: x.invalid === true }] : [];
  });
}
const invalidCount = (steps: readonly { readonly toolCalls: readonly unknown[] }[]): number => steps.flatMap((s) => callsOf(s.toolCalls)).filter((c) => c.invalid).length;

type Decide = (r: Omit<PlannerRationale, "schema" | "decisionId" | "actor" | "model" | "llmCallIds" | "promptHashes">) => Decision;

/**
 * One Planner turn. Throws PlannerInputError on bad input or a model of the wrong role, UnguardedModelError on a model
 * guardModel did not create; never throws on model output.
 */
export async function runPlannerTurn(input: PlannerInput, deps: PlannerDeps): Promise<PlannerOutcome> {
  const turns = Turns.safeParse(input.turns);
  if (!turns.success) throw new PlannerInputError(turns.error.issues[0]?.message ?? "invalid turns");
  const g = deps.model;
  assertGuardedModel(g, "the Planner");
  if (g.spec.role !== "planner") throw new PlannerInputError(`the Planner needs a planner model, got ${g.spec.role}`);
  const randomBytes = deps.randomBytes ?? defaultRandomBytes;
  const decisionId = uuidV7((deps.clockMs ?? Date.now)(), randomBytes);
  const before = g.records.length;
  const decide: Decide = (r) => {
    const calls = g.records.slice(before);
    return rationaleCommitment<PlannerRationale>(
      { schema: "hogee.rationale.v1", decisionId, actor: "planner", model: g.spec.registryId, llmCallIds: calls.map((c) => c.id), promptHashes: calls.map((c) => c.promptHash), ...r },
      randomBytes,
    );
  };

  if (detectImperativeText(turns.data.at(-1)?.text ?? "").some((f) => f.flag === "SECRET_REQUEST")) {
    return { kind: "refused", reason: "SECRET_REQUEST", decision: decide({ kind: "REFUSED", reasonCode: "SECRET_REQUEST", templateIds: [] }) };
  }

  const tools = plannerTools(input.context.countryPack, deps.ports, { countryPackTool: deps.countryPackTool !== false });
  const stopOnInvalid: StopCondition<typeof tools> = ({ steps }) => invalidCount(steps) >= PLANNER_MAX_INVALID_CALLS;
  const res = await generateText({
    model: g.model,
    ...g.settings,
    instructions: PLANNER_INSTRUCTIONS,
    messages: toMessages(turns.data, input.context, facilityMemory(deps.memory, input.context)),
    tools,
    stopWhen: [isStepCount(PLANNER_MAX_STEPS), stopOnInvalid],
    ...(deps.abortSignal ? { abortSignal: deps.abortSignal } : {}),
  });
  const steps: StepLike[] = res.steps.map((s) => ({
    refused: classifyStop({ rawFinishReason: s.rawFinishReason, finishReason: s.finishReason }) === "REFUSAL",
    calls: callsOf(s.toolCalls),
  }));
  return interpret(steps, { turns: turns.data, context: input.context, g, before, decisionId, decide });
}

interface InterpretCtx {
  readonly turns: readonly PlannerTurn[];
  readonly context: PlannerContext;
  readonly g: GuardedModel;
  readonly before: number;
  readonly decisionId: string;
  readonly decide: Decide;
}

/** Deterministic: turn the model's steps into an outcome. Only the FINAL step's valid terminal call counts. */
function interpret(steps: readonly StepLike[], x: InterpretCtx): PlannerOutcome {
  if (steps.some((s) => s.refused)) {
    return { kind: "refused", reason: "MODEL_REFUSAL", decision: x.decide({ kind: "REFUSED", reasonCode: "MODEL_REFUSAL", templateIds: [] }) };
  }
  const finalCalls = (steps.at(-1)?.calls ?? []).filter((c) => !c.invalid);
  const ask = finalCalls.find((c) => c.toolName === ASK_TOOL);
  const propose = finalCalls.find((c) => c.toolName === PROPOSE_TOOL);
  const askQuestions = (slots: readonly IntentSlot[], reasonCode?: string): PlannerOutcome => {
    const questions = questionsFor(slots, x.context.facility.countryCode, x.decisionId);
    const used = questions.map((q) => q.slot);
    return { kind: "questions", questions, decision: x.decide({ kind: "QUESTIONS", slots: used, templateIds: used.map((s) => `question.${s}`), ...(reasonCode ? { reasonCode } : {}) }) };
  };
  if (ask) return askQuestions((ask.input as { slots: IntentSlot[] }).slots);
  if (!propose) {
    const malformed = steps.flatMap((s) => s.calls).filter((c) => c.invalid).length >= PLANNER_MAX_INVALID_CALLS;
    const reason = malformed ? "MALFORMED_INTENT" : "NO_PROPOSAL";
    const detail = malformed ? "the proposal failed validation twice" : "the model ended its turn without a proposal";
    return { kind: "rejected", reason, detail, decision: x.decide({ kind: "REJECTED", reasonCode: reason, templateIds: [] }) };
  }
  const grounded = groundIntent(propose.input, x.turns, x.context.facility);
  if (!grounded.ok) {
    if (grounded.slots.length > 0) return askQuestions(grounded.slots, grounded.reason);
    return { kind: "rejected", reason: "MALFORMED_INTENT", detail: grounded.reason, decision: x.decide({ kind: "REJECTED", reasonCode: grounded.reason, templateIds: [] }) };
  }
  return compileOutcome(grounded.intent, grounded.budgetSource, x.context, x.g, x.before, x.decide);
}

function compileOutcome(
  intent: PlanIntent,
  budgetSource: string,
  context: PlannerContext,
  g: GuardedModel,
  before: number,
  decide: Decide,
): PlannerOutcome {
  const proposingCall = g.records.slice(before).at(-1);
  let draft: PlanDraft;
  try {
    draft = compilePlan({
      intent,
      countryPack: context.countryPack,
      facility: context.facility,
      now: context.now,
      ids: context.ids,
      // NFRA (二十一) AI-generated-content label: planner model + the hash of the redacted request that proposed it.
      aigc: { model: g.spec.registryId, promptHash: proposingCall?.promptHash ?? ZERO_HEX32 },
      ...(context.current ? { current: context.current } : {}),
      ...(context.current && context.currentIntent ? { currentIntent: context.currentIntent } : {}),
    });
  } catch (e) {
    if (!(e instanceof CompileError)) throw e;
    const missing = e instanceof PackFactMissingError ? { missingFacts: e.leaves } : {};
    return {
      kind: "rejected",
      reason: "COMPILE_FAILED",
      detail: e.code,
      ...missing,
      decision: decide({ kind: "REJECTED", reasonCode: e.code, intentHash: hashObject(intent), templateIds: [] }),
    };
  }
  const explanation = explainPlanDraft(draft);
  const decision = decide({
    kind: "PLAN_INTENT",
    intentHash: hashObject(intent),
    draftId: draft.draftId,
    planHash: planHash(draft.manifest),
    blastRadiusMinor: draft.blastRadiusMinor,
    constitutionOk: constitutionOk(draft.constitutionReport),
    grounding: { budgetCeilingMinor: budgetSource },
    templateIds: explanation.sentences.map((s) => s.templateId),
  });
  return { kind: "plan", intent, draft, explanation, decision };
}
