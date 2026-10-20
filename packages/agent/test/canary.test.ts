/**
 * Canary (project.md §13.2 T32, §14.1): synthetic MyKad / NIK / phone / bank numbers planted in the founder's text,
 * in memory, in a tool result and in an invoice never appear in ANY prompt a model receives, after redaction:
 * not at the language-model boundary (MockLanguageModelV4) and not in the HTTP body sent to Anthropic (fake fetch).
 * The outbound canary guard is switched OFF here, so this proves the redaction path itself, not the backstop.
 */
import { describe, expect, it } from "vitest";
import { examplePlanIntent } from "@hogee/core";
import { guardModel } from "../src/guard/guarded-model";
import { createMemoryEntry } from "../src/memory/memory";
import { handleFor } from "../src/models/registry";
import { runPlannerTurn } from "../src/planner/planner";
import { readDocument } from "../src/reader/reader";
import { CANARY, CapturingSink, FakeRedactor, anthropicReply, fakeAnthropic, mockHandle, mockModel, specFor, textResult, toolCallResult } from "./helpers/mock-model";
import { RINA_PLANNER_CONTEXT } from "./helpers/rina";

const PLANTED = Object.values(CANARY);
const FOUNDER_TEXT = `I'm Rina from Selangor, IC ${CANARY.myKad}, NIK ${CANARY.nik}, phone ${CANARY.phoneMy}, bank ${CANARY.bank}. I want to sell insulated tumblers on Shopee with a RM10,000 micro-loan.`;
const noBackstop = () => {};

function leaks(payload: unknown): string[] {
  const s = JSON.stringify(payload);
  return PLANTED.filter((v) => s.includes(v));
}

function guardedWith(handle: Parameters<typeof guardModel>[0], redactor: FakeRedactor) {
  return guardModel(handle, { redactor, outboundGuard: noBackstop, sink: new CapturingSink(), context: { facilityId: "fac-rina", traceId: "canary" } });
}

const memory = [
  createMemoryEntry(
    { id: "mem-1", facilityId: "fac-rina", sessionId: null, key: "note:contact", value: `call me on ${CANARY.phoneId}`, source: "USER_TURN", sourceRef: "msg-1", createdAt: "2026-10-16T01:00:00Z" },
    new Uint8Array(32).fill(5),
  ),
];
const leakyFx = async () => ({ value: 0.61, sourceUrl: `https://example.invalid/fx/${CANARY.bank}`, retrievedAt: "2026-10-16T00:00:00Z", snippetHash: `0x${"0".repeat(64)}`, evidence: "tier3" as const, sourceType: "mock" as const });

describe("canary: planted IDs never reach a model", () => {
  it("planner: founder text, memory and a tool result are all redacted on every step", async () => {
    const redactor = new FakeRedactor();
    const model = mockModel([toolCallResult("getFx", { pair: "CNY/MYR" }), toolCallResult("proposePlanIntent", examplePlanIntent)]);
    const g = guardedWith(mockHandle("planner", model), redactor);
    const out = await runPlannerTurn({ turns: [{ role: "user", text: FOUNDER_TEXT }], context: RINA_PLANNER_CONTEXT }, { model: g, memory, ports: { getFx: leakyFx } });
    expect(out.kind).toBe("plan");
    expect(model.doGenerateCalls).toHaveLength(2);
    for (const call of model.doGenerateCalls) expect(leaks(call)).toEqual([]);
    // Not vacuous: every canary was really in the input and went through the redactor.
    expect(PLANTED.filter((v) => redactor.seen.join("\n").includes(v)).sort()).toEqual([...PLANTED].sort());
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain("<MY_BANK_ACCOUNT>");
    // The call log holds hashes and offsets only.
    expect(leaks(g.records)).toEqual([]);
  });

  it("reader: an invoice full of IDs is redacted before extraction", async () => {
    const redactor = new FakeRedactor();
    const text = `INVOICE No. INV-1\nCustomer IC ${CANARY.myKad}, NIK ${CANARY.nik}\nCall ${CANARY.phoneMy} or ${CANARY.phoneId}\nTOTAL DUE: MYR 10.00\nPay to account ${CANARY.bank}`;
    const out = { invoiceNumber: "INV-1", issuerName: null, currency: "MYR", total: { value: "10.00", unit: "MYR", snippet: "TOTAL DUE: MYR 10.00" }, lineItems: [], addressesAiAgents: false, mentionsPaymentChange: false };
    const model = mockModel([textResult(JSON.stringify(out))], "claude-haiku-5-5");
    const g = guardedWith(mockHandle("reader", model), redactor);
    const r = await readDocument({ kind: "invoice", docId: "inv-1", text }, { model: g });
    expect(r.fields.total?.value.amountMinor).toBe("1000");
    for (const call of model.doGenerateCalls) expect(leaks(call)).toEqual([]);
  });

  it("wire: the HTTP bodies sent to Anthropic carry no planted ID (fake fetch, no network)", async () => {
    const { provider, sent } = fakeAnthropic([
      anthropicReply("claude-sonnet-5-5", [{ type: "tool_use", id: "toolu_1", name: "getFx", input: { pair: "CNY/MYR" } }], "tool_use"),
      anthropicReply("claude-sonnet-5-5", [{ type: "tool_use", id: "toolu_2", name: "proposePlanIntent", input: examplePlanIntent }], "tool_use"),
    ]);
    const spec = specFor("planner");
    const g = guardedWith(handleFor(spec, provider(spec.modelId)), new FakeRedactor());
    const out = await runPlannerTurn({ turns: [{ role: "user", text: FOUNDER_TEXT }], context: RINA_PLANNER_CONTEXT }, { model: g, memory, ports: { getFx: leakyFx } });
    expect(out.kind).toBe("plan");
    expect(sent).toHaveLength(2);
    for (const req of sent) expect(leaks(req.body)).toEqual([]);
    expect(sent[0]?.body.thinking).toEqual({ type: "between_tools" });
  });
});
