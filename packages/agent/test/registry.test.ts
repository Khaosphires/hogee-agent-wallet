import { describe, expect, it } from "vitest";
import { generateText, isStepCount, tool } from "ai";
import { z } from "zod";
import { ModelConfigError, createModelRegistry, resolveModelSpecs } from "../src/models/registry";
import { auditCallOptions, callSettingsFor, classifyStop } from "../src/models/rules";
import { ModelRuleViolationError } from "../src/guard/guarded-model";
import { anthropicReply, fakeAnthropic, guarded, specFor } from "./helpers/mock-model";

const KEY_SENTINEL = "sk-test-sentinel-not-a-real-key";

describe("resolveModelSpecs: provider and model selection from env", () => {
  it("defaults to Claude 5.5 (Sonnet planner, Haiku reader) and a DeepSeek judge (different family)", () => {
    const s = resolveModelSpecs({});
    expect(s.planner).toMatchObject({ provider: "anthropic", modelId: "claude-sonnet-5-5", registryId: "anthropic:claude-sonnet-5-5" });
    expect(s.reader).toMatchObject({ provider: "anthropic", modelId: "claude-haiku-5-5" });
    expect(s.judge).toMatchObject({ provider: "deepseek", modelId: "deepseek-v4-pro" });
    expect(s.judge.family).not.toBe(s.planner.family);
  });

  it("switches every role with MODEL_PROVIDER (China fallback)", () => {
    const d = resolveModelSpecs({ MODEL_PROVIDER: "deepseek" });
    expect([d.planner.registryId, d.reader.registryId, d.judge.registryId]).toEqual([
      "deepseek:deepseek-v4-pro",
      "deepseek:deepseek-flash",
      "qwen:qwen3-max",
    ]);
    const q = resolveModelSpecs({ MODEL_PROVIDER: "qwen" });
    expect(q.planner.registryId).toBe("qwen:qwen3-max");
    expect(q.judge.family).not.toBe(q.planner.family);
  });

  it("takes per-role overrides, with an optional provider prefix (Ollama names keep their colon)", () => {
    const s = resolveModelSpecs({ PLANNER_MODEL: "claude-sonnet-5-5", READER_MODEL: "ollama:qwen3.5:4b", JUDGE_MODEL: "qwen:qwen-plus" });
    expect(s.reader).toMatchObject({ provider: "ollama", modelId: "qwen3.5:4b", registryId: "ollama:qwen3.5:4b" });
    expect(s.judge).toMatchObject({ provider: "qwen", modelId: "qwen-plus" });
    expect(s.planner.registryId).toBe("anthropic:claude-sonnet-5-5");
  });

  it("treats an empty override as unset (the .env template ships JUDGE_MODEL=)", () => {
    expect(resolveModelSpecs({ JUDGE_MODEL: "", PLANNER_MODEL: "  " }).judge.registryId).toBe("deepseek:deepseek-v4-pro");
  });

  it("rejects an unknown provider, an empty model id and a judge from the planner's family", () => {
    expect(() => resolveModelSpecs({ MODEL_PROVIDER: "openai" })).toThrow(ModelConfigError);
    expect(() => resolveModelSpecs({ PLANNER_MODEL: "anthropic:" })).toThrow(ModelConfigError);
    expect(() => resolveModelSpecs({ READER_MODEL: "bad id with spaces" })).toThrow(ModelConfigError);
    expect(() => resolveModelSpecs({ JUDGE_MODEL: "anthropic:claude-haiku-5-5" })).toThrow(/different model family/);
  });
});

