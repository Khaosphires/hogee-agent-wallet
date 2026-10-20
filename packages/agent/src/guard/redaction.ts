/**
 * Redaction gate (project.md §7.1 "redact PII before the first send", §12.2, §14.1). EVERY model call passes its whole
 * prompt through an injected `Redactor` (production: `@hogee/privacy` `redact`, pure TypeScript recognizers, see
 * docs/decisions/privacy.md) BEFORE the provider sees it. Fail CLOSED: a redactor that throws, or returns anything
 * malformed, blocks the call.
 *
 * What is redacted: the system message, every text part (user and assistant), and every string inside tool results
 * (text, error text, JSON keys and leaves, content text). What is kept: reasoning parts (opaque and signed by the
 * provider; editing them breaks the next step) and tool-call inputs (JSON the model produced from already-redacted
 * context). The outbound canary (guarded-model.ts) then scans the serialised redacted prompt, tool-call inputs included.
 * Every other part is refused (an allow-list, so a new part type fails closed): file, reasoning-file and custom parts
 * cannot be redacted, and two JSON keys that redact to the same text are refused rather than merged.
 *
 * JSON leaves are redacted twice: alone (so a key can never veto a match, e.g. a card number under "price"), then as
 * "<context>: <value>" (so a context-only entity, e.g. a bare 8-digit SG phone under "phone", is caught). The context
 * is the leaf's own key after the words a nested value inherits: its parent keys and a "type" / "kind" sibling
 * (security audit run-8). Number leaves are redacted too and become strings only when something was found.
 */
import type { LanguageModelMiddleware } from "ai";
import { z } from "zod";
import { assertNoIds, redact, type RedactionResult } from "@hogee/privacy";

export interface Redactor {
  redact(text: string): Promise<RedactionResult>;
}

/** Production redactor: `@hogee/privacy` `redact` (it throws on a bad config or an over-size input, so calls fail closed). */
export const privacyRedactor: Redactor = { redact };

/** Synchronous canary over the outbound text; throws to block. Production: `@hogee/privacy` `assertNoIds`. */
export type OutboundGuard = (text: string) => void;
export const privacyOutboundGuard: OutboundGuard = assertNoIds;

export class RedactionUnavailableError extends Error {
  override readonly name = "RedactionUnavailableError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(`redaction unavailable, model call blocked: ${message}`, options);
  }
}

type CallOptions = Parameters<NonNullable<LanguageModelMiddleware["transformParams"]>>[0]["params"];
export type ModelPrompt = CallOptions["prompt"];
type Message = ModelPrompt[number];
type ToolResultOutput = Extract<Extract<Message, { role: "tool" }>["content"][number], { type: "tool-result" }>["output"];

export interface RedactedSpan {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  /**
   * Which redacted string (in prompt order) the offsets belong to. A JSON leaf's key-context pass has its own part
   * number, and its offsets index the leaf as the previous (alone) part left it.
   */
  readonly part: number;
}
export interface PromptRedactionReport {
  readonly entities: readonly RedactedSpan[];
  readonly count: number;
}

const RedactionResultSchema = z.object({
  text: z.string(),
  report: z.object({
    entities: z.array(z.object({ type: z.string().min(1).max(64), start: z.number().int().min(0), end: z.number().int().min(0) })),
    count: z.number().int().min(0),
  }),
});

type JsonValue = null | string | number | boolean | JsonValue[] | { [k: string]: JsonValue };

/**
 * The context a JSON key gives its value, as words the recognizers' context lists can match: camelCase split
 * ("contactPhone" → "contact Phone"), and a plural word's singular added ("phones" → "phones phone").
 */
export function keyContext(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const singulars = [...spaced.matchAll(/[A-Za-z]{3,}(?=s(?![A-Za-z]))/g)].map((m) => m[0]);
  return [spaced, ...singulars].join(" ");
}

