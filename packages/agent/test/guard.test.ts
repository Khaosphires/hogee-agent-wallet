import { describe, expect, it } from "vitest";
import { generateText, isStepCount, tool } from "ai";
import { z } from "zod";
import { PiiLeakError } from "@hogee/privacy";
import { keccak256Utf8 } from "@hogee/core";
import { RedactionUnavailableError, keyContext, privacyOutboundGuard, privacyRedactor, redactPrompt, type Redactor } from "../src/guard/redaction";
import { guardModel, isGuardedModel, OutboundBlockedError, UnguardedModelError, type GuardedModel } from "../src/guard/guarded-model";
import { toLlmCallRow } from "../src/guard/call-log";
import { runPlannerTurn } from "../src/planner/planner";
import { readDocument } from "../src/reader/reader";
import { CANARY, CapturingSink, FakeRedactor, canaryGuard, guarded, mockHandle, mockModel, refusalResult, textResult, toolCallResult } from "./helpers/mock-model";
import { RINA_PLANNER_CONTEXT } from "./helpers/rina";

const HEX32 = /^0x[0-9a-f]{64}$/;

describe("redaction gate: fail closed", () => {
  it("the real @hogee/privacy redactor replaces IDs before the model sees the prompt, and its canary blocks one that slips through", async () => {
    const model = mockModel([textResult("ok")]);
    const sink = new CapturingSink();
    const g = guardModel(mockHandle("planner", model), {
      redactor: privacyRedactor,
      outboundGuard: privacyOutboundGuard,
      sink,
      context: { facilityId: "fac-rina", traceId: null },
    });
    const r = await generateText({ model: g.model, ...g.settings, prompt: `my IC is ${CANARY.myKad}, NIK ${CANARY.nik}`, maxRetries: 0 });
    expect(r.text).toBe("ok");
    expect(model.doGenerateCalls).toHaveLength(1);
    const wire = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    expect(wire).not.toContain(CANARY.myKad);
    expect(wire).not.toContain(CANARY.nik);
    expect(wire).toContain("my IC is <MY_NRIC>, NIK <ID_NIK>");
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]!.redactionReport.count).toBe(2);

    const leaky: Redactor = { redact: async (text) => ({ text, report: { entities: [], count: 0 } }) };
    const blockedModel = mockModel([textResult("never")]);
    const b = guardModel(mockHandle("planner", blockedModel), { redactor: leaky, outboundGuard: privacyOutboundGuard, sink: new CapturingSink(), context: { facilityId: "f", traceId: null } });
    const err = await generateText({ model: b.model, ...b.settings, prompt: `my IC is ${CANARY.myKad}`, maxRetries: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OutboundBlockedError);
    expect((err as OutboundBlockedError).cause).toBeInstanceOf(PiiLeakError);
    expect(blockedModel.doGenerateCalls).toHaveLength(0);
  });

  it("a redactor that returns garbage is treated as unavailable", async () => {
    const bad: Redactor = { redact: async () => ({ text: 42 }) as never };
    const model = mockModel([textResult("never")]);
    const g = guardModel(mockHandle("planner", model), { redactor: bad, outboundGuard: canaryGuard, sink: new CapturingSink(), context: { facilityId: "f", traceId: null } });
    await expect(generateText({ model: g.model, ...g.settings, prompt: "x", maxRetries: 0 })).rejects.toThrow(RedactionUnavailableError);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("the outbound canary blocks a prompt that still carries an ID after redaction", async () => {
    const leaky: Redactor = { redact: async (text) => ({ text, report: { entities: [], count: 0 } }) };
    const model = mockModel([textResult("never")]);
    const g = guardModel(mockHandle("planner", model), { redactor: leaky, outboundGuard: canaryGuard, sink: new CapturingSink(), context: { facilityId: "f", traceId: null } });
    await expect(generateText({ model: g.model, ...g.settings, prompt: `my IC is ${CANARY.myKad}`, maxRetries: 0 })).rejects.toThrow(OutboundBlockedError);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("file parts cannot be redacted, so they are refused", async () => {
    await expect(
      redactPrompt([{ role: "user", content: [{ type: "file", data: { type: "text", text: CANARY.nik }, mediaType: "text/plain" }] }], new FakeRedactor()),
    ).rejects.toThrow(RedactionUnavailableError);
  });

  it("assistant reasoning-file and custom parts cannot be redacted, so they are refused (security audit run-3)", async () => {
    const r = new FakeRedactor();
    await expect(
      redactPrompt([{ role: "user", content: [{ type: "text", text: "hi" }] }, { role: "assistant", content: [{ type: "reasoning-file", data: { type: "data", data: Buffer.from(CANARY.nik).toString("base64") }, mediaType: "text/plain" }] }], r),
    ).rejects.toThrow(RedactionUnavailableError);
    await expect(
      redactPrompt([{ role: "user", content: [{ type: "text", text: "hi" }] }, { role: "assistant", content: [{ type: "custom", kind: "anthropic.fallback", providerOptions: { anthropic: { note: CANARY.myKad } } }] }], r),
    ).rejects.toThrow(RedactionUnavailableError);
  });

  it("JSON tool-result object keys are redacted as well as values (security audit run-3)", async () => {
    const r = new FakeRedactor();
    const { prompt, report } = await redactPrompt(
      [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "c1",
              toolName: "getFx",
              output: { type: "json", value: { [CANARY.nik]: "on file", nested: [{ [`call ${CANARY.phoneMy}`]: 1 }], plain: CANARY.bank } },
            },
          ],
        },
      ],
      r,
    );
    const wire = JSON.stringify(prompt);
    for (const v of [CANARY.nik, CANARY.phoneMy, CANARY.bank]) expect(wire).not.toContain(v);
    expect(wire).toContain('"<ID_NIK>":"on file"');
    expect(wire).toContain('"call <MY_PHONE>":1');
    expect(report.count).toBe(3);
  });

  it("a JSON leaf is redacted behind its key too, so context-only entities are caught (privacy follow-up, decisions/privacy.md §4)", async () => {
    // Synthetic values only. Alone, a bare 8-digit SG phone and a bare account number carry no context and stay.
    const toolResult = (value: Record<string, unknown>) =>
      [{ role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: "c1", toolName: "getPlan", output: { type: "json" as const, value: value as never } }] }];
    expect((await privacyRedactor.redact("91234567")).report.count).toBe(0);
    const { prompt, report } = await redactPrompt(
      toolResult({
        phone: "91234567",
        payoutAccount: "1234567890",
        contactPhones: ["81234567", { note: "no id here" }],
        mobile: 91234567,
        price: "012-345 6789",
        totalMinor: "91234567",
        rank: 1,
        score: 0.87,
      }),
      privacyRedactor,
    );
    const value = (prompt[0] as unknown as { content: [{ output: { value: unknown } }] }).content[0].output.value;
    expect(value).toEqual({
      phone: "<SG_PHONE>",
      payoutAccount: "<MY_BANK_ACCOUNT>",
      contactPhones: ["<SG_PHONE>", { note: "no id here" }],
      mobile: "<SG_PHONE>",
      // A key never vetoes a match the value alone already has (a negative context word like "price").
      price: "<MY_PHONE>",
      // Amount-like keys keep amounts: "minor" and "total" are negative context words.
      totalMinor: "91234567",
      rank: 1,
      score: 0.87,
    });
    // The key-context pass reports offsets into the value, under its own part number.
    const phone = report.entities.find((e) => e.type === "SG_PHONE");
    expect(phone).toMatchObject({ start: 0, end: 8 });
    expect(report.count).toBe(5);
  });

  it("keyContext splits camelCase and adds singulars", () => {
    expect(keyContext("contactPhone")).toBe("contact Phone");
    expect(keyContext("phones")).toBe("phones phone");
    expect(keyContext("bank_accounts")).toBe("bank_accounts account");
  });

  it("a redactor that rewrites the key context fails closed instead of guessing where the value starts", async () => {
    const tagging: Redactor = { redact: async (text) => ({ text: `[r] ${text}`, report: { entities: [], count: 0 } }) };
    const spanInKey: Redactor = { redact: async (text) => ({ text, report: { entities: text.includes(": ") ? [{ type: "X", start: 0, end: 2 }] : [], count: 0 } }) };
    for (const r of [tagging, spanInKey]) {
      await expect(
        redactPrompt([{ role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "getPlan", output: { type: "json", value: { note: "x" } } }] }], r),
      ).rejects.toThrow(RedactionUnavailableError);
    }
  });

  it("two JSON keys that redact to the same text are refused (no value is silently dropped)", async () => {
    const value = { [CANARY.nik]: "a", "3171010101900002": "b" };
    await expect(
      redactPrompt([{ role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "getFx", output: { type: "json", value } }] }], new FakeRedactor()),
    ).rejects.toThrow(RedactionUnavailableError);
  });

  it("redacts system, user, assistant text and every tool-result string; keeps reasoning and tool-call parts", async () => {
    const r = new FakeRedactor();
    const { prompt, report } = await redactPrompt(
      [
        { role: "system", content: `ops note ${CANARY.phoneMy}` },
        { role: "user", content: [{ type: "text", text: `IC ${CANARY.myKad}` }] },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "opaque-signed" },
            { type: "text", text: `you said ${CANARY.bank}` },
            { type: "tool-call", toolCallId: "c1", toolName: "getPlan", input: {} },
          ],
        },
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "c1", toolName: "getPlan", output: { type: "json", value: { a: [CANARY.nik, { b: CANARY.phoneId }], n: 7 } } },
          ],
        },
      ],
      r,
    );
    const wire = JSON.stringify(prompt);
    for (const v of Object.values(CANARY)) expect(wire).not.toContain(v);
    expect(wire).toContain("opaque-signed");
    expect(report.count).toBe(5);
    expect(new Set(report.entities.map((e) => e.part)).size).toBe(5);
  });
});

