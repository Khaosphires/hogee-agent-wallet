/**
 * Claude 5.5 call rules (project.md §7.1), in ONE place. `scripts/smoke-models.ts` proved each against the live API
 * (15 Oct 2026); the guard (src/guard/guarded-model.ts) re-audits every outgoing call with `auditCallOptions`.
 *
 * - never set temperature, top_p or top_k (Sonnet 5.5 returns 400; Haiku 5.5 only accepts fixed values);
 * - never force a tool (`toolChoice` required / a named tool): 400 on Sonnet 5.5;
 * - never `thinking: disabled|enabled`; the Planner sends `{type:"between_tools"}` (effort low/medium/high only),
 *   the Reader leaves thinking out (adaptive default);
 * - no assistant prefill; conversations are append-only;
 * - HTTP 200 + stop_reason "refusal" is a refusal (AI SDK 7: finishReason "content-filter", raw "refusal").
 *
 * DeepSeek, Qwen and Ollama go through the OpenAI-compatible provider. They get the same "no sampling params, no
 * forced tool" rule (one uniform team rule) and no provider options.
 */
import type { AnthropicLanguageModelOptions } from "@ai-sdk/anthropic";
import type { ModelRole, ModelSpec } from "./registry";

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export interface CallSettings {
  readonly maxOutputTokens: number;
  /** JSON-typed for the AI SDK; each literal below is checked with `satisfies AnthropicLanguageModelOptions`. */
  readonly providerOptions?: { readonly anthropic: { readonly [k: string]: Json } };
}

const MAX_OUTPUT: { readonly [R in ModelRole]: number } = { planner: 4096, reader: 2048, judge: 2048 };

/** The ONLY place call settings are built. Never add temperature/topP/topK/toolChoice here. */
export function callSettingsFor(spec: Pick<ModelSpec, "role" | "provider">): CallSettings {
  const maxOutputTokens = MAX_OUTPUT[spec.role];
  if (spec.provider !== "anthropic") return { maxOutputTokens };
  switch (spec.role) {
    case "planner":
      return { maxOutputTokens, providerOptions: { anthropic: { thinking: { type: "between_tools" }, effort: "medium" } satisfies AnthropicLanguageModelOptions } };
    case "reader":
      return { maxOutputTokens, providerOptions: { anthropic: { structuredOutputMode: "outputFormat", effort: "low" } satisfies AnthropicLanguageModelOptions } };
    case "judge":
      return { maxOutputTokens, providerOptions: { anthropic: { effort: "low" } satisfies AnthropicLanguageModelOptions } };
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const SAMPLING_KEYS = new Set(["temperature", "topP", "topK", "top_p", "top_k"]);

/**
 * Every rule violation in `o`. Works on AI SDK settings / call options (camelCase) and on wire bodies (snake_case),
 * at any depth (provider options included).
 */
export function auditCallOptions(o: unknown, path = ""): string[] {
  if (!isObj(o)) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    const p = path ? `${path}.${k}` : k;
    if (SAMPLING_KEYS.has(k) && v !== undefined) out.push(`${p} is set`);
    if ((k === "toolChoice" || k === "tool_choice") && v !== undefined) {
      const choice = isObj(v) ? v.type : v;
      if (choice !== "auto" && choice !== "none") out.push(`${p} forces tool use`);
    }
    if (k === "thinking" && isObj(v) && (v.type === "disabled" || v.type === "enabled")) out.push(`${p}.type=${String(v.type)}`);
    out.push(...auditCallOptions(v, p));
  }
  return out;
}

export type StopClass = "OK" | "TOOL_USE" | "REFUSAL" | "MAX_TOKENS" | "OTHER";

/** Raw provider stop reason wins; the AI SDK's unified finishReason is the fallback (as in smoke-models.ts). */
export function classifyStop(r: { readonly rawFinishReason?: string | undefined; readonly finishReason?: string | undefined }): StopClass {
  switch (r.rawFinishReason) {
    case "refusal":
      return "REFUSAL";
    case "end_turn":
    case "stop_sequence":
    case "stop":
      return "OK";
    case "tool_use":
    case "tool_calls":
      return "TOOL_USE";
    case "max_tokens":
    case "length":
    case "model_context_window_exceeded":
      return "MAX_TOKENS";
    default:
      break;
  }
  switch (r.finishReason) {
    case "content-filter":
      return "REFUSAL";
    case "stop":
      return "OK";
    case "tool-calls":
      return "TOOL_USE";
    case "length":
      return "MAX_TOKENS";
    default:
      return "OTHER";
  }
}
