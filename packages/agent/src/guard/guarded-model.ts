/**
 * The single choke point in front of every provider call (planner, reader, judge): an AI SDK language-model
 * middleware that, for EVERY call (each tool-loop step and each SDK retry):
 *
 *   1. audits the call settings against the Claude 5.5 rules (no sampling params, no forced tool, no thinking
 *      disabled, no assistant prefill) and refuses the call on any violation;
 *   2. redacts the whole prompt with the injected Redactor, failing CLOSED (src/guard/redaction.ts);
 *   3. runs the outbound canary over the redacted request (tool-call inputs included) and refuses on a hit;
 *   4. times the call and writes one LlmCallRecord (hashes, usage, latency, outcome) to the injected sink. A sink
 *      that throws fails the call: an unlogged answer is never used. A stream is held back until its record is
 *      written (nothing reaches the consumer first), and a provider error or a consumer cancel still writes one.
 *
 * Nothing reaches the provider unless steps 1-3 pass. Models are created per request with the tenant's context.
 *
 * `GuardedModel` is a structural type, so a caller could wrap a raw registry handle in a look-alike object. Every
 * object guardModel returns is therefore recorded in a module-level WeakSet, and the Planner and the Reader refuse
 * any model that is not in it (`assertGuardedModel`): there is no way to reach them around the guard. The guarded
 * object, its wrapped `model` and its `spec` are frozen (re-check L4), so `doGenerate` / `doStream` cannot be swapped
 * for the raw ones after registration.
 *
 * What the WeakSet proves is only "created via guardModel". guardModel takes its Redactor, OutboundGuard and call-log
 * sink from the caller (GuardDeps), so a caller that passes a no-op redactor or sink still gets a model the Planner and
 * the Reader accept. Production wiring goes through `agentModelsForRequest` (agent.ts), whose redactor and canary
 * default to the fail-closed @hogee/privacy ones; the sink is always the caller's. The membership check does not, and
 * cannot, vouch for deps a caller supplies.
 */
import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import { jsonHash, toJsonValue } from "../hash";
import type { ModelHandle, ModelSpec, ProviderModel } from "../models/registry";
import { auditCallOptions, classifyStop, type CallSettings } from "../models/rules";
import type { LlmCallOutcome, LlmCallRecord, LlmCallSink } from "./call-log";
import { redactPrompt, type OutboundGuard, type PromptRedactionReport, type Redactor } from "./redaction";

