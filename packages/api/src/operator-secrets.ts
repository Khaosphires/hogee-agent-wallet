/**
 * G0-AUDIT (v-2): operator secrets (OFFICER_TOKEN, PERSONA_COOKIE_SECRET) and the constant-time officer token check
 * behind POST /api/session/persona. Shared by the live API (task 1.12) and P2's api-mock.
 *
 * Attempt limiting and a trace event per failed officer-token attempt belong to the setPersona handler (task 1.12),
 * not to this primitive.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/** Same bounds as @hogee/api-contract OfficerToken (a test pins the two together). */
export const OPERATOR_SECRET_MIN_LENGTH = 32;
export const OPERATOR_SECRET_MAX_LENGTH = 256;
const MIN_DISTINCT_CHARS = 12;
// Published placeholders and copy-paste examples are never valid secrets.
const PLACEHOLDER = /not-a-secret|example/i;

/**
 * A usable operator secret: a string of 32..256 chars, no leading/trailing whitespace, no "not-a-secret" or
 * "example" (any case), and at least 12 distinct characters. `openssl rand -hex 32` passes.
 */
export function isStrongSecret(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= OPERATOR_SECRET_MIN_LENGTH &&
    value.length <= OPERATOR_SECRET_MAX_LENGTH &&
    value === value.trim() &&
    !PLACEHOLDER.test(value) &&
    new Set(value).size >= MIN_DISTINCT_CHARS
  );
}

export const sha256 = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/**
 * Constant-time check of an officer token against the operator secret OFFICER_TOKEN. Fails closed when the secret
 * is unset or weak (isStrongSecret). Both sides are hashed first, so a length difference neither throws nor leaks.
 */
export function officerTokenMatches(given: string, configured: string | undefined): boolean {
  if (typeof given !== "string" || !isStrongSecret(configured)) return false;
  return timingSafeEqual(sha256(given), sha256(configured));
}
