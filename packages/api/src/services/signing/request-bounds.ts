/**
 * Bounds on the founder-persona signature writers (audit run-6 v-1). Any caller without a signed cookie reads as the
 * founder (demo design), and every request or refused submission adds signature_requests and traces rows that the
 * evidence export collects, so both writers stay bounded per facility:
 *   - reuse: a request for the same kind, refId and method returns the facility's unexpired PENDING request for it when
 *     that request still carries exactly what would be built now (same struct apart from nonce and expiry, same
 *     panel) and has REUSE_MIN_REMAINING_S left; nothing is inserted or traced;
 *   - supersede (run-6 re-check M2): a new request for a kind, refId and method expires (EXPIRED) the facility's older
 *     PENDING requests for the same three, so each has at most one open request;
 *   - cap: at most MAX_OPEN_REQUESTS distinct open (kind, refId) pairs per facility, counting unexpired PENDING requests
 *     only (a REJECTED one never counts). A request for a new pair past the cap evicts the oldest open pair (its
 *     PENDING requests become EXPIRED). It is never refused: an anonymous caller (who reads as the founder) can no
 *     longer fill the cap and lock the founder out of signing;
 *   - refusals: the MAX_REFUSALS-th refused submission of a request moves it to REJECTED (terminal), so one request
 *     writes at most MAX_REFUSALS ALERT traces. Refusals are counted from those traces (no schema change).
 * Creating a request is not rate-bounded any more (each one writes one row and one SIGNATURE trace): the bound and
 * lockout-freedom cannot both hold while anonymous equals founder, and the demo keeps lockout-freedom.
 */
import { hashObject } from "@hogee/core";

export const MAX_OPEN_REQUESTS = 10;
export const MAX_REFUSALS = 5;
/** A request with less chain time than this left is not handed out again (the founder needs time to sign). */
export const REUSE_MIN_REMAINING_S = 60n;
/** reason_code of the ALERT trace a refused submission writes (traceId = the request id). */
export const REFUSAL_REASON = "INVALID_SIGNATURE";

/** What a request is: its typed data and panel, without the per-request nonce, expiry and digest. */
export interface RequestContent {
  readonly typedData: { readonly domain: unknown; readonly types: unknown; readonly primaryType: string; readonly message: Readonly<Record<string, unknown>> };
  readonly displayModel: Readonly<Record<string, unknown>>;
}

export function contentKey(c: RequestContent): string {
  const { nonce: _nonce, expiry: _expiry, ...fields } = c.typedData.message;
  const { digest: _digest, ...panel } = c.displayModel;
  return hashObject({ domain: c.typedData.domain, types: c.typedData.types, primaryType: c.typedData.primaryType, fields, panel });
}

export interface OpenCandidate {
  readonly id: string;
  readonly expiresAt: bigint;
  readonly key: string;
}

/** An open (kind, refId) pair: at least one unexpired PENDING request. */
export interface OpenPair {
  readonly kind: string;
  readonly refId: string;
}

/** create: insert a new request after expiring the older PENDING ones of its kind, refId and method, and every `evict` pair's. */
export type RequestDecision = { readonly reuse: string } | { readonly create: true; readonly evict: readonly OpenPair[] };

/**
 * candidates: the facility's unexpired PENDING requests for this kind, refId and method; otherPairs: its OTHER open
 * (kind, refId) pairs, oldest first (by their newest request). A matching candidate is reused (nothing evicted);
 * otherwise a new request is created, and the oldest other pairs are evicted until at most MAX_OPEN_REQUESTS stay open
 * with the new one. Never a refusal.
 */
export function decideRequest(candidates: readonly OpenCandidate[], otherPairs: readonly OpenPair[], freshKey: string, chainNow: bigint): RequestDecision {
  const match = candidates.find((c) => c.key === freshKey && c.expiresAt - chainNow >= REUSE_MIN_REMAINING_S);
  if (match) return { reuse: match.id };
  const over = Math.max(0, otherPairs.length + 1 - MAX_OPEN_REQUESTS);
  return { create: true, evict: otherPairs.slice(0, over) };
}

/** After this refusal (refusals so far, before it): REJECTED once the limit is reached. */
export const rejectsAfter = (refusalsBefore: number): boolean => refusalsBefore + 1 >= MAX_REFUSALS;