type TransformArgs = Parameters<NonNullable<LanguageModelMiddleware["transformParams"]>>[0];
type CallOptions = TransformArgs["params"];
type GenerateArgs = Parameters<NonNullable<LanguageModelMiddleware["wrapGenerate"]>>[0];
type GenerateResult = Awaited<ReturnType<GenerateArgs["doGenerate"]>>;
type StreamArgs = Parameters<NonNullable<LanguageModelMiddleware["wrapStream"]>>[0];
type StreamResult = Awaited<ReturnType<StreamArgs["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

export class ModelRuleViolationError extends Error {
  override readonly name = "ModelRuleViolationError";
  constructor(readonly violations: readonly string[]) {
    super(`model call blocked by the Claude 5.5 rules: ${violations.join("; ")}`);
  }
}

export class OutboundBlockedError extends Error {
  override readonly name = "OutboundBlockedError";
  constructor(options?: { cause?: unknown }) {
    super("model call blocked: the outbound canary found an identifier after redaction", options);
  }
}

export class UnguardedModelError extends Error {
  override readonly name = "UnguardedModelError";
  constructor(user: string) {
    super(`${user} refused a model that was not created by guardModel (no redaction, canary or call log)`);
  }
}

/** Every GuardedModel guardModel has returned. Only these can reach the Planner and the Reader. */
const GUARDED = new WeakSet<object>();

/** True only for an object guardModel created (a copy or a hand-made look-alike is false). */
export function isGuardedModel(m: unknown): m is GuardedModel {
  return typeof m === "object" && m !== null && GUARDED.has(m);
}

/** Throws UnguardedModelError unless `m` came from guardModel. `user` names the caller in the message. */
export function assertGuardedModel(m: unknown, user: string): asserts m is GuardedModel {
  if (!isGuardedModel(m)) throw new UnguardedModelError(user);
}

export interface GuardContext {
  readonly facilityId: string;
  readonly traceId: string | null;
}

export interface GuardDeps {
  readonly redactor: Redactor;
  readonly outboundGuard: OutboundGuard;
  readonly sink: LlmCallSink;
  readonly context: GuardContext;
  /** Call-record ids (default crypto.randomUUID). */
  readonly newId?: () => string;
  /** Monotonic milliseconds (default performance.now). */
  readonly clock?: () => number;
}

export interface GuardedModel {
  readonly spec: ModelSpec;
  readonly settings: CallSettings;
  /** The wrapped model: pass it to generateText/streamText together with `settings`. */
  readonly model: ProviderModel;
  /** Every call record written through this guard, in order (the planner cites them in its rationale). */
  readonly records: readonly LlmCallRecord[];
}

interface Pending {
  readonly report: PromptRedactionReport;
  readonly promptHash: LlmCallRecord["promptHash"];
  readonly paramsJson: Readonly<Record<string, unknown>>;
}

/** Only the settings fields are audited (a tool result that happens to contain "temperature" is data, not a setting). */
function ruleViolations(params: CallOptions): string[] {
  const settings = { temperature: params.temperature, topP: params.topP, topK: params.topK, toolChoice: params.toolChoice, providerOptions: params.providerOptions };
  const out = auditCallOptions(settings);
  if (params.prompt.at(-1)?.role === "assistant") out.push("assistant prefill (the last message is from the assistant)");
  return out;
}

function paramsJsonOf(params: CallOptions): Readonly<Record<string, unknown>> {
  return toJsonValue({
    maxOutputTokens: params.maxOutputTokens,
    providerOptions: params.providerOptions,
    toolChoice: params.toolChoice,
    toolNames: params.tools?.map((t) => t.name),
    responseFormat: params.responseFormat?.type ?? "text",
  }) as Record<string, unknown>;
}

function usageOf(u: GenerateResult["usage"] | undefined): LlmCallRecord["tokens"] {
  const input = u?.inputTokens.total;
  const output = u?.outputTokens.total;
  return input === undefined && output === undefined ? null : { input: input ?? 0, output: output ?? 0 };
}

function outcomeOf(finish: GenerateResult["finishReason"] | undefined): LlmCallOutcome {
  return classifyStop({ rawFinishReason: finish?.raw, finishReason: finish?.unified }) === "REFUSAL" ? "refusal" : "ok";
}

interface CallResult {
  readonly outcome: LlmCallOutcome;
  readonly content: unknown;
  readonly usage: GenerateResult["usage"] | undefined;
  readonly finish: GenerateResult["finishReason"] | undefined;
}
const FAILED_CALL: CallResult = { outcome: "error", content: null, usage: undefined, finish: undefined };
/** Stream parts whose hash stands for the answer (as in a generate call's content). */
const ANSWER_PARTS: ReadonlySet<string> = new Set(["text-delta", "tool-call", "reasoning-delta"]);

/**
 * Hold every part of a provider stream until its call record is written (security audit run-3), so the consumer never
 * sees an unlogged answer: the whole stream is read, the record written, and only then are the parts released. A sink
 * that throws errors the stream with nothing released. A provider stream that fails, or a consumer that cancels
 * before the release, still writes one record (outcome "error", no response hash). A record whose outcome is "error"
 * or whose response hash is null (an `error` part, or no `finish` part) releases nothing either: the stream errors
 * (re-check L3), so no content reaches the consumer without a logged answer hash.
 */
function holdUntilLogged(inner: ReadableStream<StreamPart>, log: (r: CallResult) => Promise<LlmCallRecord>): ReadableStream<StreamPart> {
  const reader = inner.getReader();
  let logged = false;
  let cancelled = false;
  const logOnce = async (r: CallResult): Promise<LlmCallRecord | null> => {
    if (logged) return null;
    logged = true;
    return log(r);
  };
  return new ReadableStream<StreamPart>({
    async pull(controller) {
      const parts: StreamPart[] = [];
      const seen: StreamPart[] = [];
      let finish: Extract<StreamPart, { type: "finish" }> | undefined;
      let failed = false;
      let streamError: unknown;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          const part = next.value;
          if (part.type === "finish") finish = part;
          else if (part.type === "error") {
            failed = true;
            streamError ??= (part as { error?: unknown }).error;
          } else if (ANSWER_PARTS.has(part.type)) seen.push(part);
          parts.push(part);
        }
      } catch (e) {
        if (cancelled) return;
        await logOnce(FAILED_CALL);
        throw e;
      }
      if (cancelled) return;
      const outcome: LlmCallOutcome = failed || !finish ? "error" : outcomeOf(finish.finishReason);
      const record = await logOnce({ outcome, content: seen, usage: finish?.usage, finish: finish?.finishReason });
      if (cancelled) return;
      if (!record || record.outcome === "error" || record.responseHash === null) {
        if (failed) controller.error(streamError instanceof Error ? streamError : new Error("model stream reported an error", { cause: streamError }));
        else controller.error(new Error("model stream ended without a finish part"));
        return;
      }
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
    async cancel(reason) {
      cancelled = true;
      try {
        await reader.cancel(reason);
      } finally {
        await logOnce(FAILED_CALL);
      }
    },
  });
}

