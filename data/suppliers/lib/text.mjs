/**
 * Listing text, snippet hashes and output helpers for the supplier generator.
 * snippetHash matches core's snippetHash (0x + sha256 of the sentence trimmed, whitespace runs collapsed to one
 * space) for the plain sentences written here; packages/api/test/supplier-demo-catalog.test.ts re-checks every hash
 * with core itself.
 */
import { createHash } from "node:crypto";

export function snippetHash(sentence) {
  const normalized = sentence.trim().split(/\s+/).join(" ");
  if (!normalized) throw new Error("empty snippet");
  return `0x${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
}

const codePoints = (s) => Array.from(s).length;

/**
 * One sentence per line, in order. Returns the text (ending in a newline) and each keyed line's span as code-point
 * offsets [start, end) into that text (the SupplierEvalLabel span convention).
 */
export function listingText(lines) {
  const spans = {};
  let offset = 0;
  for (const { key, text } of lines) {
    if (text.includes("\n")) throw new Error("a listing line cannot contain a newline");
    if (key) spans[key] = { start: offset, end: offset + codePoints(text) };
    offset += codePoints(text) + 1;
  }
  return { text: `${lines.map((l) => l.text).join("\n")}\n`, spans };
}

/** The listing line with `key` (throws when absent: a fact must be backed by a sentence in the raw text). */
export function lineOf(lines, key) {
  const line = lines.find((l) => l.key === key);
  if (!line) throw new Error(`listing has no "${key}" line`);
  return line.text;
}

/** Stable JSON file content: 2-space indent, trailing newline. */
export const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** CNY fen → "5.60". */
export const cny = (fen) => `${Math.floor(fen / 100)}.${String(fen % 100).padStart(2, "0")}`;

/** A Sourced leaf for a mock listing fact backed by `sentence` of the raw text (tier is simulated; sourceType stays mock). */
export function mockSourced(value, url, sentence, retrievedAt, evidence = "tier3") {
  return { value, sourceUrl: url, retrievedAt, snippetHash: snippetHash(sentence), evidence, sourceType: "mock" };
}
