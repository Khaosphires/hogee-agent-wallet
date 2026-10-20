import { describe, expect, it } from "vitest";
import { generateText } from "ai";
import * as agent from "../src/index";
import { CapturingSink } from "./helpers/mock-model";

describe("agentModelsForRequest: production defaults fail closed", () => {
  it("production defaults redact before the provider sees the prompt", async () => {
    const bodies: string[] = [];
    const fakeFetch: typeof fetch = async (_input, init) => {
      bodies.push(String(init?.body ?? ""));
      return new Response("{}", { status: 500 });
    };
    const registry = agent.createModelRegistry({ ANTHROPIC_API_KEY: "offline-placeholder" }, { fetch: fakeFetch });
    const sink = new CapturingSink();
    const { planner, reader } = agent.agentModelsForRequest(registry, { sink }, { facilityId: "fac-rina", traceId: "t-1" });
    expect(planner.spec.role).toBe("planner");
    expect(reader.spec.role).toBe("reader");
    const err = await generateText({ model: planner.model, ...planner.settings, prompt: "my IC is 900101-14-5678", maxRetries: 0 }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(agent.RedactionUnavailableError);
    expect(err).not.toBeInstanceOf(agent.OutboundBlockedError);
    expect(bodies).toHaveLength(1);
    const body = bodies[0] ?? "";
    expect(body).toContain("my IC is <MY_NRIC>");
    for (const raw of ["900101-14-5678", "900101145678", "900101 14 5678", "900101", "14-5678", "145678"]) expect(body).not.toContain(raw);
    expect(body.replace(/[^0-9]/g, "")).not.toContain("900101145678");
    expect(sink.records).toHaveLength(1);
  });

  it("exports the public API", () => {
    for (const name of ["runPlannerTurn", "readDocument", "explainPlanDraft", "explainDecision", "createMemoryEntry", "bindInvoiceSpend", "guardModel", "createModelRegistry"]) {
      expect(typeof (agent as Record<string, unknown>)[name]).toBe("function");
    }
  });
});
