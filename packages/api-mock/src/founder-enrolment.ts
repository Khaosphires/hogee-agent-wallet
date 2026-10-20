/**
 * G2 founder-key enrolment in the mock (closes security-audit run-4 lead 5 in P1's API; same rules here):
 *   - the officer issues a one-time code (18 random bytes, base64url) valid 15 minutes of wall-clock time; only its
 *     keccak256 is kept, and issuing revokes the open code;
 *   - register/options needs the open code (hash compared in constant time) and answers a random challenge bound to
 *     that code (audit run-7; the live API binds its HMAC challenge to the code's hash), with the founder's current
 *     key in excludeCredentials, as live;
 *   - register/verify of a NEW credential needs a clientDataJSON whose challenge register/options issued under the
 *     still-open code, and consumes the code. The code is marked used before any await (audit run-7), so two racing
 *     verifies cannot both use it; a registration the core handler refuses gives it back. Replays of a known
 *     credential and a key after a REGISTERED one keep handlers-core.ts's answers (record / FounderKeyAlreadySet);
 *   - one key slot, as live (audit run-7): a new credential while a non-rejected key is pending is
 *     FounderKeyAlreadySet, and approve is FounderKeyAlreadySet once any key is REGISTERED. The seeded example key
 *     (there only so the contract example round-trips) never holds the slot and is never shown as pending (P1, g2-ui:
 *     the officer must not have to reject a placeholder first); a real registration is the pending key the officer sees;
 *   - the officer reads the pending key and can reject it (never a REGISTERED key). The reject revokes the open code
 *     (audit run-7). A rejected key never registers or is approved again, by credential id or by public key, and
 *     never signs (store.ts founderKeyFor); a loosening it already signed is not queued (exceptions.ts).
 * The existing passkey handlers (handlers-core.ts) run unchanged behind these wrappers.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  ENROLMENT_CODE_BYTES,
  ENROLMENT_CODE_TTL_SECONDS,
  examplePasskeyRegistrationResult,
  examplePendingFounderKey,
  keccak256Utf8,
  type PendingFounderKey,
} from "@hogee/core";
import type { Handlers } from "./http";
import { coreHandlers, keyFromSpki } from "./handlers-core";
import { appendTrace, nextId, nowIso, type FounderKey, type MockState } from "./store";
import { isFailure, type Failure } from "./result";

interface IssuedCode {
  readonly id: string;
  readonly hash: string;
  readonly expiresAtMs: number;
  used?: boolean;
  revoked?: boolean;
}

interface EnrolmentState {
  readonly codes: IssuedCode[];
  /** Challenges register/options issued → the id of the open code each was issued under. */
  readonly challenges: Map<string, string>;
  /** `qx:qy` of every rejected key, so it cannot come back under a new credential id (the ids: st.rejectedFounderKeys). */
  readonly rejectedPoints: Set<string>;
  readonly registeredAt: Map<string, string>;
}

/** Challenges kept per open code (the oldest is dropped past it): only a code holder can ask for more. */
const MAX_CHALLENGES = 16;

/** Per store: demo reset builds a new MockState, so this resets with it. */
const STATES = new WeakMap<MockState, EnrolmentState>();

function enrolment(st: MockState): EnrolmentState {
  let e = STATES.get(st);
  if (!e) {
    e = {
      codes: [],
      challenges: new Map(),
      rejectedPoints: new Set(),
      registeredAt: new Map([[examplePendingFounderKey.credentialId, examplePendingFounderKey.createdAt]]),
    };
    STATES.set(st, e);
  }
  return e;
}

const FORBIDDEN: Failure = { code: "FORBIDDEN", message: "This enrolment code is not valid (wrong, already used, replaced or expired); ask your loan officer for a new one" };
const alreadySet = (message: string): Failure => ({ code: "FounderKeyAlreadySet", message, contractError: { name: "FounderKeyAlreadySet" } });

const openCode = (e: EnrolmentState, nowMs = Date.now()): IssuedCode | undefined => e.codes.find((c) => !c.used && !c.revoked && c.expiresAtMs > nowMs);

