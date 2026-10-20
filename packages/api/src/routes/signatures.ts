/**
 * §26.6 signing (hard rule 5): POST /api/signatures/request → POST /api/signatures/:id/submit.
 *
 * request: typed data built with @hogee/chain from SERVER state (the body names only kind, refId and method), a
 *   server-side displayModel rendered from the same struct, a random 256-bit nonce and an expiry in chain time.
 *   Bounded per facility (audit run-6, services/signing/request-bounds.ts): an unexpired PENDING request with the
 *   same content is returned again instead of a new row; a new one expires the older PENDING ones of its kind, refId
 *   and method; at most MAX_OPEN_REQUESTS (kind, refId) pairs are open at once, and a new pair evicts the oldest
 *   (never CONFLICT, so nobody can lock the founder out by filling the cap; run-6 re-check M2).
 * submit, in order, each failing closed:
 *   1. the request is this facility's, PENDING and unexpired in chain time (expired → EXPIRED + SignatureExpired;
 *      REJECTED → CONFLICT);
 *   2. the stored digest is recomputed from the stored struct (a tampered row never verifies);
 *   3. the signature is VERIFIED here with HogeeSigs rules against the key the CHAIN holds (ECDSA → ownerEOA; passkey
 *      → founderKey qx/qy, plus the registered credential id, rpIdHash and an allowed origin); a failure leaves the
 *      request PENDING, writes an ALERT trace and answers InvalidSignature, and the MAX_REFUSALS-th failure closes
 *      the request (REJECTED), so one request writes at most MAX_REFUSALS ALERT traces;
 *   4. the exact relayed call is simulated from the relayer address (a revert answers its contract error);
 *   5. one transaction consumes the request (PENDING → SUBMITTED, single use) and writes the product rows and the
 *      unsigned chain action; the worker relays it (only the worker signs, D19).
 */
import { createHash } from "node:crypto";
import type { ChainAction, PasskeyAssertion, SignatureKind, SignatureRequestResponse, SignatureSubmitBody } from "@hogee/core";
import type { Hex } from "viem";
import { VERIFYING_CONTRACT_OF, decodeRevertData, revertDataFromError, type HogeeCall, type OnchainSig } from "../chain-lib";
import type { ApiDeps, Scope } from "../context";
import { contractAddress } from "../deployment";
import { contractFailure, fail, isContractError } from "../http/problem";
import type { RouteGroup } from "../http/register";
import { wake } from "../services/actions";
import { chainNow, founderKeyOnChain, workerRoles } from "../services/chain";
import { founderRow, requireFacility } from "../services/facility";
import { newId } from "../services/ids";
import type { SignKind, StoredRequest } from "../services/signing/kinds";
import { milestoneRelease, ownerSpend } from "../services/signing/founder-payments";
import { loosenRequest } from "../services/signing/loosen-request";
import { planApproval } from "../services/signing/plan-approval";
import { supplierApproval } from "../services/signing/supplier-approval";
import { contentKey, decideRequest, MAX_REFUSALS, REFUSAL_REASON, rejectsAfter, type OpenPair, type RequestContent } from "../services/signing/request-bounds";
import { buildTyped, digestOf } from "../services/signing/typed";
import { verifyEcdsaSignature, verifyPasskeyAssertion, webAuthnSigData } from "../services/signing/verify";
import { inTx, one, pool, rows, type Q } from "../services/sql";
import { appendTrace } from "../services/traces";

const KINDS: Readonly<Partial<Record<SignatureKind, SignKind>>> = Object.freeze({
  PlanApproval: planApproval,
  LoosenRequest: loosenRequest,
  SupplierApproval: supplierApproval,
  MilestoneRelease: milestoneRelease,
  OwnerSpend: ownerSpend,
});

const ZERO = /^0x0+$/;

/**
 * signature_requests.nonce is a bigint column (frozen DB schema), too narrow for the random 256-bit struct nonce. The
 * authoritative nonce is the one inside typed_data_json (signed, verified, relayed); the column keeps its low 63 bits
 * as a lookup aid only.
 */
const nonceColumn = (nonce: bigint): string => (nonce & ((1n << 63n) - 1n)).toString();