/** Sibling fields whose word value names what the other fields of an object hold: [{"type": "mobile", "value": …}]. */
const KIND_KEYS: ReadonlySet<string> = new Set(["type", "kind"]);
/**
 * An inherited context keeps only its nearest words: the recognizers look at most 48 characters before a value
 * (data/pii/recognizers.json), and the cap bounds the prefix, and so the per-leaf cost, however deep the JSON nests.
 */
const MAX_INHERITED_CONTEXT = 48;

/**
 * Letters only, redaction placeholders dropped: an inherited context never carries a digit or an "<ENTITY>", so it can
 * never put an identifier in front of a value (withContext would fail closed on it).
 */
const contextWords = (s: string): string => s.replace(/<[A-Z_]+>/g, " ").replace(/[^\p{L}]+/gu, " ").trim();

/**
 * The context an object hands its fields (security audit run-8, h-privacy): its own context (the parent key chain)
 * plus the word value of a "type" / "kind" sibling, cut to the nearest MAX_INHERITED_CONTEXT characters. So
 * {"phone": {"number": "…"}} reads "phone number: …" and [{"type": "mobile", "value": "…"}] reads "mobile value: …".
 * The field's own key always comes last, next to the value, so only the own key can veto a match (a money word must
 * touch the value), as before.
 */
function inheritedContext(context: string | null, v: { readonly [k: string]: JsonValue }): string {
  const kinds = Object.entries(v).flatMap(([k, x]) => (KIND_KEYS.has(k.toLowerCase()) && typeof x === "string" ? [contextWords(keyContext(x))] : []));
  const words = [contextWords(context ?? ""), ...kinds].filter((w) => w.length > 0).join(" ");
  if (words.length <= MAX_INHERITED_CONTEXT) return words;
  const tail = words.slice(-MAX_INHERITED_CONTEXT);
  return tail.slice(tail.indexOf(" ") + 1);
}

/** Redacts strings one at a time, in prompt order, collecting a combined report. */
class PromptRedactor {
  private part = 0;
  readonly entities: RedactedSpan[] = [];
  constructor(private readonly redactor: Redactor) {}

  private async call(s: string): Promise<z.infer<typeof RedactionResultSchema>> {
    let raw: unknown;
    try {
      raw = await this.redactor.redact(s);
    } catch (e) {
      throw new RedactionUnavailableError(e instanceof Error ? e.name : "redactor failed", { cause: e });
    }
    const parsed = RedactionResultSchema.safeParse(raw);
    if (!parsed.success) throw new RedactionUnavailableError("redactor returned a malformed result");
    return parsed.data;
  }

  async text(s: string): Promise<string> {
    const part = this.part;
    this.part += 1;
    if (s.length === 0) return s;
    const r = await this.call(s);
    for (const e of r.report.entities) this.entities.push({ type: e.type, start: e.start, end: e.end, part });
    return r.text;
  }

  /**
   * `s` (already redacted alone) redacted again behind its key: "<context>: <s>". Fails closed when the redactor
   * touches the context prefix, since the value could then not be cut out of the result cleanly.
   */
  async withContext(context: string, s: string): Promise<string> {
    const part = this.part;
    this.part += 1;
    if (s.length === 0 || context.length === 0) return s;
    const prefix = `${context}: `;
    const r = await this.call(prefix + s);
    if (!r.text.startsWith(prefix) || r.report.entities.some((e) => e.start < prefix.length)) {
      throw new RedactionUnavailableError("a tool-result value could not be redacted apart from its key");
    }
    for (const e of r.report.entities) this.entities.push({ type: e.type, start: e.start - prefix.length, end: e.end - prefix.length, part });
    return r.text.slice(prefix.length);
  }

  /** A leaf: alone first (a key can never veto a match), then behind its key (context-only entities). */
  private async leaf(s: string, context: string | null): Promise<string> {
    const alone = await this.text(s);
    return context === null ? alone : this.withContext(context, alone);
  }