/** Revokes every unused code and forgets the challenges issued under them. */
function revokeOpen(e: EnrolmentState): void {
  for (const c of e.codes) if (!c.used && !c.revoked) c.revoked = true;
  e.challenges.clear();
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a.slice(2), "hex");
  const y = Buffer.from(b.slice(2), "hex");
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
}

const pointOf = (k: { readonly qx: string; readonly qy: string }): string => `${k.qx.toLowerCase()}:${k.qy.toLowerCase()}`;

/** The challenge inside a registration's clientDataJSON (base64url JSON), if it has one. */
function clientChallenge(clientDataJSON: unknown): string | undefined {
  if (typeof clientDataJSON !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8"));
    const challenge = (parsed as { challenge?: unknown } | null)?.challenge;
    return typeof challenge === "string" ? challenge : undefined;
  } catch {
    return undefined;
  }
}

/** The founder's keys, seeded with the core example exactly as handlers-core.ts seeds them on first use. */
function keys(st: MockState): Map<string, FounderKey> {
  if (st.founderKeys.size === 0) {
    st.founderKeys.set(examplePasskeyRegistrationResult.credentialId, { ...examplePasskeyRegistrationResult, founderId: st.baseSession.founderId });
  }
  return st.founderKeys;
}

const isRejected = (st: MockState, e: EnrolmentState, k: { readonly credentialId: string; readonly qx: string; readonly qy: string }): boolean =>
  st.rejectedFounderKeys.has(k.credentialId) || e.rejectedPoints.has(pointOf(k));

const pendingKeys = (st: MockState, e: EnrolmentState): FounderKey[] => [...keys(st).values()].filter((k) => k.onchain === "PENDING_LENDER" && !isRejected(st, e, k));

/** The seeded core example only makes the contract example round-trip: it never holds the one key slot. */
const EXAMPLE_KEY_ID = examplePasskeyRegistrationResult.credentialId;
const realPendingKeys = (st: MockState, e: EnrolmentState): FounderKey[] => pendingKeys(st, e).filter((k) => k.credentialId !== EXAMPLE_KEY_ID);

/**
 * As live (excludeCredentials = the founder's credential): the founder's current key, pending or registered, never a
 * rejected one or the seeded example. An authenticator that holds it then refuses to create a second credential for
 * the same user, instead of overwriting the one that signs ("Create a new passkey" after an InvalidSignature).
 */
const excludeCredentials = (st: MockState, e: EnrolmentState): { type: "public-key"; id: string }[] =>
  [...keys(st).values()].filter((k) => k.credentialId !== EXAMPLE_KEY_ID && !isRejected(st, e, k)).map((k) => ({ type: "public-key", id: k.credentialId }));

/** The newest real pending key: never the seeded example, so the officer never has to reject a placeholder (P1). */
function pending(st: MockState): PendingFounderKey | null {
  const e = enrolment(st);
  const withTime = realPendingKeys(st, e).map((k) => ({ k, at: e.registeredAt.get(k.credentialId) ?? examplePendingFounderKey.createdAt }));
  const newest = withTime.sort((a, b) => b.at.localeCompare(a.at))[0];
  return newest ? { credentialId: newest.k.credentialId, qx: newest.k.qx, qy: newest.k.qy, createdAt: newest.at } : null;
}

type EnrolmentRoutes = "passkeyRegisterOptions" | "passkeyRegisterVerify" | "approveFounderKey" | "getPendingFounderKey" | "issueEnrolmentCode" | "rejectFounderKey";