describe("only models made by guardModel are accepted (security audit run-3)", () => {
  const turns = [{ role: "user" as const, text: "I have a RM10,000 micro-loan." }];

  it("a hand-made look-alike around a raw handle is refused by the planner and the reader, before any call", async () => {
    const pModel = mockModel([toolCallResult("askClarifyingQuestions", { slots: ["buyFrom"] })]);
    const p = mockHandle("planner", pModel);
    const plannerLookAlike: GuardedModel = { spec: p.spec, settings: p.settings, model: p.model, records: [] };
    await expect(runPlannerTurn({ turns, context: RINA_PLANNER_CONTEXT }, { model: plannerLookAlike })).rejects.toThrow(UnguardedModelError);
    expect(pModel.doGenerateCalls).toHaveLength(0);

    const rModel = mockModel([textResult("{}")], "claude-haiku-5-5");
    const r = mockHandle("reader", rModel);
    const readerLookAlike: GuardedModel = { spec: r.spec, settings: r.settings, model: r.model, records: [] };
    await expect(readDocument({ kind: "invoice", docId: "inv-1", text: "TOTAL DUE: MYR 1.00" }, { model: readerLookAlike })).rejects.toThrow(UnguardedModelError);
    expect(rModel.doGenerateCalls).toHaveLength(0);
  });

  it("a copy of a genuine guarded model with its model swapped for the raw one is refused too", async () => {
    const model = mockModel([toolCallResult("askClarifyingQuestions", { slots: ["buyFrom"] })]);
    const handle = mockHandle("planner", model);
    const { guarded: g } = guarded(handle);
    const swapped: GuardedModel = { ...g, model: handle.model };
    await expect(runPlannerTurn({ turns, context: RINA_PLANNER_CONTEXT }, { model: swapped })).rejects.toThrow(/guardModel/);
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(Object.isFrozen(g)).toBe(true);
  });

  it("the guarded model and its spec are frozen: doGenerate cannot be swapped after registration (re-check L4)", async () => {
    const model = mockModel([toolCallResult("askClarifyingQuestions", { slots: ["buyFrom"] })]);
    const handle = mockHandle("planner", model);
    const { guarded: g } = guarded(handle);
    expect(Object.isFrozen(g.model)).toBe(true);
    expect(Object.isFrozen(g.spec)).toBe(true);
    const raw = (handle.model as unknown as { doGenerate: unknown }).doGenerate;
    expect(() => {
      (g.model as unknown as { doGenerate: unknown }).doGenerate = raw;
    }).toThrow(TypeError);
    expect(() => {
      (g.spec as { modelId: string }).modelId = "claude-haiku-5-5";
    }).toThrow(TypeError);
    // Still a working model: the planner runs through the guard.
    await runPlannerTurn({ turns, context: RINA_PLANNER_CONTEXT }, { model: g });
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("isGuardedModel is true only for objects guardModel created", () => {
    const handle = mockHandle("planner", mockModel([]));
    const { guarded: g } = guarded(handle);
    expect(isGuardedModel(g)).toBe(true);
    expect(isGuardedModel({ ...g })).toBe(false);
    expect(isGuardedModel(handle)).toBe(false);
    expect(isGuardedModel(null)).toBe(false);
  });
});

describe("LLM call log", () => {
  it("records model, prompt/response hashes, usage and latency for every call (each step)", async () => {
    const model = mockModel([toolCallResult("getFx", { pair: "CNY/MYR" }), textResult("rate is fixture")]);
    const { guarded: g, sink } = guarded(mockHandle("planner", model));
    await generateText({
      model: g.model,
      ...g.settings,
      prompt: `budget RM10,000, phone ${CANARY.phoneMy}`,
      tools: { getFx: tool({ inputSchema: z.object({ pair: z.string() }), execute: async () => ({ v: "0.61" }) }) },
      stopWhen: isStepCount(3),
    });
    expect(sink.records).toHaveLength(2);
    const [a, b] = sink.records;
    expect(a).toMatchObject({ id: "llm-1", facilityId: "fac-rina", traceId: "trace-test", role: "planner", provider: "anthropic", modelId: "claude-sonnet-5-5", outcome: "ok" });
    expect(a?.promptHash).toMatch(HEX32);
    expect(a?.responseHash).toMatch(HEX32);
    expect(a?.promptHash).not.toBe(b?.promptHash);
    expect(a?.tokens).toEqual({ input: 12, output: 7 });
    expect(a?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(a?.redactionReport.count).toBe(1);
    expect(a?.paramsJson).toMatchObject({ toolNames: ["getFx"], maxOutputTokens: 4096 });
    expect(g.records).toEqual(sink.records);
    // Hashes only: the log never holds prompt text.
    expect(JSON.stringify(sink.records)).not.toContain("RM10,000");
    // promptHash is the hash of the REDACTED request, the same bytes the provider received.
    const sentPrompt = model.doGenerateCalls[0]?.prompt;
    expect(JSON.stringify(sentPrompt)).toContain("<MY_PHONE>");
  });

  it("a refusal is logged with outcome refusal and the raw stop reason", async () => {
    const model = mockModel([refusalResult()]);
    const { guarded: g, sink } = guarded(mockHandle("planner", model));
    const res = await generateText({ model: g.model, ...g.settings, prompt: "x" });
    expect(res.finishReason).toBe("content-filter");
    expect(sink.records[0]).toMatchObject({ outcome: "refusal", finishReason: "content-filter", rawFinishReason: "refusal" });
  });

  it("a provider error is logged (no response hash) and rethrown", async () => {
    const model = mockModel([]);
    model.doGenerate = async () => {
      throw new Error("upstream 529");
    };
    const { guarded: g, sink } = guarded(mockHandle("reader", model));
    await expect(generateText({ model: g.model, ...g.settings, prompt: "x", maxRetries: 0 })).rejects.toThrow("upstream 529");
    expect(sink.records[0]).toMatchObject({ outcome: "error", responseHash: null, role: "reader" });
  });

  it("toLlmCallRow keeps exactly the llm_calls columns", () => {
    const row = toLlmCallRow({
      id: "llm-1",
      facilityId: "fac-rina",
      traceId: null,
      role: "planner",
      provider: "anthropic",
      modelId: "claude-sonnet-5-5",
      paramsJson: {},
      promptHash: keccak256Utf8("p"),
      responseHash: null,
      redactionReport: { entities: [], count: 0 },
      latencyMs: 3,
      tokens: null,
      outcome: "error",
      finishReason: null,
      rawFinishReason: null,
    });
    expect(Object.keys(row).sort()).toEqual(
      ["facilityId", "id", "latencyMs", "modelId", "paramsJson", "promptHash", "provider", "redactionReport", "responseHash", "role", "tokens", "traceId"].sort(),
    );
  });
});

describe("streaming calls go through the same gate", () => {
  it("redacts the prompt and writes one call record when the stream finishes", async () => {
    const { streamText, simulateReadableStream } = await import("ai");
    const { MockLanguageModelV4 } = await import("ai/test");
    const model = new MockLanguageModelV4({
      provider: "anthropic.messages",
      modelId: "claude-sonnet-5-5",
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "ok" },
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage: { inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } } },
          ],
        }),
      }),
    });
    const { guarded: g, sink } = guarded(mockHandle("planner", model));
    const res = streamText({ model: g.model, ...g.settings, prompt: `IC ${CANARY.myKad}` });
    expect(await res.text).toBe("ok");
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).not.toContain(CANARY.myKad);
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({ outcome: "ok", tokens: { input: 3, output: 1 }, redactionReport: { count: 1 } });
  });
});

