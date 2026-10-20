/**
 * Streams a journey reply as an AI SDK UI-message stream, as the live API does: one text block per text part (word by
 * word, for the typing effect) and the data parts in order.
 */
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import type { JourneyPart } from "@hogee/core";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function streamReply(messageId: string, parts: readonly JourneyPart[], delayMs = 18): Response {
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      writer.write({ type: "start", messageId });
      for (const [i, p] of parts.entries()) {
        if (p.type !== "text") {
          writer.write({ type: p.type, ...(p.id ? { id: p.id } : {}), data: p.data } as Parameters<typeof writer.write>[0]);
          continue;
        }
        const id = `${messageId}-t${i}`;
        writer.write({ type: "text-start", id });
        for (const word of p.text.split(/(?<= )/)) {
          writer.write({ type: "text-delta", id, delta: word });
          if (delayMs > 0) await sleep(delayMs);
        }
        writer.write({ type: "text-end", id });
      }
      writer.write({ type: "finish" });
    },
  });
  return createUIMessageStreamResponse({ stream });
}
