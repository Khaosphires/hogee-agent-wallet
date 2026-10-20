/**
 * Eval deadline (skills re-check of run-5, LOW 4): every model call of an eval request carries one per-request
 * AbortSignal.timeout; at the deadline the call is aborted, the request answers 504 UPSTREAM (EVAL_DEADLINE), and its
 * concurrency slot is released only after the aborted work has stopped. The API pool bounds connection waits.
 */
import { describe, expect, it } from "vitest";
import { handleFor, type ModelRegistry, type ModelRole } from "@hogee/agent";
import { ApiError } from "@hogee/core";
import { MockLanguageModelV4 } from "ai/test";
import { createApiApp } from "../src/app";
import type { AgentPort } from "../src/context";
import { EVAL_MAX_CONCURRENT, evalRoutes } from "../src/routes/eval";
import { budgetedAgentModels } from "../src/runtime/budgeted-models";
import { API_PG_CONNECT_TIMEOUT_MS } from "../src/runtime/deps";
import { ModelBudget } from "../src/services/model-budget";
import { regexRedactor } from "./support/agent";
import { testCatalog, testChecks } from "./support/catalog";
import { facilityOnlyDb, fakeDeps } from "./support/fake-deps";

/** A model whose every call waits until its abort signal fires, then records that it stopped. */
function hangingAgent(events: string[]): AgentPort {
  const model = new MockLanguageModelV4({
    provider: "anthropic.messages",
    modelId: "claude-haiku-5-5",
    doGenerate: (options) =>
      new Promise((_resolve, reject) => {
        events.push("call");
        options.abortSignal?.addEventListener("abort", () => {
          events.push("stopped");
          reject(options.abortSignal?.reason ?? new Error("aborted"));
        });
      }),
  });
  const spec = (role: ModelRole) => ({ role, provider: "anthropic" as const, modelId: model.modelId, registryId: `anthropic:${model.modelId}`, family: role === "judge" ? "deepseek" : "claude" });
  const registry: ModelRegistry = { specs: { planner: spec("planner"), reader: spec("reader"), judge: spec("judge") }, handle: (role) => handleFor(spec(role), model) };
  const budget = new ModelBudget();
  return {
    configured: true,
    memoryKey: null,
    redactor: regexRedactor,
    budget,
    models: (context, sink) => budgetedAgentModels(registry, budget, { sink, redactor: regexRedactor, outboundGuard: () => undefined }, context),
  };
}

describe("eval deadline", () => {
  it("aborts the model call at the deadline (504 EVAL_DEADLINE) and frees the slot only after the work stopped", async () => {
    const events: string[] = [];
    const f = fakeDeps({ deps: { catalog: testCatalog, checks: testChecks, agent: hangingAgent(events), db: facilityOnlyDb() } });
    const app = createApiApp(async () => f.deps, evalRoutes({ deadlineMs: 150 }));
    const send = () => app.request("/api/eval/shortlist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setId: "set-01", mode: "llm_rank" }) });
    const running = Array.from({ length: EVAL_MAX_CONCURRENT }, send);
    while (events.filter((e) => e === "call").length < EVAL_MAX_CONCURRENT) await new Promise((r) => setTimeout(r, 5));
    expect((await send()).status).toBe(503); // both slots held while the calls hang
    for (const res of await Promise.all(running)) {
      expect(res.status).toBe(504);
      expect(ApiError.parse(await res.json()).error).toMatchObject({ code: "UPSTREAM", details: { reason: "EVAL_DEADLINE" } });
    }
    expect(events.filter((e) => e === "stopped")).toHaveLength(EVAL_MAX_CONCURRENT);
    // Slots were released after the aborted calls stopped: a new request runs (and hits its own deadline).
    expect((await send()).status).toBe(504);
  });

  it("the API pool bounds the wait for a connection", () => {
    expect(API_PG_CONNECT_TIMEOUT_MS).toBe(10_000);
  });
});
