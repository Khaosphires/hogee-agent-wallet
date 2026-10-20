/**
 * Streams stored parts as an AI SDK UI-message stream (§26.6): start, one text block per text part, the data parts,
 * finish. The parts are exactly what was stored (persistTurn validated them), so the live stream and a reload agree.
 */
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";

type Part = Readonly<Record<string, unknown>>;

export function streamParts(messageId: string, list: readonly object[]): Response {
  const parts = list as readonly Part[];
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({ type: "start", messageId });
      parts.forEach((p, i) => {
        if (p.type === "text") {
          const id = `${messageId}-t${i}`;
          writer.write({ type: "text-start", id });
          writer.write({ type: "text-delta", id, delta: String(p.text) });
          writer.write({ type: "text-end", id });
        } else {
          writer.write({ type: p.type as `data-${string}`, ...(typeof p.id === "string" ? { id: p.id } : {}), data: p.data });
        }
      });
      writer.write({ type: "finish" });
    },
  });
  return createUIMessageStreamResponse({ stream });
}
