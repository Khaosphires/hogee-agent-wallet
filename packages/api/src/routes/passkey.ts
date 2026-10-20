/**
 * Founder key registration (§26.1 step 0, hard rule 4).
 *   POST /api/passkey/register/options (founder) → WebAuthn creation options with a stateless HMAC challenge. G2: the
 *     body carries the loan officer's one-time enrolment code (services/enrolment.ts) and the challenge is bound to
 *     its hash, so only whoever holds the officer's code gets a challenge that can register a key.
 *   POST /api/passkey/register/verify  (founder) → verified P-256 key, stored PENDING_LENDER in the transaction that
 *     consumes that code. It NEVER overwrites a credential: a second registration is FounderKeyAlreadySet (the UPDATE
 *     only matches an empty credential), and a credential the officer rejected never comes back.
 *   POST /api/officer/founder-key/approve (officer) → registerFounderKey with EXACTLY the reviewed
 *     {credentialId, qx, qy}, still pending and never rejected (re-checked under the founder row lock); anything else
 *     is CONFLICT, and a key already on-chain is FounderKeyAlreadySet.
 * The officer's pending / enrolment-code / reject routes are in founder-key.ts.
 */
import { createHmac } from "node:crypto";
import type { PasskeyRegistrationOptions, PasskeyRegistrationResult } from "@hogee/core";
import { consumeEnrolmentCode, isFounderKeyRejected, lockFounder } from "@hogee/db";
import type { ApiDeps, Scope } from "../context";
import type { RouteGroup } from "../http/register";
import { contractFailure, fail } from "../http/problem";
import { insertAction, liveAction, wake } from "../services/actions";
import { founderKeyOnChain } from "../services/chain";
import { requirePresentedCode, requireOpenCode, noOpenCode } from "../services/enrolment";
import { founderRow, requireFacility, type FounderRow } from "../services/facility";
import { newId } from "../services/ids";
import { RegistrationError, issueRegistrationChallenge, parseRegistration } from "../services/signing/webauthn";
import { inTx, pool } from "../services/sql";
import { appendTrace } from "../services/traces";

const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

/** The challenge key, derived from PERSONA_COOKIE_SECRET (required for every persona-bearing deployment). */
function challengeKey(deps: ApiDeps): Buffer {
  const secret = deps.flags().cookieSecret;
  if (!secret) throw fail("CONFLICT", "Passkey registration is not configured (PERSONA_COOKIE_SECRET)");
  return createHmac("sha256", secret).update("hogee/webauthn-registration-key").digest();
}

/** G2: the challenge is issued for this facility, this founder AND this enrolment code (its keccak256). */
const bindingOf = (scope: Scope, codeHash: string) => `${scope.facilityId}|${scope.founderId}|${codeHash.toLowerCase()}`;

export async function requireFounder(deps: ApiDeps, scope: Scope): Promise<FounderRow> {
  await requireFacility(pool(deps.db), scope);
  const founder = await founderRow(pool(deps.db), scope);
  if (!founder) throw fail("CONFLICT", "The loan officer has not opened the facility for this founder yet");
  return founder;
}

export const alreadySet = (message: string) => contractFailure("FounderKeyAlreadySet", message);

async function options(deps: ApiDeps, scope: Scope, enrolmentCode: string): Promise<PasskeyRegistrationOptions> {
  const founder = await requireFounder(deps, scope);
  const code = await requirePresentedCode(deps, scope, enrolmentCode);
  const { rpId, rpName } = deps.config.webauthn;
  return {
    rp: { name: rpName, id: rpId },
    user: { id: Buffer.from(scope.founderId).toString("base64url"), name: scope.founderId, displayName: "Founder" },
    challenge: issueRegistrationChallenge(challengeKey(deps), bindingOf(scope, code.codeHash), deps.clock()),
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
    attestation: "none",
    timeout: 300_000,
    // A founder who already registered gets the same options, but the browser will not create a second credential
    // on that authenticator, and verify refuses any second key.
    excludeCredentials: founder.passkey_credential_id ? [{ type: "public-key", id: founder.passkey_credential_id }] : [],
  };
}