export async function requestSignature(deps: ApiDeps, scope: Scope, kind: SignatureKind, refId: string, method: "passkey" | "eip712"): Promise<SignatureRequestResponse> {
  if (kind === "StageRelease") throw fail("FORBIDDEN", "A stage release is signed by the lender after the loan officer approves it");
  const handler = KINDS[kind];
  if (!handler) throw fail("NOT_FOUND", `Nothing of kind ${kind} can be signed here`);
  const db = pool(deps.db);
  await requireFacility(db, scope);
  const key = await founderKeyOnChain(deps);
  if (method === "passkey" && ZERO.test(key.qx) && ZERO.test(key.qy)) throw fail("CONFLICT", "Your passkey is not registered on-chain yet");
  if (method === "eip712" && ZERO.test(key.ownerEOA)) throw fail("CONFLICT", "No wallet is registered for you on-chain");
  const prepared = await handler.prepare(deps, scope, refId);
  const now = await chainNow(deps);
  const built = buildTyped(deps, kind, prepared.contract, prepared.fields, now);
  const requestId = newId("sig");
  const displayModel = {
    title: prepared.title,
    kind,
    rows: [...prepared.rows],
    digest: built.digest,
    chainId: deps.deployment.chainId,
    contract: contractAddress(deps.deployment, prepared.contract),
    deploymentId: deps.deployment.deploymentId,
  };
  const fresh: SignatureRequestResponse = { requestId, typedData: built.typedData, digest: built.digest, challengeB64url: built.challengeB64url, displayModel, expiresAt: built.expiry.toString() };
  return inTx(deps.db, async (q) => {
    // One decision at a time per facility, so the reuse and the cap hold under concurrent requests.
    await q.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`signature-requests:${scope.facilityId}`]);
    const reused = await openRequestFor(q, scope, { kind, refId, method }, fresh, now);
    if (reused) return reused;
    await q.query(
      `insert into signature_requests (id, facility_id, kind, ref_id, method, typed_data_json, digest, challenge_b64url, display_model_json, nonce, expires_at, status)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10, $11, 'PENDING')`,
      [requestId, scope.facilityId, kind, refId, method, JSON.stringify(built.typedData), built.digest, built.challengeB64url, JSON.stringify(displayModel), nonceColumn(built.nonce), built.expiry.toString()],
    );
    await appendTrace(q, { facilityId: scope.facilityId, traceId: requestId, actor: "founder", kind: "SIGNATURE", summary: `Signature requested: ${kind} for ${refId} (${method})` });
    return fresh;
  });
}

interface OpenRow {
  readonly id: string;
  readonly typed_data_json: SignatureRequestResponse["typedData"];
  readonly digest: string;
  readonly challenge_b64url: string;
  readonly display_model_json: SignatureRequestResponse["displayModel"];
  readonly expires_at: string;
}

/** The content key of a stored row; a row that is not a well-formed request never matches. */
function storedKey(r: OpenRow): string {
  try {
    return contentKey({ typedData: r.typed_data_json, displayModel: r.display_model_json } as unknown as RequestContent);
  } catch {
    return "";
  }
}

/**
 * The open request to hand out again for this kind, refId and method (same content, unexpired, PENDING), or null to
 * create one. Before a create, the older PENDING requests of the same kind, refId and method are superseded and the
 * oldest other pairs past the cap evicted (both EXPIRED). Runs under the facility's request lock.
 */
async function openRequestFor(
  q: Q,
  scope: Scope,
  key: { readonly kind: SignatureKind; readonly refId: string; readonly method: "passkey" | "eip712" },
  fresh: SignatureRequestResponse,
  now: bigint,
): Promise<SignatureRequestResponse | null> {
  const candidates = await rows<OpenRow>(
    q,
    `select id, typed_data_json, digest, challenge_b64url, display_model_json, expires_at::text as expires_at from signature_requests
      where facility_id = $1 and kind = $2 and ref_id = $3 and method = $4 and status = 'PENDING' and expires_at > $5
      order by created_at desc limit 5`,
    [scope.facilityId, key.kind, key.refId, key.method, now.toString()],
  );
  // Open pairs count unexpired PENDING requests only: a REJECTED request never holds a place (run-6 re-check M2).
  const others = await rows<{ kind: string; ref_id: string }>(
    q,
    `select kind::text as kind, ref_id from signature_requests
      where facility_id = $1 and status = 'PENDING' and expires_at > $2 and not (kind = $3 and ref_id = $4)
      group by kind, ref_id order by max(created_at), ref_id collate "C"`,
    [scope.facilityId, now.toString(), key.kind, key.refId],
  );
  const decision = decideRequest(
    candidates.map((r) => ({ id: r.id, expiresAt: BigInt(r.expires_at), key: storedKey(r) })),
    others.map((r) => ({ kind: r.kind, refId: r.ref_id })),
    contentKey(fresh as unknown as RequestContent),
    now,
  );
  if ("create" in decision) {
    await expirePending(q, scope, key);
    for (const pair of decision.evict) await expirePending(q, scope, pair);
    return null;
  }
  const r = candidates.find((c) => c.id === decision.reuse) as OpenRow;
  return { requestId: r.id, typedData: r.typed_data_json, digest: r.digest as Hex, challengeB64url: r.challenge_b64url, displayModel: r.display_model_json, expiresAt: r.expires_at };
}