export const enrolmentHandlers: Pick<Handlers, EnrolmentRoutes> = {
  issueEnrolmentCode: ({ st }) => {
    const e = enrolment(st);
    const now = Date.now();
    revokeOpen(e);
    const code = randomBytes(ENROLMENT_CODE_BYTES).toString("base64url");
    const expiresAtMs = now + ENROLMENT_CODE_TTL_SECONDS * 1000;
    e.codes.push({ id: nextId(st, "enr"), hash: keccak256Utf8(code), expiresAtMs });
    appendTrace(st, { traceId: nextId(st, "trace"), actor: "officer", kind: "SIGNATURE", summary: "Loan officer issued a one-time passkey enrolment code for the founder", refs: {} });
    return { code, expiresAt: new Date(expiresAtMs).toISOString() };
  },

  passkeyRegisterOptions: async (ctx) => {
    const e = enrolment(ctx.st);
    const open = openCode(e);
    const matches = sameHash(keccak256Utf8(ctx.req.body.enrolmentCode), open?.hash ?? `0x${"00".repeat(32)}`);
    if (!open || !matches) return FORBIDDEN;
    const out = await coreHandlers.passkeyRegisterOptions(ctx);
    if (out instanceof Response || isFailure(out)) return out;
    // Audit run-7: a random challenge bound to this code, so only this caller's ceremony can consume it.
    const challenge = randomBytes(32).toString("base64url");
    if (e.challenges.size >= MAX_CHALLENGES) e.challenges.delete(e.challenges.keys().next().value as string);
    e.challenges.set(challenge, open.id);
    return { ...out, challenge, excludeCredentials: excludeCredentials(ctx.st, e) };
  },

  passkeyRegisterVerify: async (ctx) => {
    const { st, req } = ctx;
    const e = enrolment(st);
    const point = keyFromSpki((req.body.response as { publicKey?: unknown }).publicKey);
    if (st.rejectedFounderKeys.has(req.body.id) || (point && e.rejectedPoints.has(pointOf(point)))) return { code: "CONFLICT", message: "The loan officer rejected this passkey; create a new one" };
    const known = keys(st).has(req.body.id);
    const registered = [...keys(st).values()].some((k) => k.onchain === "REGISTERED");
    if (known || registered) return coreHandlers.passkeyRegisterVerify(ctx);
    if (realPendingKeys(st, e).length > 0) return alreadySet("The founder's key is already registered; it can never be replaced");
    const open = openCode(e);
    const challenge = clientChallenge(req.body.response.clientDataJSON);
    if (!open || challenge === undefined || e.challenges.get(challenge) !== open.id) return FORBIDDEN;
    open.used = true; // before any await (audit run-7): a racing verify finds no open code
    const out = await coreHandlers.passkeyRegisterVerify(ctx);
    if (out instanceof Response || isFailure(out)) {
      // Refused before anything was stored: the code is open again, unless a newer one replaced it meanwhile.
      open.used = false;
      if (e.codes[e.codes.length - 1] !== open) open.revoked = true;
      return out;
    }
    e.challenges.clear();
    e.registeredAt.set(out.credentialId, nowIso());
    return out;
  },

  approveFounderKey: async (ctx) => {
    const { st, req } = ctx;
    const e = enrolment(st);
    if (isRejected(st, e, req.body)) {
      return { code: "CONFLICT", message: "This key is no longer the founder's pending registration (rejected); review the key again" };
    }
    if ([...keys(st).values()].some((k) => k.onchain === "REGISTERED")) return alreadySet("A founder key is already registered on-chain");
    return coreHandlers.approveFounderKey(ctx);
  },

  getPendingFounderKey: ({ st }) => pending(st),

  rejectFounderKey: ({ req, st }) => {
    const e = enrolment(st);
    const key = keys(st).get(req.body.credentialId);
    if (key?.onchain === "REGISTERED") return { code: "FounderKeyAlreadySet", message: "A key registered on-chain is never rejected", contractError: { name: "FounderKeyAlreadySet" } };
    if (!key || st.rejectedFounderKeys.has(key.credentialId)) return { code: "NOT_FOUND", message: "No pending founder key with that credential" };
    st.rejectedFounderKeys.add(key.credentialId);
    e.rejectedPoints.add(pointOf(key));
    revokeOpen(e); // audit run-7: a code issued while the key was pending does not outlive the reject
    appendTrace(st, { traceId: nextId(st, "trace"), actor: "officer", kind: "SIGNATURE", summary: "Loan officer rejected the founder's pending passkey; a new enrolment needs a new code", refs: {} });
    return { credentialId: key.credentialId, status: "REJECTED" };
  },
};
