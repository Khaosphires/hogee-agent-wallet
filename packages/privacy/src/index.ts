// PII redaction before every LLM call (project.md §12.2, §14.1, §26.8). P1 froze these signatures at G0; P3 task 3.11
// fills the bodies. DEVIATION (docs/decisions/privacy.md): pure TypeScript, no Presidio service (the demo machine may
// not run Docker). data/pii/recognizers.json keeps the Presidio ad-hoc recognizer format, and the date / region /
// checksum re-checks run in validators.ts. Fail closed: a bad config, a non-string or an over-size input throws.
import { canaryHits } from "./canary";
import { loadCanary, loadRecognizers } from "./config";
import { detect } from "./detect";
import { PiiLeakError, PrivacyInputTooLargeError, type PiiEntityName } from "./errors";

export { PiiCanaryFile, PiiRecognizersFile, compileCanary, compileRecognizers } from "./config";
export { PiiLeakError, PrivacyConfigError, PrivacyInputTooLargeError, type PiiEntityName } from "./errors";
export { linearRegexProblem } from "./safe-regex";
export { isCreditCard, isIdNik, isMyNric, isMyNricPlain, isSgNric, luhn } from "./validators";

/** redact() refuses longer input (one prompt part; the E5 docs are ≤ 20,000 characters). */
export const MAX_REDACT_CHARS = 1_048_576;
/** assertNoIds() refuses longer input (a whole serialised prompt, tool definitions included). */
export const MAX_CANARY_CHARS = 4 * MAX_REDACT_CHARS;

export type RedactionSpan = {
  /** One of the frozen PiiEntity names, or another detected type (e.g. "SG_NRIC", "EMAIL_ADDRESS"). */
  readonly type: PiiEntityName;
  /** Offsets into the ORIGINAL text, end exclusive. */
  readonly start: number;
  readonly end: number;
};

export type RedactionResult = {
  readonly text: string;
  readonly report: {
    readonly entities: readonly RedactionSpan[];
    readonly count: number;
  };
};

function checkInput(fn: string, text: unknown, max: number): asserts text is string {
  if (typeof text !== "string") throw new TypeError(`${fn} expects a string`);
  if (text.length > max) throw new PrivacyInputTooLargeError(text.length, max);
}

/**
 * Replaces each detected identifier with `<ENTITY_TYPE>` (the spec names no format). Spans index the ORIGINAL text,
 * end exclusive, sorted and non-overlapping. Deterministic: the same input always gives the same output.
 */
export async function redact(text: string): Promise<RedactionResult> {
  checkInput("redact", text, MAX_REDACT_CHARS);
  if (text.length === 0) return { text, report: { entities: [], count: 0 } };
  const entities = detect(text, loadRecognizers());
  let out = "";
  let at = 0;
  for (const s of entities) {
    out += `${text.slice(at, s.start)}<${s.type}>`;
    at = s.end;
  }
  return { text: out + text.slice(at), report: { entities, count: entities.length } };
}

/** Canary: throws PiiLeakError if any data/pii/canary-patterns.json pattern matches. Synchronous. */
export function assertNoIds(text: string): void {
  checkInput("assertNoIds", text, MAX_CANARY_CHARS);
  const hits = canaryHits(text, loadCanary());
  if (hits.length > 0) throw new PiiLeakError(hits);
}