describe("ollama privacy mode keeps every role local (security audit run-3)", () => {
  it("rejects a role override that resolves to a cloud provider, naming the local spelling", () => {
    expect(() => resolveModelSpecs({ MODEL_PROVIDER: "ollama", READER_MODEL: "qwen:7b" })).toThrow(/privacy mode.*ollama:qwen:7b/);
    expect(() => resolveModelSpecs({ MODEL_PROVIDER: "ollama", PLANNER_MODEL: "anthropic:claude-sonnet-5-5" })).toThrow(ModelConfigError);
    expect(() => resolveModelSpecs({ MODEL_PROVIDER: "ollama", JUDGE_MODEL: "deepseek:deepseek-v4-pro" })).toThrow(ModelConfigError);
    expect(() => createModelRegistry({ MODEL_PROVIDER: "ollama", READER_MODEL: "qwen:7b", DASHSCOPE_API_KEY: KEY_SENTINEL })).toThrow(/privacy mode/);
  });

  it("the defaults and an explicit ollama: prefix stay local", () => {
    const d = resolveModelSpecs({ MODEL_PROVIDER: "ollama" });
    expect([d.planner.provider, d.reader.provider, d.judge.provider]).toEqual(["ollama", "ollama", "ollama"]);
    expect(resolveModelSpecs({ MODEL_PROVIDER: "ollama", READER_MODEL: "ollama:qwen:7b" }).reader).toMatchObject({ provider: "ollama", modelId: "qwen:7b" });
  });

  it("OLLAMA_ALLOW_CLOUD=1 (and only 1) opts in to a cloud role", () => {
    expect(resolveModelSpecs({ MODEL_PROVIDER: "ollama", OLLAMA_ALLOW_CLOUD: "1", JUDGE_MODEL: "deepseek:deepseek-v4-pro" }).judge.provider).toBe("deepseek");
    expect(() => resolveModelSpecs({ MODEL_PROVIDER: "ollama", OLLAMA_ALLOW_CLOUD: "true", READER_MODEL: "qwen:7b" })).toThrow(ModelConfigError);
  });

  it("other modes may still pick a local reader", () => {
    expect(resolveModelSpecs({ READER_MODEL: "ollama:qwen3.5:4b" }).reader.provider).toBe("ollama");
  });
});

