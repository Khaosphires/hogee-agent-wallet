/**
 * Test helpers: AI SDK v7 mock language model results, a capturing call sink and a synthetic regex redactor.
 * No network: every model here is `MockLanguageModelV4` from `ai/test` or an Anthropic provider over a fake fetch.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { MockLanguageModelV4 } from "ai/test";
import type { RedactionResult } from "@hogee/privacy";
import { handleFor, type ModelHandle, type ModelRole, type ModelSpec, type ProviderId } from "../../src/models/registry";
import { guardModel, type GuardedModel } from "../../src/guard/guarded-model";
import type { LlmCallRecord } from "../../src/guard/call-log";
import type { Redactor } from "../../src/guard/redaction";

type GenerateResult = Exclude<NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>["doGenerate"], ((...a: never[]) => unknown) | unknown[] | undefined>;

export const usage = (input = 12, output = 7) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

export function textResult(text: string): GenerateResult {
  return { content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "end_turn" }, usage: usage(), warnings: [] };
}

let callSeq = 0;
export function toolCallResult(toolName: string, input: unknown, raw = JSON.stringify(input)): GenerateResult {
  callSeq += 1;
  return {
    content: [{ type: "tool-call", toolCallId: `call-${callSeq}`, toolName, input: raw }],
    finishReason: { unified: "tool-calls", raw: "tool_use" },
    usage: usage(),
    warnings: [],
  };
}

/** Claude 5.5 classifier block: HTTP 200, stop_reason "refusal" (AI SDK: finishReason content-filter). */
export function refusalResult(): GenerateResult {
  return { content: [], finishReason: { unified: "content-filter", raw: "refusal" }, usage: usage(5, 0), warnings: [] };
}

export function mockModel(results: GenerateResult[], modelId = "claude-sonnet-5-5"): MockLanguageModelV4 {
  return new MockLanguageModelV4({ provider: "anthropic.messages", modelId, doGenerate: results });
}

export function specFor(role: ModelRole, provider: ProviderId = "anthropic", modelId?: string): ModelSpec {
  const id = modelId ?? (role === "planner" ? "claude-sonnet-5-5" : "claude-haiku-5-5");
  return { role, provider, modelId: id, registryId: `${provider}:${id}`, family: provider };
}

export function mockHandle(role: ModelRole, model: MockLanguageModelV4, provider: ProviderId = "anthropic"): ModelHandle {
  return handleFor(specFor(role, provider, model.modelId), model);
}

/** Every value a call sink received, in order. */
export class CapturingSink {
  readonly records: LlmCallRecord[] = [];
  record(r: LlmCallRecord): void {
    this.records.push(r);
  }
}

// ---- synthetic PII (test data only: no real person, account or ID) --------------------------------------------
export const CANARY = {
  myKad: "900101-14-5678",
  nik: "3171010101900001",
  phoneMy: "+60 12-345 6789",
  phoneId: "+62 812 3456 7890",
  bank: "1234567890123",
} as const;

const PATTERNS: readonly { type: string; re: RegExp }[] = [
  { type: "MY_NRIC", re: /\b\d{6}-\d{2}-\d{4}\b/g },
  { type: "ID_NIK", re: /\b\d{16}\b/g },
  { type: "MY_PHONE", re: /\+?60[ -]?1\d[ -]?\d{3,4}[ -]?\d{4}\b/g },
  { type: "ID_PHONE", re: /\+?62[ -]?8\d{2}[ -]?\d{3,4}[ -]?\d{3,4}\b/g },
  { type: "MY_BANK_ACCOUNT", re: /\b\d{10,15}\b/g },
];

/** Regex stand-in for Presidio (P3 task 3.11): replaces each synthetic ID with `<TYPE>`; offsets into the original. */
export function regexRedact(text: string): RedactionResult {
  const spans: { type: string; start: number; end: number }[] = [];
  for (const { type, re } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (!spans.some((s) => start < s.end && end > s.start)) spans.push({ type, start, end });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  let out = "";
  let at = 0;
  for (const s of spans) {
    out += `${text.slice(at, s.start)}<${s.type}>`;
    at = s.end;
  }
  out += text.slice(at);
  return { text: out, report: { entities: spans, count: spans.length } };
}

export class FakeRedactor implements Redactor {
  calls = 0;
  readonly seen: string[] = [];
  async redact(text: string): Promise<RedactionResult> {
    this.calls += 1;
    this.seen.push(text);
    return regexRedact(text);
  }
}

/** Outbound canary used in tests: throws if any synthetic ID survives redaction. */
export function canaryGuard(text: string): void {
  for (const v of Object.values(CANARY)) if (text.includes(v)) throw new Error("canary leaked");
}

export interface TestGuard {
  readonly guarded: GuardedModel;
  readonly sink: CapturingSink;
  readonly redactor: FakeRedactor;
}

export function guarded(handle: ModelHandle, redactor = new FakeRedactor()): TestGuard {
  const sink = new CapturingSink();
  let n = 0;
  const g = guardModel(handle, {
    redactor,
    outboundGuard: canaryGuard,
    sink,
    context: { facilityId: "fac-rina", traceId: "trace-test" },
    newId: () => `llm-${(n += 1)}`,
  });
  return { guarded: g, sink, redactor };
}

/** Anthropic provider over a fake fetch that records each request body and replays fixture responses. */
export function fakeAnthropic(fixtures: object[]) {
  const sent: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    sent.push({ url: String(input), headers, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    const fx = fixtures[Math.min(sent.length, fixtures.length) - 1];
    return new Response(JSON.stringify(fx), { status: 200, headers: { "content-type": "application/json" } });
  };
  const provider = createAnthropic({ apiKey: "offline-placeholder", baseURL: "https://offline.invalid/v1", fetch: fakeFetch });
  return { provider, sent, fakeFetch };
}

export const anthropicReply = (model: string, content: object[], stopReason: string) => ({
  id: `msg_fx_${stopReason}`,
  type: "message",
  role: "assistant",
  model,
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  usage: { input_tokens: 42, output_tokens: 7 },
});