/**
 * Wrap a model handle so every call is rule-checked, redacted, canary-scanned and logged. The redactor, outbound guard
 * and sink are the CALLER's (see the module note): the result is trusted by the Planner and the Reader only as far as
 * those deps are.
 */
export function guardModel(handle: ModelHandle, deps: GuardDeps): GuardedModel {
  const pending = new WeakMap<object, Pending>();
  const records: LlmCallRecord[] = [];
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const clock = deps.clock ?? (() => performance.now());
  const spec: ModelSpec = Object.freeze({ ...handle.spec });

  const write = async (meta: Pending, t0: number, r: CallResult): Promise<LlmCallRecord> => {
    const record: LlmCallRecord = {
      id: newId(),
      facilityId: deps.context.facilityId,
      traceId: deps.context.traceId,
      role: spec.role,
      provider: spec.provider,
      modelId: spec.modelId,
      paramsJson: meta.paramsJson,
      promptHash: meta.promptHash,
      responseHash: r.outcome === "error" ? null : jsonHash(r.content),
      redactionReport: meta.report,
      latencyMs: Math.max(0, Math.round(clock() - t0)),
      tokens: usageOf(r.usage),
      outcome: r.outcome,
      finishReason: r.finish?.unified ?? null,
      rawFinishReason: r.finish?.raw ?? null,
    };
    records.push(record);
    await deps.sink.record(record);
    return record;
  };

  const metaFor = (params: CallOptions): Pending => {
    const meta = pending.get(params);
    if (!meta) throw new ModelRuleViolationError(["call did not pass the redaction gate"]);
    return meta;
  };

  const middleware: LanguageModelMiddleware = {
    transformParams: async ({ params }) => {
      const violations = ruleViolations(params);
      if (violations.length > 0) throw new ModelRuleViolationError(violations);
      const { prompt, report } = await redactPrompt(params.prompt, deps.redactor);
      try {
        deps.outboundGuard(JSON.stringify({ prompt, tools: params.tools }));
      } catch (e) {
        throw new OutboundBlockedError({ cause: e });
      }
      const redacted: CallOptions = { ...params, prompt };
      pending.set(redacted, {
        report,
        promptHash: jsonHash({ prompt, tools: params.tools ?? null, responseFormat: params.responseFormat ?? null }),
        paramsJson: paramsJsonOf(params),
      });
      return redacted;
    },

    wrapGenerate: async ({ doGenerate, params }) => {
      const meta = metaFor(params);
      const t0 = clock();
      let result: GenerateResult;
      try {
        result = await doGenerate();
      } catch (e) {
        await write(meta, t0, FAILED_CALL);
        throw e;
      }
      await write(meta, t0, { outcome: outcomeOf(result.finishReason), content: result.content, usage: result.usage, finish: result.finishReason });
      return result;
    },

    wrapStream: async ({ doStream, params }) => {
      const meta = metaFor(params);
      const t0 = clock();
      let res: StreamResult;
      try {
        res = await doStream();
      } catch (e) {
        await write(meta, t0, FAILED_CALL);
        throw e;
      }
      return { ...res, stream: holdUntilLogged(res.stream, (r) => write(meta, t0, r)) };
    },
  };

  const model = Object.freeze(wrapLanguageModel({ model: handle.model, middleware }));
  const guarded: GuardedModel = Object.freeze({ spec, settings: handle.settings, model, records });
  GUARDED.add(guarded);
  return guarded;
}