describe("createModelRegistry", () => {
  it("fails fast when a needed key is missing, naming the variable but never a value", () => {
    const err = (() => {
      try {
        createModelRegistry({ DEEPSEEK_API_KEY: KEY_SENTINEL });
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(ModelConfigError);
    expect(String((err as Error).message)).toContain("ANTHROPIC_API_KEY");
    expect(String((err as Error).message)).not.toContain(KEY_SENTINEL);
  });

  it("refuses a non-loopback OLLAMA_BASE_URL (privacy mode must stay on this machine)", () => {
    const env = { ANTHROPIC_API_KEY: KEY_SENTINEL, DEEPSEEK_API_KEY: KEY_SENTINEL, READER_MODEL: "ollama:qwen3.5:4b" };
    expect(() => createModelRegistry({ ...env, OLLAMA_BASE_URL: "http://10.0.0.5:11434" })).toThrow(/loopback/);
    const ok = createModelRegistry({ ...env, OLLAMA_BASE_URL: "http://localhost:11434" });
    expect(ok.handle("reader").spec.provider).toBe("ollama");
  });

  it("checks the eval judge's key lazily (the API needs only planner and reader keys)", () => {
    const r = createModelRegistry({ ANTHROPIC_API_KEY: KEY_SENTINEL });
    expect(r.handle("reader").spec.registryId).toBe("anthropic:claude-haiku-5-5");
    expect(() => r.handle("judge")).toThrow(/DEEPSEEK_API_KEY/);
    expect(() => createModelRegistry({ ANTHROPIC_API_KEY: KEY_SENTINEL }, { require: ["judge"] })).toThrow(ModelConfigError);
  });

  it("builds one handle per role with settings from the single rules table", () => {
    const r = createModelRegistry({ ANTHROPIC_API_KEY: KEY_SENTINEL, DEEPSEEK_API_KEY: KEY_SENTINEL });
    const planner = r.handle("planner");
    expect(planner.spec.registryId).toBe("anthropic:claude-sonnet-5-5");
    expect(planner.settings).toEqual(callSettingsFor(planner.spec));
    expect(JSON.stringify(r.specs)).not.toContain(KEY_SENTINEL);
  });
});

describe("Claude 5.5 rules (enforced in one place)", () => {
  it("planner: thinking between_tools, no sampling params, no forced tool choice; reader: outputFormat", () => {
    const p = callSettingsFor(specFor("planner"));
    expect(p.providerOptions).toEqual({ anthropic: { thinking: { type: "between_tools" }, effort: "medium" } });
    const r = callSettingsFor(specFor("reader"));
    expect(r.providerOptions).toEqual({ anthropic: { structuredOutputMode: "outputFormat", effort: "low" } });
    expect(auditCallOptions(p)).toEqual([]);
    expect(auditCallOptions(r)).toEqual([]);
    expect(Object.keys(p)).not.toEqual(expect.arrayContaining(["temperature"]));
  });

  it("OpenAI-compatible roles get no Anthropic options and no sampling params", () => {
    const s = callSettingsFor(specFor("reader", "deepseek", "deepseek-flash"));
    expect(s.providerOptions).toBeUndefined();
    expect(auditCallOptions(s)).toEqual([]);
  });

  it("the audit catches every forbidden setting (negative controls)", () => {
    const negatives: unknown[] = [
      { temperature: 0.2 },
      { topP: 0.9 },
      { topK: 5 },
      { toolChoice: "required" },
      { toolChoice: { type: "required" } },
      { toolChoice: { type: "tool", toolName: "proposePlanIntent" } },
      { tool_choice: { type: "any" } },
      { providerOptions: { anthropic: { thinking: { type: "disabled" } } } },
    ];
    for (const n of negatives) expect(auditCallOptions(n), JSON.stringify(n)).toHaveLength(1);
    expect(auditCallOptions({ toolChoice: { type: "auto" } })).toEqual([]);
  });

  it("classifyStop maps HTTP 200 + stop_reason refusal (and content-filter) to REFUSAL", () => {
    expect(classifyStop({ rawFinishReason: "refusal", finishReason: "stop" })).toBe("REFUSAL");
    expect(classifyStop({ finishReason: "content-filter" })).toBe("REFUSAL");
    expect(classifyStop({ rawFinishReason: "end_turn" })).toBe("OK");
    expect(classifyStop({ finishReason: "tool-calls" })).toBe("TOOL_USE");
    expect(classifyStop({ rawFinishReason: "max_tokens" })).toBe("MAX_TOKENS");
  });
});

describe("guarded model on the Anthropic wire (fake fetch, no network)", () => {
  const fx = {
    getFx: tool({
      description: "Read-only FX lookup",
      inputSchema: z.object({ pair: z.string() }),
      execute: async () => ({ value: "0.61" }),
    }),
  };

  it("sends thinking between_tools and no sampling params; step 2 is append-only", async () => {
    const { provider, sent } = fakeAnthropic([
      anthropicReply("claude-sonnet-5-5", [{ type: "tool_use", id: "toolu_1", name: "getFx", input: { pair: "CNY/MYR" } }], "tool_use"),
      anthropicReply("claude-sonnet-5-5", [{ type: "text", text: "done" }], "end_turn"),
    ]);
    const { guarded: g } = guarded({ ...createHandleFromProvider(provider) });
    await generateText({ model: g.model, ...g.settings, instructions: "x", prompt: "rate?", tools: fx, stopWhen: isStepCount(3) });
    expect(sent).toHaveLength(2);
    for (const { body } of sent) {
      expect(body.thinking).toEqual({ type: "between_tools" });
      expect(auditCallOptions(body)).toEqual([]);
    }
    const [m1, m2] = sent.map((s) => s.body.messages as unknown[]);
    expect(m2?.slice(0, m1?.length)).toEqual(m1);
  });

  it("blocks a call that sets temperature or forces a tool, before anything is sent", async () => {
    const { provider, sent } = fakeAnthropic([anthropicReply("claude-sonnet-5-5", [{ type: "text", text: "x" }], "end_turn")]);
    const { guarded: g } = guarded(createHandleFromProvider(provider));
    await expect(generateText({ model: g.model, ...g.settings, prompt: "hi", temperature: 0.2, maxRetries: 0 })).rejects.toThrow(ModelRuleViolationError);
    await expect(
      generateText({ model: g.model, ...g.settings, prompt: "hi", tools: fx, toolChoice: "required", maxRetries: 0 }),
    ).rejects.toThrow(ModelRuleViolationError);
    expect(sent).toHaveLength(0);
  });
});

function createHandleFromProvider(provider: ReturnType<typeof fakeAnthropic>["provider"]) {
  const spec = specFor("planner");
  return { spec, model: provider(spec.modelId), settings: callSettingsFor(spec) };
}
