/**
 * Per-request wiring for task 1.12: one registry per process, guarded planner and reader models per request (the
 * tenant's facility id and trace id go into every call record). Production defaults fail CLOSED: the redactor and the
 * outbound canary are @hogee/privacy's `redact` and `assertNoIds`; a redactor error blocks the call, and the canary
 * blocks any national ID that survives redaction, so no prompt leaves unredacted.
 */
import { guardModel, type GuardContext, type GuardedModel } from "./guard/guarded-model";
import type { LlmCallSink } from "./guard/call-log";
import { privacyOutboundGuard, privacyRedactor, type OutboundGuard, type Redactor } from "./guard/redaction";
import type { ModelRegistry } from "./models/registry";

export interface AgentModelDeps {
  readonly sink: LlmCallSink;
  /** Default: @hogee/privacy `redact` (fail closed). */
  readonly redactor?: Redactor;
  /** Default: @hogee/privacy `assertNoIds` (fail closed). */
  readonly outboundGuard?: OutboundGuard;
  readonly newId?: () => string;
}

export interface AgentModels {
  readonly planner: GuardedModel;
  readonly reader: GuardedModel;
}

export function agentModelsForRequest(registry: ModelRegistry, deps: AgentModelDeps, context: GuardContext): AgentModels {
  const common = {
    redactor: deps.redactor ?? privacyRedactor,
    outboundGuard: deps.outboundGuard ?? privacyOutboundGuard,
    sink: deps.sink,
    context,
    ...(deps.newId ? { newId: deps.newId } : {}),
  };
  return { planner: guardModel(registry.handle("planner"), common), reader: guardModel(registry.handle("reader"), common) };
}
