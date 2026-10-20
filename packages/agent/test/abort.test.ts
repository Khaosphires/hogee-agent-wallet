/**
 * Eval deadlines (skills re-check of run-5, LOW 4): the planner, the reader and the ranking baseline pass an optional
 * caller AbortSignal to every provider call, so /api/eval/* can bound a run; without one, nothing changes.
 */
import { describe, expect, it } from "vitest";
import { examplePlanIntent } from "@hogee/core";
import { rankListingsBaseline } from "../src/baseline/rank-listings";
import { runPlannerTurn } from "../src/planner/planner";
import { readDocument } from "../src/reader/reader";
import { guarded, mockHandle, mockModel, textResult, toolCallResult } from "./helpers/mock-model";
import { RINA_PLANNER_CONTEXT } from "./helpers/rina";

const INVOICE = { invoiceNumber: null, issuerName: null, currency: "MYR", total: null, lineItems: [], addressesAiAgents: false, mentionsPaymentChange: false };

describe("caller abort signals reach the provider", () => {
  it("planner: every step carries the signal; none by default", async () => {
    const signal = new AbortController().signal;
    const model = mockModel([toolCallResult("proposePlanIntent", examplePlanIntent)]);
    await runPlannerTurn({ turns: [{ role: "user", text: "Tumblers on Shopee from China, budget RM10,000." }], context: RINA_PLANNER_CONTEXT }, { model: guarded(mockHandle("planner", model)).guarded, abortSignal: signal });
    expect(model.doGenerateCalls[0]?.abortSignal).toBe(signal);
    const plain = mockModel([toolCallResult("proposePlanIntent", examplePlanIntent)]);
    await runPlannerTurn({ turns: [{ role: "user", text: "Tumblers on Shopee from China, budget RM10,000." }], context: RINA_PLANNER_CONTEXT }, { model: guarded(mockHandle("planner", plain)).guarded });
    expect(plain.doGenerateCalls[0]?.abortSignal).toBeUndefined();
  });

  it("reader and baseline: the signal reaches the call", async () => {
    const signal = new AbortController().signal;
    const reader = mockModel([textResult(JSON.stringify(INVOICE))], "claude-haiku-5-5");
    await readDocument({ kind: "invoice", docId: "doc-1", text: "Invoice, no total." }, { model: guarded(mockHandle("reader", reader)).guarded, abortSignal: signal });
    expect(reader.doGenerateCalls[0]?.abortSignal).toBe(signal);
    const ranker = mockModel([textResult(JSON.stringify({ ranking: ["s-1"] }))], "claude-haiku-5-5");
    await rankListingsBaseline([{ supplierId: "s-1", text: "t" }], { model: guarded(mockHandle("reader", ranker)).guarded, abortSignal: signal });
    expect(ranker.doGenerateCalls[0]?.abortSignal).toBe(signal);
  });
});