describe("streams: nothing is released before the call record is written (security audit run-3)", () => {
  type Part = { readonly type: string };
  type RawStreamModel = { doStream(o: unknown): Promise<{ stream: ReadableStream<Part> }> };
  const FINISH = { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage: { inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } } };
  const PARTS = [{ type: "stream-start", warnings: [] }, { type: "text-start", id: "t1" }, { type: "text-delta", id: "t1", delta: "ok" }, { type: "text-end", id: "t1" }, FINISH];
  const PROMPT = { prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };

  async function streamingGuard(inner: () => ReadableStream<Part>, sink: { record(r: unknown): void | Promise<void> }) {
    const { MockLanguageModelV4 } = await import("ai/test");
    const model = new MockLanguageModelV4({ provider: "anthropic.messages", modelId: "claude-sonnet-5-5", doStream: async () => ({ stream: inner() as never }) });
    const g = guardModel(mockHandle("planner", model), { redactor: new FakeRedactor(), outboundGuard: canaryGuard, sink, context: { facilityId: "f", traceId: null }, newId: () => "llm-s" });
    return g.model as unknown as RawStreamModel;
  }
  const finite = () => new ReadableStream<Part>({ start: (c) => { for (const p of PARTS) c.enqueue(p); c.close(); } });

  it("the record is written before the first part reaches the consumer", async () => {
    const log: string[] = [];
    const m = await streamingGuard(finite, { record: async () => void log.push("record") });
    const { stream } = await m.doStream(PROMPT);
    for await (const part of stream) log.push(part.type);
    expect(log).toEqual(["record", ...PARTS.map((p) => p.type)]);
  });

  it("a sink that throws errors the stream with nothing released", async () => {
    const m = await streamingGuard(finite, { record: () => { throw new Error("call log down"); } });
    const { stream } = await m.doStream(PROMPT);
    const got: string[] = [];
    await expect((async () => { for await (const part of stream) got.push(part.type); })()).rejects.toThrow("call log down");
    expect(got).toEqual([]);
  });

  it("a consumer that cancels mid-stream still gets a call record (outcome error), and the provider stream is cancelled", async () => {
    let providerCancelled = false;
    const hanging = () => new ReadableStream<Part>({ start: (c) => { c.enqueue(PARTS[0] as Part); c.enqueue(PARTS[2] as Part); }, cancel: () => void (providerCancelled = true) });
    const sink = new CapturingSink();
    const m = await streamingGuard(hanging, sink);
    const reader = (await m.doStream(PROMPT)).stream.getReader();
    const first = reader.read();
    await reader.cancel("user closed the chat");
    expect(await first).toEqual({ done: true, value: undefined });
    expect(providerCancelled).toBe(true);
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({ outcome: "error", responseHash: null });
  });

  it("streamText aborted with an AbortSignal still writes a record", async () => {
    const { streamText } = await import("ai");
    const { MockLanguageModelV4 } = await import("ai/test");
    const hanging = new ReadableStream<Part>({ start: (c) => { c.enqueue(PARTS[0] as Part); c.enqueue(PARTS[1] as Part); c.enqueue(PARTS[2] as Part); } });
    const model = new MockLanguageModelV4({ provider: "anthropic.messages", modelId: "claude-sonnet-5-5", doStream: async () => ({ stream: hanging as never }) });
    const { guarded: g, sink } = guarded(mockHandle("planner", model));
    const abort = new AbortController();
    const res = streamText({ model: g.model, ...g.settings, prompt: "hi", abortSignal: abort.signal });
    const text = Promise.resolve(res.text).catch(() => "");
    await expect.poll(() => model.doStreamCalls.length).toBe(1);
    abort.abort();
    expect(await text).toBe("");
    await expect.poll(() => sink.records.length).toBe(1);
    expect(sink.records[0]).toMatchObject({ outcome: "error", responseHash: null });
  });

  it("an error part in the stream writes an error record and releases no content (re-check L3)", async () => {
    const withError = () =>
      new ReadableStream<Part>({
        start: (c) => {
          for (const p of [PARTS[0], PARTS[1], PARTS[2], { type: "error", error: new Error("overloaded") }, FINISH]) c.enqueue(p as Part);
          c.close();
        },
      });
    const sink = new CapturingSink();
    const m = await streamingGuard(withError, sink);
    const { stream } = await m.doStream(PROMPT);
    const got: string[] = [];
    await expect((async () => { for await (const part of stream) got.push(part.type); })()).rejects.toThrow("overloaded");
    expect(got).toEqual([]);
    expect(sink.records).toEqual([expect.objectContaining({ outcome: "error", responseHash: null })]);
  });

  it("a stream that ends without a finish part releases no content (re-check L3)", async () => {
    const truncated = () => new ReadableStream<Part>({ start: (c) => { for (const p of PARTS.slice(0, 3)) c.enqueue(p as Part); c.close(); } });
    const sink = new CapturingSink();
    const m = await streamingGuard(truncated, sink);
    const { stream } = await m.doStream(PROMPT);
    const got: string[] = [];
    await expect((async () => { for await (const part of stream) got.push(part.type); })()).rejects.toThrow(/without a finish/);
    expect(got).toEqual([]);
    expect(sink.records).toEqual([expect.objectContaining({ outcome: "error", responseHash: null })]);
  });

  it("a provider stream that fails mid-way writes an error record and releases nothing", async () => {
    const failing = () => new ReadableStream<Part>({ start: (c) => { c.enqueue(PARTS[2] as Part); c.error(new Error("socket reset")); } });
    const sink = new CapturingSink();
    const m = await streamingGuard(failing, sink);
    const { stream } = await m.doStream(PROMPT);
    const got: string[] = [];
    await expect((async () => { for await (const part of stream) got.push(part.type); })()).rejects.toThrow("socket reset");
    expect(got).toEqual([]);
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({ outcome: "error", responseHash: null });
  });
});
