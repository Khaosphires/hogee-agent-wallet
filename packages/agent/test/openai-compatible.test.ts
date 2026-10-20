/**
 * DeepSeek / Qwen / Ollama path (OpenAI-compatible provider, no strict-schema mode): JSON mode, the schema stated in
 * the instructions, code fences stripped, zod-validated by the Reader. Fake fetch, no network.
 */
import { describe, expect, it } from "vitest";
import { createModelRegistry } from "../src/models/registry";
import { auditCallOptions } from "../src/models/rules";
import { readDocument } from "../src/reader/reader";
import { guarded } from "./helpers/mock-model";

const output = {
  invoiceNumber: "INV-9",
  issuerName: null,
  currency: "MYR",
  total: { value: "42.00", unit: "MYR", snippet: "TOTAL DUE: MYR 42.00" },
  lineItems: [],
  addressesAiAgents: false,
  mentionsPaymentChange: false,
};

function fakeOpenAiCompatible(content: string) {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    const reply = {
      id: "chatcmpl-fx",
      object: "chat.completion",
      created: 1_760_000_000,
      model: "deepseek-flash",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
    };
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { sent, fakeFetch };
}

describe("OpenAI-compatible Reader (DeepSeek)", () => {
  it("sends JSON mode with the schema in the instructions, no sampling params, and parses a fenced reply", async () => {
    const { sent, fakeFetch } = fakeOpenAiCompatible(`\`\`\`json\n${JSON.stringify(output)}\n\`\`\``);
    const env = { MODEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "offline-placeholder" };
    const registry = createModelRegistry(env, { fetch: fakeFetch });
    const { guarded: g, sink } = guarded(registry.handle("reader"));
    const r = await readDocument({ kind: "invoice", docId: "inv-9", text: "INVOICE No. INV-9\nTOTAL DUE: MYR 42.00" }, { model: g });
    expect(r.fields.total?.value.amountMinor).toBe("4200");
    const body = sent[0]?.body ?? {};
    expect(sent[0]?.url).toBe("https://api.deepseek.com/chat/completions");
    expect(body.model).toBe("deepseek-flash");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.tools).toBeUndefined();
    expect(auditCallOptions(body)).toEqual([]);
    expect(JSON.stringify(body.messages)).toContain("JSON Schema");
    expect(sink.records[0]).toMatchObject({ provider: "deepseek", modelId: "deepseek-flash", role: "reader", tokens: { input: 30, output: 20 } });
  });
});
