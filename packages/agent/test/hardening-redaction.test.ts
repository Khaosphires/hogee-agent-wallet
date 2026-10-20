/**
 * Security audit run-8 hardening: nested JSON key context in tool-result redaction (h-privacy). Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import { privacyRedactor, redactPrompt, type ModelPrompt } from "../src/guard/redaction";

describe("redaction: nested JSON values keep their parent key and a type/kind sibling as context (run-8 h-privacy)", () => {
  const toolResult = (value: unknown): ModelPrompt => [
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "getPlan", output: { type: "json", value: value as never } }] },
  ];
  const redacted = async (value: unknown) => {
    const { prompt } = await redactPrompt(toolResult(value), privacyRedactor);
    return (prompt[0] as unknown as { content: [{ output: { value: unknown } }] }).content[0].output.value;
  };

  it.each([
    ["a phone object", { phone: { number: "91234567" } }, { phone: { number: "<SG_PHONE>" } }],
    ["a type sibling", [{ type: "mobile", value: "91234567" }], [{ type: "mobile", value: "<SG_PHONE>" }]],
    ["a kind sibling after the value, number leaf", { contacts: [{ value: 81234567, kind: "WhatsApp" }] }, { contacts: [{ value: "<SG_PHONE>", kind: "WhatsApp" }] }],
    ["a grandparent key", { contact: { details: { value: "81234567" } } }, { contact: { details: { value: "<SG_PHONE>" } } }],
    ["a bank account object", { payout: { type: "bankAccount", value: "1234567890" } }, { payout: { type: "bankAccount", value: "<MY_BANK_ACCOUNT>" } }],
  ])("%s", async (_name, value, expected) => {
    expect(await redacted(value)).toEqual(expected);
  });

  it("an amount key still keeps an amount, and an amount-like parent never vetoes a child's own key", async () => {
    expect(await redacted({ phone: { totalMinor: "91234567" } })).toEqual({ phone: { totalMinor: "91234567" } });
    expect(await redacted({ totals: { phone: "91234567" } })).toEqual({ totals: { phone: "<SG_PHONE>" } });
    expect(await redacted([{ type: "price", value: "91234567" }])).toEqual([{ type: "price", value: "91234567" }]);
  });

  it("an identifier in a parent key or a type value is never context (it is redacted, not re-scanned)", async () => {
    expect(await redacted({ "call +65 9123 4567": { number: "81234567" } })).toEqual({ "call <SG_PHONE>": { number: "<SG_PHONE>" } });
    expect(await redacted([{ type: "+65 9123 4567", value: "no id here" }])).toEqual([{ type: "<SG_PHONE>", value: "no id here" }]);
  });
});