/** Expires the facility's PENDING requests of a pair (and of one method, when given): superseded or evicted. */
async function expirePending(q: Q, scope: Scope, of: OpenPair & { readonly method?: string }): Promise<void> {
  await q.query(
    "update signature_requests set status = 'EXPIRED' where facility_id = $1 and kind = $2 and ref_id = $3 and ($4::text is null or method::text = $4) and status = 'PENDING'",
    [scope.facilityId, of.kind, of.refId, of.method ?? null],
  );
}

async function loadRequest(deps: ApiDeps, scope: Scope, id: string): Promise<StoredRequest> {
  const r = await one<StoredRequest>(
    pool(deps.db),
    "select id, kind, ref_id, method, typed_data_json, digest, expires_at::text as expires_at, status from signature_requests where facility_id = $1 and id = $2",
    [scope.facilityId, id],
  );
  if (!r) throw fail("NOT_FOUND", "No such signature request");
  return r;
}

const CLOSED_MESSAGE = `This signature request was closed after ${MAX_REFUSALS} failed signatures; request a new one`;

/**
 * Records a refused submission: one ALERT trace while the request is still PENDING (row-locked, so concurrent
 * refusals count one by one), and the MAX_REFUSALS-th one closes the request (REJECTED).
 */
async function refuse(deps: ApiDeps, scope: Scope, req: StoredRequest, reason: string): Promise<never> {
  const outcome = await inTx(deps.db, async (q) => {
    const row = await one<{ status: string }>(q, "select status from signature_requests where facility_id = $1 and id = $2 for update", [scope.facilityId, req.id]);
    if (row?.status === "REJECTED") return "closed" as const;
    if (row?.status !== "PENDING") return "gone" as const; // consumed or expired meanwhile: nothing to count
    const before = (await one<{ n: number }>(q, "select count(*)::int as n from traces where facility_id = $1 and trace_id = $2 and kind = 'ALERT' and reason_code = $3", [scope.facilityId, req.id, REFUSAL_REASON]))?.n ?? 0;
    const closes = rejectsAfter(before);
    if (before < MAX_REFUSALS) {
      await appendTrace(q, {
        facilityId: scope.facilityId,
        traceId: req.id,
        actor: "founder",
        kind: "ALERT",
        summary: `Refused a signature for ${req.kind}: ${reason}${closes ? `; request closed after ${MAX_REFUSALS} failed signatures` : ""}`,
        reasonCode: REFUSAL_REASON,
      });
    }
    if (closes) await q.query("update signature_requests set status = 'REJECTED' where facility_id = $1 and id = $2 and status = 'PENDING'", [scope.facilityId, req.id]);
    return closes ? ("rejected" as const) : ("refused" as const);
  });
  if (outcome === "closed") throw fail("CONFLICT", CLOSED_MESSAGE);
  if (outcome === "gone") throw fail("CONFLICT", "This signature request is no longer open; request a new one");
  const closedNote = outcome === "rejected" ? `; that was the ${MAX_REFUSALS}th failed signature, so this request is closed (request a new one)` : "";
  throw contractFailure("InvalidSignature", `The signature does not verify against your registered key${closedNote}`);
}

/** Server-side extras beyond HogeeSigs (phishing and wrong-credential defence): credential id, rpIdHash, origin. */
function passkeyContextProblem(deps: ApiDeps, a: PasskeyAssertion, registeredCredential: string | null): string | null {
  if (!registeredCredential || a.credentialId !== registeredCredential) return "not the registered passkey";
  const authData = Buffer.from(a.authenticatorData.slice(2), "hex");
  const rpIdHash = createHash("sha256").update(deps.config.webauthn.rpId).digest();
  if (authData.length < 37 || !authData.subarray(0, 32).equals(rpIdHash)) return "the passkey belongs to another site";
  try {
    const client = JSON.parse(a.clientDataJSON) as { origin?: unknown };
    if (typeof client.origin !== "string" || !deps.config.webauthn.origins.includes(client.origin)) return "signed on an origin this app does not serve";
  } catch {
    return "malformed client data";
  }
  return null;
}

