/**
 * The chat answer as the browser sees it: an AI SDK UI-message stream (`data: {json}` lines, `data: [DONE]` last).
 * Every data part is parsed with core ChatDataPart (the frozen part schemas), so a case can never pass on a part the
 * contract would refuse. Text deltas are joined per text block.
 */
import { ChatDataPart } from "@hogee/core";

export interface StreamParts {
  /** Every data part, parsed, in stream order. */
  readonly parts: readonly ChatDataPart[];
  /** The joined text of every text block (what the founder reads). */
  readonly text: string;
  /** `data-*` chunks that failed ChatDataPart (a contract break; the case fails on any). */
  readonly invalid: readonly { readonly type: string; readonly issue: string }[];
  /** Chunk types seen, in order (start, text-delta, data-*, finish, error, ...). */
  readonly chunkTypes: readonly string[];
}

interface Chunk {
  readonly type?: unknown;
  readonly delta?: unknown;
  readonly errorText?: unknown;
}

/** Parses one UI-message stream body. Lines that are not `data: ` lines are ignored (SSE comments, blank lines). */
export function parseUiStream(body: string): StreamParts {
  const parts: ChatDataPart[] = [];
  const invalid: { type: string; issue: string }[] = [];
  const chunkTypes: string[] = [];
  let text = "";
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    let chunk: Chunk;
    try {
      chunk = JSON.parse(line.slice(6)) as Chunk;
    } catch {
      invalid.push({ type: "(not json)", issue: line.slice(0, 80) });
      continue;
    }
    const type = typeof chunk.type === "string" ? chunk.type : "(no type)";
    chunkTypes.push(type);
    if (type === "text-delta" && typeof chunk.delta === "string") text += chunk.delta;
    if (!type.startsWith("data-")) continue;
    const parsed = ChatDataPart.safeParse(chunk);
    if (parsed.success) parts.push(parsed.data);
    else invalid.push({ type, issue: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300) });
  }
  return { parts, text, invalid, chunkTypes };
}

/** The data shape of the part `type`. */
export type DataOf<T extends ChatDataPart["type"]> = Extract<ChatDataPart, { type: T }> extends { data: infer D } ? D : never;

/** The data of the first part of `type`, or null. */
export function firstPart<T extends ChatDataPart["type"]>(s: StreamParts, type: T): DataOf<T> | null {
  const p = s.parts.find((x) => x.type === type);
  return p ? (p.data as DataOf<T>) : null;
}

/** Every part's data of `type`. */
export function partsOf<T extends ChatDataPart["type"]>(s: StreamParts, type: T): DataOf<T>[] {
  return s.parts.filter((x) => x.type === type).map((p) => p.data as DataOf<T>);
}

/** The part types in order (for transcripts and the journey contract). */
export const partTypes = (s: StreamParts): string[] => s.parts.map((p) => p.type);
