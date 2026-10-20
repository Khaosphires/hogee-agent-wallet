/**
 * The budget behind the REAL guard: every provider call reserves on the redacted request before it is sent and settles
 * after; a refused call never reaches the provider; concurrent calls cannot overshoot; errors keep the reservation.
 */
import { describe, expect, it } from "vitest";
import { MemoryCallSink, handleFor, type ModelRegistry, type ModelRole, type ModelSpec, type Redactor } from "@hogee/agent";
import { APICallError, generateText, streamText } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { budgetedAgentModels } from "../src/runtime/budgeted-models";
import { ModelBudget, ModelBudgetExhaustedError, budgetRefusalIn, type ModelBudgetLimits } from "../src/services/model-budget";
import { regexRedactor } from "./support/agent";

type DoGenerate = NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>["doGenerate"];

const answer = (t: string) => ({
  content: [{ type: "text" as const, text: t }],
  finishReason: { unified: "stop" as const, raw: "end_turn" },
  usage: { inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 2, text: 2, reasoning: undefined } },
  warnings: [],
});

const spec = (role: ModelRole): ModelSpec => ({ role, provider: "anthropic", modelId: "claude-haiku-5-5", registryId: "anthropic:claude-haiku-5-5", family: "claude" });

function setup(doGenerate: DoGenerate, over: Partial<ModelBudgetLimits> = {}, redactor: Redactor = regexRedactor) {
  const model = new MockLanguageModelV4({ provider: "anthropic.messages", modelId: "claude-haiku-5-5", doGenerate });
  const registry: ModelRegistry = { specs: { planner: spec("planner"), reader: spec("reader"), judge: spec("judge") }, handle: (role) => handleFor(spec(role), model) };
  const budget = new ModelBudget({ windowMs: 86_400_000, windowCalls: 100, windowChars: 10_000_000, totalCalls: 1_000, totalChars: 100_000_000, outputReserveChars: 1_000, ...over });
  const sink = new MemoryCallSink();
  const models = () => budgetedAgentModels(registry, budget, { sink, redactor, outboundGuard: () => undefined }, { facilityId: "fac-rina", traceId: "trace-1" });
  const ask = (prompt: string) => {
    const m = models().reader;
    return generateText({ model: m.model, ...m.settings, prompt, maxRetries: 0 });
  };
  return { model, budget, sink, models, ask };
}

describe("budgeted models", () => {
  it("reserves before the provider call and settles to the measured size of the redacted request and answer", async () => {
    const { model, budget, ask } = setup(async () => answer("fine"));
    await ask("Call me on +60 12-345 6789 about the plan.");
    expect(model.doGenerateCalls).toHaveLength(1);
    const call = model.doGenerateCalls[0];
    const sent = JSON.stringify(call?.prompt);
    expect(sent).toContain("<MY_PHONE>"); // the budget sees what the guard lets out, redacted
    const size = (v: unknown) => JSON.stringify(v ?? null).length;
    const measured = sent.length + size(call?.tools) + size(call?.responseFormat) + size([{ type: "text", text: "fine" }]);
    expect(budget.status().total).toEqual({ calls: 1, chars: measured });
  });

  it("refuses a call before it is sent once the budget is used up, and the guard logs the refused call", async () => {
    const { model, budget, sink, models } = setup(async () => answer("ok"), { windowCalls: 1 });
    const m = models().reader; // built while the budget was open
    await generateText({ model: m.model, ...m.settings, prompt: "one", maxRetries: 0 });
    const err = await generateText({ model: m.model, ...m.settings, prompt: "two", maxRetries: 0 }).catch((e: unknown) => e);
    expect(budgetRefusalIn(err)?.scope).toBe("window");
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(sink.records.map((r) => r.outcome)).toEqual(["ok", "error"]);
    expect(budget.status().total.calls).toBe(1);
  });

  it("builds no model (and so logs nothing) when the budget is already used up", async () => {
    const { budget, sink, models } = setup(async () => answer("ok"), { totalCalls: 1 });
    budget.reserve(0);
    expect(() => models()).toThrow(ModelBudgetExhaustedError);
    expect(sink.records).toHaveLength(0);
  });

  it("concurrent calls in flight cannot overshoot the call cap", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { model, budget, models } = setup(async () => {
      await gate;
      return answer("ok");
    }, { windowCalls: 3 });
    const m = models().reader;
    const calls = Array.from({ length: 10 }, (_, i) => generateText({ model: m.model, ...m.settings, prompt: `q${i}`, maxRetries: 0 }).then(() => "ok", (e: unknown) => (budgetRefusalIn(e) ? "refused" : "other")));
    await new Promise((r) => setTimeout(r, 20));
    release();
    const outcomes = await Promise.all(calls);
    expect(outcomes.filter((o) => o === "ok")).toHaveLength(3);
    expect(outcomes.filter((o) => o === "refused")).toHaveLength(7);
    expect(model.doGenerateCalls).toHaveLength(3);
    expect(budget.status().window.calls).toBe(3);
  });

  it("counts every SDK retry as its own call, and a failed call keeps its reservation", async () => {
    const { model, budget, models } = setup(async () => {
      throw new APICallError({ message: "overloaded", url: "http://127.0.0.1/v1/messages", requestBodyValues: {}, statusCode: 529, isRetryable: true });
    });
    const m = models().reader;
    await expect(generateText({ model: m.model, ...m.settings, prompt: "x", maxRetries: 1 })).rejects.toThrow();
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(budget.status().total.calls).toBe(2);
    expect(budget.status().total.chars).toBeGreaterThan(2 * 1_000); // each keeps request + the whole output allowance
  });

  it("a guard refusal (redaction down) reaches neither the budget nor the provider", async () => {
    const down: Redactor = {
      async redact() {
        throw new Error("Presidio is down");
      },
    };
    const { model, budget, ask } = setup(async () => answer("ok"), {}, down);
    await expect(ask("hello")).rejects.toThrow();
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(budget.status().total.calls).toBe(0);
  });

  it("streams: reserves before the call and settles when the stream ends", async () => {
    const model = new MockLanguageModelV4({
      provider: "anthropic.messages",
      modelId: "claude-haiku-5-5",
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "hello" },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage: answer("").usage },
        ]),
      }),
    });
    const registry: ModelRegistry = { specs: { planner: spec("planner"), reader: spec("reader"), judge: spec("judge") }, handle: (role) => handleFor(spec(role), model) };
    const budget = new ModelBudget({ windowMs: 86_400_000, windowCalls: 1, windowChars: 100_000, totalCalls: 10, totalChars: 1_000_000, outputReserveChars: 5_000 });
    const m = budgetedAgentModels(registry, budget, { sink: new MemoryCallSink(), redactor: regexRedactor, outboundGuard: () => undefined }, { facilityId: "fac-rina", traceId: null }).reader;
    const r = streamText({ model: m.model, ...m.settings, prompt: "hi", maxRetries: 0 });
    expect(await r.text).toBe("hello");
    const chars = budget.status().total.chars;
    expect(chars).toBeGreaterThan(0);
    expect(chars).toBeLessThan(5_000); // settled below the reservation
    const errors: unknown[] = [];
    const second = streamText({ model: m.model, ...m.settings, prompt: "again", maxRetries: 0, onError: ({ error }) => void errors.push(error) });
    await second.consumeStream();
    expect(model.doStreamCalls).toHaveLength(1); // the second call never reached the provider
    expect(errors.some((e) => budgetRefusalIn(e) !== null)).toBe(true);
  });
});