  async json(v: JsonValue, context: string | null = null): Promise<JsonValue> {
    if (typeof v === "string") return this.leaf(v, context);
    if (typeof v === "number") {
      // A number can be an identifier too ({"phone": 91234567}); it stays a number unless something was redacted.
      const s = String(v);
      const out = await this.leaf(s, context);
      return out === s ? v : out;
    }
    if (Array.isArray(v)) {
      const out: JsonValue[] = [];
      for (const x of v) out.push(await this.json(x, context));
      return out;
    }
    if (v !== null && typeof v === "object") {
      // Keys are redacted too (a tool can key a map by an ID). Object.fromEntries keeps a "__proto__" key as data.
      const entries: [string, JsonValue][] = [];
      const keys = new Set<string>();
      const inherited = inheritedContext(context, v);
      for (const [k, x] of Object.entries(v)) {
        const key = await this.text(k);
        if (keys.has(key)) throw new RedactionUnavailableError("two tool-result keys redact to the same text");
        keys.add(key);
        // The REDACTED key is the context: a key that holds an ID never reaches the redactor a second time.
        const own = keyContext(key);
        entries.push([key, await this.json(x, inherited.length > 0 ? `${inherited} ${own}` : own)]);
      }
      return Object.fromEntries(entries);
    }
    return v;
  }

  async toolOutput(o: ToolResultOutput): Promise<ToolResultOutput> {
    switch (o.type) {
      case "text":
      case "error-text":
        return { ...o, value: await this.text(o.value) };
      case "json":
      case "error-json":
        return { ...o, value: (await this.json(o.value as JsonValue)) as typeof o.value };
      case "execution-denied":
        return o.reason === undefined ? o : { ...o, reason: await this.text(o.reason) };
      case "content": {
        const value: typeof o.value = [];
        for (const item of o.value) {
          if (item.type !== "text") throw new RedactionUnavailableError(`tool-result ${item.type} content cannot be redacted`);
          value.push({ ...item, text: await this.text(item.text) });
        }
        return { ...o, value };
      }
    }
  }

  async message(m: Message): Promise<Message> {
    switch (m.role) {
      case "system":
        return { ...m, content: await this.text(m.content) };
      case "user": {
        const content: typeof m.content = [];
        for (const p of m.content) {
          if (p.type !== "text") throw new RedactionUnavailableError(`user ${p.type} parts cannot be redacted`);
          content.push({ ...p, text: await this.text(p.text) });
        }
        return { ...m, content };
      }
      case "assistant": {
        const content: typeof m.content = [];
        for (const p of m.content) {
          if (p.type === "text") content.push({ ...p, text: await this.text(p.text) });
          else if (p.type === "tool-result") content.push({ ...p, output: await this.toolOutput(p.output) });
          else if (p.type === "reasoning" || p.type === "tool-call") content.push(p);
          else throw new RedactionUnavailableError(`assistant ${p.type} parts cannot be redacted`);
        }
        return { ...m, content };
      }
      case "tool": {
        const content: typeof m.content = [];
        for (const p of m.content) {
          if (p.type === "tool-result") content.push({ ...p, output: await this.toolOutput(p.output) });
          else if (p.type === "tool-approval-response") content.push(p.reason === undefined ? p : { ...p, reason: await this.text(p.reason) });
          else throw new RedactionUnavailableError(`tool ${(p as { type: string }).type} parts cannot be redacted`);
        }
        return { ...m, content };
      }
    }
  }
}

/** Redact a whole model prompt (sequentially, prompt order). Throws RedactionUnavailableError (fail closed). */
export async function redactPrompt(prompt: ModelPrompt, redactor: Redactor): Promise<{ prompt: ModelPrompt; report: PromptRedactionReport }> {
  const r = new PromptRedactor(redactor);
  const out: Message[] = [];
  for (const m of prompt) out.push(await r.message(m));
  return { prompt: out, report: { entities: r.entities, count: r.entities.length } };
}
