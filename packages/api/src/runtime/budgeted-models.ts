/**
 * Puts the model budget (services/model-budget.ts) between the guard and the provider. Each registry handle's provider
 * model is wrapped in a budget middleware, and guardModel then wraps that: the guard audits, redacts and canary-scans
 * the request first, and only a request that passes reaches the budget, which reserves and then calls the provider.
 * So every provider call (each tool-loop step and each SDK retry) is counted on the redacted request it actually
 * sends, and a call the budget refuses never leaves the machine. The guard logs that refused call like any failed one.
 */
import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import { agentModelsForRequest, type AgentModelDeps, type AgentModels, type GuardContext, type ModelRegistry } from "@hogee/agent";
import type { ModelBudget } from "../services/model-budget";

type WrapStream = NonNullable<LanguageModelMiddleware["wrapStream"]>;
type CallParams = Parameters<WrapStream>[0]["params"];
type StreamResult = Awaited<ReturnType<Parameters<WrapStream>[0]["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

/** Stream parts that carry the answer (the guard hashes the same ones). */
const ANSWER_PARTS: ReadonlySet<string> = new Set(["text-delta", "tool-call", "reasoning-delta"]);

const size = (value: unknown): number => JSON.stringify(value ?? null).length;

/** Characters a call sends: the (already redacted) prompt, the tool definitions and the response format. */
export function requestChars(params: CallParams): number {
  return size(params.prompt) + size(params.tools) + size(params.responseFormat);
}

/** Reserve before the provider call, settle with the measured size after; a failed call keeps its reservation. */
export function budgetMiddleware(budget: ModelBudget): LanguageModelMiddleware {
  return {
    wrapGenerate: async ({ doGenerate, params }) => {
      const input = requestChars(params);
      const reservation = budget.reserve(input);
      const result = await doGenerate();
      reservation.settle(input + size(result.content));
      return result;
    },
    wrapStream: async ({ doStream, params }) => {
      const input = requestChars(params);
      const reservation = budget.reserve(input);
      const res = await doStream();
      let output = 0;
      let failed = false;
      const counted = res.stream.pipeThrough(
        new TransformStream<StreamPart, StreamPart>({
          transform(part, controller) {
            if (part.type === "error") failed = true;
            else if (ANSWER_PARTS.has(part.type)) output += size(part);
            controller.enqueue(part);
          },
          flush() {
            if (!failed) reservation.settle(input + output);
          },
        }),
      );
      return { ...res, stream: counted };
    },
  };
}

/** The same registry, with every handle's provider model behind the budget. */
export function budgetedRegistry(registry: ModelRegistry, budget: ModelBudget): ModelRegistry {
  const middleware = budgetMiddleware(budget);
  return {
    specs: registry.specs,
    handle: (role) => {
      const h = registry.handle(role);
      return Object.freeze({ ...h, model: wrapLanguageModel({ model: h.model, middleware }) });
    },
  };
}

/**
 * The guarded planner and reader of one request (agentModelsForRequest), every provider call behind the budget. When
 * the budget is already used up this throws ModelBudgetExhaustedError before any model exists, so the request writes
 * no call log row.
 */
export function budgetedAgentModels(registry: ModelRegistry, budget: ModelBudget, deps: AgentModelDeps, context: GuardContext): AgentModels {
  budget.assertOpen();
  return agentModelsForRequest(budgetedRegistry(registry, budget), deps, context);
}
