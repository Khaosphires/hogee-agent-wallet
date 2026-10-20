/**
 * The planner chat session id: a UUIDv7 the client creates (project.md §26.3) and keeps per browser, so the plan
 * and supplier pages read the draft of the same conversation. Storage can fail (private mode); then the id lives
 * for this page view only.
 */
const KEY = "hogee.chat.sessionId";
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let memo: string | undefined;

/** RFC 9562 UUIDv7: 48-bit unix ms, version 7, variant 10, 74 random bits. Lowercase. */
export function uuidv7(now = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let ms = BigInt(now);
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = Number(ms & 0xffn);
    ms >>= 8n;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function getChatSessionId(): string {
  if (memo) return memo;
  try {
    const stored = window.localStorage.getItem(KEY);
    if (stored && UUIDV7.test(stored)) return (memo = stored);
    memo = uuidv7();
    window.localStorage.setItem(KEY, memo);
    return memo;
  } catch {
    return (memo ??= uuidv7());
  }
}

/** Start a new conversation (the next getChatSessionId() returns a fresh id). */
export function resetChatSessionId(): string {
  memo = uuidv7();
  try {
    window.localStorage.setItem(KEY, memo);
  } catch {
    // Storage unavailable: the new id lives for this page view.
  }
  return memo;
}
