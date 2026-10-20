/**
 * Error text helpers. Node and RPC errors can carry a provider URL with an API key in it (viem puts the
 * request URL in the message and `details`), so what leaves this package is redacted:
 * - outcome reasons use {@link shortErrorReason} (first line only, URLs redacted, length capped);
 * - errors rethrown by `broadcast`, `fillNonceHoles`, `signAndStore` and `headAt` go through
 *   {@link redactError}: one that carries a URL anywhere in its cause chain is replaced by a RedactedError
 *   with a redacted message and the original as `cause` (callers must not log `cause` verbatim). Errors
 *   with nothing to redact are rethrown unchanged, so typed errors keep their class.
 */

/** Messages and `details` of an error and its `cause` chain, joined (for classifying node errors). */
export function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (current instanceof Error) parts.push(current.message, (current as { details?: string }).details ?? '');
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

/** URL shapes a provider key can hide in, most specific first. Each match becomes `<url>`. */
const URL_PATTERNS: readonly RegExp[] = [
  // JSON-escaped: https:\/\/host\/v2\/<key>
  /\b[a-z][a-z0-9+.-]*:\\\/\\\/[^\s'"<>]*/gi,
  // percent-encoded: https%3A%2F%2Fhost%2Fv2%2F<key>
  /\b[a-z][a-z0-9+.-]*%3a%2f%2f[^\s'"<>]*/gi,
  // scheme://… (http, https, ws, wss, postgres, …)
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi,
  // schemeless host[:port]/path, e.g. eth-sepolia.g.alchemy.com/v2/<key>
  /\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\/[^\s'"<>]*/gi,
];

/**
 * Bare provider keys that can surface outside a URL (an echoed request body or header). Each match becomes `<key>`.
 * VISION-DECISIONS §7: Tavily keys (`tvly-…`, TAVILY_API_KEY); `tvly-` plus at least 8 key characters, so prose that
 * merely names the prefix stays readable.
 */
const KEY_PATTERNS: readonly RegExp[] = [/\btvly-[A-Za-z0-9_-]{8,}/g];

/** `text` with every URL (escaped, encoded or schemeless) replaced by `<url>` and every known key by `<key>`. */
export function redactText(text: string): string {
  const noUrls = URL_PATTERNS.reduce((out, re) => out.replace(re, '<url>'), text);
  return KEY_PATTERNS.reduce((out, re) => out.replace(re, '<key>'), noUrls);
}

const DEFAULT_REASON_LENGTH = 160;

/** `<name>: <first line of the short message>`, URLs replaced by `<url>`, at most `max` chars. */
export function shortErrorReason(error: unknown, max: number = DEFAULT_REASON_LENGTH): string {
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? ((error as { shortMessage?: string }).shortMessage ?? error.message) : String(error);
  const text = redactText(`${name}: ${message.split('\n')[0] ?? ''}`);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A rethrown error whose original (in `cause`) carried a URL. Its own message is redacted. */
export class RedactedError extends Error {
  override readonly name = 'RedactedError';
}

/** `error` itself when nothing in it needs redacting, else a RedactedError wrapping it (idempotent). */
export function redactError(error: unknown): unknown {
  if (error instanceof RedactedError) return error;
  const text = error instanceof Error ? `${errorText(error)} | ${(error as { shortMessage?: string }).shortMessage ?? ''}` : String(error);
  if (redactText(text) === text) return error;
  return new RedactedError(shortErrorReason(error), { cause: error });
}