async function verifiedSig(deps: ApiDeps, scope: Scope, req: StoredRequest, body: SignatureSubmitBody, digest: Hex): Promise<OnchainSig> {
  const key = await founderKeyOnChain(deps);
  if ("ecdsa" in body) {
    const sig = body.ecdsa.signature.toLowerCase() as Hex;
    if (!(await verifyEcdsaSignature(digest, sig, key.ownerEOA))) return refuse(deps, scope, req, "not signed by the registered wallet");
    return { kind: 0, data: sig };
  }
  const founder = await founderRow(pool(deps.db), scope);
  const problem = passkeyContextProblem(deps, body.passkey, founder?.passkey_credential_id ?? null);
  if (problem) return refuse(deps, scope, req, problem);
  if (!verifyPasskeyAssertion(digest, body.passkey, { qx: key.qx, qy: key.qy })) return refuse(deps, scope, req, "the passkey signature does not verify");
  return { kind: 1, data: webAuthnSigData(body.passkey).toLowerCase() as Hex };
}

/** eth_call from the relayer: the chain's own verdict before anything is written or queued. */
async function simulate(deps: ApiDeps, call: HogeeCall): Promise<void> {
  const roles = await workerRoles(pool(deps.db), deps);
  try {
    await deps.client.call({ account: roles.relayer, to: contractAddress(deps.deployment, call.contract), data: call.data });
  } catch (error: unknown) {
    const data = revertDataFromError(error);
    const decoded = data ? decodeRevertData(data) : null;
    if (decoded && isContractError(decoded.name)) throw contractFailure(decoded.name, `The chain would refuse this (${decoded.name})`);
    if (decoded) throw fail("CONFLICT", `The chain would refuse this (${decoded.name})`);
    deps.log.warn("simulation_failed", { kind: call.kind, error });
    throw fail("UPSTREAM", "The chain node could not check this call; try again shortly");
  }
}

async function submitSignature(deps: ApiDeps, scope: Scope, id: string, body: SignatureSubmitBody): Promise<ChainAction> {
  const req = await loadRequest(deps, scope, id);
  if (req.status === "EXPIRED") throw contractFailure("SignatureExpired", "This signature request has expired; request a new one");
  if (req.status === "REJECTED") throw fail("CONFLICT", CLOSED_MESSAGE);
  if (req.status !== "PENDING") throw fail("CONFLICT", "This signature request was already used");
  if (BigInt(req.expires_at) < (await chainNow(deps))) {
    await pool(deps.db).query("update signature_requests set status = 'EXPIRED' where facility_id = $1 and id = $2 and status = 'PENDING'", [scope.facilityId, id]);
    throw contractFailure("SignatureExpired", "This signature request has expired; request a new one");
  }
  if (("passkey" in body) !== (req.method === "passkey")) throw fail("VALIDATION", `This request expects a ${req.method === "passkey" ? "passkey" : "wallet"} signature`);
  const handler = KINDS[req.kind];
  if (!handler) throw fail("NOT_FOUND", `Nothing of kind ${req.kind} can be signed here`);
  const digest = digestOf(deps, req.kind, VERIFYING_CONTRACT_OF[req.kind], req.typed_data_json.message);
  if (digest !== req.digest) {
    deps.log.error("signature_request_inconsistent", { requestId: id });
    throw fail("UPSTREAM", "The stored signature request is inconsistent");
  }
  const sig = await verifiedSig(deps, scope, req, body, digest);
  const finalized = await handler.finalize(deps, scope, req, sig);
  if (finalized.call) await simulate(deps, finalized.call);
  const action = await inTx(deps.db, async (q) => {
    const consumed = await q.query(
      "update signature_requests set status = 'SUBMITTED', signature_json = $3::jsonb, submitted_at = now() where facility_id = $1 and id = $2 and status = 'PENDING'",
      [scope.facilityId, id, JSON.stringify(body)],
    );
    if (consumed.rowCount !== 1) throw fail("CONFLICT", "This signature request was already used");
    const created = await finalized.commit(q);
    // A founder-signed payment is a payments row (its id is the action id), not a chain_actions row.
    await q.query(
      "update signature_requests set chain_action_id = $3 where facility_id = $1 and id = $2 and exists (select 1 from chain_actions where facility_id = $1 and id = $3)",
      [scope.facilityId, id, created.actionId],
    );
    await appendTrace(q, { facilityId: scope.facilityId, traceId: id, actor: "founder", kind: "SIGNATURE", summary: `Founder signed ${req.kind} (${req.method}); verified and queued for the relayer` });
    return created;
  });
  await wake(deps, "relay");
  await wake(deps, "agent-actions"); // founder-signed payments (release / owner spend) are relayed by that job
  return action;
}

export const signatureRoutes: RouteGroup = {
  requestSignature: ({ req, deps, scope }) => requestSignature(deps, scope, req.body.kind, req.body.refId, req.body.method),
  submitSignature: ({ req, deps, scope }) => submitSignature(deps, scope, req.params.id, req.body),
};