async function verify(deps: ApiDeps, scope: Scope, body: Parameters<typeof parseRegistration>[0]): Promise<PasskeyRegistrationResult> {
  const founder = await requireFounder(deps, scope);
  if (founder.passkey_credential_id || founder.key_status === "REGISTERED" || (await founderKeyOnChain(deps)).set) {
    throw alreadySet("The founder's key is already registered; it can never be replaced");
  }
  const code = await requireOpenCode(deps, scope);
  const nowMs = deps.clock();
  let key;
  try {
    key = parseRegistration(body, { ...deps.config.webauthn, secret: challengeKey(deps), binding: bindingOf(scope, code.codeHash), nowMs });
  } catch (e) {
    // The challenge carries the enrolment code: one that does not verify against the open code (forged, expired,
    // another founder's, or issued under a code that was since replaced) is an unauthorised registration.
    if (e instanceof RegistrationError && e.reason === "CHALLENGE") throw fail("FORBIDDEN", "The registration was not started with the open enrolment code; start again with the code from your loan officer", { details: { reason: e.reason } });
    if (e instanceof RegistrationError) throw fail("VALIDATION", `The passkey registration did not verify (${e.reason})`, { details: { reason: e.reason } });
    throw e;
  }
  // Audit run-7: by credential id or by public key, so a rejected key cannot return under a new credential id.
  if (await isFounderKeyRejected(pool(deps.db), scope.facilityId, key)) {
    throw fail("CONFLICT", "The loan officer rejected this passkey; create a new one");
  }
  const stored = await inTx(deps.db, async (q) => {
    if (!(await lockFounder(q, scope.facilityId, scope.founderId))) return false;
    // Consumed with the key, or not at all: a failure below rolls the consumption back.
    if (!(await consumeEnrolmentCode(q, { facilityId: scope.facilityId, id: code.id, credentialId: key.credentialId, now: new Date(nowMs) }))) throw noOpenCode();
    const r = await q.query(
      `update founders set passkey_credential_id = $3, qx = $4, qy = $5, key_status = 'PENDING_LENDER', passkey_registered_at = $6
        where facility_id = $1 and id = $2 and passkey_credential_id is null and key_status = 'PENDING_LENDER'`,
      [scope.facilityId, scope.founderId, key.credentialId, key.qx, key.qy, new Date(nowMs)],
    );
    if (r.rowCount !== 1) throw alreadySet("The founder's key is already registered; it can never be replaced");
    await appendTrace(q, {
      facilityId: scope.facilityId,
      traceId: newId("trace"),
      actor: "founder",
      kind: "SIGNATURE",
      summary: "Founder registered a passkey (Touch ID) with the loan officer's enrolment code; the officer must approve this exact key before it goes on-chain",
    });
    return true;
  });
  if (!stored) throw fail("CONFLICT", "The loan officer has not opened the facility for this founder yet");
  return { credentialId: key.credentialId, qx: key.qx, qy: key.qy, onchain: "PENDING_LENDER" };
}

interface ReviewedKey {
  readonly founderId: string;
  readonly credentialId: string;
  readonly qx: string;
  readonly qy: string;
}

const isReviewed = (f: Pick<FounderRow, "passkey_credential_id" | "qx" | "qy">, body: ReviewedKey) =>
  f.passkey_credential_id === body.credentialId && f.qx === body.qx.toLowerCase() && f.qy === body.qy.toLowerCase();

async function approve(deps: ApiDeps, scope: Scope, body: ReviewedKey) {
  if (body.founderId !== scope.founderId) throw fail("NOT_FOUND", "No such founder in this facility");
  const founder = await requireFounder(deps, scope);
  if (!isReviewed(founder, body)) throw fail("CONFLICT", "This is not the founder's pending registration; review the key again");
  const db = pool(deps.db);
  const existing = await liveAction(db, scope.facilityId, "PlanRegistry.registerFounderKey", scope.founderId);
  if (existing) return existing; // the same approval again
  if (founder.key_status === "REGISTERED" || (await founderKeyOnChain(deps)).set) throw alreadySet("A founder key is already registered on-chain");
  const action = await inTx(deps.db, async (q) => {
    // G2: decide under the founder row lock, so a concurrent reject cannot slip between the check and the insert.
    const [f] = (await q.query<Pick<FounderRow, "passkey_credential_id" | "qx" | "qy" | "key_status" | "wallet_address">>(
      "select passkey_credential_id, qx, qy, key_status, wallet_address from founders where facility_id = $1 and id = $2 for update",
      [scope.facilityId, scope.founderId],
    )).rows;
    if (!f || f.key_status !== "PENDING_LENDER" || !isReviewed(f, body) || (await isFounderKeyRejected(q, scope.facilityId, { credentialId: body.credentialId, qx: f.qx, qy: f.qy }))) {
      throw fail("CONFLICT", "This key is no longer the founder's pending registration (rejected or replaced); review the key again");
    }
    if (await liveAction(q, scope.facilityId, "PlanRegistry.registerFounderKey", scope.founderId)) throw fail("CONFLICT", "This key is already being approved; reload");
    const created = await insertAction(q, {
      facilityId: scope.facilityId,
      kind: "PlanRegistry.registerFounderKey",
      refId: scope.founderId,
      request: { qx: f.qx, qy: f.qy, ownerEOA: f.wallet_address ?? ZERO_ADDRESS, credentialId: f.passkey_credential_id },
    });
    await appendTrace(q, {
      facilityId: scope.facilityId,
      traceId: newId("trace"),
      actor: "officer",
      kind: "SIGNATURE",
      summary: "Loan officer approved the founder's reviewed passkey; registerFounderKey is signed by the demo lender key in the worker",
    });
    return created;
  });
  await wake(deps, "relay");
  return action;
}

export const passkeyRoutes: RouteGroup = {
  passkeyRegisterOptions: ({ req, deps, scope }) => options(deps, scope, req.body.enrolmentCode),
  passkeyRegisterVerify: ({ req, deps, scope }) => verify(deps, scope, req.body as Parameters<typeof parseRegistration>[0]),
  approveFounderKey: ({ req, deps, scope }) => approve(deps, scope, req.body),
};
