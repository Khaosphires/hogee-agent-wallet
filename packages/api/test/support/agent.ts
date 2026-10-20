/**
 * A scripted agent port for tests: AI SDK MockLanguageModelV4 models behind the REAL guard and the REAL model budget
 * (budgetedAgentModels → agentModelsForRequest → guardModel: rules audit, redaction, canary, call log; every provider
 * call reserves from the budget), a regex stand-in for Presidio (synthetic test data only) and a per-world memory key.
 * Each test queues the provider results the next model calls return.
 */
import { randomBytes } from "node:crypto";
import { handleFor, type ModelRegistry, type ModelRole, type ModelSpec, type Redactor } from "@hogee/agent";
import type { RedactionResult } from "@hogee/privacy";
import { MockLanguageModelV4 } from "ai/test";
import type { AgentPort } from "../../src/context";
import { budgetedAgentModels } from "../../src/runtime/budgeted-models";
import { ModelBudget } from "../../src/services/model-budget";

type GenerateResult = Exclude<NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>["doGenerate"], ((...a: never[]) => unknown) | unknown[] | undefined>;

const usage = () => ({
  inputTokens: { total: 12, noCache: 12, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 7, text: 7, reasoning: undefined },
});

let callSeq = 0;
export function toolCall(toolName: string, input: unknown): GenerateResult {
  callSeq += 1;
  return { content: [{ type: "tool-call", toolCallId: `call-${callSeq}`, toolName, input: JSON.stringify(input) }], finishReason: { unified: "tool-calls", raw: "tool_use" }, usage: usage(), warnings: [] };
}

export function text(t: string): GenerateResult {
  return { content: [{ type: "text", text: t }], finishReason: { unified: "stop", raw: "end_turn" }, usage: usage(), warnings: [] };
}

/** Synthetic patterns only (no real person, account or ID). */
const PATTERNS: readonly { type: string; re: RegExp }[] = [
  { type: "MY_NRIC", re: /\b\d{6}-\d{2}-\d{4}\b/g },
  { type: "MY_PHONE", re: /\+?60[ -]?1\d[ -]?\d{3,4}[ -]?\d{4}\b/g },
];

export const regexRedactor: Redactor = {
  async redact(input: string): Promise<RedactionResult> {
    const spans: { type: string; start: number; end: number }[] = [];
    for (const { type, re } of PATTERNS) for (const m of input.matchAll(re)) spans.push({ type, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
    spans.sort((a, b) => a.start - b.start);
    let out = "";
    let at = 0;
    for (const s of spans) {
      out += `${input.slice(at, s.start)}<${s.type}>`;
      at = s.end;
    }
    return { text: out + input.slice(at), report: { entities: spans, count: spans.length } };
  },
};

const failingRedactor: Redactor = {
  async redact() {
    throw new Error("Presidio is down");
  },
};

export interface ScriptedAgent extends AgentPort {
  /** Results the next planner calls return, in order. */
  queue(...results: GenerateResult[]): void;
  readonly calls: () => number;
  /** The serialised prompt of the latest model call (already redacted by the guard). */
  readonly lastPrompt: () => string;
  /** Simulate Presidio being down (every model call and chat write must fail closed). */
  breakRedaction(on: boolean): void;
}

function spec(role: ModelRole): ModelSpec {
  const modelId = role === "planner" ? "claude-sonnet-5-5" : role === "reader" ? "claude-haiku-5-5" : "deepseek-v4-pro";
  const provider = role === "judge" ? "deepseek" : "anthropic";
  return { role, provider, modelId, registryId: `${provider}:${modelId}`, family: role === "judge" ? "deepseek" : "claude" };
}

/** `budget`: the agent's model budget (default: the production defaults, which no test reaches). */
export function scriptedAgent(opts: { readonly budget?: ModelBudget } = {}): ScriptedAgent {
  const budget = opts.budget ?? new ModelBudget();
  const pending: GenerateResult[] = [];
  let calls = 0;
  let broken = false;
  const model = new MockLanguageModelV4({
    provider: "anthropic.messages",
    modelId: "claude-sonnet-5-5",
    doGenerate: async () => {
      calls += 1;
      const next = pending.shift();
      if (!next) throw new Error("no scripted model result left");
      return next;
    },
  });
  const registry: ModelRegistry = {
    specs: { planner: spec("planner"), reader: spec("reader"), judge: spec("judge") },
    handle: (role) => handleFor(spec(role), model),
  };
  const redactor: Redactor = { redact: (t) => (broken ? failingRedactor.redact(t) : regexRedactor.redact(t)) };
  return {
    configured: true,
    memoryKey: randomBytes(32),
    redactor,
    budget,
    models: (context, sink) => budgetedAgentModels(registry, budget, { sink, redactor, outboundGuard: () => undefined }, context),
    queue: (...results) => void pending.push(...results),
    calls: () => calls,
    lastPrompt: () => JSON.stringify(model.doGenerateCalls.at(-1)?.prompt ?? null),
    breakRedaction: (on) => void (broken = on),
  };
}
