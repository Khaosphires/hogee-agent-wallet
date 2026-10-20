/**
 * LLM call log (project.md §7.1 "every call is recorded in the LLM call log", §12.1 `llm_calls`, §14.1).
 *
 * One record per provider call (each tool-loop step and each retry is its own call). It holds HASHES only: the
 * redacted request (`promptHash`) and the response (`responseHash`), never prompt or response text, so no PII and no
 * untrusted text lands in the log. `toLlmCallRow` maps a record onto the frozen `llm_calls` columns
 * (packages/db/src/schema/audit.ts); `outcome`, `finishReason` and `rawFinishReason` are extra and go to the trace.
 * The sink is injected: task 1.12 writes rows to Postgres; tests capture them in memory.
 */
import type { Hex32 } from "@hogee/core";
import type { PromptRedactionReport } from "./redaction";

/** Mirrors packages/db `llmRoleValues` (the explainer is templated and makes no calls today). */
export type LlmCallRole = "planner" | "reader" | "explainer" | "judge" | "classifier";
export type LlmCallOutcome = "ok" | "refusal" | "error";

export interface LlmCallRecord {
  readonly id: string;
  readonly facilityId: string;
  readonly traceId: string | null;
  readonly role: LlmCallRole;
  readonly provider: string;
  readonly modelId: string;
  /** Call settings only (max output, provider options, tool names, response format type): never prompt content. */
  readonly paramsJson: Readonly<Record<string, unknown>>;
  /** keccak256(JCS({prompt, tools, responseFormat})) of the REDACTED request. */
  readonly promptHash: Hex32;
  /** keccak256(JCS(content)) of the response; null when the call failed. */
  readonly responseHash: Hex32 | null;
  readonly redactionReport: PromptRedactionReport;
  readonly latencyMs: number;
  /** LLM usage counts `{input, output}` (`llm_calls.tokens`, the one wording exception allowed by §14.4). */
  readonly tokens: { readonly input: number; readonly output: number } | null;
  readonly outcome: LlmCallOutcome;
  readonly finishReason: string | null;
  readonly rawFinishReason: string | null;
}

export interface LlmCallSink {
  record(record: LlmCallRecord): void | Promise<void>;
}

/** Exactly the `llm_calls` insert columns (created_at is defaulted by Postgres). */
export interface LlmCallRow {
  readonly id: string;
  readonly facilityId: string;
  readonly traceId: string | null;
  readonly role: LlmCallRole;
  readonly provider: string;
  readonly modelId: string;
  readonly paramsJson: Readonly<Record<string, unknown>>;
  readonly promptHash: Hex32;
  readonly responseHash: Hex32 | null;
  readonly redactionReport: PromptRedactionReport;
  readonly latencyMs: number;
  readonly tokens: { readonly input: number; readonly output: number } | null;
}

export function toLlmCallRow(r: LlmCallRecord): LlmCallRow {
  return {
    id: r.id,
    facilityId: r.facilityId,
    traceId: r.traceId,
    role: r.role,
    provider: r.provider,
    modelId: r.modelId,
    paramsJson: r.paramsJson,
    promptHash: r.promptHash,
    responseHash: r.responseHash,
    redactionReport: r.redactionReport,
    latencyMs: r.latencyMs,
    tokens: r.tokens,
  };
}

/** In-memory sink (tests, eval runs). */
export class MemoryCallSink implements LlmCallSink {
  readonly records: LlmCallRecord[] = [];
  record(r: LlmCallRecord): void {
    this.records.push(r);
  }
}
