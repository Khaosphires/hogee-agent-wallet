/**
 * Bounds on the other founder-persona writers (audit run-7, api:founder-persona-trace-writers-unbounded; the run-6
 * v-1 pattern of signing/request-bounds.ts). Any caller without a signed cookie reads as the founder (demo design), and
 * each of these writers adds rows to tables the evidence export collects, so each stays bounded per facility:
 *   - shortlist (POST /api/suppliers/shortlist): the facility's newest PENDING or READY shortlist for an identical spec
 *     created within SHORTLIST_WINDOW_S is returned again, with nothing written or traced. A FAILED one is not reused
 *     (its reason says "start a new one", and a check that was down may be back). A new spec is never refused (run-7
 *     re-check M2: a window cap let anyone lock the supplier step): past MAX_OPEN_SHORTLISTS open (PENDING or READY)
 *     shortlists, the oldest open ones are superseded (FAILED, SUPERSEDED_REASON). A live shortlist is decided in the
 *     transaction that inserts it, so none stays PENDING. Starts of one facility run one at a time in the process
 *     (`serialized`, re-check L3), so concurrent starts cannot all pass the reuse check and each run the checks;
 *   - inspection upload (POST /api/escrow/:orderId/inspection): a re-upload whose hash equals the stored one writes
 *     nothing. A new hash is never refused (run-7 re-check M1: a refusal let anyone fix the hash the founder's
 *     MilestoneRelease signs): it is always stored, but only the first MAX_UPLOADS_PER_MILESTONE uploads leave a trace
 *     event, then one final event says that later uploads are not traced. The uploads of one milestone share one
 *     hash-chained trace (`inspectionTraceId`), so they are counted from its rows (no schema change);
 *   - exception (POST /api/exceptions): an OPEN founder exception of the same kind and payload (jsonb equality, so key
 *     order does not matter) is returned again; at most MAX_OPEN_FOUNDER_EXCEPTIONS founder exceptions are OPEN per
 *     facility (CONFLICT past it, until the officer decides some);
 *   - escalation (DEMO_MODE POST /api/proposals/spend, NEEDS_OFFICER): while a POLICY_ESCALATION for the same derived
 *     proposal (line, payee, amount and invoice or pacing slot) is OPEN, its trace is returned and nothing is written
 *     (re-check L1);
 *   - chat turn (POST /api/chat: a button's action, free of the model budget, or a text turn; audit run-9 lead 2): a
 *     session takes a turn only while its messages fit under core CHAT_SESSION_MAX_MESSAGES (`decideChatTurn`). A full
 *     session answers core sessionFullReply: nothing stored, run or sent to a model, and only its first refusal leaves
 *     a trace event (`chatFullTraceId`). The store re-checks under the session lock (chat-store appendMessages). New
 *     sessions are never refused (that would let anyone lock the founder out of chat); the rate limits bound how fast
 *     they grow, and no read loads a whole session.
 * Each decision runs under a per-facility transaction lock (`lockWriter`), the chat turn under its session's lock.
 */
import { TEXT, sessionFull } from "@hogee/core";
import type { Q } from "./sql";

export const SHORTLIST_WINDOW_S = 600;
/** Open (PENDING or READY) shortlists a facility keeps; a new one supersedes the oldest past it. */
export const MAX_OPEN_SHORTLISTS = 10;
/** The stored error of a superseded shortlist (shortlist.ts `failureReasonOf` shows it as is). */
export const SUPERSEDED_REASON = "Superseded by newer shortlists; start a new one if you still need it";
export const MAX_UPLOADS_PER_MILESTONE = 5;
export const MAX_OPEN_FOUNDER_EXCEPTIONS = 20;
/** listExceptions: the hard total limit; OPEN rows first, then the newest others (re-check L1). */
export const LIST_EXCEPTIONS_LIMIT = 200;

export type WriteDecision = { readonly reuse: string } | { readonly create: true } | { readonly refuse: string };

/** A matching row is reused even at the cap; otherwise a new one is created only below it. */
function decide(match: string | undefined, count: number, max: number, refusal: string): WriteDecision {
  if (match) return { reuse: match };
  if (count >= max) return { refuse: refusal };
  return { create: true };
}

/** reusable: the newest PENDING or READY shortlist of an identical spec in the window. Never a refusal (re-check M2). */
export const decideShortlist = (reusable: string | undefined): WriteDecision => (reusable ? { reuse: reusable } : { create: true });

/** duplicate: an OPEN founder exception of the same kind and payload; open: the facility's OPEN founder exceptions. */
export const decideException = (duplicate: string | undefined, open: number): WriteDecision =>
  decide(duplicate, open, MAX_OPEN_FOUNDER_EXCEPTIONS, `There are already ${MAX_OPEN_FOUNDER_EXCEPTIONS} open requests; wait for the loan officer to decide some first`);

/**
 * unchanged: write nothing. write: store the new hash, and append a trace event when `trace` is set ("recorded" for a
 * traced upload, "last" for the final event that says later uploads are not traced). Never a refusal.
 */
export type UploadDecision = { readonly unchanged: true } | { readonly write: true; readonly trace: "recorded" | "last" | null };

/** stored: the milestone's evidence hash; traced: the trace events its uploads already wrote. */
export function decideUpload(stored: string | null, fresh: string, traced: number): UploadDecision {
  if (stored !== null && stored.toLowerCase() === fresh.toLowerCase()) return { unchanged: true };
  if (traced < MAX_UPLOADS_PER_MILESTONE) return { write: true, trace: "recorded" };
  return { write: true, trace: traced === MAX_UPLOADS_PER_MILESTONE ? "last" : null };
}

/** stored: the session's messages; adding: the turn's (a press or a text turn stores two). Never reused. */
export const decideChatTurn = (stored: number, adding: number): WriteDecision => (sessionFull(stored, adding) ? { refuse: TEXT.sessionFull } : { create: true });

/** The one trace a full chat session's first refused turn appends (later refusals of that session write nothing). */
export const chatFullTraceId = (sessionId: string): string => `chat-full-${sessionId}`.slice(0, 128);

/** The one trace every recorded upload of a milestone appends to. */
export const inspectionTraceId = (orderId: string, idx: number): string => `inspection:${orderId}:${idx}`;

const queues = new Map<string, Promise<void>>();

/**
 * Runs `fn` once every earlier call with the same key in this process has settled (re-check L3). Waiters hold no
 * pooled client, unlike a blocking advisory lock held across the outside checks.
 */
export async function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  try {
    return await run;
  } finally {
    if (queues.get(key) === tail) queues.delete(key);
  }
}

/** Serialises one writer's decisions per facility (transaction-scoped). */
export async function lockWriter(q: Q, writer: "shortlists" | "founder-exceptions" | "escalations" | "denials", facilityId: string): Promise<void> {
  await q.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`${writer}:${facilityId}`]);
}
